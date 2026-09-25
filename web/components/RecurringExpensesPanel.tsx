'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, Pencil, Trash2, Repeat } from 'lucide-react';
import { useUserGroups } from '../lib/hooks';
import { getCategoryVisual } from '../lib/categoryVisuals';
import { CANONICAL_CATEGORIES } from '../lib/categoryNormalization';
import {
  createRecurring,
  dayLabel,
  deleteRecurring,
  listRecurring,
  recurringErrorMessage,
  updateRecurring,
  type RecurringInput,
  type RecurringItem,
  type RecurringMember,
} from '../lib/recurringApi';

const INPUT =
  'w-full rounded-lg border border-line bg-card px-3 py-2 text-base text-fg focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';

interface Draft {
  name: string;
  amount: string;
  category: string;
  dayOfMonth: number;
  payment: 'shared' | 'advance';
  payerLineId: string;
}

function emptyDraft(me: string): Draft {
  return { name: '', amount: '', category: '住居費', dayOfMonth: 27, payment: 'advance', payerLineId: me };
}

function toDraft(item: RecurringItem, me: string): Draft {
  return {
    name: item.name,
    amount: String(item.amount),
    category: item.category,
    dayOfMonth: item.dayOfMonth,
    payment: item.payment,
    payerLineId: item.payerLineId ?? me,
  };
}

/** 入力を API に送る形にする（不正なら文を返す） */
function toInput(draft: Draft, active: boolean): RecurringInput | string {
  const name = draft.name.trim();
  if (!name) return '名前を入力してください';
  if (Array.from(name).length > 40) return '名前は40文字以内で入力してください';
  const amount = Number(draft.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 10_000_000) return '金額は1円以上の整数で入力してください';
  if (draft.payment === 'advance' && !draft.payerLineId) return '立て替える人を選んでください';
  return {
    name,
    amount,
    category: draft.category,
    dayOfMonth: draft.dayOfMonth,
    payment: draft.payment,
    payerLineId: draft.payment === 'advance' ? draft.payerLineId : null,
    active,
  };
}

/**
 * 設定の「固定費」タブ。家賃・光熱費など、引き落としで LINE に記録されない毎月の支出を登録する。
 * 引き落とし日の朝に、設定した金額で明細へ自動で入る（光熱費は請求が確定したら明細の金額を直す）。
 */
export default function RecurringExpensesPanel({ lineId }: { lineId: string }) {
  const { groups, loading: groupsLoading } = useUserGroups(lineId);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [items, setItems] = useState<RecurringItem[]>([]);
  const [members, setMembers] = useState<RecurringMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 編集中の項目（'new' は追加）
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(lineId));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // 選んだ世帯（未選択なら最初の世帯）
  const activeGroupId = groupId ?? groups[0]?.id ?? null;

  useEffect(() => {
    if (!activeGroupId) return;
    let cancelled = false;
    listRecurring(activeGroupId)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setMembers(res.members);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(recurringErrorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeGroupId]);

  const memberName = (id: string | null) => {
    if (!id) return '';
    const m = members.find((x) => x.lineId === id);
    if (!m) return '（メンバー外）';
    return m.lineId === lineId ? `${m.displayName || '自分'}（自分）` : m.displayName || 'メンバー';
  };

  const startNew = () => {
    setEditing('new');
    setDraft(emptyDraft(members.some((m) => m.lineId === lineId) ? lineId : members[0]?.lineId ?? ''));
    setNotice(null);
    setError(null);
  };

  const startEdit = (item: RecurringItem) => {
    setEditing(item.id);
    setDraft(toDraft(item, lineId));
    setNotice(null);
    setError(null);
  };

  const save = async () => {
    if (!activeGroupId || !editing) return;
    const current = editing === 'new' ? null : items.find((i) => i.id === editing) ?? null;
    const input = toInput(draft, current?.active ?? true);
    if (typeof input === 'string') {
      setError(input);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (current) {
        const saved = await updateRecurring(current.id, input);
        setItems((prev) => prev.map((i) => (i.id === saved.id ? saved : i)));
        setNotice(`「${saved.name}」を更新しました`);
      } else {
        const saved = await createRecurring(activeGroupId, input);
        setItems((prev) => [...prev, saved].sort((a, b) => a.dayOfMonth - b.dayOfMonth));
        setNotice(`「${saved.name}」を登録しました。${dayLabel(saved.dayOfMonth).replace('毎月', '')}の朝に明細へ入ります`);
      }
      setEditing(null);
    } catch (e) {
      setError(recurringErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (item: RecurringItem) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await updateRecurring(item.id, { active: !item.active });
      setItems((prev) => prev.map((i) => (i.id === saved.id ? saved : i)));
      setNotice(
        saved.active
          ? `「${saved.name}」を再開しました。今月の引き落とし日を過ぎている場合は来月から入ります`
          : `「${saved.name}」を一時停止しました`
      );
    } catch (e) {
      setError(recurringErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: RecurringItem) => {
    setBusy(true);
    setError(null);
    try {
      await deleteRecurring(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setConfirmDelete(null);
      setNotice(`「${item.name}」を削除しました（入力済みの明細は残ります）`);
    } catch (e) {
      setError(recurringErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (groupsLoading || (activeGroupId && loading)) {
    return (
      <div className="glass rounded-2xl shadow-glass p-8 text-center">
        <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (!activeGroupId) {
    return (
      <div className="glass rounded-2xl shadow-glass p-5">
        <h3 className="text-sm font-semibold text-fg">固定費</h3>
        <p className="mt-2 text-sm text-muted">世帯（LINEグループ）に参加すると固定費を登録できます</p>
      </div>
    );
  }

  const total = items.filter((i) => i.active).reduce((sum, i) => sum + i.amount, 0);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      {groups.length > 1 && (
        <div className="glass rounded-2xl shadow-glass p-4">
          <label className="mb-2 block text-sm font-medium text-fg">世帯</label>
          <select
            value={activeGroupId}
            onChange={(e) => {
              setLoading(true);
              setItems([]);
              setMembers([]);
              setEditing(null);
              setGroupId(e.target.value);
            }}
            className={INPUT}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {(error || notice) && (
        <div
          role={error ? 'alert' : 'status'}
          className={`rounded-xl p-3 text-sm ${
            error
              ? 'border border-rose-500/20 bg-rose-500/12 text-rose-700 dark:text-rose-300'
              : 'border border-emerald-500/20 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
          }`}
        >
          {error || notice}
        </div>
      )}

      <div className="glass rounded-2xl shadow-glass p-5">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fg">固定費</h3>
          <span className="text-xs text-muted">毎月の合計: ¥{total.toLocaleString()}</span>
        </div>
        <p className="mb-4 text-xs text-muted">
          引き落とし日の朝に、設定した金額で明細へ自動で入ります。光熱費など金額が変わるものは、請求が確定したら明細の金額を直してください。29〜30日の指定は、その日が無い月は末日に入ります。カードの利用通知メールで自動登録される支出は、二重になるので登録しないでください。
        </p>

        {items.length === 0 && editing !== 'new' && (
          <p className="rounded-xl border border-dashed border-line p-4 text-center text-sm text-muted">
            まだ登録されていません（例: 家賃・電気代・ガス代・水道代）
          </p>
        )}

        <ul className="space-y-2">
          {items.map((item) => {
            const v = getCategoryVisual(item.category);
            const Icon = v.icon;
            if (editing === item.id) {
              return (
                <li key={item.id}>
                  <DraftForm
                    draft={draft}
                    setDraft={setDraft}
                    members={members}
                    lineId={lineId}
                    busy={busy}
                    onSave={save}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              );
            }
            return (
              <li
                key={item.id}
                className={`rounded-xl border border-line p-3 transition-opacity ${item.active ? '' : 'opacity-55'}`}
              >
                <div className="flex items-center gap-3">
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${v.bg} ${v.fg}`}>
                    <Icon className="h-4 w-4" strokeWidth={2.1} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{item.name}</p>
                    <p className="truncate text-xs text-muted">
                      {dayLabel(item.dayOfMonth)}・
                      {item.payment === 'shared' ? '共通のカード・口座' : `${memberName(item.payerLineId)}が立替`}
                      {!item.active && '・停止中'}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-bold text-fg">¥{item.amount.toLocaleString()}</span>
                </div>
                <div className="mt-2 flex items-center justify-end gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => toggleActive(item)}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-fg/5 hover:text-fg disabled:opacity-50"
                  >
                    {item.active ? '一時停止' : '再開'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => startEdit(item)}
                    className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    編集
                  </button>
                  {confirmDelete === item.id ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDelete(null)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-fg/5"
                      >
                        やめる
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove(item)}
                        className="rounded-lg bg-rose-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                      >
                        削除する
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmDelete(item.id)}
                      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-500/10 disabled:opacity-50 dark:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      削除
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {editing === 'new' ? (
          <div className="mt-3">
            <DraftForm
              draft={draft}
              setDraft={setDraft}
              members={members}
              lineId={lineId}
              busy={busy}
              onSave={save}
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={startNew}
            disabled={busy || editing !== null}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-accent/40 py-2.5 text-sm font-medium text-accent transition-colors hover:bg-accent/[0.06] disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            固定費を追加
          </button>
        )}
      </div>
    </motion.div>
  );
}

function DraftForm({
  draft,
  setDraft,
  members,
  lineId,
  busy,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  members: RecurringMember[];
  lineId: string;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      className="space-y-3 rounded-xl bg-accent/[0.06] p-4"
    >
      <div>
        <label className="mb-1.5 block text-sm font-medium text-fg">名前</label>
        <input
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          maxLength={40}
          placeholder="例: 家賃"
          className={INPUT}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-fg">金額（見込み）</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">¥</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={draft.amount}
              onChange={(e) => set('amount', e.target.value)}
              className={`${INPUT} pl-7`}
            />
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-fg">引き落とし日</label>
          <select value={draft.dayOfMonth} onChange={(e) => set('dayOfMonth', Number(e.target.value))} className={INPUT}>
            {Array.from({ length: 30 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                毎月{d}日
              </option>
            ))}
            <option value={31}>毎月末日</option>
          </select>
        </div>
      </div>
      <div>
        <label className="mb-1.5 block text-sm font-medium text-fg">カテゴリ</label>
        <select value={draft.category} onChange={(e) => set('category', e.target.value)} className={INPUT}>
          {CANONICAL_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className="mb-1.5 block text-sm font-medium text-fg">引き落とし元</legend>
        <div className="space-y-2">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-card p-3">
            <input
              type="radio"
              name="payment"
              checked={draft.payment === 'advance'}
              onChange={() => set('payment', 'advance')}
              className="mt-0.5 h-4 w-4 accent-accent"
            />
            <span className="text-sm text-fg">
              個人の口座（立替）
              <span className="block text-xs text-muted">精算のときに相手が半分を払います（例: 家賃）</span>
            </span>
          </label>
          {draft.payment === 'advance' && (
            <select
              value={draft.payerLineId}
              onChange={(e) => set('payerLineId', e.target.value)}
              aria-label="立て替える人"
              className={INPUT}
            >
              {members.map((m) => (
                <option key={m.lineId} value={m.lineId}>
                  {m.lineId === lineId ? `${m.displayName || '自分'}（自分）` : m.displayName || 'メンバー'}
                </option>
              ))}
            </select>
          )}
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-card p-3">
            <input
              type="radio"
              name="payment"
              checked={draft.payment === 'shared'}
              onChange={() => set('payment', 'shared')}
              className="mt-0.5 h-4 w-4 accent-accent"
            />
            <span className="text-sm text-fg">
              共通のカード・口座
              <span className="block text-xs text-muted">共同費として予算に入ります（例: 光熱費）</span>
            </span>
          </label>
        </div>
      </fieldset>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="flex-1 rounded-xl border border-line bg-card py-2.5 text-sm font-medium text-fg hover:bg-fg/5 disabled:opacity-50"
        >
          キャンセル
        </button>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent py-2.5 text-sm font-medium text-accent-fg shadow-sm hover:opacity-90 disabled:opacity-50"
        >
          <Repeat className="h-4 w-4" />
          {busy ? '保存中...' : '保存'}
        </button>
      </div>
    </form>
  );
}
