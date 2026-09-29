// 明細の状態・絞り込み・並び・集計・書き込み可否の純関数。
// node --test から直接読めるよう、他のモジュールからは型だけを import する（値の import は dayjs のみ）。
import dayjs from 'dayjs';
import type { Expense } from './hooks';
import type { KnownUser } from './expenseEdit';

type ExpenseFields = Partial<Omit<Expense, 'id'>>;

/** Gmail 自動取込の支出の lineId（bot/src/gmail/handler.ts と同じ） */
export const GMAIL_SYSTEM_LINE_ID = 'gmail-auto-system';
/** 固定費の自動計上（共通のカード・口座）の lineId（bot/src/recurringExpenses.ts と同じ） */
export const RECURRING_SYSTEM_LINE_ID = 'recurring-system';

// ---- 状態 ------------------------------------------------------------------

/** 要確認: status が無い / pending で、確認済みフラグが立っていない（bot の OK と同じ判定） */
export function isPending(e: Pick<ExpenseFields, 'status' | 'confirmed'>): boolean {
  return (e.status == null || e.status === 'pending') && e.confirmed !== true;
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

// ---- 並び -----------------------------------------------------------------

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
 * 一覧の並び（同じ値のものは元の順のまま）。
 * - date: 日付の降順
 * - amount: 金額の降順
 */
export function sortForList<E extends Pick<Expense, 'date' | 'amount'>>(list: readonly E[], sortBy: SortKey = 'date'): E[] {
  return [...list].sort((a, b) => {
    if (sortBy === 'date') {
      return dayjs(b.date).valueOf() - dayjs(a.date).valueOf();
    }
    return b.amount - a.amount;
  });
}

// ---- 支払い者 -----------------------------------------------------------------

/** 共通のカード・口座から払った支出（Gmail 自動取込・固定費の自動計上） */
export function isCardSource(e: Pick<ExpenseFields, 'inputSource' | 'payerId'>): boolean {
  return e.inputSource === 'gmail_auto' || (e.inputSource === 'recurring' && e.payerId === RECURRING_SYSTEM_LINE_ID);
}

/**
 * 支払い者名（一覧のチップ・支払い者別の合計で共通）。
 * - Gmail 自動取込は「クレジットカード」、固定費の自動計上は「共通口座」にまとめる
 * - payerDisplayName を最優先し、不明系の名前は支出履歴から補う
 */
export function resolvePayerName(
  expense: Pick<Expense, 'lineId'> &
    Partial<Pick<Expense, 'inputSource' | 'payerId' | 'payerDisplayName' | 'userDisplayName'>>,
  historicalUsers: readonly KnownUser[]
): string {
  if (expense.inputSource === 'gmail_auto') return 'クレジットカード';
  if (expense.inputSource === 'recurring' && expense.payerId === RECURRING_SYSTEM_LINE_ID) return '共通口座';
  const payerId = expense.payerId || expense.lineId;
  let payerName = expense.payerDisplayName || expense.userDisplayName || '個人';
  if (
    payerName === 'メンバー' ||
    payerName === '個人' ||
    payerName.startsWith('Unknown_') ||
    payerName.startsWith('User_')
  ) {
    const historical = historicalUsers.find((u) => u.lineId === payerId);
    if (historical) payerName = historical.displayName;
  }
  return payerName;
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
  // ルール（canWriteExistingExpense）と同じ: 個人支出は所有者、グループ支出は有効メンバー。
  // lineGroupId だけを持つ旧形式は書けない（先に groupId の backfill が必要）
  if (isPersonalExpense(e)) return e.lineId === me;
  if (!e.groupId) return false;
  return isActiveMemberOf(e.groupId, activeGroupIds);
}

/** クライアントから削除できるか（精算済みは不可。グループ支出は本人か、システムが登録した分（Gmail 取込・固定費）だけ） */
export function canClientDelete(
  e: OwnershipFields,
  me: string | null,
  activeGroupIds: readonly string[] | null
): boolean {
  if (!me || isSettled(e)) return false;
  // ルールと同じ: 個人支出は所有者、グループ支出は有効メンバーのうち本人かシステムが登録した分
  if (isPersonalExpense(e)) return e.lineId === me;
  if (!e.groupId) return false;
  return (
    isActiveMemberOf(e.groupId, activeGroupIds) &&
    (e.lineId === me || e.lineId === GMAIL_SYSTEM_LINE_ID || e.lineId === RECURRING_SYSTEM_LINE_ID)
  );
}

/** 確認（サーバー経由）を出せるか。サーバーの認可と同じ条件で、最終判断はサーバー */
export function canServerConfirm(
  e: OwnershipFields,
  me: string | null,
  activeGroupIds: readonly string[] | null
): boolean {
  // サーバー（authorizeExpenseWrite）はルールより厳しい: グループ支出は有効メンバーのみ、旧形式は不可
  if (!me) return false;
  if (isPersonalExpense(e)) return e.lineId === me;
  if (!e.groupId) return false;
  return isActiveMemberOf(e.groupId, activeGroupIds);
}

// ---- 絞り込み・集計（明細のフィルター・合計カード） ---------------------------------
// フィルター（すべて / 合計に含む / 合計から除外 / カテゴリ）と合計カードの計算。

export type BudgetFilter = 'all' | 'included' | 'excluded';

export interface ExpenseFilter {
  /** 説明・カテゴリの部分一致（空なら絞らない） */
  query: string;
  budget: BudgetFilter;
  /** カテゴリ（'all' なら絞らない） */
  category: string;
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
 * 明細の合計カード・支払い者別カードの集計。
 * 支払い者名は呼び出し側で（resolvePayerName で）解決して渡す。
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
