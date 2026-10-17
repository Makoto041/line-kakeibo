'use client';

// 内訳シート: 合計 → カテゴリ / 支払い者 → 明細 と潜っていく（モバイル: 下からのシート / デスクトップ: 右のドロワー）。
// ホームのカテゴリ別カードと、精算の期間の精算（折半）の金額から開く。計算は lib/drilldown.ts。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import dayjs from 'dayjs';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  CreditCard,
  Landmark,
  Layers,
  List,
  Pencil,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import BodyPortal from '../BodyPortal';
import { getCategoryVisual } from '../../lib/categoryVisuals';
import { yen } from '../../lib/money';
import { splitChip } from '../../lib/expenseState';
import {
  CARD_PAYER_NAME,
  SHARED_PAYER_NAME,
  deltaPct,
  groupDrill,
  inputSourceLabel,
  matchesDrill,
  payerColor,
  resolveDim,
  availableDims,
  sharePct,
  sortDrillItems,
  sumAmount,
  weeklyTotals,
  type DrillDim,
  type DrillFilter,
  type DrillItem,
  type DrillRange,
  type DrillSort,
} from '../../lib/drilldown';

export type DrillView =
  | { kind: 'set'; title: string; filter: DrillFilter; dim?: DrillDim }
  | { kind: 'item'; title: string; id: string };

interface Props {
  /** 開いたときの階層（パンくずの先頭から）。閉じている間はこの部品を描かない */
  initial: DrillView[];
  items: readonly DrillItem[];
  range: DrillRange;
  /** 前の期間のカテゴリ別合計（前期比を出す。無ければ出さない） */
  prevCategoryTotals?: Record<string, number> | null;
  /** 支出一覧への遷移先（カテゴリ・期間で絞る）。null なら出さない */
  listHref?: (filter: DrillFilter) => string | null;
  /** 明細の編集画面。null なら出さない（ゲストなど） */
  editHref?: (id: string) => string | null;
  onClose: () => void;
}

const SPLIT_LABEL = { shared: '共同費', personal: '個人（除外）', advance: '立替', settled: '立替（精算済み）' };

/** 描画のたびに選ぶアイコン（変数に入れたコンポーネントをそのまま描かない） */
function IconOf({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon className={className} strokeWidth={2.1} />;
}

function payerIcon(name: string): LucideIcon {
  if (name === CARD_PAYER_NAME) return CreditCard;
  if (name === SHARED_PAYER_NAME) return Landmark;
  return User;
}

export default function DrillSheet({ initial, items, range, prevCategoryTotals, listHref, editHref, onClose }: Props) {
  const [stack, setStack] = useState<DrillView[]>(initial);
  // 階層ごとの内訳の軸（カテゴリ / 支払い者）
  const [dims, setDims] = useState<Record<number, DrillDim>>({});
  const [sort, setSort] = useState<DrillSort>('date');
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  // 呼び出し側が毎回新しい関数を渡しても、開いたときの処理（フォーカスの移動など）をやり直さない
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const depth = stack.length - 1;
  const view = stack[depth];

  // 開いている間は背面をスクロールさせない。Esc で閉じ、Tab はシートの中だけを回り、閉じたら元の場所へフォーカスを戻す
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  // 階層を移ったら先頭から見せる
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    const crumbs = crumbsRef.current;
    if (crumbs) crumbs.scrollLeft = crumbs.scrollWidth;
  }, [stack]);

  // 支払い者の色（カード・共通口座は決まった色、人は金額の多い順）
  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    groupDrill(
      items.filter((i) => i.included),
      'payer'
    )
      .filter((g) => g.label !== CARD_PAYER_NAME && g.label !== SHARED_PAYER_NAME)
      .forEach((g, index) => map.set(g.key, payerColor(g.label, index)));
    return (key: string, label: string) => map.get(key) ?? payerColor(label, map.size);
  }, [items]);

  const push = (next: DrillView) => setStack((s) => [...s, next]);
  const goTo = (index: number) => setStack((s) => s.slice(0, index + 1));

  // 精算のカード（.glass）の中から開いても画面全体を覆うよう、body 直下に描く
  return (
    <BodyPortal>
      <div className="fixed inset-0 z-50 flex pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]" role="dialog" aria-modal="true" aria-labelledby="drill-title">
        {/* 背景のタップで閉じる（キーボードでは右上の閉じるボタンを使う） */}
        <button type="button" tabIndex={-1} aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
        {/* 透けると背面が重なって読みにくいので不透明にする。高さは iOS のツールバーを除いた dvh で測る */}
        <div ref={panelRef} className="relative z-10 ml-auto flex w-full animate-fade-up flex-col border border-line/60 bg-card shadow-glass-lg max-sm:mt-auto max-sm:max-h-[88dvh] max-sm:rounded-t-2xl sm:h-full sm:max-w-md sm:rounded-l-2xl">
          <div className="flex items-center gap-1 border-b border-line px-2 py-2">
            <button
              type="button"
              onClick={() => goTo(depth - 1)}
              aria-label="戻る"
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-fg/5 hover:text-fg ${depth > 0 ? '' : 'invisible'}`}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <nav ref={crumbsRef} aria-label="内訳の階層" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap text-xs">
              {stack.map((s, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted" />}
                  <button
                    type="button"
                    onClick={() => goTo(i)}
                    aria-current={i === depth ? 'page' : undefined}
                    className={`rounded-md px-1.5 py-1 ${i === depth ? 'font-semibold text-fg' : 'text-muted hover:bg-fg/5'}`}
                  >
                    {s.kind === 'item' ? '明細' : s.title}
                  </button>
                </React.Fragment>
              ))}
            </nav>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="閉じる"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-fg/5 hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div ref={bodyRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-4">
            {view.kind === 'item' ? (
              <ItemView item={items.find((i) => i.id === view.id)} editHref={editHref} colorOf={colorOf} />
            ) : (
              <SetView
                view={view}
                items={items}
                range={range}
                prevCategoryTotals={prevCategoryTotals}
                dim={dims[depth]}
                onDim={(d) => setDims((m) => ({ ...m, [depth]: d }))}
                sort={sort}
                onSort={setSort}
                onPush={push}
                listHref={listHref}
                colorOf={colorOf}
              />
            )}
          </div>
        </div>
      </div>
    </BodyPortal>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-0.5 rounded-lg bg-fg/5 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${value === o.value ? 'bg-card text-fg shadow-sm' : 'text-muted hover:text-fg'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export { Segmented };

function SetView({
  view,
  items,
  range,
  prevCategoryTotals,
  dim: preferredDim,
  onDim,
  sort,
  onSort,
  onPush,
  listHref,
  colorOf,
}: {
  view: Extract<DrillView, { kind: 'set' }>;
  items: readonly DrillItem[];
  range: DrillRange;
  prevCategoryTotals?: Record<string, number> | null;
  dim?: DrillDim;
  onDim: (d: DrillDim) => void;
  sort: DrillSort;
  onSort: (s: DrillSort) => void;
  onPush: (v: DrillView) => void;
  listHref?: (filter: DrillFilter) => string | null;
  colorOf: (key: string, label: string) => string;
}) {
  const { filter } = view;
  const all = items.filter((i) => matchesDrill(i, filter));
  const included = all.filter((i) => i.included);
  const excluded = all.filter((i) => !i.included);
  const total = sumAmount(included);
  const grandTotal = sumAmount(items.filter((i) => i.included));
  const dims = availableDims(included, filter);
  const dim = resolveDim(included, filter, preferredDim ?? view.dim);
  const groups = dim ? groupDrill(included, dim) : [];
  const singlePayer = filter.payers && filter.payers.length === 1 ? included.find((i) => i.payerKey === filter.payers![0]) : undefined;

  let heroIcon: LucideIcon = Layers;
  let heroColor = '#10b981';
  if (filter.category !== undefined) {
    const v = getCategoryVisual(filter.category);
    heroIcon = v.icon;
    heroColor = v.hex;
  } else if (singlePayer) {
    heroIcon = payerIcon(singlePayer.payerName);
    heroColor = colorOf(singlePayer.payerKey, singlePayer.payerName);
  }
  const prev = filter.category !== undefined && !filter.payers ? prevCategoryTotals?.[filter.category] : undefined;
  const delta = filter.category !== undefined && !filter.payers && prevCategoryTotals ? deltaPct(total, prev) : null;
  const href = listHref?.(filter) ?? null;

  return (
    <>
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ color: heroColor, background: `${heroColor}22` }}>
          <IconOf icon={heroIcon} className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 id="drill-title" className="truncate text-sm font-semibold text-fg">{view.title}</h2>
          <p className="text-2xl font-black tabular-nums text-fg">{yen(total)}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[11px] text-muted">
        <span className="rounded-full bg-fg/5 px-2 py-0.5"><b className="font-semibold text-fg">{included.length}</b>件</span>
        {(filter.category !== undefined || filter.payers) && (
          <span className="rounded-full bg-fg/5 px-2 py-0.5">合計の <b className="font-semibold text-fg">{sharePct(total, grandTotal)}%</b></span>
        )}
        {filter.category !== undefined && !filter.payers && prevCategoryTotals && (
          <span className="rounded-full bg-fg/5 px-2 py-0.5">
            前期 <b className="font-semibold text-fg">{prev ? yen(prev) : 'なし'}</b>
            {delta !== null && delta !== 0 && (
              <span className={delta > 0 ? 'ml-1 text-rose-600 dark:text-rose-400' : 'ml-1 text-emerald-600 dark:text-emerald-400'}>
                {delta > 0 ? '▲' : '▼'}{Math.abs(delta)}%
              </span>
            )}
          </span>
        )}
        {included.length > 0 && (
          <span className="rounded-full bg-fg/5 px-2 py-0.5">1件平均 <b className="font-semibold text-fg">{yen(Math.round(total / included.length))}</b></span>
        )}
      </div>

      {filter.category !== undefined && included.length > 0 && <Weeks items={included} range={range} color={heroColor} />}

      {dim && (
        <section>
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-muted">内訳</h3>
            {dims.category && dims.payer && (
              <Segmented
                label="内訳の切り替え"
                value={dim}
                options={[
                  { value: 'category', label: 'カテゴリ' },
                  { value: 'payer', label: '支払い者' },
                ]}
                onChange={onDim}
              />
            )}
          </div>
          <ul>
            {groups.map((g) => {
              const isCategory = dim === 'category';
              const v = isCategory ? getCategoryVisual(g.key) : null;
              const color = isCategory ? v!.hex : colorOf(g.key, g.label);
              const Icon = isCategory ? v!.icon : payerIcon(g.label);
              const payerTitle = singlePayer?.payerName;
              const next: DrillView = isCategory
                ? { kind: 'set', title: payerTitle ? `${payerTitle}・${g.label}` : g.label, filter: { ...filter, category: g.key } }
                : {
                    kind: 'set',
                    title: filter.category !== undefined ? `${filter.category}・${g.label}` : `${g.label}の支払い`,
                    filter: { ...filter, payers: [g.key] },
                  };
              return (
                <li key={g.key} className="border-b border-line last:border-0">
                  <BreakdownRow
                    icon={Icon}
                    color={color}
                    label={g.label}
                    count={g.count}
                    amount={g.total}
                    share={sharePct(g.total, total)}
                    note={`${sharePct(g.total, total)}%`}
                    onClick={() => onPush(next)}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-muted">明細</h3>
          {included.length > 1 && (
            <Segmented
              label="並び"
              value={sort}
              options={[
                { value: 'date', label: '日付順' },
                { value: 'amount', label: '金額順' },
              ]}
              onChange={onSort}
            />
          )}
        </div>
        {included.length === 0 ? (
          <p className="rounded-xl bg-fg/[0.03] p-4 text-center text-sm text-muted">この条件の支出はありません</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {sortDrillItems(included, sort).map((item) => (
              <li key={item.id}>
                <ItemRow item={item} color={colorOf(item.payerKey, item.payerName)} onClick={() => onPush({ kind: 'item', title: item.description, id: item.id })} />
              </li>
            ))}
          </ul>
        )}
        {excluded.length > 0 && (
          <p className="mt-2 text-center text-[11px] text-muted">
            合計に含まない {excluded.length}件（{yen(sumAmount(excluded))}）は数えていません
          </p>
        )}
      </section>

      {href && (
        <Link
          href={href}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-fg/5 py-3 text-sm font-medium text-fg hover:bg-fg/10"
        >
          <List className="h-4 w-4" />
          支出一覧で{filter.category !== undefined ? `「${filter.category}」を` : ''}開く
        </Link>
      )}
    </>
  );
}

export function BreakdownRow({
  icon: Icon,
  color,
  label,
  count,
  amount,
  share,
  note,
  noteTone,
  onClick,
}: {
  icon: LucideIcon;
  color: string;
  label: string;
  count: number;
  amount: number;
  /** バーの長さ（%） */
  share: number;
  note: string;
  noteTone?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="grid w-full grid-cols-[2rem_minmax(0,1fr)_auto_1rem] items-center gap-2.5 rounded-xl px-1.5 py-2.5 text-left hover:bg-fg/5">
      <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ color, background: `${color}22` }}>
        <IconOf icon={Icon} className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-medium text-fg">{label}</span>
          <span className="shrink-0 text-[11px] text-muted">{count}件</span>
        </span>
        <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-fg/10">
          <span className="block h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, share))}%`, background: color }} />
        </span>
      </span>
      <span className="text-right">
        <span className="block text-sm font-bold tabular-nums text-fg">{yen(amount)}</span>
        <span className={`block text-[11px] tabular-nums ${noteTone ?? 'text-muted'}`}>{note}</span>
      </span>
      <ChevronRight className="h-4 w-4 text-muted" />
    </button>
  );
}

function ItemRow({ item, color, onClick }: { item: DrillItem; color: string; onClick: () => void }) {
  const v = getCategoryVisual(item.category);
  const Icon = v.icon;
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-fg/[0.03]">
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${v.bg} ${v.fg}`}>
        <Icon className="h-4 w-4" strokeWidth={2.1} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fg">{item.description || item.category}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          {dayjs(item.date).format('M/D')}
          <span className="rounded px-1.5 py-px font-medium" style={{ color, background: `${color}1f` }}>{item.payerName}</span>
          {item.pending && (
            <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-px font-semibold text-amber-700 dark:text-amber-300">
              <Clock className="h-3 w-3" />
              要確認
            </span>
          )}
        </span>
      </span>
      <span className="shrink-0 text-sm font-semibold tabular-nums text-fg">{yen(item.amount)}</span>
    </button>
  );
}

function Weeks({ items, range, color }: { items: readonly DrillItem[]; range: DrillRange; color: string }) {
  const weeks = weeklyTotals(items, range);
  const max = Math.max(1, ...weeks.map((w) => w.total));
  if (weeks.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-muted">週ごと</h3>
      <div className="grid h-24 items-end gap-2" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks.map((w) => (
          <div key={w.start} className="flex h-full flex-col items-center justify-end gap-1" title={`${w.start}〜${w.end}: ${yen(w.total)}`}>
            <span className="text-[10px] font-medium tabular-nums text-fg">
              {w.total > 0 ? (w.total >= 10000 ? `${(w.total / 10000).toFixed(1)}万` : w.total.toLocaleString('ja-JP')) : ''}
            </span>
            <span className="block w-3/4 max-w-[2rem] rounded-t-md rounded-b-sm" style={{ height: `${Math.max(3, Math.round((w.total / max) * 60))}px`, background: color }} />
            <span className="whitespace-nowrap text-[10px] text-muted">{dayjs(w.start).format('M/D')}〜</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ItemView({
  item,
  editHref,
  colorOf,
}: {
  item: DrillItem | undefined;
  editHref?: (id: string) => string | null;
  colorOf: (key: string, label: string) => string;
}) {
  if (!item) return <p className="text-sm text-muted">この支出は見つかりませんでした</p>;
  const v = getCategoryVisual(item.category);
  const Icon = v.icon;
  const href = editHref?.(item.id) ?? null;
  const color = colorOf(item.payerKey, item.payerName);
  return (
    <>
      <div className="flex items-center gap-3">
        <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${v.bg} ${v.fg}`}>
          <Icon className="h-5 w-5" strokeWidth={2.1} />
        </span>
        <div className="min-w-0">
          <h2 id="drill-title" className="truncate text-sm font-semibold text-fg">{item.description || item.category}</h2>
          <p className="text-2xl font-black tabular-nums text-fg">{yen(item.amount)}</p>
        </div>
      </div>
      {item.pending && (
        <p className="flex items-start gap-1.5 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
          <Clock className="mt-px h-3.5 w-3.5 shrink-0" />
          要確認です。LINE で手入力した支出は、確認するまで合計に入りません
        </p>
      )}
      <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line text-sm">
        {[
          ['日付', dayjs(item.date).format('YYYY/M/D')],
          ['カテゴリ', item.category],
          ['支払い者', <span key="p" style={{ color }}>{item.payerName}</span>],
          ['入力', inputSourceLabel(item.inputSource)],
          ['区分', item.pending ? '未確認' : SPLIT_LABEL[splitChip(item)]],
          ['合計', item.included ? '含む' : '含まない'],
        ].map(([label, value]) => (
          <div key={String(label)} className="flex justify-between gap-3 px-3.5 py-2.5">
            <dt className="text-muted">{label}</dt>
            <dd className="text-right font-medium text-fg">{value}</dd>
          </div>
        ))}
      </dl>
      {href && (
        <Link href={href} className="flex items-center justify-center gap-1.5 rounded-xl bg-accent py-3 text-sm font-medium text-accent-fg shadow-sm hover:opacity-90">
          <Pencil className="h-4 w-4" />
          この支出を編集
        </Link>
      )}
    </>
  );
}
