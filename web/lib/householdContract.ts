// bot の /household/* エンドポイントとの契約（型・応答の検証・エラーの分類）。
// 通信は householdApi.ts が行う。ここは node --test から直接読める純関数だけ（型以外の import なし）。
import type { ExpenseStatus } from './hooks';

// ---- 型 ---------------------------------------------------------------------

/** 全額にする前の立替（advanceFull の無い advance_pending）。全額の立替は期間の精算で返すので含まない */
export interface AdvanceItem {
  id: string;
  date: string;
  description: string;
  amount: number;
  category: string;
  /** 立替にした人（advanceBy、無ければ支払った人） */
  advanceBy: string | null;
  /** 立替にした人の名前（支出に記録された名前。分からなければ空文字） */
  advanceByName: string;
}

/** GET /household/legacy-advances の応答 */
export interface AdvancesResponse {
  groupId: string;
  /** 新しい順 */
  items: AdvanceItem[];
  expenseIds: string[];
  asOf: string;
}

export interface SettleLegacyAdvancesResult {
  settled: number;
  skipped: number;
}

export interface DateRangeYmd {
  startDate: string;
  endDate: string;
}

/**
 * 精算の通知を送れない理由
 * no_line_group: LINE グループに紐づいていない / no_collect_from: 集金するメンバーが未指定 /
 * not_two_members: 有効メンバーが 2 人でない / fixed_period: 期間を日付で固定している
 */
export type SummaryUnavailableReason = 'no_line_group' | 'no_collect_from' | 'not_two_members' | 'fixed_period';

/** GET /household/settlement-summary の応答（設定の「LINEへの精算の通知」） */
export interface SummaryStatus {
  reason: SummaryUnavailableReason | null;
  startDay: number | null;
  closed: DateRangeYmd | null;
  current: DateRangeYmd | null;
  /** 締まった期間を送った時刻（ISO 8601）。まだなら null */
  closedSentAt: string | null;
}

export type SummaryPeriodKind = 'closed' | 'current';

export interface SummarySendResult {
  range: DateRangeYmd;
  interim: boolean;
}

/** POST /household/expenses/:id/actions（confirm）の応答から画面に反映する項目 */
export interface ConfirmedExpensePatch {
  id: string;
  status?: ExpenseStatus;
  includeInTotal: boolean;
  confirmed: boolean;
  advanceBy: string | null;
  category?: string;
}

export type HouseholdErrorCode =
  | 'unavailable'
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'nothing_to_settle'
  | 'stale'
  | 'too_many'
  | 'line_limit'
  | 'line_failed'
  | 'rate_limited'
  | 'network'
  | 'internal'
  | 'failed';

// ---- ベース URL・ID ------------------------------------------------------------

function normalizeBase(value: string): string | null {
  try {
    const url = new URL(value);
    // ID トークンを平文で送らないよう、http は手元（localhost）だけ許す
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    if (url.search || url.hash) return null;
    return value.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * API のベース URL。明示の値（空文字は未設定扱い）→ 認証エンドポイントの /auth/line を除いたもの。
 * どちらからも得られなければ null（確認・立替の印を外す・通知の送信などの操作は無効にする）。
 * 明示の値が off / none のときは機能を止める（bot を戻したときに web を出し直さずに済むように）。
 */
export function deriveApiBase(explicit: string | undefined, authEndpoint: string | undefined): string | null {
  const direct = (explicit ?? '').trim();
  if (/^(off|none)$/i.test(direct)) return null;
  if (direct) return normalizeBase(direct);
  const auth = (authEndpoint ?? '').trim();
  if (!auth) return null;
  const derived = auth.replace(/\/auth\/line\/?$/, '');
  if (derived === auth) return null;
  return normalizeBase(derived);
}

/** Firestore のドキュメント ID として送ってよいか（サーバーの検証と同じ条件） */
export function isValidDocId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= 128 &&
    !id.includes('/') &&
    id !== '.' &&
    id !== '..' &&
    !(id.length >= 4 && id.startsWith('__') && id.endsWith('__'))
  );
}

// ---- 応答の検証 ----------------------------------------------------------------

const STATUSES: readonly ExpenseStatus[] = ['pending', 'shared', 'personal', 'advance_pending', 'advance_settled'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function parseRange(value: unknown): DateRangeYmd | null {
  if (!isRecord(value)) return null;
  const startDate = toStr(value.startDate);
  const endDate = toStr(value.endDate);
  return YMD.test(startDate) && YMD.test(endDate) ? { startDate, endDate } : null;
}

/** 応答の形を確かめて型に揃える。必須の形でなければ null */
export function parseAdvancesResponse(json: unknown): AdvancesResponse | null {
  if (!isRecord(json) || !Array.isArray(json.items) || !Array.isArray(json.expenseIds)) return null;
  return {
    groupId: toStr(json.groupId),
    items: json.items
      .filter(isRecord)
      .map((it) => ({
        id: toStr(it.id),
        date: toStr(it.date),
        description: toStr(it.description),
        amount: toNumber(it.amount),
        category: toStr(it.category),
        advanceBy: toStr(it.advanceBy) || null,
        advanceByName: toStr(it.advanceByName),
      }))
      .filter((it) => it.id),
    expenseIds: json.expenseIds.filter((id): id is string => typeof id === 'string'),
    asOf: toStr(json.asOf),
  };
}

export function parseSettleLegacyAdvancesResult(json: unknown): SettleLegacyAdvancesResult | null {
  if (!isRecord(json) || json.ok !== true) return null;
  return { settled: toNumber(json.settled), skipped: toNumber(json.skipped) };
}

const SUMMARY_REASONS: readonly SummaryUnavailableReason[] = ['no_line_group', 'no_collect_from', 'not_two_members', 'fixed_period'];

export function parseSummaryStatus(json: unknown): SummaryStatus | null {
  if (!isRecord(json)) return null;
  const reason = SUMMARY_REASONS.includes(json.reason as SummaryUnavailableReason) ? (json.reason as SummaryUnavailableReason) : null;
  if (json.reason !== null && !reason) return null;
  const closed = parseRange(json.closed);
  const current = parseRange(json.current);
  // 送れるなら 2 つの期間がそろっている
  if (!reason && (!closed || !current)) return null;
  const day = toNumber(json.startDay);
  return {
    reason,
    startDay: Number.isInteger(day) && day >= 1 && day <= 31 ? day : null,
    closed,
    current,
    closedSentAt: typeof json.closedSentAt === 'string' && !Number.isNaN(Date.parse(json.closedSentAt)) ? json.closedSentAt : null,
  };
}

export function parseSummarySendResult(json: unknown): SummarySendResult | null {
  if (!isRecord(json) || json.ok !== true) return null;
  const range = parseRange(json.range);
  return range ? { range, interim: json.interim === true } : null;
}

// ---- カテゴリのルール（確定ルールと、AI へ伝える例） ---------------------------------

export interface CategoryRule {
  keyword: string;
  category: string;
}

export interface CategoryRuleLimits {
  maxRules: number;
  maxKeywordLength: number;
  maxExamplesPerCategory: number;
  maxExampleLength: number;
}

export interface CategoryRulesConfig {
  rules: CategoryRule[];
  /** カテゴリ名 → 例 */
  examples: Record<string, string[]>;
  limits: CategoryRuleLimits;
}

export function parseCategoryRulesResponse(json: unknown): CategoryRulesConfig | null {
  if (!isRecord(json) || !Array.isArray(json.rules) || !isRecord(json.examples) || !isRecord(json.limits)) return null;
  const rules: CategoryRule[] = [];
  for (const item of json.rules) {
    if (!isRecord(item) || typeof item.keyword !== 'string' || typeof item.category !== 'string') return null;
    rules.push({ keyword: item.keyword, category: item.category });
  }
  const examples: Record<string, string[]> = {};
  for (const [category, list] of Object.entries(json.examples)) {
    if (!Array.isArray(list) || list.some((t) => typeof t !== 'string')) return null;
    examples[category] = list as string[];
  }
  const l = json.limits;
  const limits = {
    maxRules: toNumber(l.maxRules),
    maxKeywordLength: toNumber(l.maxKeywordLength),
    maxExamplesPerCategory: toNumber(l.maxExamplesPerCategory),
    maxExampleLength: toNumber(l.maxExampleLength),
  };
  if (Object.values(limits).some((n) => !Number.isInteger(n) || n < 1)) return null;
  return { rules, examples, limits };
}

export function parseConfirmResponse(json: unknown): ConfirmedExpensePatch | null {
  if (!isRecord(json) || !isRecord(json.expense)) return null;
  const e = json.expense;
  const id = toStr(e.id);
  if (!id) return null;
  const status = STATUSES.includes(e.status as ExpenseStatus) ? (e.status as ExpenseStatus) : undefined;
  return {
    id,
    ...(status ? { status } : {}),
    includeInTotal: e.includeInTotal === true,
    confirmed: e.confirmed !== false,
    advanceBy: toStr(e.advanceBy) || null,
    ...(typeof e.category === 'string' ? { category: e.category } : {}),
  };
}

// ---- エラー ------------------------------------------------------------------

const KNOWN_ERRORS: readonly HouseholdErrorCode[] = [
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'unavailable',
  'nothing_to_settle',
  'stale',
  'too_many',
  'line_limit',
  'line_failed',
  'rate_limited',
  'internal',
];

/** HTTP の失敗応答をエラーコードにする（本文の error を優先し、無ければ状態コードで） */
export function classifyHouseholdFailure(status: number, body: unknown): HouseholdErrorCode {
  const code = isRecord(body) ? body.error : undefined;
  if (typeof code === 'string' && (KNOWN_ERRORS as readonly string[]).includes(code)) {
    return code as HouseholdErrorCode;
  }
  if (status === 400) return 'invalid_request';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal';
  return 'failed';
}
