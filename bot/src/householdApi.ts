/**
 * Web（精算タブ・設定・明細の確認ボタン）向けの認証付き API
 *
 * `api` 関数（Express）に `/household` としてマウントする。Firestore ルールではクライアントから
 * status / confirmed を書けないため、状態を変える操作はここで Admin SDK を使って行う。判定と書き込みは
 * LINE の postback と同じ関数（expenseActions.ts）。
 *
 * - POST /household/expenses/:expenseId/actions   { action: 'confirm' }
 * - GET  /household/legacy-advances?groupId=<id>   全額にする前の立替（advanceFull の無い advance_pending）
 * - POST /household/legacy-advances/settle        { groupId, expectedExpenseIds }（精算済みにする）
 * - POST /household/split-settings                { groupId, collectFromLineId }（期間の折半精算で集金するメンバー）
 * - GET  /household/settlement-summary?groupId=<id>  精算の通知の状態（送れるか・期間・締まった期間を送ったか）
 * - POST /household/settlement-summary/send       { groupId, period: 'closed' | 'current' }（今すぐ LINE へ送る）
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
import { isValidDocId } from './docId';
import { applyExpenseChange, decideConfirm, decideSettleLegacyAdvance } from './expenseActions';
import { getPendingAdvances, type Expense } from './firestore';
import { readActiveMember } from './householdMembers';
import { getLineClient } from './line/client';
import { buildSettlementSummaryMessages } from './line/settlementSummaryMessage';
import { errorFields, maskId } from './logSafe';
import {
  MAX_RECURRING_PER_GROUP,
  RECURRING_COLLECTION,
  dueDateFor,
  isConsistentPayment,
  loadGroupContext,
  parseRecurringInput,
  toRecurringItem,
  toRecurringView,
  type RecurringInput,
} from './recurringExpenses';
import { sendSettlementSummaryNow, settlementSummaryStatus, type SummaryPeriodKind } from './settlementSummary';
import { todayJST } from './time';
import { applyWebCorsHeaders } from './webOrigins';
import {
  CATEGORY_RULES_LIMITS,
  invalidateCategoryRules,
  parseCategoryRulesInput,
  readStoredCategoryRules,
} from './categoryRules';

/** 1 回に精算済みにできる以前の立替の件数の上限 */
export const MAX_LEGACY_SETTLE_IDS = 500;

// ============================================
// 入力検証（純関数）
// ============================================

// ドキュメント ID の判定は LINE の postback と共用（docId.ts）。既存の呼び出し・テストのためここからも export する
export { isValidDocId };

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
  return ids.length > MAX_LEGACY_SETTLE_IDS ? 'too_many' : ids;
}

/** 2 つの ID 集合が等しいか（順序・重複は無視） */
export function sameIdSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const id of setA) if (!setB.has(id)) return false;
  return true;
}

/** 手動で送る期間（closed: 締まった期間 / current: 今の期間の途中経過）。不正なら null */
export function parseSummaryPeriod(value: unknown): SummaryPeriodKind | null {
  return value === 'closed' || value === 'current' ? value : null;
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
  return (await readActiveMember(db, groupId, lineId, tx)) !== null;
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
  res.setHeader('Vary', 'Origin');
  applyWebCorsHeaders(req, res, {
    methods: 'GET, POST, PATCH, DELETE, OPTIONS',
    allowHeaders: 'Content-Type, Authorization',
  });
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
  | 'unavailable'
  | 'line_limit'
  | 'line_failed'
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
  console.error('household: unexpected error', errorFields(err));
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
      console.warn('household: ID token rejected', errorFields(error));
      return { status: 401 };
    }
    console.error('household: ID token verification failed', errorFields(error));
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
    console.warn('household: token without LINE identity', { uid: maskId(decoded.uid) });
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

/** 認証後の lineId 単位の上限（IP は見ないので IP 関連の検証は切る）。既定は 1 分あたり */
function lineIdLimiter(limit: number, options: { skipFailedRequests?: boolean; windowMs?: number } = {}) {
  const { windowMs = 60 * 1000, ...rest } = options;
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: RATE_LIMITED_BODY,
    keyGenerator: (_req, res) => `line:${String((res as Response).locals.lineId)}`,
    validate: { ip: false, trustProxy: false, xForwardedForHeader: false, forwardedHeader: false },
    ...rest,
  });
}

/** 全ルート共通（失敗した応答も数える。1 つの store を全ルートで共有） */
const userLimiter = lineIdLimiter(60);
/**
 * 以前の立替を精算済みにする操作の上限。成功したものだけを数える（400/403/409 stale などで枠を使い切らないように）。
 * 失敗の連打は userLimiter で抑える。
 */
const legacySettleLimiter = lineIdLimiter(5, { skipFailedRequests: true });
/**
 * 精算の通知を手動で送る上限（10 分に 3 回。成功したものだけ）。LINE の push は月の無料枠
 * （送信数 × 受け取る人数）を使うので、連打で使い切らないようにする。
 */
const summarySendLimiter = lineIdLimiter(3, { skipFailedRequests: true, windowMs: 10 * 60 * 1000 });

// ============================================
// 全額にする前の立替（advanceFull の無い advance_pending）
// ============================================

interface AdvanceScope {
  id: string;
  isLine: boolean;
}

/**
 * 立替を引く範囲
 *
 * LINE グループに紐づく世帯は lineGroupId 基準（以前の LINE の「立替一覧」「精算」と同じ集合）。
 * 以前の立替の精算は lineGroupId で引いていたので、それに合わせる。
 * 紐づいていなければ groupId 基準。グループが無ければ null。
 */
async function resolveScope(db: Firestore, groupId: string): Promise<AdvanceScope | null> {
  const group = await db.collection('groups').doc(groupId).get();
  if (!group.exists) return null;
  const lineGroupId = group.get('lineGroupId');
  return typeof lineGroupId === 'string' && lineGroupId.length > 0
    ? { id: lineGroupId, isLine: true }
    : { id: groupId, isLine: false };
}

export interface AdvancesView {
  groupId: string;
  /** 新しい順（createdAt 降順） */
  items: Array<{
    id: string;
    date: string;
    description: string;
    amount: number;
    category: string;
    /** 立替にした人（advanceBy、無ければ支払った人） */
    advanceBy: string | null;
    /** 立替にした人の名前（支出に記録された名前。分からなければ空文字） */
    advanceByName: string;
  }>;
  expenseIds: string[];
  asOf: string;
}

async function loadAdvances(groupId: string, scope: AdvanceScope): Promise<AdvancesView> {
  // 全額で返す立替（advanceFull）は期間の精算で返すので含めない
  const expenses = (await getPendingAdvances(scope.id, scope.isLine)).filter((e) => e.advanceFull !== true);
  return {
    groupId,
    items: expenses.map((e: Expense) => ({
      id: e.id!,
      date: typeof e.date === 'string' ? e.date : '',
      description: typeof e.description === 'string' ? e.description : '',
      amount: typeof e.amount === 'number' ? e.amount : 0,
      category: typeof e.category === 'string' ? e.category : '',
      advanceBy: e.advanceBy || e.payerId || null,
      // 以前の LINE の「立替一覧」と同じ名前の選び方（advanceBy があれば登録者の名前）
      advanceByName: (e.advanceBy ? e.userDisplayName || e.payerDisplayName : e.payerDisplayName) || '',
    })),
    expenseIds: expenses.map((e) => e.id!),
    asOf: new Date().toISOString(),
  };
}

// ============================================
// ルート
// ============================================

type Handler = (req: Request, res: Response) => Promise<void>;

/** ハンドラの例外を 500 にする（原因はログに種類だけ出す。errorFields） */
function route(name: string, handler: Handler) {
  return async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error("household handler error", { handler: name, ...errorFields(error) });
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
      // ID は利用者の入力なので、書式文字列に埋め込まず伏せてオブジェクトで出す
      console.warn('household confirm: forbidden', { expense: maskId(expenseId), user: maskId(lineId) });
      sendError(res, 403, 'forbidden');
      return;
    }
    if ('reject' in result) {
      // decideConfirm は拒否しない（精算済みも確認済みにするだけ）。ここに来たら判定関数の変更漏れなので 500
      throw new Error('confirm decision unexpectedly rejected');
    }

    const record = result.record;
    const updatedAt = written.update?.updatedAt instanceof Date ? written.update.updatedAt : new Date();
    console.log('household confirm', {
      expense: maskId(expenseId),
      user: maskId(lineId),
      status: typeof record.status === 'string' ? record.status : null,
    });
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

/** GET /household/legacy-advances?groupId=<id> — 全額にする前の立替（精算タブのお知らせ） */
householdRouter.get(
  '/legacy-advances',
  userLimiter,
  route('legacy-advances', async (req, res) => {
    const lineId = res.locals.lineId as string;
    const groupId = req.query.groupId;
    if (!isValidDocId(groupId)) {
      sendError(res, 400, 'invalid_request');
      return;
    }

    const db = getFirestore();
    // メンバー判定とグループの読み取りは並べて行い、Firestore への往復を 1 回減らす
    // （画面はこの応答を待っている）。グループの内容はメンバーと分かるまで使わない
    const [member, scope] = await Promise.all([isActiveMember(db, groupId, lineId), resolveScope(db, groupId)]);
    if (!member) {
      sendError(res, 403, 'forbidden');
      return;
    }
    if (!scope) {
      sendError(res, 404, 'not_found');
      return;
    }

    res.status(200).json(await loadAdvances(groupId, scope));
  })
);

/**
 * POST /household/legacy-advances/settle  { groupId, expectedExpenseIds }
 *
 * 全額にする前の立替を精算済み（advance_settled）にする。精算済みはどの期間の折半にも入らない。
 * 表示した対象（ID の集合）とずれていれば、409 stale と最新の一覧を返す。500 件を超えていれば 409 too_many。
 * 1 件ずつトランザクションで判定し、その間に精算済み・取り消し・全額の立替になった支出は飛ばす。
 */
householdRouter.post(
  '/legacy-advances/settle',
  userLimiter,
  legacySettleLimiter,
  route('legacy-advances-settle', async (req, res) => {
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

    const current = await loadAdvances(groupId, scope);
    if (current.expenseIds.length > MAX_LEGACY_SETTLE_IDS) {
      sendError(res, 409, 'too_many');
      return;
    }
    if (expected === 'too_many' || !sameIdSet(current.expenseIds, expected)) {
      sendError(res, 409, 'stale', { current });
      return;
    }
    if (current.expenseIds.length === 0) {
      sendError(res, 409, 'nothing_to_settle');
      return;
    }

    let settled = 0;
    let skipped = 0;
    for (const id of current.expenseIds) {
      // 読んでから書くまでの間に、別の操作（LINE の古いカードなど）で変わっていないかをトランザクション内で見る
      const now = new Date();
      const result = await applyExpenseChange(id, (data) => {
        const inScope = scope.isLine ? data.lineGroupId === scope.id : data.groupId === scope.id;
        if (!inScope) return { reject: 'out_of_scope' };
        return decideSettleLegacyAdvance(now)(data);
      });
      if (result && 'record' in result) settled += 1;
      else skipped += 1;
    }
    if (settled === 0) {
      sendError(res, 409, 'nothing_to_settle');
      return;
    }

    console.log('household legacy advances settled', { group: maskId(groupId), by: maskId(lineId), settled, skipped });
    res.status(200).json({ ok: true, settled, skipped });
  })
);

// ============================================
// 精算の通知（LINE）
// ============================================

/** GET /household/settlement-summary?groupId=<id> — 設定画面の「LINEへの精算の通知」の状態 */
householdRouter.get(
  '/settlement-summary',
  userLimiter,
  route('settlement-summary', async (req, res) => {
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
    const status = await settlementSummaryStatus(db, groupId);
    if (!status) {
      sendError(res, 404, 'not_found');
      return;
    }
    res.status(200).json(status);
  })
);

/**
 * POST /household/settlement-summary/send  { groupId, period: 'closed' | 'current' }
 *
 * 精算サマリーを今すぐ世帯の LINE グループへ送る（自動の通知と同じ内容。current は今日までの途中経過）。
 * 送れない世帯（LINE グループ無し・集金するメンバー未指定・2 人でない・固定期間）は 409 unavailable。
 * LINE の送信に失敗したら 502（429 は月の上限・送りすぎ → line_limit、それ以外 → line_failed）。
 */
householdRouter.post(
  '/settlement-summary/send',
  userLimiter,
  summarySendLimiter,
  route('settlement-summary-send', async (req, res) => {
    const lineId = res.locals.lineId as string;
    const body = req.body;
    const period = isPlainObject(body) ? parseSummaryPeriod(body.period) : null;
    if (!isPlainObject(body) || !isValidDocId(body.groupId) || !period) {
      sendError(res, 400, 'invalid_request');
      return;
    }
    const groupId = body.groupId;
    const db = getFirestore();
    if (!(await isActiveMember(db, groupId, lineId))) {
      sendError(res, 403, 'forbidden');
      return;
    }

    // 502 にするのは LINE への送信の失敗だけ（世帯・支出の読み込みの失敗は route() の 500）
    let pushError: { status: unknown; error: unknown } | null = null;
    let result;
    try {
      result = await sendSettlementSummaryNow(db, groupId, period, {
        build: buildSettlementSummaryMessages,
        push: async (to, messages, retryKey) => {
          try {
            await getLineClient().pushMessage({ to, messages }, retryKey);
          } catch (error) {
            pushError = { status: (error as { status?: unknown }).status, error };
            throw error;
          }
        },
      });
    } catch (error) {
      if (!pushError) throw error;
      const failure: { status: unknown; error: unknown } = pushError;
      console.error('household settlement summary: push failed', { group: maskId(groupId), status: failure.status, ...errorFields(failure.error) });
      sendError(res, 502, failure.status === 429 ? 'line_limit' : 'line_failed');
      return;
    }
    if (!result) {
      sendError(res, 404, 'not_found');
      return;
    }
    if (!result.ok) {
      sendError(res, 409, 'unavailable', { reason: result.reason });
      return;
    }
    console.log('household settlement summary sent', { group: maskId(groupId), by: maskId(lineId), interim: result.interim });
    res.status(200).json({ ok: true, range: result.range, interim: result.interim });
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
      .map((doc) => {
        const item = toRecurringItem(doc.id, doc.data());
        if (!item) console.warn('household recurring: skipped a malformed item', { item: maskId(doc.id) });
        return item;
      })
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

/** 固定費の文書を読み、世帯のメンバーか確かめる。だめなら応答を返して null（更新はこのあとトランザクションで読み直す） */
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
    // 同時に編集されても上書きし合わないよう、トランザクションで読み直してから書く
    const result = await ctx.db.runTransaction(async (tx) => {
      const fresh = await tx.get(ctx.ref);
      const current = fresh.exists ? toRecurringItem(ctx.item.id, fresh.data()) : null;
      if (!current || current.groupId !== ctx.item.groupId) return 'not_found' as const;
      const merged: RecurringInput = {
        name: current.name,
        amount: current.amount,
        category: current.category,
        dayOfMonth: current.dayOfMonth,
        payment: current.payment,
        payerLineId: current.payerLineId,
        active: current.active,
        ...patch,
      };
      // shared に切り替えたら立替者を外す
      if (merged.payment === 'shared') merged.payerLineId = null;
      if (
        !isConsistentPayment(merged) ||
        (merged.payerLineId !== null && merged.payerLineId !== current.payerLineId && !ctx.group.names.has(merged.payerLineId))
      ) {
        return 'invalid' as const;
      }
      // 再開したとき、今月の引き落とし日を過ぎていれば今月分は遡って入れない（作成時と同じ扱い）
      let lastPostedMonth = current.lastPostedMonth;
      if (!current.active && merged.active) {
        const today = todayJST();
        const month = today.slice(0, 7);
        if (dueDateFor(month, merged.dayOfMonth) < today && (lastPostedMonth === null || lastPostedMonth < month)) {
          lastPostedMonth = month;
        }
      }
      tx.update(ctx.ref, { ...merged, lastPostedMonth, updatedAt: new Date() });
      return { ...current, ...merged, lastPostedMonth };
    });
    if (result === 'not_found') {
      sendError(res, 404, 'not_found');
      return;
    }
    if (result === 'invalid') {
      sendError(res, 400, 'invalid_request');
      return;
    }
    console.log('household recurring: updated', { item: maskId(ctx.item.id), user: maskId(ctx.lineId) });
    res.status(200).json({ item: toRecurringView(result) });
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

// ============================================
// 期間の折半精算の設定
// ============================================

/** 集金するメンバーの指定の入力。lineId か null（指定の解除）。それ以外は undefined */
export function parseCollectFromLineId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return isValidDocId(value) ? value : undefined;
}

/**
 * POST /household/split-settings  { groupId, collectFromLineId: string | null }
 *
 * 期間の折半精算で「集金するメンバー」を世帯ごとに指定する（groups/{groupId}.splitSettings）。
 * groups はクライアントから書けないので、ここで Admin SDK を使って書く。指定できるのは世帯の有効メンバーだけ。
 */
householdRouter.post(
  '/split-settings',
  userLimiter,
  route('split-settings', async (req, res) => {
    const lineId = res.locals.lineId as string;
    const body = isPlainObject(req.body) ? req.body : null;
    const ctx = await requireGroupMember(res, body?.groupId, lineId);
    if (!ctx || !body) return;
    const collectFromLineId = parseCollectFromLineId(body.collectFromLineId);
    if (collectFromLineId === undefined || (collectFromLineId !== null && !ctx.group.names.has(collectFromLineId))) {
      sendError(res, 400, 'invalid_request');
      return;
    }
    await ctx.db
      .collection('groups')
      .doc(ctx.groupId)
      .update({ splitSettings: { collectFromLineId, updatedBy: lineId, updatedAt: new Date() } });
    console.log('household split-settings: updated', { group: maskId(ctx.groupId), user: maskId(lineId) });
    res.status(200).json({ collectFromLineId });
  })
);

// ============================================
// 世帯のカテゴリのルール（確定ルールと、AI へ伝える例）
// ============================================

/** GET /household/category-rules?groupId=<id> — 世帯のカテゴリのルールと、上限 */
householdRouter.get(
  '/category-rules',
  userLimiter,
  route('category-rules-get', async (req, res) => {
    const ctx = await requireGroupMember(res, req.query.groupId, res.locals.lineId as string);
    if (!ctx) return;
    const snap = await ctx.db.collection('groups').doc(ctx.groupId).get();
    const config = readStoredCategoryRules(snap.data()?.categoryRules);
    res.status(200).json({ ...config, limits: CATEGORY_RULES_LIMITS });
  })
);

/**
 * POST /household/category-rules  { groupId, rules: [{ keyword, category }], examples: { [category]: string[] } }
 *
 * 世帯のカテゴリのルールを丸ごと置き換える（groups/{groupId}.categoryRules）。groups はクライアントから書けないので
 * Admin SDK で書く。書けるのは世帯の有効メンバーだけ。上限・カテゴリの一覧・文字を検査し、満たさなければ 400（丸めない）。
 * 文はモデルへ渡るので、制御文字は取り除く（parseCategoryRulesInput）
 */
householdRouter.post(
  '/category-rules',
  userLimiter,
  route('category-rules-save', async (req, res) => {
    const lineId = res.locals.lineId as string;
    const body = isPlainObject(req.body) ? req.body : null;
    const ctx = await requireGroupMember(res, body?.groupId, lineId);
    if (!ctx || !body) return;
    const config = parseCategoryRulesInput({ rules: body.rules, examples: body.examples });
    if (!config) {
      sendError(res, 400, 'invalid_request');
      return;
    }
    await ctx.db
      .collection('groups')
      .doc(ctx.groupId)
      .update({ categoryRules: { ...config, updatedBy: lineId, updatedAt: new Date() } });
    invalidateCategoryRules(ctx.groupId);
    console.log('household category-rules: updated', {
      group: maskId(ctx.groupId),
      user: maskId(lineId),
      rules: config.rules.length,
    });
    res.status(200).json({ ...config, limits: CATEGORY_RULES_LIMITS });
  })
);

householdRouter.use((_req: Request, res: Response) => {
  sendError(res, 404, 'not_found');
});
