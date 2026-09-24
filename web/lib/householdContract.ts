// bot の /household/* エンドポイントとの契約（型・応答の検証・エラーの分類）。
// 通信は householdApi.ts が行う。ここは node --test から直接読める純関数だけ（型以外の import なし）。
import type { ExpenseStatus } from './hooks';
import type { ToastKey } from './uiText';

// ---- 型 ---------------------------------------------------------------------

export type SettlementBasis = 'none' | 'pair' | 'single_advancer' | 'undeterminable';

export interface SettlementMember {
  lineId: string;
  displayName: string;
  /** 有効メンバーか（false はメンバー外・脱退済みの立替者） */
  isMember: boolean;
}

/** 計算できない理由（basis が undeterminable のときだけ） */
export type UndeterminableReason = 'more_than_two' | 'partner_unknown';

export interface SettlementTransfer {
  fromUserId: string;
  toUserId: string;
  amount: number;
}

export interface SettlementItem {
  id: string;
  date: string;
  description: string;
  amount: number;
  category: string;
  advanceBy: string | null;
}

/** GET /household/settlement の応答（未精算の立替の全件） */
export interface SettlementResponse {
  groupId: string;
  scope: 'line_group' | 'group';
  /** 精算の関係者（応答の participants）。有効メンバー（joinedAt 昇順）→ メンバー外の立替者 */
  members: SettlementMember[];
  /** 関係者全員の立替合計（有効メンバーは 0 埋め） */
  totals: Record<string, number>;
  basis: SettlementBasis;
  reason: UndeterminableReason | null;
  settlement: SettlementTransfer | null;
  items: SettlementItem[];
  expenseIds: string[];
  asOf: string;
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

export interface SettleResult {
  settled: number;
  skipped: number;
  basis: SettlementBasis;
  settlement: SettlementTransfer | null;
}

export type HouseholdErrorCode =
  | 'unavailable'
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'settled'
  | 'nothing_to_settle'
  | 'nothing_settled'
  | 'undeterminable'
  | 'too_many'
  | 'rate_limited'
  | 'network'
  | 'internal'
  | 'failed';

// ---- ベース URL・ID ------------------------------------------------------------

function normalizeBase(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.search || url.hash) return null;
    return value.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * API のベース URL。明示の値（空文字は未設定扱い）→ 認証エンドポイントの /auth/line を除いたもの。
 * どちらからも得られなければ null（確認・精算の操作は無効にする）。
 */
export function deriveApiBase(explicit: string | undefined, authEndpoint: string | undefined): string | null {
  const direct = (explicit ?? '').trim();
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
    !/^__.*__$/.test(id)
  );
}

// ---- 応答の検証 ----------------------------------------------------------------

const BASES: readonly SettlementBasis[] = ['none', 'pair', 'single_advancer', 'undeterminable'];
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

function parseTransfer(value: unknown): SettlementTransfer | null {
  if (!isRecord(value)) return null;
  const fromUserId = toStr(value.fromUserId);
  const toUserId = toStr(value.toUserId);
  if (!fromUserId || !toUserId) return null;
  return { fromUserId, toUserId, amount: toNumber(value.amount) };
}

/** 応答の形を確かめて型に揃える。必須の形でなければ null */
export function parseSettlementResponse(json: unknown): SettlementResponse | null {
  if (!isRecord(json)) return null;
  // 関係者は participants（bot の応答）。古い形の members も受け付ける
  const people = Array.isArray(json.participants) ? json.participants : json.members;
  if (!Array.isArray(people) || !Array.isArray(json.expenseIds)) return null;
  const basis = BASES.includes(json.basis as SettlementBasis) ? (json.basis as SettlementBasis) : null;
  if (!basis) return null;

  const members: SettlementMember[] = [];
  for (const m of people) {
    if (!isRecord(m) || !toStr(m.lineId)) continue;
    if (members.some((x) => x.lineId === m.lineId)) continue;
    members.push({ lineId: toStr(m.lineId), displayName: toStr(m.displayName), isMember: m.isMember !== false });
  }

  const totals: Record<string, number> = {};
  for (const m of members) totals[m.lineId] = 0;
  const reason: UndeterminableReason | null =
    basis === 'undeterminable' && (json.reason === 'more_than_two' || json.reason === 'partner_unknown')
      ? json.reason
      : null;
  if (isRecord(json.totals)) {
    for (const [id, v] of Object.entries(json.totals)) totals[id] = toNumber(v);
  }

  const items: SettlementItem[] = Array.isArray(json.items)
    ? json.items.filter(isRecord).map((it) => ({
        id: toStr(it.id),
        date: toStr(it.date),
        description: toStr(it.description),
        amount: toNumber(it.amount),
        category: toStr(it.category),
        advanceBy: toStr(it.advanceBy) || null,
      }))
    : [];

  return {
    groupId: toStr(json.groupId),
    scope: json.scope === 'group' ? 'group' : 'line_group',
    members,
    totals,
    basis,
    reason,
    settlement: parseTransfer(json.settlement),
    items,
    expenseIds: json.expenseIds.filter((id): id is string => typeof id === 'string'),
    asOf: toStr(json.asOf),
  };
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

export function parseSettleResult(json: unknown): SettleResult | null {
  if (!isRecord(json) || json.ok !== true) return null;
  return {
    settled: toNumber(json.settled),
    skipped: toNumber(json.skipped),
    basis: BASES.includes(json.basis as SettlementBasis) ? (json.basis as SettlementBasis) : 'none',
    settlement: parseTransfer(json.settlement),
  };
}

// ---- エラー ------------------------------------------------------------------

const KNOWN_ERRORS: readonly HouseholdErrorCode[] = [
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'settled',
  'nothing_to_settle',
  'nothing_settled',
  'undeterminable',
  'too_many',
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

/** トーストの語（uiText の T.toast のキー）。サーバーの message は表示しない */
export function toastKeyForHouseholdError(code: HouseholdErrorCode): ToastKey {
  switch (code) {
    case 'unauthenticated':
    case 'forbidden':
      return 'forbidden';
    case 'not_found':
    case 'network':
      return 'network';
    case 'rate_limited':
      return 'busy';
    case 'settled':
    case 'nothing_to_settle':
    case 'nothing_settled':
      return 'settled';
    default:
      return 'failed';
  }
}
