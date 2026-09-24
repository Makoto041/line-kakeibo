/**
 * Web（ふたりタブ・明細の確認ボタン）向けの認証付き API
 *
 * `api` 関数（Express）に `/household` としてマウントする。Firestore ルールではクライアントから
 * status / confirmed を書けないため、状態を変える操作はここで Admin SDK を使って行う。判定と書き込みは
 * LINE の postback・「精算」コマンドと同じ関数（expenseActions.ts / firestore.ts / householdSettlement.ts）。
 *
 * - POST /household/expenses/:expenseId/actions   { action: 'confirm' }
 * - GET  /household/settlement?groupId=<id>
 * - POST /household/settlement/settle             { groupId, expectedExpenseIds }
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

import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getAuth } from 'firebase-admin/auth';
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
 */
export function isValidDocId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    !value.includes('/') &&
    value !== '.' &&
    value !== '..' &&
    !/^__.*__$/.test(value)
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
 * 配列で 500 件以下、要素はすべて `isValidDocId` を満たす文字列。
 */
export function parseExpectedExpenseIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SETTLE_IDS) return null;
  if (!value.every(isValidDocId)) return null;
  return Array.from(new Set(value as string[]));
}

/** 2 つの ID 集合が等しいか（順序・重複は無視） */
export function sameIdSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const id of setA) if (!setB.has(id)) return false;
  return true;
}

// ============================================
// 認可
// ============================================

/** groupMembers/{groupId}_{lineId} が有効（isActive === true）か。読み取りは tx があればトランザクション内で行う */
async function isActiveMember(
  db: Firestore,
  groupId: string,
  lineId: string,
  tx?: Pick<Transaction, 'get'>
): Promise<boolean> {
  if (!isValidDocId(groupId)) return false;
  const ref = db.collection('groupMembers').doc(groupMemberDocId(groupId, lineId));
  const snapshot = tx ? await tx.get(ref) : await ref.get();
  return snapshot.exists && snapshot.get('isActive') === true;
}

/**
 * 支出を書き換えてよいか（Firestore ルールの「既存の支出を書ける人」と同じ条件）
 *
 * - groupId がある → そのグループの有効メンバー（脱退者は不可）
 * - groupId も lineGroupId も無い個人支出 → 所有者（lineId が一致）
 * - lineGroupId だけを持つ旧形式 → 不可（先に groupId の backfill が必要）
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '3600');
  }
  res.setHeader('Cache-Control', 'no-store');
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
  | 'rejected'
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

/**
 * Firebase ID トークンを検証し、res.locals.lineId に検証済みの LINE userId を入れる
 *
 * 受け付けるのは `/auth/line` のカスタムトークンでサインインしたユーザー（sign_in_provider が custom で
 * lineId クレームを持つ）だけ。匿名ユーザーは 403。トークンはログに出さない。
 */
async function requireLineUser(req: Request, res: Response, next: NextFunction) {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    sendError(res, 401, 'unauthenticated');
    return;
  }

  let decoded: Awaited<ReturnType<ReturnType<typeof getAuth>['verifyIdToken']>>;
  try {
    decoded = await getAuth().verifyIdToken(token, true);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && code.startsWith('auth/') && code !== 'auth/internal-error') {
      console.warn(`household: ID token rejected (${code})`);
      sendError(res, 401, 'unauthenticated');
      return;
    }
    console.error('household: ID token verification failed:', typeof code === 'string' ? code : errorMessage(error));
    sendError(res, 500, 'internal');
    return;
  }

  const lineId = (decoded as { lineId?: unknown }).lineId;
  if (decoded.firebase?.sign_in_provider !== 'custom' || !isValidDocId(lineId)) {
    console.warn(`household: token without LINE identity (uid ${maskId(decoded.uid)})`);
    sendError(res, 403, 'forbidden');
    return;
  }

  res.locals.lineId = lineId;
  next();
}

const RATE_LIMITED_BODY = { error: 'rate_limited' };

/**
 * 認証前の IP 単位の上限
 *
 * `trust proxy` を設定していない（`/auth/line` の挙動を変えないため）ので、Cloud Run では req.ip が
 * 前段のアドレスにまとまり、実質インスタンス全体の上限になる。正規ユーザーを締め出さないよう大きめにし、
 * 実際の制限は lineId 単位の limiter に任せる。
 */
const preAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: RATE_LIMITED_BODY,
});

/** 認証後の lineId 単位の上限（IP は見ないので IP 関連の検証は切る） */
function lineIdLimiter(limit: number) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: RATE_LIMITED_BODY,
    keyGenerator: (_req, res) => `line:${String((res as Response).locals.lineId)}`,
    validate: { ip: false, trustProxy: false, xForwardedForHeader: false, forwardedHeader: false },
  });
}

const userLimiter = lineIdLimiter(60);
const settleLimiter = lineIdLimiter(5);

// ============================================
// 精算の表示内容
// ============================================

interface SettlementScope {
  id: string;
  isLine: boolean;
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
  return typeof lineGroupId === 'string' && lineGroupId.length > 0
    ? { id: lineGroupId, isLine: true }
    : { id: groupId, isLine: false };
}

export interface SettlementView {
  groupId: string;
  scope: 'line_group' | 'group';
  members: Array<{ lineId: string; displayName: string }>;
  totals: Record<string, number>;
  basis: SettlementBasis;
  reason: UndeterminableReason | null;
  settlement: { fromUserId: string; toUserId: string; amount: number } | null;
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
  const result = computeHouseholdSettlement(summaries, sortActiveMembers(members));

  // getPendingAdvances と同じ並び（createdAt 降順）
  const expenses = summaries.flatMap((s) => s.expenses).sort((a, b) => createdAtMillis(b) - createdAtMillis(a));
  const expenseIds = expenses.map((e) => e.id!);

  const view: SettlementView = {
    groupId,
    scope: scope.isLine ? 'line_group' : 'group',
    members: result.participants.map((p) => ({ lineId: p.userId, displayName: p.displayName })),
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
      console.error(`household ${name} error:`, errorMessage(error));
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
      console.warn(`household confirm: forbidden (expense ${expenseId}, user ${maskId(lineId)})`);
      sendError(res, 403, 'forbidden');
      return;
    }
    if ('reject' in result) {
      sendError(res, 409, 'rejected');
      return;
    }

    const record = result.record;
    const updatedAt = written.update?.updatedAt instanceof Date ? written.update.updatedAt : new Date();
    console.log(`household confirm: expense ${expenseId} by ${maskId(lineId)} (status: ${record.status})`);
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
 * POST /household/settlement/settle  { groupId, expectedExpenseIds }
 *
 * LINE の「精算」と同じ書き込み（settleAdvances）。表示した内容と対象がずれていれば 409 stale と
 * 最新の表示内容を返す。LINE グループへの通知（push）は送らない。
 */
householdRouter.post(
  '/settlement/settle',
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
    if (!expected) {
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
    if (current.expenseIds.length === 0) {
      sendError(res, 409, 'nothing_to_settle');
      return;
    }
    if (!sameIdSet(current.expenseIds, expected)) {
      sendError(res, 409, 'stale', { current: current.view });
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
      `household settle: group ${groupId} by ${maskId(lineId)} (settled ${result.settled}, skipped ${result.skipped})`
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

householdRouter.use((_req: Request, res: Response) => {
  sendError(res, 404, 'not_found');
});
