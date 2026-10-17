'use client';

// 精算タブの「以前の立替が残っています」のお知らせ。立替は期間の精算に全額を加算して返すようにした。
// それより前に「自分が立替」にした支出（advanceFull の無い advance_pending）が残っているときだけ出し、
// 精算済みにできるようにする（/household/legacy-advances/settle。どの期間の精算にも入らなくなる）。
import React, { useState } from 'react';
import { ChevronDown, Info, Loader2 } from 'lucide-react';
import { householdErrorCode, settleLegacyAdvances, type AdvancesResponse } from '../lib/householdApi';
import { advanceDateSpan, advanceItemMeta } from '../lib/leftoverAdvances';
import { getCategoryVisual } from '../lib/categoryVisuals';
import { yen } from '../lib/money';

interface Props {
  groupId: string;
  data: AdvancesResponse;
  /** 世帯のメンバー名（lineId → 表示名）。立替にした人の名前に使う */
  names: Readonly<Record<string, string>>;
  canSettle: boolean;
  /** 精算済みにできた（件数・飛ばした件数）。呼び出し側で一覧を空にし、ほかの画面のキャッシュも直す */
  onSettled: (ids: readonly string[], settled: number, skipped: number) => void;
  /** 表示が古かった（最新の一覧に差し替える） */
  onStale: (latest: AdvancesResponse) => void;
  onError: (text: string) => void;
}

function settleErrorMessage(error: unknown): string {
  switch (householdErrorCode(error)) {
    case 'forbidden':
      return 'この世帯の立替を変更する権限がありません';
    case 'nothing_to_settle':
      return '以前の立替はもうありません（ほかの端末で精算済みにした可能性があります）';
    case 'too_many':
      return '件数が多すぎるため、ここでは外せません';
    case 'rate_limited':
      return '操作が多すぎます。少し待ってからやり直してください';
    default:
      return '精算済みにできませんでした。時間をおいてやり直してください';
  }
}

export default function LeftoverAdvancesCard({ groupId, data, names, canSettle, onSettled, onStale, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [settling, setSettling] = useState(false);
  const count = data.items.length;
  const thisYear = new Date().getFullYear();
  const span = advanceDateSpan(data.items, thisYear);

  const settle = async () => {
    if (settling || !canSettle) return;
    setSettling(true);
    try {
      const outcome = await settleLegacyAdvances(groupId, data.expenseIds);
      if (outcome.ok) {
        onSettled(data.expenseIds, outcome.settled, outcome.skipped);
      } else {
        onStale(outcome.stale);
        setConfirming(false);
      }
    } catch (error) {
      console.error('Failed to settle legacy advances:', error);
      onError(settleErrorMessage(error));
      if (householdErrorCode(error) === 'nothing_to_settle') onStale({ ...data, items: [], expenseIds: [] });
    } finally {
      setSettling(false);
    }
  };

  return (
    <div className="glass rounded-2xl p-5 shadow-glass">
      <h2 className="flex items-start gap-1.5 text-sm font-semibold text-fg">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        以前の「立替」が{count}件残っています
      </h2>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        {span ? `${span}の、` : ''}
        立替を全額で精算するようにする前の支出です。精算が済んでいれば、精算済みにしてください（どの期間の精算にも入らなくなります）。
      </p>

      {open && (
        <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
          {data.items.map((item) => {
            const v = getCategoryVisual(item.category);
            const Icon = v.icon;
            const meta = advanceItemMeta(item, names, thisYear);
            return (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${v.bg} ${v.fg}`}>
                  <Icon className="h-3.5 w-3.5" strokeWidth={2.1} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg">{item.description || item.category || '支出'}</p>
                  {meta && <p className="truncate text-xs text-muted">{meta}</p>}
                </div>
                <span className="shrink-0 text-sm font-medium tabular-nums text-fg">{yen(item.amount)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {confirming ? (
        <div className="mt-4 rounded-xl border border-accent/25 bg-accent/[0.06] p-4">
          <p className="text-sm text-fg">{count}件を精算済みにします。どの期間の精算（折半）にも入らなくなります。</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={settling}
              onClick={() => setConfirming(false)}
              className="flex-1 rounded-xl border border-line bg-card py-2.5 text-sm font-medium text-fg hover:bg-fg/5 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={settling || !canSettle}
              onClick={settle}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent py-2.5 text-sm font-medium text-accent-fg shadow-sm hover:opacity-90 disabled:opacity-50"
            >
              {settling && <Loader2 className="h-4 w-4 animate-spin" />}
              精算済みにする
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="inline-flex items-center justify-center gap-1 rounded-xl border border-line bg-card py-2.5 text-sm font-medium text-fg hover:bg-fg/5"
          >
            {open ? '閉じる' : `${count}件を見る`}
            <ChevronDown className={`h-4 w-4 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          <button
            type="button"
            disabled={!canSettle}
            onClick={() => setConfirming(true)}
            className="rounded-xl bg-accent py-2.5 text-sm font-medium text-accent-fg shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            精算済みにする
          </button>
        </div>
      )}
    </div>
  );
}
