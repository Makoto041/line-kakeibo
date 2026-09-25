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
      className="kb-card-2 mx-4 mt-4 flex h-[82px] w-[calc(100%-2rem)] scroll-mt-24 items-center rounded-kb-row pl-6 pr-3 text-left transition-transform duration-150 active:scale-[0.99]"
    >
      <ExpenseIcon description={expense.description} category={expense.category} size={34} />
      <span
        className={cx(
          'min-w-0 flex-1 truncate text-kb-row-lg text-ink',
          // 390 未満で時計が付く行は間を詰め、4 字の名前が省略されないようにする
          pending ? 'ml-[23px] max-[389px]:ml-3.5' : 'ml-[23px]',
        )}
      >{expenseLabel(expense)}</span>
      <Amount
        value={expense.amount}
        base={24}
        className={cx('ml-3 shrink-0', pending && 'max-[389px]:ml-2', isCounted(expense) ? 'text-ink' : 'text-ink-4')}
      />
      {pending && <span className="sr-only">{T.expenses.pending}</span>}
      {!isCounted(expense) && <span className="sr-only">{T.expenses.uncounted}</span>}
      {pending && (
        <span
          aria-hidden="true"
          className="ml-[18px] grid h-[34px] w-[34px] max-[389px]:ml-2.5 shrink-0 place-items-center rounded-full bg-warn-halo text-warn-icon"
        >
          <Clock size={28} strokeWidth={2} />
        </span>
      )}
      <ChevronRight
        size={24}
        strokeWidth={2}
        aria-hidden="true"
        className={cx('shrink-0 text-ink-5', pending ? 'ml-2.5 max-[389px]:ml-1.5' : 'ml-4')}
      />
    </button>
  );
}
