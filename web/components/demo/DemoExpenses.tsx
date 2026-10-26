'use client';

// デモの支出一覧。本番の支出一覧（app/(app)/expenses/page.tsx）と同じ部品・純関数で、検索・絞り込み・並び替えはその場の状態で動く。
// カードは lineId=null で描くので、確認・計上の切り替え・編集・削除・レシート添付のボタンは出ない（何も保存しない）。
// 本番のカードは中項目を出さないので、デモでは中項目をカードの下の行に重ねて出す。
import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Inbox } from 'lucide-react';
import {
  categoriesIn,
  countPending,
  filterExpenses,
  matchesSegment,
  parseSegment,
  resolvePayerName,
  sortForList,
  summarizeExpenses,
  type Segment,
  type SortKey,
} from '../../lib/expenseState';
import { collectHistoricalUsers } from '../../lib/expenseEdit';
import { NO_SUB_CATEGORY, subCategoryKey } from '../../lib/drilldown';
import { subCategoriesOf } from '../../lib/categoryTaxonomy';
import { getCategoryVisual } from '../../lib/categoryVisuals';
import ExpenseControls from '../expenses/ExpenseControls';
import ExpenseCard from '../expenses/ExpenseCard';
import { DEMO_DEFAULT_MONTH_INDEX, DEMO_EXPENSES, DEMO_MONTHS, inDemoRange } from '../../lib/demo/demoData';

const USERS = collectHistoricalUsers(DEMO_EXPENSES);
const noop = () => {};

function SubCategoryTag({ category, subCategory }: { category: string; subCategory: string | undefined }) {
  // 内訳シートと同じく、一覧にある名前だけを出す（無い大項目・中項目なしは出さない）
  const key = subCategoryKey(subCategoriesOf(category), subCategory);
  if (!key || key === NO_SUB_CATEGORY) return null;
  const v = getCategoryVisual(category);
  return (
    // カードの下の行（ボタンの行。デモでは空）の中に置く。左端はカードの左の線（4px）＋余白にそろえる
    <span className="pointer-events-none absolute bottom-[5px] left-5 inline-flex items-center gap-1.5 text-[11px] sm:bottom-[7px] sm:left-6">
      <span className="text-muted">中項目</span>
      <span className={`rounded-md px-1.5 py-px font-medium ${v.bg} ${v.fg}`}>
        {category} › {key}
      </span>
    </span>
  );
}

export default function DemoExpenses() {
  const searchParams = useSearchParams();
  const [monthIndex, setMonthIndex] = useState(DEMO_DEFAULT_MONTH_INDEX);
  const month = DEMO_MONTHS[monthIndex];
  // ?filter=pending（デモのホームの「要確認」から開いたとき）
  const [segment, setSegment] = useState<Segment>(() => parseSegment(searchParams.get('filter')));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState<SortKey>('date');

  const expenses = useMemo(() => DEMO_EXPENSES.filter((e) => inDemoRange(e, month.range)), [month]);
  const budgetFilter = filter === 'included' || filter === 'excluded' ? filter : 'all';
  const filtered = filterExpenses(
    expenses.filter((e) => matchesSegment(e, segment)),
    { query, budget: budgetFilter, category: budgetFilter === 'all' ? filter : 'all' }
  );
  const sorted = sortForList(filtered, sortBy);
  const payerNameOf = (e: (typeof expenses)[number]) => resolvePayerName(e, USERS);
  const summary = summarizeExpenses(filtered, payerNameOf);

  // 期間の移動は、デモのデータがある月の外へは動かない
  return (
    <div>
      <ExpenseControls
        segment={segment}
        onSegmentChange={setSegment}
        pendingCount={countPending(expenses)}
        query={query}
        onQueryChange={setQuery}
        periodTitle={month.title}
        onPrevPeriod={() => setMonthIndex((i) => Math.max(0, i - 1))}
        onNextPeriod={() => setMonthIndex((i) => Math.min(DEMO_MONTHS.length - 1, i + 1))}
        hasExpenses={expenses.length > 0}
        filter={filter}
        onFilterChange={setFilter}
        categories={categoriesIn(expenses)}
        sortBy={sortBy}
        onSortChange={setSortBy}
        summary={summary}
      />

      {sorted.length === 0 ? (
        <div className="glass rounded-2xl p-8 text-center shadow-glass">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-fg/5 text-muted">
            <Inbox className="h-6 w-6" strokeWidth={1.8} />
          </span>
          <p className="text-sm text-muted">条件に合う支出はありません</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((expense) => (
            <div key={expense.id} className="relative">
              <ExpenseCard
                expense={expense}
                editing={false}
                payerName={payerNameOf(expense)}
                lineId={null}
                isGuest
                apiAvailable={false}
                activeGroupIds={null}
                confirming={false}
                onConfirm={noop}
                onToggleInclude={noop}
                onEdit={noop}
                onPreviewReceipt={noop}
                onDelete={noop}
                showAttachLink={false}
              />
              <SubCategoryTag category={expense.category} subCategory={expense.subCategory} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
