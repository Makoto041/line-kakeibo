'use client';

// 明細のたたんだ行カード（design.md §3.10）。[アイコン][名前][金額][要確認の時計][›]。押すと展開する。
import { ChevronRight, Clock } from 'lucide-react';
import type { Expense } from '@/lib/hooks';
import { cx } from '@/lib/cx';
import { isCounted } from '@/lib/expenseState';
import { T } from '@/lib/uiText';
import { Amount } from '@/components/ui/Amount';
import { ExpenseIcon, expenseLabel } from './ExpenseIcon';

export function ExpenseRowCard({
  expense,
  pending,
  onExpand,
}: {
  expense: Expense;
  pending: boolean;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      id={`expense-${expense.id}`}
      aria-expanded={false}
      onClick={onExpand}
      className="kb-card-2 mx-4 mt-2 flex h-14 w-[calc(100%-2rem)] scroll-mt-20 items-center rounded-kb-row pl-4 pr-2.5 text-left transition-transform duration-150 active:scale-[0.99]"
    >
      <ExpenseIcon description={expense.description} category={expense.category} size={22} />
      <span
        className="ml-3 min-w-0 flex-1 truncate text-kb-row text-ink"
      >{expenseLabel(expense)}</span>
      <Amount
        value={expense.amount}
        base={16}
        weight={600}
        className={cx('ml-3 shrink-0', isCounted(expense) ? 'text-ink' : 'text-ink-4')}
      />
      {pending && <span className="sr-only">{T.expenses.pending}</span>}
      {!isCounted(expense) && <span className="sr-only">{T.expenses.uncounted}</span>}
      {pending && (
        <span
          aria-hidden="true"
          className="ml-2 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-warn-halo text-warn-icon"
        >
          <Clock size={16} strokeWidth={2.25} />
        </span>
      )}
      <ChevronRight
        size={16}
        strokeWidth={2.25}
        aria-hidden="true"
        className={cx('shrink-0 text-ink-4', pending ? 'ml-1.5' : 'ml-2')}
      />
    </button>
  );
}
