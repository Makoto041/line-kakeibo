'use client';

// 編集シート（明細の鉛筆・詳細シートの編集・LINE の「修正」リンク /expenses?edit=<id>）。
// 項目は刷新前の編集ドロワーと同じ（説明・金額・日付・カテゴリ・支払い者・予算に含める）。
// - 保存前に validateEditForm（PR #172 と同じ文言・判定順）で確かめ、変更した項目だけを送る
// - 精算済みの支出は金額・日付・支払い者を読み取り専用にし、送らない（ルールで固定されている）
import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { CircleCheck, X } from 'lucide-react';
import type { Expense } from '@/lib/hooks';
import { useGroupMembers } from '@/lib/hooks';
import {
  buildCategoryOptions,
  buildEditUpdate,
  buildPayerOptions,
  collectGroupExpenseUsers,
  collectHistoricalUsers,
  formFromExpense,
  hasEditChanges,
  mergeAvailableMembers,
  payerDisplayNameFor,
  validateEditForm,
  type EditForm,
  type EditKey,
} from '@/lib/expenseEdit';
import { isSettled } from '@/lib/expenseState';
import { CANONICAL_CATEGORIES } from '@/lib/categoryNormalization';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import { Sheet } from '@/components/ui/Sheet';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import { Switch } from '@/components/ui/Switch';

interface ExpenseEditSheetProps {
  open: boolean;
  onClose: () => void;
  /** 詳細シートから来たときの戻る */
  onBack?: () => void;
  expense: Expense | null;
  /** 読み込み済みの明細（支払い者・カテゴリの候補に使う） */
  expenses: readonly Expense[];
  /** クライアントから書けるか（書けなければ入力と保存を無効にする） */
  canWrite: boolean;
  /** 変更した項目だけを保存する。成功したら true */
  onSave: (update: Partial<EditForm>) => Promise<boolean>;
}

export function ExpenseEditSheet({ open, onClose, onBack, expense, ...rest }: ExpenseEditSheetProps) {
  const [kept, setKept] = useState<Expense | null>(expense);
  if (expense && expense !== kept) setKept(expense);
  const shown = expense ?? kept;

  return (
    <Sheet open={open && !!shown} onClose={onClose} onBack={onBack} title={T.edit.title}>
      {shown && <EditBody key={shown.id} expense={shown} onCancel={onBack ?? onClose} {...rest} />}
    </Sheet>
  );
}

const FIELD = 'kb-field h-12 w-full rounded-xl px-3 text-[16px] disabled:opacity-60';

function EditBody({
  expense,
  expenses,
  canWrite,
  onSave,
  onCancel,
}: Omit<ExpenseEditSheetProps, 'open' | 'onClose' | 'onBack' | 'expense'> & {
  expense: Expense;
  onCancel: () => void;
}) {
  const ids = {
    description: useId(),
    amount: useId(),
    date: useId(),
    category: useId(),
    payer: useId(),
    include: useId(),
    error: useId(),
  };
  const initial = useMemo(() => formFromExpense(expense), [expense]);
  const [form, setForm] = useState<EditForm>(initial);
  // 金額は入力途中の空欄を許すため文字列で持ち、保存時に数値にする
  const [amountText, setAmountText] = useState(() => String(initial.amount ?? ''));
  const [error, setError] = useState<{ field: EditKey; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldRefs = useRef<Partial<Record<EditKey, HTMLInputElement | HTMLSelectElement | null>>>({});

  const settled = isSettled(expense);
  const locked = !canWrite || saving;

  // 支払い者の候補（刷新前と同じ優先順位: 正式メンバー → このグループの履歴 → 全体の履歴）
  const { members: groupMembers } = useGroupMembers(expense.groupId || null);
  const historicalUsers = useMemo(() => collectHistoricalUsers(expenses), [expenses]);
  const groupExpenseUsers = useMemo(() => collectGroupExpenseUsers(expenses, expense), [expenses, expense]);
  const availableMembers = useMemo(
    () => mergeAvailableMembers(groupMembers, groupExpenseUsers, historicalUsers),
    [groupMembers, groupExpenseUsers, historicalUsers]
  );
  const payerOptions = buildPayerOptions(expense, availableMembers, expenses, form);
  const categoryOptions = buildCategoryOptions(CANONICAL_CATEGORIES, expenses, form.category);

  const update = <K extends EditKey>(key: K, value: EditForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (error?.field === key) setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (locked) return;
    const next: EditForm = { ...form, amount: amountText.trim() === '' ? Number.NaN : Number(amountText) };
    const invalid = validateEditForm(next, expense);
    if (invalid) {
      setError(invalid);
      fieldRefs.current[invalid.field]?.focus();
      return;
    }
    const changes = buildEditUpdate(next, expense);
    if (!hasEditChanges(changes)) {
      onCancel();
      return;
    }
    setSaving(true);
    const ok = await onSave(changes);
    if (!ok) setSaving(false);
  };

  const invalidProps = (field: EditKey) =>
    error?.field === field ? { 'aria-invalid': true as const, 'aria-describedby': ids.error } : {};

  return (
    <form onSubmit={submit} noValidate className="pb-1">
      <Field label={T.edit.description} htmlFor={ids.description} className="mt-1">
        <input
          id={ids.description}
          ref={(el) => {
            fieldRefs.current.description = el;
          }}
          type="text"
          name="description"
          value={form.description}
          disabled={locked}
          onChange={(e) => update('description', e.target.value)}
          className={FIELD}
          {...invalidProps('description')}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={T.edit.amount} htmlFor={ids.amount}>
          <span className={cx('kb-field flex h-12 items-center gap-1.5 rounded-xl px-3', (locked || settled) && 'opacity-60')}>
            <span className="text-[15px] text-ink-4">¥</span>
            <input
              id={ids.amount}
              ref={(el) => {
                fieldRefs.current.amount = el;
              }}
              type="number"
              inputMode="numeric"
              name="amount"
              min={0}
              value={amountText}
              disabled={locked || settled}
              onChange={(e) => {
                setAmountText(e.target.value);
                if (error?.field === 'amount') setError(null);
              }}
              className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none"
              {...invalidProps('amount')}
            />
          </span>
        </Field>
        <Field label={T.edit.date} htmlFor={ids.date}>
          <input
            id={ids.date}
            ref={(el) => {
              fieldRefs.current.date = el;
            }}
            type="date"
            name="date"
            value={form.date}
            disabled={locked || settled}
            onChange={(e) => update('date', e.target.value)}
            className={FIELD}
            {...invalidProps('date')}
          />
        </Field>
      </div>

      <Field label={T.edit.category} htmlFor={ids.category}>
        <select
          id={ids.category}
          ref={(el) => {
            fieldRefs.current.category = el;
          }}
          name="category"
          value={form.category}
          disabled={locked}
          onChange={(e) => update('category', e.target.value)}
          className={FIELD}
          {...invalidProps('category')}
        >
          {categoryOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>

      <Field label={T.edit.payer} htmlFor={ids.payer}>
        <select
          id={ids.payer}
          ref={(el) => {
            fieldRefs.current.payerId = el;
          }}
          name="payerId"
          value={form.payerId}
          disabled={locked || settled}
          onChange={(e) => {
            const value = e.target.value;
            setForm((prev) => ({
              ...prev,
              payerId: value,
              payerDisplayName: payerDisplayNameFor(value, availableMembers, expenses),
            }));
            if (error?.field === 'payerId') setError(null);
          }}
          className={FIELD}
          {...invalidProps('payerId')}
        >
          {payerOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="mt-5 flex min-h-[60px] items-center gap-4 rounded-2xl kb-glass-2 px-4">
        <span id={ids.include} className="min-w-0 flex-1 truncate text-kb-row text-ink">
          {T.edit.include}
        </span>
        <Switch
          checked={form.includeInTotal}
          onChange={(next) => update('includeInTotal', next)}
          disabled={locked}
          labelledBy={ids.include}
        />
      </div>

      <div className="sticky bottom-0 z-10 -mx-1 mt-4 bg-gradient-to-t from-[var(--kb-card)] from-70% to-transparent px-1 pb-1 pt-3">
        {error && (
          <p id={ids.error} role="alert" className="mb-2 px-1 text-[14px] font-medium text-danger">
            {error.message}
          </p>
        )}
        <div className="flex gap-3">
          <PrimaryButton type="submit" height={56} icon={CircleCheck} loading={saving} disabled={!canWrite} className="flex-1">
            {T.edit.save}
          </PrimaryButton>
          <PrimaryButton
            type="button"
            variant="soft"
            height={56}
            icon={X}
            onClick={onCancel}
            disabled={saving}
            className="!w-auto shrink-0 !px-6"
          >
            {T.edit.cancel}
          </PrimaryButton>
        </div>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
  className = 'mt-4',
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 block px-1 text-[14px] font-semibold text-ink-3">
        {label}
      </label>
      {children}
    </div>
  );
}
