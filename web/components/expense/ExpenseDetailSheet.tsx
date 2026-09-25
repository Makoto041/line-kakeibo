'use client';

// 明細の詳細シート（ホームの行・明細の ⋯ から開く）。
// 刷新前の明細カードにあった情報（日付・カテゴリ・入力者・支払い者・グループ・商品・レシート）と操作
// （予算に含める・確認・編集・削除）をここにまとめる。メイン画面には出さない。
// - 予算に含める: クライアントから includeInTotal を書く（master / PR #172 のどちらのルールでも通る）
// - 確認: サーバー（/household）経由。要確認のときだけ出す
// - 削除: 精算済みは出さない。1 回目で赤い「削除する」に変わり、もう一度押すと削除する
import { useId, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { ChevronRight, CircleCheck, Paperclip, Pencil, Trash2 } from 'lucide-react';
import type { Expense, HouseholdInfo } from '@/lib/hooks';
import {
  canClientDelete,
  canClientWrite,
  canServerConfirm,
  isAdvance,
  isPending,
  splitChip,
} from '@/lib/expenseState';
import { resolvePayerName, type KnownUser } from '@/lib/expenseEdit';
import { getCategoryVisual } from '@/lib/categoryVisuals';
import { yen } from '@/lib/money';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import { Sheet } from '@/components/ui/Sheet';
import { Amount } from '@/components/ui/Amount';
import { InfoRow, SheetSection } from '@/components/ui/Rows';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import { SwitchRow } from '@/components/ui/Switch';
import { ExpenseIcon, expenseLabel } from './ExpenseIcon';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 詳細の日付（YYYY年M月D日 (曜)） */
export function fullDateLabel(date: string): string {
  const d = dayjs(date);
  if (!d.isValid()) return date;
  return `${d.format('YYYY年M月D日')} (${WEEKDAYS[d.day()]})`;
}

export interface ExpenseDetailActions {
  /** 予算に含める／外す。成功したら true */
  onToggleInclude: (next: boolean) => Promise<boolean>;
  /** 確認（サーバー経由）。成功したら true */
  onConfirm: () => Promise<boolean>;
  onEdit: () => void;
  /** 削除。成功したら true（シートは呼び出し側が閉じる） */
  onDelete: () => Promise<boolean>;
  onOpenReceipt: () => void;
}

interface ExpenseDetailSheetProps extends ExpenseDetailActions {
  open: boolean;
  onClose: () => void;
  expense: Expense | null;
  me: string | null;
  /** 有効に所属しているグループ（null は読み込み中＝許可扱い） */
  activeGroupIds: readonly string[] | null;
  household: HouseholdInfo['household'];
  historicalUsers: readonly KnownUser[];
  /** ゲスト（サンプル）: 表示だけで操作はしない */
  readOnly: boolean;
  /** 確認のエンドポイントが使えるか */
  apiAvailable: boolean;
}

export function ExpenseDetailSheet({ open, onClose, expense, ...rest }: ExpenseDetailSheetProps) {
  // 閉じる動きの間（削除した直後など）も最後の内容を出しておく
  const [kept, setKept] = useState<Expense | null>(expense);
  if (expense && expense !== kept) setKept(expense);
  const shown = expense ?? kept;

  return (
    <Sheet open={open && !!shown} onClose={onClose} title={shown ? expenseLabel(shown) : ''}>
      {shown && <DetailBody key={shown.id} expense={shown} {...rest} />}
    </Sheet>
  );
}

function DetailBody({
  expense,
  me,
  activeGroupIds,
  household,
  historicalUsers,
  readOnly,
  apiAvailable,
  onToggleInclude,
  onConfirm,
  onEdit,
  onDelete,
  onOpenReceipt,
}: Omit<ExpenseDetailSheetProps, 'open' | 'onClose' | 'expense'> & { expense: Expense }) {
  const includeLabelId = useId();
  // 切り替え中の値（成功するまでスイッチはこの値を出し、失敗したら元に戻す）
  const [pendingInclude, setPendingInclude] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 書き込み中の二重実行を防ぐ（state の更新を待たずに弾く）
  const busyRef = useRef(false);

  const writable = !readOnly && canClientWrite(expense, me, activeGroupIds);
  const deletable = !readOnly && canClientDelete(expense, me, activeGroupIds);
  const pending = isPending(expense);
  const confirmable = !readOnly && apiAvailable && canServerConfirm(expense, me, activeGroupIds);

  const category = getCategoryVisual(expense.category);
  const CategoryIcon = category.icon;
  const payerName = resolvePayerName(expense, historicalUsers);
  const inputName = expense.userDisplayName && expense.userDisplayName !== '個人' ? expense.userDisplayName : null;
  const members = household?.members ?? [];
  const advanceName =
    isAdvance(expense) && expense.advanceBy
      ? members.find((m) => m.lineId === expense.advanceBy)?.displayName ||
        historicalUsers.find((u) => u.lineId === expense.advanceBy)?.displayName ||
        null
      : null;
  const isGroupExpense = !!(expense.groupId || expense.lineGroupId);
  const groupName =
    household && expense.groupId === household.groupId && household.name ? household.name : T.detail.groupFallback;
  const items = Array.isArray(expense.items) ? expense.items : [];
  const includeValue = pendingInclude ?? !!expense.includeInTotal;

  const toggleInclude = async (next: boolean) => {
    if (!writable || busyRef.current) return;
    busyRef.current = true;
    setPendingInclude(next);
    await onToggleInclude(next);
    busyRef.current = false;
    setPendingInclude(null);
  };

  const confirm = async () => {
    if (!confirmable || busyRef.current) return;
    busyRef.current = true;
    setConfirming(true);
    await onConfirm();
    busyRef.current = false;
    setConfirming(false);
  };

  const remove = async () => {
    if (!deletable || busyRef.current) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    busyRef.current = true;
    setDeleting(true);
    const ok = await onDelete();
    busyRef.current = false;
    if (!ok) {
      setDeleting(false);
      setDeleteArmed(false);
    }
  };

  return (
    <div className="pb-2">
      {/* 金額（主役） */}
      <div className="flex items-center justify-center gap-4 pb-4 pt-1">
        <ExpenseIcon description={expense.description} category={expense.category} size={34} />
        <Amount value={expense.amount} base={44} className={cx('text-ink', !expense.includeInTotal && 'opacity-60')} />
      </div>

      <div>
        <InfoRow label={T.detail.date}>{fullDateLabel(expense.date)}</InfoRow>
        <InfoRow label={T.detail.category}>
          <span className="inline-flex items-center gap-2">
            <CategoryIcon size={18} strokeWidth={2} aria-hidden="true" className="text-ink-3" />
            {expense.category}
          </span>
        </InfoRow>
        <InfoRow label={T.detail.split}>{T.split[splitChip(expense)]}</InfoRow>
        {advanceName && <InfoRow label={T.detail.advanceBy}>{advanceName}</InfoRow>}
        {inputName && <InfoRow label={T.detail.input}>{inputName}</InfoRow>}
        {payerName !== '個人' && <InfoRow label={T.detail.payer}>{payerName}</InfoRow>}
        {isGroupExpense && <InfoRow label={T.detail.group}>{groupName}</InfoRow>}
        {expense.receiptUrl ? (
          <ReceiptRow label={T.detail.receipt} onClick={onOpenReceipt} />
        ) : (
          !readOnly && (
            <ReceiptRow label={T.detail.attach} href={`/attach/?expenseId=${encodeURIComponent(expense.id)}`} />
          )
        )}
      </div>

      {items.length > 0 && (
        <SheetSection title={T.detail.items} className="!mt-5">
          <ul>
            {items.map((item, index) => (
              <li
                key={index}
                className="flex min-h-[48px] items-center gap-3 border-b border-divider px-1 last:border-b-0"
              >
                <span className="min-w-0 flex-1 break-words text-[15px] text-ink-2">{item.name}</span>
                <span className="shrink-0 text-[15px] font-semibold text-ink">{yen(item.price)}</span>
              </li>
            ))}
          </ul>
        </SheetSection>
      )}

      {/* 予算に含める */}
      <SwitchRow
        className="mt-4"
        label={T.detail.include}
        labelId={includeLabelId}
        checked={includeValue}
        onChange={toggleInclude}
        disabled={!writable}
        busy={pendingInclude !== null}
      />

      <div className="mt-4 space-y-3">
        {pending && (
          <PrimaryButton height={56} icon={CircleCheck} loading={confirming} disabled={!confirmable} onClick={confirm}>
            {T.detail.confirm}
          </PrimaryButton>
        )}
        <div className="flex gap-3">
          <PrimaryButton
            variant="soft"
            height={56}
            icon={Pencil}
            disabled={!writable}
            onClick={onEdit}
            className="flex-1"
          >
            {T.detail.edit}
          </PrimaryButton>
          {deletable && (
            <PrimaryButton
              variant={deleteArmed ? 'danger' : 'soft'}
              height={56}
              icon={Trash2}
              loading={deleting}
              onClick={remove}
              className={cx('flex-1', !deleteArmed && '!text-danger')}
            >
              {deleteArmed ? T.detail.deleteConfirm : T.detail.delete}
            </PrimaryButton>
          )}
        </div>
      </div>
    </div>
  );
}

function ReceiptRow({ label, onClick, href }: { label: string; onClick?: () => void; href?: string }) {
  const inner = (
    <>
      <Paperclip size={22} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate text-left text-[16px] font-medium text-ink">{label}</span>
      <ChevronRight size={22} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-4" />
    </>
  );
  const cls =
    'flex min-h-[60px] w-full items-center gap-4 border-b border-divider px-1 transition-opacity last:border-b-0 active:opacity-70';
  if (href) {
    // /attach は単独画面（ナビなし）。刷新前と同じく通常の遷移で開く
    return (
      <a href={href} className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}
