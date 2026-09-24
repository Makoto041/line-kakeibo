'use client';

// ホームの「最近の明細」。区切り線 → 見出し → 日付（M月D日）→ 行（アイコン・名前・金額）。
// 行は高さ 64、行の間に細い線（design.md §3.5〜3.6）。行を押すと詳細シート。
// 0 件のときは見出しの下に何も出さない（説明文は出さない）。
import dayjs from 'dayjs';
import type { Expense } from '@/lib/hooks';
import { absoluteDateLabel, groupByDate } from '@/lib/expenseState';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import { Amount } from '@/components/ui/Amount';
import { Skeleton, SkeletonGroup } from '@/components/ui/Skeleton';
import { ExpenseIcon, expenseLabel } from '@/components/expense/ExpenseIcon';

interface RecentListProps {
  /** 表示する明細（並べ替え・件数の絞り込みは呼び出し側で済ませる） */
  items: readonly Expense[];
  loading: boolean;
  onOpen: (id: string) => void;
}

export function RecentList({ items, loading, onOpen }: RecentListProps) {
  const today = dayjs().format('YYYY-MM-DD');
  const groups = groupByDate(items);

  return (
    <section aria-labelledby="home-recent-heading">
      <div aria-hidden="true" className="mx-6 mt-[23px] h-px bg-divider" />
      <h2 id="home-recent-heading" className="mx-6 mt-4 text-kb-section text-ink-soft">
        {T.home.recent}
      </h2>
      {loading ? (
        <SkeletonGroup className="mt-[18px] px-6">
          <Skeleton className="h-[14px] w-16 rounded-md" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex h-16 items-center gap-7 pl-2 pr-1.5">
              <Skeleton className="h-[30px] w-[30px] rounded-lg" />
              <Skeleton className="h-[18px] flex-1 rounded-md" />
              <Skeleton className="h-[22px] w-20 rounded-md" />
            </div>
          ))}
        </SkeletonGroup>
      ) : (
        groups.map((group) => (
          <div key={group.date}>
            <p className="mx-6 mt-[18px] text-kb-date text-ink-4">{absoluteDateLabel(group.date, today)}</p>
            <ul className="mx-6">
              {group.items.map((expense, i) => (
                <li key={expense.id} className={cx(i > 0 && 'border-t border-divider')}>
                  <ExpenseListRow expense={expense} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

export function ExpenseListRow({ expense, onOpen }: { expense: Expense; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={() => onOpen(expense.id)}
      className="flex h-16 w-full items-center pl-2 pr-1.5 text-left transition-opacity active:opacity-70"
    >
      <ExpenseIcon description={expense.description} category={expense.category} size={30} />
      <span className="ml-7 min-w-0 flex-1 truncate text-kb-row text-ink">{expenseLabel(expense)}</span>
      <Amount
        value={expense.amount}
        base={22}
        weight={600}
        className={cx('ml-3 shrink-0', expense.includeInTotal ? 'text-ink' : 'text-ink-4')}
      />
    </button>
  );
}
