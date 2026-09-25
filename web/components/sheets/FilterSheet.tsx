'use client';

// 検索・絞り込みシート（明細の検索ボタンから開く）。
// 文字検索（読み込み済みの一覧をその場で絞る）、刷新前の明細にあったフィルタ（予算に含む / 除外・カテゴリ）と
// 並び（日付 / 金額）、合計カード・支払い者別カードの集計をここにまとめる。
import { useId, useMemo } from 'react';
import { Eraser, Search } from 'lucide-react';
import type { Expense } from '@/lib/hooks';
import {
  DEFAULT_FILTER,
  categoriesIn,
  filterExpenses,
  isFilterActive,
  summarizeExpenses,
  type BudgetFilter,
  type ExpenseFilter,
  type SortKey,
} from '@/lib/expenseState';
import { collectHistoricalUsers, resolvePayerName } from '@/lib/expenseEdit';
import { yen } from '@/lib/money';
import { T } from '@/lib/uiText';
import { Sheet } from '@/components/ui/Sheet';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import { SheetSection } from '@/components/ui/Rows';

interface FilterSheetProps {
  open: boolean;
  onClose: () => void;
  value: ExpenseFilter;
  onChange: (next: ExpenseFilter) => void;
  /** 読み込み済みの明細（期間内の全件） */
  expenses: readonly Expense[];
}

export function FilterSheet({ open, onClose, value, onChange, expenses }: FilterSheetProps) {
  const queryId = useId();
  const categoryId = useId();
  const categories = useMemo(() => categoriesIn(expenses), [expenses]);
  const historicalUsers = useMemo(() => collectHistoricalUsers(expenses), [expenses]);
  const summary = useMemo(
    () => summarizeExpenses(filterExpenses(expenses, value), (e) => resolvePayerName(e, historicalUsers)),
    [expenses, value, historicalUsers]
  );
  const set = <K extends keyof ExpenseFilter>(key: K, v: ExpenseFilter[K]) => onChange({ ...value, [key]: v });
  // 選んでいたカテゴリがこの期間に無くても選択肢から消さない
  const categoryOptions =
    value.category !== 'all' && !categories.includes(value.category) ? [...categories, value.category] : categories;

  return (
    <Sheet open={open} onClose={onClose} title={T.filter.title}>
      <label htmlFor={queryId} className="kb-field mt-1 flex h-12 items-center gap-2.5 rounded-xl px-3">
        <Search size={20} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-4" />
        <input
          id={queryId}
          type="search"
          enterKeyHint="search"
          aria-label={T.filter.title}
          value={value.query}
          onChange={(e) => set('query', e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none"
        />
      </label>

      <SheetSection title={T.filter.budget} className="!mt-5">
        <SegmentedControl<BudgetFilter>
          ariaLabel={T.filter.budget}
          height={44}
          value={value.budget}
          onChange={(v) => set('budget', v)}
          items={[
            { key: 'all', label: T.filter.all },
            { key: 'included', label: T.filter.included },
            { key: 'excluded', label: T.filter.excluded },
          ]}
        />
      </SheetSection>

      <SheetSection title={T.filter.category} className="!mt-5">
        <select
          id={categoryId}
          aria-label={T.filter.category}
          value={value.category}
          onChange={(e) => set('category', e.target.value)}
          className="kb-field h-12 w-full rounded-xl px-3 text-[16px]"
        >
          <option value="all">{T.filter.all}</option>
          {categoryOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </SheetSection>

      <SheetSection title={T.filter.sort} className="!mt-5">
        <SegmentedControl<SortKey>
          ariaLabel={T.filter.sort}
          height={44}
          value={value.sortBy}
          onChange={(v) => set('sortBy', v)}
          items={[
            { key: 'date', label: T.filter.sortDate },
            { key: 'amount', label: T.filter.sortAmount },
          ]}
        />
      </SheetSection>

      <SheetSection title={T.filter.summary} className="!mt-5">
        <dl>
          <SummaryRow label={T.filter.count} value={T.filter.items(summary.count)} />
          <SummaryRow label={T.filter.total} value={yen(summary.total)} strong />
          {summary.excludedCount > 0 && (
            <SummaryRow label={T.filter.excludedCount} value={T.filter.items(summary.excludedCount)} />
          )}
          {summary.payers.map((p) => (
            <SummaryRow key={p.name} label={p.name} value={yen(p.total)} note={T.filter.items(p.count)} />
          ))}
        </dl>
      </SheetSection>

      <div className="mt-5 pb-1">
        <PrimaryButton
          variant="soft"
          height={52}
          icon={Eraser}
          disabled={!isFilterActive(value)}
          onClick={() => onChange(DEFAULT_FILTER)}
        >
          {T.filter.clear}
        </PrimaryButton>
      </div>
    </Sheet>
  );
}

function SummaryRow({ label, value, note, strong }: { label: string; value: string; note?: string; strong?: boolean }) {
  return (
    <div className="flex min-h-[52px] items-center gap-3 border-b border-divider px-1 last:border-b-0">
      <dt className="min-w-0 flex-1 truncate text-[15px] text-ink-2">{label}</dt>
      {note && <dd className="shrink-0 text-[14px] text-ink-4">{note}</dd>}
      <dd className={strong ? 'shrink-0 text-[20px] font-bold text-ink' : 'shrink-0 text-[16px] font-semibold text-ink'}>
        {value}
      </dd>
    </div>
  );
}
