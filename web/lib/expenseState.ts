// 明細の状態・並び・日付見出し・書き込み可否の純関数。
// node --test から直接読めるよう、他のモジュールからは型だけを import する（値の import は dayjs のみ）。
import dayjs from 'dayjs';
import type { Expense } from './hooks';

type ExpenseFields = Partial<Omit<Expense, 'id'>>;

/** Gmail 自動取込の支出の lineId（bot/src/gmail/handler.ts と同じ） */
export const GMAIL_SYSTEM_LINE_ID = 'gmail-auto-system';

// ---- 状態 ------------------------------------------------------------------

/** 要確認: status が無い / pending で、確認済みフラグが立っていない（bot の OK と同じ判定） */
export function isPending(e: Pick<ExpenseFields, 'status' | 'confirmed'>): boolean {
  return (e.status == null || e.status === 'pending') && e.confirmed !== true;
}

/** 予算に計上されるか（useMonthlyStats の合計と同じ判定） */
export function isCounted(e: Pick<ExpenseFields, 'includeInTotal'>): boolean {
  return !!e.includeInTotal;
}

export function isAdvance(e: Pick<ExpenseFields, 'status'>): boolean {
  return e.status === 'advance_pending' || e.status === 'advance_settled';
}

export function isSettled(e: Pick<ExpenseFields, 'status'>): boolean {
  return e.status === 'advance_settled';
}

export type SplitChip = 'shared' | 'personal' | 'advance' | 'settled';

/** 負担区分のチップ（bot の deriveExpenseSettings と同じ分け方。未確認かどうかは別の表示で示す） */
export function splitChip(e: Pick<ExpenseFields, 'status'>): SplitChip {
  switch (e.status) {
    case 'personal':
      return 'personal';
    case 'advance_pending':
      return 'advance';
    case 'advance_settled':
      return 'settled';
    default:
      return 'shared';
  }
}

export function countPending(list: ReadonlyArray<Pick<ExpenseFields, 'status' | 'confirmed'>>): number {
  let n = 0;
  for (const e of list) if (isPending(e)) n += 1;
  return n;
}

// ---- 絞り込み ----------------------------------------------------------------

export type Segment = 'all' | 'pending' | 'advance';

export function parseSegment(value: string | null | undefined): Segment {
  return value === 'pending' || value === 'advance' ? value : 'all';
}

export function matchesSegment(
  e: Pick<ExpenseFields, 'status' | 'confirmed'>,
  segment: Segment
): boolean {
  if (segment === 'pending') return isPending(e);
  if (segment === 'advance') return isAdvance(e);
  return true;
}

function normalizeForSearch(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').toLowerCase();
}

/** 説明・カテゴリの部分一致（空白区切りはすべてを含むものだけ） */
export function matchesQuery(
  e: Pick<ExpenseFields, 'description' | 'category'>,
  query: string | null | undefined
): boolean {
  const terms = normalizeForSearch(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${normalizeForSearch(e.description)}\n${normalizeForSearch(e.category)}`;
  return terms.every((term) => haystack.includes(term));
}

// ---- 並び・日付見出し ----------------------------------------------------------

/**
 * Firestore の Timestamp / Date などをミリ秒にする。
 * 既存の並び（useExpenses）と同じく、seconds を持つものは秒単位で比べる。
 */
export function timestampToMillis(value: unknown): number {
  if (value == null) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }
  if (typeof value === 'object') {
    const o = value as { seconds?: unknown; toMillis?: unknown };
    if (typeof o.seconds === 'number') return o.seconds * 1000;
    if (typeof o.toMillis === 'function') return (o.toMillis as () => number)();
  }
  return 0;
}

export type SortKey = 'date' | 'amount';

/**
 * 一覧の並び。
 * - date: 日付の降順 → 登録日時の降順（既存の「日付降順・同日は取得順＝createdAt 降順」と同じ結果）
 * - amount: 金額の降順（同額は元の順）
 */
export function sortForList<E extends Pick<ExpenseFields, 'date' | 'createdAt' | 'amount'>>(
  list: readonly E[],
  sortBy: SortKey = 'date'
): E[] {
  return list
    .map((e, index) => ({ e, index }))
    .sort((a, b) => {
      if (sortBy === 'amount') {
        return (Number(b.e.amount) || 0) - (Number(a.e.amount) || 0) || a.index - b.index;
      }
      return (
        (b.e.date ?? '').localeCompare(a.e.date ?? '') ||
        timestampToMillis(b.e.createdAt) - timestampToMillis(a.e.createdAt) ||
        a.index - b.index
      );
    })
    .map(({ e }) => e);
}

export interface DateGroup<E> {
  date: string;
  items: E[];
}

/** 日付ごとにまとめる（見出しの順は最初に現れた順） */
export function groupByDate<E extends Pick<ExpenseFields, 'date'>>(list: readonly E[]): DateGroup<E>[] {
  const groups = new Map<string, E[]>();
  for (const e of list) {
    const key = e.date ?? '';
    const items = groups.get(key);
    if (items) items.push(e);
    else groups.set(key, [e]);
  }
  return Array.from(groups, ([date, items]) => ({ date, items }));
}

/** ホームの見出し: M月D日（年が違えば YYYY年M月D日） */
export function absoluteDateLabel(date: string, today: dayjs.ConfigType): string {
  const d = dayjs(date);
  if (!d.isValid()) return date;
  return d.year() === dayjs(today).year() ? d.format('M月D日') : d.format('YYYY年M月D日');
}

/** 明細の見出し: 今日 / 昨日 / M月D日（年が違えば YYYY年M月D日） */
export function relativeDateLabel(date: string, today: dayjs.ConfigType): string {
  const d = dayjs(date);
  if (!d.isValid()) return date;
  const t = dayjs(today);
  if (d.isSame(t, 'day')) return '今日';
  if (d.isSame(t.subtract(1, 'day'), 'day')) return '昨日';
  return absoluteDateLabel(date, t);
}

// ---- 書き込み可否 -------------------------------------------------------------
// master と PR #172 のどちらの firestore.rules でも通る条件（共通部分）。
// activeGroupIds が null のときは「所属がまだ分からない」: 画面では許可扱いにし、
// 最終判断はルール（拒否されたら元に戻す）に任せる。

type OwnershipFields = Pick<ExpenseFields, 'lineId' | 'groupId' | 'lineGroupId' | 'status'>;

/** 個人支出（groupId も lineGroupId も持たない） */
export function isPersonalExpense(e: Pick<ExpenseFields, 'groupId' | 'lineGroupId'>): boolean {
  return !e.groupId && !e.lineGroupId;
}

function isActiveMemberOf(groupId: string, activeGroupIds: readonly string[] | null): boolean {
  return activeGroupIds === null || activeGroupIds.includes(groupId);
}

/** 編集・計上トグルをクライアントから書けるか */
export function canClientWrite(
  e: OwnershipFields,
  me: string | null,
  activeGroupIds: readonly string[] | null
): boolean {
  if (!me) return false;
  if (isPersonalExpense(e)) return e.lineId === me;
  // lineGroupId だけを持つ旧形式は PR #172 のルールで書けない
  if (!e.groupId) return false;
  return isActiveMemberOf(e.groupId, activeGroupIds);
}

/** クライアントから削除できるか（精算済みは不可。グループ支出は本人か Gmail 取込分だけ） */
export function canClientDelete(
  e: OwnershipFields,
  me: string | null,
  activeGroupIds: readonly string[] | null
): boolean {
  if (!me || isSettled(e)) return false;
  if (isPersonalExpense(e)) return e.lineId === me;
  if (!e.groupId) return false;
  return (
    isActiveMemberOf(e.groupId, activeGroupIds) &&
    (e.lineId === me || e.lineId === GMAIL_SYSTEM_LINE_ID)
  );
}

/** 確認（サーバー経由）を出せるか。サーバーの認可と同じ条件で、最終判断はサーバー */
export function canServerConfirm(
  e: OwnershipFields,
  me: string | null,
  activeGroupIds: readonly string[] | null
): boolean {
  return canClientWrite(e, me, activeGroupIds);
}

// ---- 検索・絞り込み・集計（検索シート） -------------------------------------------
// 刷新前の明細にあったフィルタ（すべて / 合計に含む / 合計から除外 / カテゴリ）・並び・合計カードと同じ計算。

export type BudgetFilter = 'all' | 'included' | 'excluded';

export interface ExpenseFilter {
  /** 説明・カテゴリの部分一致（空なら絞らない） */
  query: string;
  budget: BudgetFilter;
  /** カテゴリ（'all' なら絞らない） */
  category: string;
  sortBy: SortKey;
}

export const DEFAULT_FILTER: ExpenseFilter = { query: '', budget: 'all', category: 'all', sortBy: 'date' };

/** 既定から変えているか（検索ボタンの印に使う） */
export function isFilterActive(f: ExpenseFilter): boolean {
  return f.query.trim() !== '' || f.budget !== 'all' || f.category !== 'all' || f.sortBy !== 'date';
}

type FilterFields = Pick<ExpenseFields, 'description' | 'category' | 'includeInTotal'>;

/** 絞り込み（文字 → 予算 → カテゴリ）。並びは sortForList で行う */
export function filterExpenses<E extends FilterFields>(list: readonly E[], f: ExpenseFilter): E[] {
  return list.filter((e) => {
    if (!matchesQuery(e, f.query)) return false;
    if (f.budget === 'included' && !e.includeInTotal) return false;
    if (f.budget === 'excluded' && e.includeInTotal) return false;
    if (f.category !== 'all' && e.category !== f.category) return false;
    return true;
  });
}

/** 絞り込みの選択肢に出すカテゴリ（読み込み済みの明細に現れた順） */
export function categoriesIn(list: ReadonlyArray<Pick<ExpenseFields, 'category'>>): string[] {
  return Array.from(new Set(list.map((e) => e.category).filter((c): c is string => !!c)));
}

export interface PayerSummary {
  name: string;
  /** 予算に計上するものの合計 */
  total: number;
  /** 件数（計上しないものも含む） */
  count: number;
}

export interface ExpenseSummary {
  count: number;
  /** 予算に計上するものの合計 */
  total: number;
  excludedCount: number;
  /** 支払い者別（計上するものが 1 件以上ある人だけ。合計の多い順） */
  payers: PayerSummary[];
}

/**
 * 刷新前の明細の合計カード・支払い者別カードと同じ集計。
 * 支払い者名は呼び出し側の規則（expenseEdit.resolvePayerName）で解決して渡す。
 */
export function summarizeExpenses<E extends Pick<ExpenseFields, 'amount' | 'includeInTotal'>>(
  list: readonly E[],
  payerName: (e: E) => string
): ExpenseSummary {
  const totals = new Map<string, number>();
  const counts = new Map<string, number>();
  let total = 0;
  let excludedCount = 0;
  for (const e of list) {
    const name = payerName(e);
    const amount = Number(e.amount) || 0;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (e.includeInTotal) {
      totals.set(name, (totals.get(name) ?? 0) + amount);
      total += amount;
    } else {
      excludedCount += 1;
    }
  }
  const payers = Array.from(totals, ([name, t]) => ({ name, total: t, count: counts.get(name) ?? 0 })).sort(
    (a, b) => b.total - a.total
  );
  return { count: list.length, total, excludedCount, payers };
}
