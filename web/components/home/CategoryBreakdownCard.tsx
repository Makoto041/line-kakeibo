'use client';

// ホームのカテゴリ別 / 支払い者別カード。行をタップすると内訳シート（DrillSheet）で明細まで潜れる。
import React, { useMemo, useState } from 'react';
import { ChevronRight, CreditCard, Landmark, PieChart as PieChartIcon, User } from 'lucide-react';
import { GlassCard } from './GlassCard';
import { BreakdownRow, Segmented, type DrillView } from '../drilldown/DrillSheet';
import { getCategoryVisual } from '../../lib/categoryVisuals';
import { yen } from '../../lib/money';
import {
  CARD_PAYER_NAME,
  SHARED_PAYER_NAME,
  deltaPct,
  groupDrill,
  payerColor,
  sharePct,
  sumAmount,
  type DrillDim,
  type DrillItem,
} from '../../lib/drilldown';

const TOP = 6;
export const TOTAL_VIEW: DrillView = { kind: 'set', title: '期間の合計', filter: {} };

export function CategoryBreakdownCard({
  items,
  prevCategoryTotals,
  loading,
  partial = false,
  onOpen,
}: {
  items: readonly DrillItem[];
  /** 前の期間のカテゴリ別合計（前期比） */
  prevCategoryTotals: Record<string, number> | null;
  loading: boolean;
  /** 期間の明細の一部だけで数えている（長い固定期間・件数が多い） */
  partial?: boolean;
  onOpen: (views: DrillView[]) => void;
}) {
  const [dim, setDim] = useState<DrillDim>('category');
  const [showAll, setShowAll] = useState(false);
  const included = useMemo(() => items.filter((i) => i.included), [items]);
  const total = sumAmount(included);
  const groups = useMemo(() => groupDrill(included, dim), [included, dim]);
  const people = useMemo(
    () => groupDrill(included, 'payer').filter((g) => g.label !== CARD_PAYER_NAME && g.label !== SHARED_PAYER_NAME),
    [included]
  );
  const colorOf = (key: string, label: string) => {
    if (dim === 'category') return getCategoryVisual(key).hex;
    const index = people.findIndex((p) => p.key === key);
    return payerColor(label, index < 0 ? 0 : index);
  };
  const shown = showAll ? groups : groups.slice(0, TOP);

  return (
    <GlassCard className="p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
          <PieChartIcon className="h-[18px] w-[18px] text-accent" strokeWidth={2.2} />
          {dim === 'category' ? 'カテゴリ別' : '支払い者別'}
        </h2>
        <Segmented
          label="集計の切り替え"
          value={dim}
          options={[
            { value: 'category', label: 'カテゴリ' },
            { value: 'payer', label: '支払い者' },
          ]}
          onChange={(d) => {
            setDim(d);
            setShowAll(false);
          }}
        />
      </div>

      {loading && included.length === 0 ? (
        <div className="py-10 text-center">
          <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onOpen([TOTAL_VIEW])}
            className="mt-3 flex w-full items-center justify-between rounded-xl bg-fg/[0.03] px-3 py-2 text-left hover:bg-fg/5"
          >
            <span className="text-xs text-muted">
              合計（{included.length}件）<b className="ml-1 text-sm font-bold tabular-nums text-fg">{yen(total)}</b>
            </span>
            <span className="inline-flex items-center text-xs font-medium text-accent">
              内訳を見る
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </button>

          {/* 割合の帯 */}
          <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
            {groups.map((g) => (
              <span key={g.key} className="block h-full" style={{ flex: g.total, background: colorOf(g.key, g.label) }} />
            ))}
          </div>

          <ul className="mt-2">
            {shown.map((g) => {
              const isCategory = dim === 'category';
              const delta = isCategory && prevCategoryTotals ? deltaPct(g.total, prevCategoryTotals[g.key]) : null;
              const note = isCategory
                ? prevCategoryTotals
                  ? delta === null
                    ? '前期 なし'
                    : delta === 0
                    ? '前期と同じ'
                    : `${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}%`
                  : `${sharePct(g.total, total)}%`
                : `${sharePct(g.total, total)}%`;
              const noteTone =
                delta && delta > 0 ? 'text-rose-600 dark:text-rose-400' : delta && delta < 0 ? 'text-emerald-600 dark:text-emerald-400' : undefined;
              const next: DrillView = isCategory
                ? { kind: 'set', title: g.label, filter: { category: g.key } }
                : { kind: 'set', title: `${g.label}の支払い`, filter: { payers: [g.key] } };
              return (
                <li key={g.key} className="border-b border-line last:border-0">
                  <BreakdownRow
                    icon={isCategory ? getCategoryVisual(g.key).icon : g.label === CARD_PAYER_NAME ? CreditCard : g.label === SHARED_PAYER_NAME ? Landmark : User}
                    color={colorOf(g.key, g.label)}
                    label={g.label}
                    count={g.count}
                    amount={g.total}
                    share={sharePct(g.total, total)}
                    note={note}
                    noteTone={noteTone}
                    onClick={() => onOpen([TOTAL_VIEW, next])}
                  />
                </li>
              );
            })}
          </ul>
          {partial && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              期間が長いか件数が多いため、一部の支出だけで集計しています（上の合計と合わないことがあります）
            </p>
          )}
          {groups.length > TOP && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-1 w-full rounded-xl py-2 text-center text-xs font-medium text-accent hover:bg-fg/5"
            >
              {showAll ? `上位 ${TOP} 件だけ表示` : `すべて表示（${groups.length}）`}
            </button>
          )}
        </>
      )}
    </GlassCard>
  );
}
