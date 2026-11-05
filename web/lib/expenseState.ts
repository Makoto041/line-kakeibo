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

/**
 * 自動で入った支出（Gmail のカード取込・固定費の自動計上）。未読にしない・区分を未定として扱わない。
 * 固定費は登録時から既読（confirmed: true）なので、実際に効くのは以前に pending で入ったカード取込
 * （LINE のカード再表示 bot/src/line/flexMessage.ts の buildExpenseCardFromRecord も同じ扱い）
 */
export function isAutoInput(e: Pick<ExpenseFields, 'inputSource'>): boolean {
  return e.inputSource === 'gmail_auto' || e.inputSource === 'recurring';
}

/**
 * 画面では「未読」。手入力の支出で、status が無い / pending のまま confirmed（既読 = confirmed）が立っていない。
 * 自動で入った支出は未読にしない（以前に pending で入ったカード取込も含む。集計にはもとから入っている）
 */
export function isPending(e: Pick<ExpenseFields, 'status' | 'confirmed' | 'inputSource'>): boolean {
  if (isAutoInput(e)) return false;
  return (e.status == null || e.status === 'pending') && e.confirmed !== true;
}

/**
 * 会計に含める / 含めないを押したとき、区分（status）もサーバーに決めてもらう必要があるか（shouldSendInclude で使う）。
 * 手入力の支出で status が無い / pending のもの。未読に加え、既読にしただけ（confirmed: true）のものと、
 * status の無い旧データの確認済みも含む。サーバーは含める → 共同費、含めない → 個人にする。
 * 画面の表示（区分のチップなど）には使わない（チップを出さないのは未読 = isPending のときだけ）
 */
export function needsSplitDecision(e: Pick<ExpenseFields, 'status' | 'inputSource'>): boolean {
  if (isAutoInput(e)) return false;
  return e.status == null || e.status === 'pending';
}

/**
 * 会計に含める / 含めないを押したとき、サーバーに送るか。
 * 区分が未定（needsSplitDecision。未読を含む）なら同じ値でも送る（区分が決まり、未読なら既読にもなる）。
 * そうでなければ、今と違う値のときだけ送る
 */
export function shouldSendInclude(
  e: Pick<ExpenseFields, 'status' | 'inputSource' | 'includeInTotal'>,
  include: boolean
): boolean {
  return needsSplitDecision(e) || e.includeInTotal !== include;
}

/** 支出一覧のカードの操作（既読にする / 会計に含める / 会計に含めない） */
export type ExpenseActionKind = 'read' | 'include' | 'exclude';

export function isAdvance(e: Pick<ExpenseFields, 'status'>): boolean {
  return e.status === 'advance_pending' || e.status === 'advance_settled';
}

export function isSettled(e: Pick<ExpenseFields, 'status'>): boolean {
  return e.status === 'advance_settled';
}

export type SplitChip = 'shared' | 'personal' | 'advance' | 'settled';

/** 負担区分のチップ（bot の deriveExpenseSettings と同じ分け方。未読かどうかは別の表示で示す） */
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

/** 未読（isPending）の件数（画面では「未読」） */
export function countPending(list: ReadonlyArray<Pick<ExpenseFields, 'status' | 'confirmed' | 'inputSource'>>): number {
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
  e: Pick<ExpenseFields, 'status' | 'confirmed' | 'inputSource'>,
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

/**
 * 共通のカード・口座から払った支出（Gmail 自動取込・固定費の自動計上）。
 * LINE の［自分が払った］［自分が立替］で支払った人をメンバーにしたカード取込は、その人の支払いとして扱う
 */
export function isCardSource(e: Pick<ExpenseFields, 'inputSource' | 'payerId'>): boolean {
  return (
    (e.inputSource === 'gmail_auto' && (!e.payerId || e.payerId === GMAIL_SYSTEM_LINE_ID)) ||
    (e.inputSource === 'recurring' && e.payerId === RECURRING_SYSTEM_LINE_ID)
  );
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
  if (expense.inputSource === 'gmail_auto' && (!expense.payerId || expense.payerId === GMAIL_SYSTEM_LINE_ID)) return 'クレジットカード';
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

/** 編集をクライアントから書けるか */
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

/** 既読・会計の切り替え（サーバー経由）を出せるか。サーバーの認可と同じ条件で、最終判断はサーバー */
export function canServerWrite(
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
// フィルター（すべて / 会計に含める / 会計に含めない / カテゴリ）と合計カードの計算。

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
