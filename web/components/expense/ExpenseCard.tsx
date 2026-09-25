'use client';

// 明細の展開カード（design.md §3.9）。
// [アイコン][名前][⋯] / 大きい金額 / チップ（カテゴリ・区分）/ 予算の帯 / [確認][鉛筆]。
// 確認は要確認のときだけ出す（確認済みは鉛筆だけを右に寄せる）。詳しい情報は ⋯ の詳細シートへ。
import { CircleCheck, Ellipsis, HandCoins, Pencil, User, Users } from 'lucide-react';
import type { Expense } from '@/lib/hooks';
import { isCounted, splitChip, type SplitChip } from '@/lib/expenseState';
import { getCategoryVisual } from '@/lib/categoryVisuals';
import { T } from '@/lib/uiText';
import { Amount } from '@/components/ui/Amount';
import { Chip } from '@/components/ui/Chip';
import { IconButton } from '@/components/ui/IconButton';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import { StatusStrip } from '@/components/ui/StatusStrip';
import type { AnyIcon } from '@/components/ui/icons';
import { ExpenseIcon, expenseLabel } from './ExpenseIcon';

const SPLIT_ICON: Record<SplitChip, AnyIcon> = {
  shared: Users,
  personal: User,
  advance: HandCoins,
  settled: CircleCheck,
};

interface ExpenseCardProps {
  expense: Expense;
  /** 要確認（確認ボタンを出す） */
  pending: boolean;
  /** 確認を押せるか（API 未設定・ゲスト・権限なしでは押せない） */
  confirmable: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onEdit: () => void;
  onDetail: () => void;
  /** 見出し（アイコンと名前）を押したとき（たたむ） */
  onCollapse: () => void;
}

export function ExpenseCard({
  expense,
  pending,
  confirmable,
  confirming,
  onConfirm,
  onEdit,
  onDetail,
  onCollapse,
}: ExpenseCardProps) {
  const category = getCategoryVisual(expense.category);
  const split = splitChip(expense);
  const counted = isCounted(expense);

  return (
    <article
      id={`expense-${expense.id}`}
      className="kb-card mx-4 mt-4 scroll-mt-24 rounded-kb-card px-4 pb-5 pt-4"
    >
      <div className="flex h-[52px] items-center pl-2">
        <button
          type="button"
          id={`expense-${expense.id}-toggle`}
          aria-expanded={true}
          onClick={onCollapse}
          className="flex min-w-0 flex-1 items-center self-stretch text-left"
        >
          <ExpenseIcon description={expense.description} category={expense.category} size={34} />
          <span className="ml-[23px] min-w-0 flex-1 truncate text-kb-row-lg text-ink">{expenseLabel(expense)}</span>
        </button>
        <IconButton
          label={T.aria.detail}
          icon={Ellipsis}
          variant="plain"
          size={44}
          iconSize={28}
          strokeWidth={2}
          aria-haspopup="dialog"
          onClick={onDetail}
          className="-mr-[7px] ml-2 !text-dots"
        />
      </div>

      <div className="mt-[14px] text-center">
        <Amount value={expense.amount} base={44} className="text-ink" />
      </div>

      <div className="mt-3 flex flex-wrap justify-center gap-3">
        <Chip icon={category.icon} label={expense.category} />
        <Chip icon={SPLIT_ICON[split]} label={T.split[split]} />
      </div>

      <StatusStrip counted={counted} className="mx-0.5 mt-[18px]" />

      <div className="mt-4 flex items-center gap-3">
        {pending ? (
          <PrimaryButton
            icon={CircleCheck}
            loading={confirming}
            disabled={!confirmable}
            onClick={onConfirm}
            className="min-w-0 flex-1"
          >
            {T.expenses.confirm}
          </PrimaryButton>
        ) : (
          <span className="flex-1" />
        )}
        <IconButton
          label={T.aria.edit}
          icon={Pencil}
          variant="soft"
          size={64}
          iconSize={24}
          aria-haspopup="dialog"
          onClick={onEdit}
          className="!text-ink-edit"
        />
      </div>
    </article>
  );
}
