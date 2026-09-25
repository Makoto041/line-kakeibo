/**
 * Web（ふたりタブ・明細の確認ボタン）向けの認証付き API
 *
 * `api` 関数（Express）に `/household` としてマウントする。Firestore ルールではクライアントから
 * status / confirmed を書けないため、状態を変える操作はここで Admin SDK を使って行う。判定と書き込みは
 * LINE の postback・「精算」コマンドと同じ関数（expenseActions.ts / firestore.ts / householdSettlement.ts）。
 *
 * - POST /household/expenses/:expenseId/actions   { action: 'confirm' }
 * - GET  /household/settlement?groupId=<id>
 * - POST /household/settlement/settle             { groupId, expectedExpenseIds, expectedSettlement? }
 *
 * 防御線は Firebase ID トークンの検証（カスタムトークン由来で lineId クレームを持つものだけ）と
 * groupMembers の有効メンバー確認。CORS は `/auth/line` と同じ許可リストだが防御線ではない
 * （Cookie を使わず Allow-Credentials も付けないので CSRF は成立しない）。
 *
 * このモジュールは index.ts を import しない（素の express に載せて統合テストできるようにする）。
 * JSON の解析はマウント先の `express.json()` に任せ、その解析エラーにも CORS ヘッダーを付けるため
 * `householdErrorHandler` を同じパスに続けてマウントすること:
 *   app.use("/household", householdRouter, householdErrorHandler);
 */

import { isIP } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirestore, type DocumentData, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { parseBearerToken } from './adminAuth';
import { applyExpenseChange, decideConfirm } from './expenseActions';
import {
  getAdvanceSummaryByUser,
  getGroupMembers,
  groupMemberDocId,
  settleAdvances,
  type Expense,
} from './firestore';
import {
  computeHouseholdSettlement,
  sortActiveMembers,
  type SettlementBasis,
  type UndeterminableReason,
} from './householdSettlement';
import { errorMessage, maskId } from './logSafe';
import {
  MAX_RECURRING_PER_GROUP,
  RECURRING_COLLECTION,
  isConsistentPayment,
  loadGroupContext,
  parseRecurringInput,
  toRecurringItem,
  toRecurringView,
  type RecurringInput,
} from './recurringExpenses';
import { todayJST } from './time';
import { isAllowedWebOrigin } from './webOrigins';

/** 1 回に精算できる件数の上限（Firestore の batch の上限） */
export const MAX_SETTLE_IDS = 500;

// ============================================
// 入力検証（純関数）
// ============================================

/**
 * Firestore のドキュメント ID として安全な文字列か
 *
 * 1〜128 文字、`/` を含まない、`.` `..` ではない、`__…__`（予約 ID。Firestore が拒否して 500 になる）ではない。
 * 予約 ID の判定は改行を含む値（`__a\nb__`）も対象にするため、正規表現の `.` ではなく前後の一致で見る。
 */
export function isValidDocId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    !value.includes('/') &&
    value !== '.' &&
    value !== '..' &&
    !(value.length >= 4 && value.startsWith('__') && value.endsWith('__'))
  );
}

/** JSON のオブジェクト（配列・null 以外）か */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `expectedExpenseIds` を検証して重複を除く（不正なら null）
 *
 * 配列で、要素はすべて `isValidDocId` を満たす文字列。重複を除いて 500 件を超えるものは照合に使わず
 * `too_many` を返す（GET の expenseIds は 500 件を超えうるので、そのまま送られても 400 にはせず、
 * 呼び出し側が 409 too_many / stale で返す）。本文の大きさは express.json() の上限（100kb）で抑えられる。
 */
export function parseExpectedExpenseIds(value: unknown): string[] | 'too_many' | null {
  if (!Array.isArray(value) || !value.every(isValidDocId)) return null;
  const ids = Array.from(new Set(value as string[]));
  return ids.length > MAX_SETTLE_IDS ? 'too_many' : ids;
}

/** 2 つの ID 集合が等しいか（順序・重複は無視） */
export function sameIdSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const id of setA) if (!setB.has(id)) return false;
  return true;
}

/** 精算額（誰が誰にいくら）。null は「精算額なし」（未精算なし・差額 0・計算できない） */
export interface SettlementFigure {
  fromUserId: string;
  toUserId: string;
  amount: number;
}

/**
 * `expectedSettlement`（画面に出した精算額）を検証する
 *
 * null か `{ fromUserId, toUserId, amount }`（ID は `isValidDocId`、amount は 0 以上の整数）。
 * 不正なら `invalid` を返す。
 */
export function parseExpectedSettlement(value: unknown): SettlementFigure | null | 'invalid' {
  if (value === null) return null;
  if (!isPlainObject(value)) return 'invalid';
  const { fromUserId, toUserId, amount } = value;
  if (!isValidDocId(fromUserId) || !isValidDocId(toUserId)) return 'invalid';
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return 'invalid';
  return { fromUserId, toUserId, amount };
}

/** 2 つの精算額が同じか（null 同士も同じ） */
export function sameSettlement(a: SettlementFigure | null, b: SettlementFigure | null): boolean {
  if (a === null || b === null) return a === b;
  return a.fromUserId === b.fromUserId && a.toUserId === b.toUserId && a.amount === b.amount;
}

// ============================================
// 認可
// ============================================

/**
 * groupMembers/{groupId}_{lineId} が有効（isActive === true）か。読み取りは tx があればトランザクション内で行う
 *
 * 文書 ID だけでなく文書の groupId・lineId も照合する（groupId は利用者が指定でき `_` を含みうるため、
 * `${groupId}_${lineId}` が別の組み合わせの文書 ID と一致しても通さない）。
 */
async function isActiveMember(
  db: Firestore,
  groupId: string,
  lineId: string,
  tx?: Pick<Transaction, 'get'>
): Promise<boolean> {
  if (!isValidDocId(groupId)) return false;
  const ref = db.collection('groupMembers').doc(groupMemberDocId(groupId, lineId));
  const snapshot = tx ? await tx.get(ref) : await ref.get();
  return (
    snapshot.exists &&
    snapshot.get('isActive') === true &&
    snapshot.get('groupId') === groupId &&
    snapshot.get('lineId') === lineId
  );
}

/**
 * 支出を書き換えてよいか
 *
 * - groupId がある → そのグループの有効メンバー（脱退者は不可）
 * - groupId も lineGroupId も無い個人支出 → 所有者（lineId が一致）
 * - lineGroupId だけを持つ旧形式 → 不可（先に groupId の backfill が必要）
 *
 * Firestore ルールより厳しい（ルールは所有者の更新を広く認めることがある）: groupId のある支出は所有者で
 * あっても、そのグループの有効メンバーでなければ 403。旧形式は所有者でも 403。
 *
 * メンバー文書はトランザクション内で読む（applyExpenseChange の authorize から呼ぶ）。
 */
export async function authorizeExpenseWrite(
  tx: Pick<Transaction, 'get'>,
  db: Firestore,
  data: DocumentData,
  lineId: string
): Promise<boolean> {
  const groupId = data.groupId;
  if (groupId) {
    return typeof groupId === 'string' && (await isActiveMember(db, groupId, lineId, tx));
  }
  if (!data.lineGroupId) return data.lineId === lineId;
  return false;
}

// ============================================
// CORS・エラー応答
// ============================================

/** `/auth/line` と同じ許可リストで CORS ヘッダーを付ける（エラー応答にも付ける） */
export function applyHouseholdCors(req: Request, res: Response): void {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (typeof origin === 'string' && isAllowedWebOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '3600');
  }
  res.setHeader('Cache-Control', 'no-store');
  // 応答は Firestore の利用者入力（description・displayName など）を含む JSON。型の推測をさせない
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function householdCors(req: Request, res: Response, next: NextFunction) {
  applyHouseholdCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

type ErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'too_many'
  | 'nothing_to_settle'
  | 'stale'
  | 'undeterminable'
  | 'nothing_settled'
  | 'rate_limited'
  | 'internal';

function sendError(res: Response, status: number, error: ErrorCode, extra: Record<string, unknown> = {}) {
  res.status(status).json({ error, ...extra });
}

/**
 * ルーターの外（マウント先の express.json() など）で起きたエラーも含めて JSON で返す
 *
 * `app.use("/household", householdRouter, householdErrorHandler)` のように同じパスにマウントする。
 */
export function householdErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) {
    next(err);
    return;
  }
  applyHouseholdCors(req, res);
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : 500;
  if (status >= 400 && status < 500) {
    sendError(res, status, 'invalid_request');
    return;
  }
  console.error('household: unexpected error:', errorMessage(err));
  sendError(res, 500, 'internal');
}

// ============================================
// 認証・レート制限
// ============================================

type TokenCheck = { decoded: DecodedIdToken } | { status: 401 | 500 };

/** verifyIdToken の結果を 401（トークンの問題）/ 500（検証できない）に振り分ける。トークンはログに出さない */
async function checkIdToken(token: string, checkRevoked: boolean): Promise<TokenCheck> {
  try {
    return { decoded: await getAuth().verifyIdToken(token, checkRevoked) };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && code.startsWith('auth/') && code !== 'auth/internal-error') {
      console.warn(`household: ID token rejected (${code})`);
      return { status: 401 };
    }
    console.error('household: ID token verification failed:', typeof code === 'string' ? code : errorMessage(error));
    return { status: 500 };
  }
}

function sendTokenError(res: Response, status: 401 | 500) {
  sendError(res, status, status === 401 ? 'unauthenticated' : 'internal');
}

/**
 * Firebase ID トークンを検証し、res.locals.lineId に検証済みの LINE userId を入れる
 *
 * 受け付けるのは `/auth/line` のカスタムトークンでサインインしたユーザー（sign_in_provider が custom で
 * lineId クレームを持つ）だけ。匿名ユーザーは 403。
 *
 * 検証は 2 段階: まず署名と有効期限だけを確かめ（公開鍵はキャッシュされるので通常はネットワークを使わない）、
 * LINE のユーザーだと分かってから失効・無効化を確かめる（Auth API を呼ぶ）。誰でも作れる匿名トークンの
 * 連打で Auth API を呼ばせないため。
 */
async function requireLineUser(req: Request, res: Response, next: NextFunction) {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    sendError(res, 401, 'unauthenticated');
    return;
  }

  const signed = await checkIdToken(token, false);
  if ('status' in signed) {
    sendTokenError(res, signed.status);
    return;
  }
  const decoded = signed.decoded;
  const lineId = (decoded as { lineId?: unknown }).lineId;
  if (decoded.firebase?.sign_in_provider !== 'custom' || !isValidDocId(lineId)) {
    console.warn(`household: token without LINE identity (uid ${maskId(decoded.uid)})`);
    sendError(res, 403, 'forbidden');
    return;
  }

  const current = await checkIdToken(token, true);
  if ('status' in current) {
    sendTokenError(res, current.status);
    return;
  }

  res.locals.lineId = lineId;
  next();
}

const RATE_LIMITED_BODY = { error: 'rate_limited' };

/**
 * 認証前のレート制限のキー（接続元の IP）
 *
 * `trust proxy` は `/auth/line` の挙動を変えないため設定しておらず、Cloud Run では req.ip が前段の
 * アドレスにまとまる（そのままだと 1 人の連打でインスタンス上の全員が 429 になる）。Google のフロント
 * エンドは X-Forwarded-For の末尾に接続元の IP を足すので、末尾の値をキーにする（クライアントが送った値は
 * その前に並ぶだけなので、末尾は詐称できない）。末尾が IP として読めなければ req.ip。IPv6 は
 * ipKeyGenerator で /56 にまとめる。前段がさらに増えて末尾が共通のアドレスになった場合は、従来どおり
 * インスタンス全体の上限として働く（そのため上限は大きめのまま）。
 */
export function clientIpKey(req: Pick<Request, 'headers' | 'ip'>): string {
  const header = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(header) ? header.join(',') : header ?? '').split(',');
  const last = hops[hops.length - 1].trim();
  const ip = last && isIP(last) ? last : req.ip;
  return ipKeyGenerator(ip || 'unknown');
}

/**
 * 認証前の接続元 IP 単位の上限（clientIpKey）
 *
 * 正規ユーザーを締め出さないよう大きめにし、実際の制限は lineId 単位の limiter に任せる。Bearer トークンの
 * 無い要求は requireLineUser が verifyIdToken を呼ばずに 401 で返すので数えない。
 */
const preAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: RATE_LIMITED_BODY,
  skip: (req) => !parseBearerToken(req.headers.authorization),
  keyGenerator: (req) => clientIpKey(req),
  validate: { ip: false, trustProxy: false, xForwardedForHeader: false, forwardedHeader: false },
});

/** 認証後の lineId 単位の上限（IP は見ないので IP 関連の検証は切る） */
function lineIdLimiter(limit: number, options: { skipFailedRequests?: boolean } = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: RATE_LIMITED_BODY,
    keyGenerator: (_req, res) => `line:${String((res as Response).locals.lineId)}`,
    validate: { ip: false, trustProxy: false, xForwardedForHeader: false, forwardedHeader: false },
    ...options,
  });
}

/** 全ルート共通（失敗した応答も数える。1 つの store を全ルートで共有） */
const userLimiter = lineIdLimiter(60);
/**
 * 精算の記録の上限。成功した記録だけを数える（400/403/409 stale などで枠を使い切らないように）。
 * 失敗の連打は userLimiter で抑える。
 */
const settleLimiter = lineIdLimiter(5, { skipFailedRequests: true });

// ============================================
// 精算の表示内容
// ============================================

interface SettlementScope {
  id: string;
  isLine: boolean;
  /** 世帯の作成者の lineId（仮名「作成者」を名前として扱わない対象。分からなければ null） */
  createdBy: string | null;
}

/**
 * 精算の対象範囲
 *
 * LINE グループに紐づく世帯は lineGroupId 基準（LINE の「立替一覧」「精算」と同じ集合）。
 * 紐づいていなければ groupId 基準。グループが無ければ null。
 */
async function resolveScope(db: Firestore, groupId: string): Promise<SettlementScope | null> {
  const group = await db.collection('groups').doc(groupId).get();
  if (!group.exists) return null;
  const lineGroupId = group.get('lineGroupId');
  const createdBy = group.get('createdBy');
  const creator = typeof createdBy === 'string' && createdBy.length > 0 ? createdBy : null;
  return typeof lineGroupId === 'string' && lineGroupId.length > 0
    ? { id: lineGroupId, isLine: true, createdBy: creator }
    : { id: groupId, isLine: false, createdBy: creator };
}

export interface SettlementView {
  groupId: string;
  scope: 'line_group' | 'group';
  /** 関係者: 有効メンバー（joinedAt 昇順）、その後にメンバー外・脱退済みの立替者（isMember: false） */
  participants: Array<{ lineId: string; displayName: string; isMember: boolean }>;
  totals: Record<string, number>;
  basis: SettlementBasis;
  reason: UndeterminableReason | null;
  settlement: SettlementFigure | null;
  items: Array<{
    id: string;
    date: string;
    description: string;
    amount: number;
    category: string;
    advanceBy: string | null;
  }>;
  expenseIds: string[];
  asOf: string;
}

function createdAtMillis(expense: Expense): number {
  const createdAt = expense.createdAt as { toMillis?: () => number } | undefined;
  return typeof createdAt?.toMillis === 'function' ? createdAt.toMillis() : 0;
}

async function loadSettlement(groupId: string, scope: SettlementScope) {
  const [summaries, members] = await Promise.all([
    getAdvanceSummaryByUser(scope.id, scope.isLine),
    getGroupMembers(groupId),
  ]);
  const result = computeHouseholdSettlement(summaries, sortActiveMembers(members, scope.createdBy));

  // getPendingAdvances と同じ並び（createdAt 降順）
  const expenses = summaries.flatMap((s) => s.expenses).sort((a, b) => createdAtMillis(b) - createdAtMillis(a));
  const expenseIds = expenses.map((e) => e.id!);

  const view: SettlementView = {
    groupId,
    scope: scope.isLine ? 'line_group' : 'group',
    participants: result.participants.map((p) => ({
      lineId: p.userId,
      displayName: p.displayName,
      isMember: p.isMember,
    })),
    totals: Object.fromEntries(result.participants.map((p) => [p.userId, p.totalAdvanced])),
    basis: result.basis,
    reason: result.reason,
    settlement: result.settlement
      ? {
          fromUserId: result.settlement.fromUserId,
          toUserId: result.settlement.toUserId,
          amount: result.settlement.amount,
        }
      : null,
    items: expenses.map((e) => ({
      id: e.id!,
      date: typeof e.date === 'string' ? e.date : '',
      description: typeof e.description === 'string' ? e.description : '',
      amount: typeof e.amount === 'number' ? e.amount : 0,
      category: typeof e.category === 'string' ? e.category : '',
      // 集計のキー（getAdvanceSummaryByUser と同じ advanceBy || payerId）
      advanceBy: e.advanceBy || e.payerId || null,
    })),
    expenseIds,
    asOf: new Date().toISOString(),
  };

  return { view, expenseIds, basis: result.basis, reason: result.reason, settlement: view.settlement };
}

// ============================================
// ルート
// ============================================

type Handler = (req: Request, res: Response) => Promise<void>;

/** ハンドラの例外を 500 にする（原因はログに message だけ出す） */
function route(name: string, handler: Handler) {
  return async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error("household handler error", { handler: name, error: errorMessage(error) });
      if (!res.headersSent) sendError(res, 500, 'internal');
    }
  };
}

export const householdRouter = express.Router();

householdRouter.use(householdCors);
householdRouter.use(preAuthLimiter);
householdRouter.use(requireLineUser);

/**
 * POST /household/expenses/:expenseId/actions  { action: 'confirm' }
 *
 * LINE の OK ボタンと同じ処理。未確認（status 無し / pending）なら共同費にして予算に計上する。
 * それ以外の status は確認済みにするだけで 200（現在の status を返す）。
 */
householdRouter.post(
  '/expenses/:expenseId/actions',
  userLimiter,
  route('confirm', async (req, res) => {
    const lineId = res.locals.lineId as string;
    const expenseId = req.params.expenseId;
    if (!isValidDocId(expenseId) || !isPlainObject(req.body) || req.body.action !== 'confirm') {
      sendError(res, 400, 'invalid_request');
      return;
    }

    const db = getFirestore();
    const decide = decideConfirm();
    const written: { update?: Record<string, any> } = {};
    const result = await applyExpenseChange(
      expenseId,
      (data) => {
        const decision = decide(data);
        written.update = 'update' in decision ? decision.update : undefined;
        return decision;
      },
      { authorize: (data, tx) => authorizeExpenseWrite(tx, db, data, lineId) }
    );

    if (!result) {
      sendError(res, 404, 'not_found');
      return;
    }
    if ('forbidden' in result) {
      // ID は利用者の入力なので、改行などでログ行を偽造されないよう JSON 文字列にして出す
      console.warn(`household confirm: forbidden (expense ${JSON.stringify(expenseId)}, user ${maskId(lineId)})`);
      sendError(res, 403, 'forbidden');
      return;
    }
    if ('reject' in result) {
      // decideConfirm は拒否しない（精算済みも確認済みにするだけ）。ここに来たら判定関数の変更漏れなので 500
      throw new Error('confirm decision unexpectedly rejected');
    }

    const record = result.record;
    const updatedAt = written.update?.updatedAt instanceof Date ? written.update.updatedAt : new Date();
    console.log(
      `household confirm: expense ${JSON.stringify(expenseId)} by ${maskId(lineId)} (status: ${JSON.stringify(record.status ?? null)})`
    );
    res.status(200).json({
      ok: true,
      expense: {
        id: expenseId,
        status: typeof record.status === 'string' ? record.status : null,
        includeInTotal: record.includeInTotal === true,
        confirmed: true,
        advanceBy: typeof record.advanceBy === 'string' ? record.advanceBy : null,
        category: typeof record.category === 'string' ? record.category : null,
        updatedAt: updatedAt.toISOString(),
      },
    });
  })
);

/** GET /household/settlement?groupId=<id> — ふたりタブの表示内容 */
householdRouter.get(
  '/settlement',
  userLimiter,
  route('settlement', async (req, res) => {
    const lineId = res.locals.lineId as string;
    const groupId = req.query.groupId;
    if (!isValidDocId(groupId)) {
      sendError(res, 400, 'invalid_request');
      return;
    }

    const db = getFirestore();
    if (!(await isActiveMember(db, groupId, lineId))) {
      sendError(res, 403, 'forbidden');
      return;
    }
    const scope = await resolveScope(db, groupId);
    if (!scope) {
      sendError(res, 404, 'not_found');
      return;
    }

    const { view } = await loadSettlement(groupId, scope);
    res.status(200).json(view);
  })
);

/**
 * POST /household/settlement/settle  { groupId, expectedExpenseIds, expectedSettlement? }
 *
 * LINE の「精算」と同じ書き込み（settleAdvances）。表示した内容と対象（ID の集合）、または
 * 送られていれば精算額（expectedSettlement）がずれていれば、409 stale と最新の表示内容を返す。
 * 未精算が 500 件を超えていれば（GET の expenseIds をそのまま送った場合も）409 too_many。
 * LINE グループへの通知（push）は送らない。
 */
householdRouter.post(
  '/settlement/settle',
  userLimiter,
  settleLimiter,
  route('settle', async (req, res) => {
    const lineId = res.locals.lineId as string;
    const body = req.body;
    if (!isPlainObject(body) || !isValidDocId(body.groupId)) {
      sendError(res, 400, 'invalid_request');
      return;
    }
    const groupId = body.groupId;
    const expected = parseExpectedExpenseIds(body.expectedExpenseIds);
    if (expected === null) {
      sendError(res, 400, 'invalid_request');
      return;
    }
    // 省略時は ID の集合だけを照合する
    const expectedSettlement =
      body.expectedSettlement === undefined ? undefined : parseExpectedSettlement(body.expectedSettlement);
    if (expectedSettlement === 'invalid') {
      sendError(res, 400, 'invalid_request');
      return;
    }

    const db = getFirestore();
    if (!(await isActiveMember(db, groupId, lineId))) {
      sendError(res, 403, 'forbidden');
      return;
    }
    const scope = await resolveScope(db, groupId);
    if (!scope) {
      sendError(res, 404, 'not_found');
      return;
    }

    const current = await loadSettlement(groupId, scope);
    if (current.expenseIds.length > MAX_SETTLE_IDS) {
      sendError(res, 409, 'too_many');
      return;
    }
    // 未精算が 0 件になっていても、画面が古ければ stale（最新の内容で描き直せるように）。
    // 500 件を超える ID が送られたが現在は 500 件以下なら、その画面も古い
    if (
      expected === 'too_many' ||
      !sameIdSet(current.expenseIds, expected) ||
      (expectedSettlement !== undefined && !sameSettlement(current.settlement, expectedSettlement))
    ) {
      sendError(res, 409, 'stale', { current: current.view });
      return;
    }
    if (current.expenseIds.length === 0) {
      sendError(res, 409, 'nothing_to_settle');
      return;
    }
    if (current.basis === 'undeterminable') {
      sendError(res, 409, 'undeterminable', { reason: current.reason });
      return;
    }

    const result = await settleAdvances(current.expenseIds, scope.id, scope.isLine);
    if (result.settled === 0) {
      sendError(res, 409, 'nothing_settled');
      return;
    }

    console.log(
      `household settle: group ${JSON.stringify(groupId)} by ${maskId(lineId)} (settled ${result.settled}, skipped ${result.skipped})`
    );
    res.status(200).json({
      ok: true,
      settled: result.settled,
      skipped: result.skipped,
      basis: current.basis,
      settlement: current.settlement,
    });
  })
);

// ============================================
// 固定費（家賃・光熱費など）
// ============================================

/** 固定費の読み書きの前提: 有効メンバーで、世帯が存在する。だめなら応答を返して null */
async function requireGroupMember(res: Response, groupId: unknown, lineId: string) {
  if (!isValidDocId(groupId)) {
    sendError(res, 400, 'invalid_request');
    return null;
  }
  const db = getFirestore();
  if (!(await isActiveMember(db, groupId, lineId))) {
    sendError(res, 403, 'forbidden');
    return null;
  }
  const group = await loadGroupContext(db, groupId);
  if (!group) {
    sendError(res, 404, 'not_found');
    return null;
  }
  return { db, groupId, group };
}

/** GET /household/recurring?groupId=<id> — 固定費の一覧と、立替者に選べるメンバー */
householdRouter.get(
  '/recurring',
  userLimiter,
  route('recurring-list', async (req, res) => {
    const ctx = await requireGroupMember(res, req.query.groupId, res.locals.lineId as string);
    if (!ctx) return;
    const snapshot = await ctx.db.collection(RECURRING_COLLECTION).where('groupId', '==', ctx.groupId).get();
    const items = snapshot.docs
      .map((doc) => toRecurringItem(doc.id, doc.data()))
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => a.dayOfMonth - b.dayOfMonth || a.name.localeCompare(b.name, 'ja'))
      .map(toRecurringView);
    const members = [...ctx.group.names.entries()].map(([lineId, displayName]) => ({ lineId, displayName }));
    res.status(200).json({ items, members });
  })
);

/** POST /household/recurring  { groupId, name, amount, category, dayOfMonth, payment, payerLineId, active? } */
householdRouter.post(
  '/recurring',
  userLimiter,
  route('recurring-create', async (req, res) => {
    const lineId = res.locals.lineId as string;
    const body = isPlainObject(req.body) ? req.body : null;
    const ctx = await requireGroupMember(res, body?.groupId, lineId);
    if (!ctx || !body) return;
    const { groupId: _groupId, ...fields } = body;
    const input = parseRecurringInput(fields, false);
    if (!input || (input.payerLineId !== null && !ctx.group.names.has(input.payerLineId))) {
      sendError(res, 400, 'invalid_request');
      return;
    }

    const collection = ctx.db.collection(RECURRING_COLLECTION);
    const existing = await collection.where('groupId', '==', ctx.groupId).count().get();
    if (existing.data().count >= MAX_RECURRING_PER_GROUP) {
      sendError(res, 409, 'too_many');
      return;
    }
    const ref = collection.doc();
    const now = new Date();
    const data = {
      ...input,
      groupId: ctx.groupId,
      startDate: todayJST(),
      lastPostedMonth: null,
      createdBy: lineId,
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(data);
    console.log('household recurring: created', { item: maskId(ref.id), user: maskId(lineId) });
    res.status(201).json({ item: toRecurringView(toRecurringItem(ref.id, data)!) });
  })
);

/** 固定費の文書を読み、世帯のメンバーか確かめる。だめなら応答を返して null */
async function loadOwnRecurring(req: Request, res: Response) {
  const lineId = res.locals.lineId as string;
  const id = req.params.id;
  if (!isValidDocId(id)) {
    sendError(res, 400, 'invalid_request');
    return null;
  }
  const db = getFirestore();
  const ref = db.collection(RECURRING_COLLECTION).doc(id);
  const snapshot = await ref.get();
  const item = snapshot.exists ? toRecurringItem(id, snapshot.data()) : null;
  if (!item) {
    sendError(res, 404, 'not_found');
    return null;
  }
  const ctx = await requireGroupMember(res, item.groupId, lineId);
  if (!ctx) return null;
  return { ...ctx, ref, item, lineId };
}

/** PATCH /household/recurring/:id  { name?, amount?, category?, dayOfMonth?, payment?, payerLineId?, active? } */
householdRouter.patch(
  '/recurring/:id',
  userLimiter,
  route('recurring-update', async (req, res) => {
    const ctx = await loadOwnRecurring(req, res);
    if (!ctx) return;
    const patch = parseRecurringInput(req.body, true);
    if (!patch || Object.keys(patch).length === 0) {
      sendError(res, 400, 'invalid_request');
      return;
    }
    const merged: RecurringInput = {
      name: ctx.item.name,
      amount: ctx.item.amount,
      category: ctx.item.category,
      dayOfMonth: ctx.item.dayOfMonth,
      payment: ctx.item.payment,
      payerLineId: ctx.item.payerLineId,
      active: ctx.item.active,
      ...patch,
    };
    // shared に切り替えたら立替者を外す
    if (merged.payment === 'shared') merged.payerLineId = null;
    if (
      !isConsistentPayment(merged) ||
      (merged.payerLineId !== null && merged.payerLineId !== ctx.item.payerLineId && !ctx.group.names.has(merged.payerLineId))
    ) {
      sendError(res, 400, 'invalid_request');
      return;
    }
    await ctx.ref.update({ ...merged, updatedAt: new Date() });
    console.log('household recurring: updated', { item: maskId(ctx.item.id), user: maskId(ctx.lineId) });
    res.status(200).json({ item: toRecurringView({ ...ctx.item, ...merged }) });
  })
);

/** DELETE /household/recurring/:id — 項目を消す（計上済みの明細はそのまま残す） */
householdRouter.delete(
  '/recurring/:id',
  userLimiter,
  route('recurring-delete', async (req, res) => {
    const ctx = await loadOwnRecurring(req, res);
    if (!ctx) return;
    await ctx.ref.delete();
    console.log('household recurring: deleted', { item: maskId(ctx.item.id), user: maskId(ctx.lineId) });
    res.status(200).json({ ok: true });
  })
);

householdRouter.use((_req: Request, res: Response) => {
  sendError(res, 404, 'not_found');
});
