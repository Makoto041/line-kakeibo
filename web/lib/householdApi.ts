'use client';

// bot の /household/* エンドポイントのクライアント（確認・精算の取得と記録）。
// Firebase の ID トークンを Authorization: Bearer で送る。匿名ユーザーからは呼ばない。
import { auth, ensureFirebaseInitialized } from './firebase';
import {
  classifyHouseholdFailure,
  deriveApiBase,
  isValidDocId,
  parseConfirmResponse,
  parseSettleResult,
  parseSettlementResponse,
  toastKeyForHouseholdError,
  type ConfirmedExpensePatch,
  type HouseholdErrorCode,
  type SettleResult,
  type SettlementResponse,
  type SettlementTransfer,
} from './householdContract';
import type { ToastKey } from './uiText';

export type { ConfirmedExpensePatch, HouseholdErrorCode, SettleResult, SettlementResponse, SettlementTransfer };

const REQUEST_TIMEOUT_MS = 25_000;
const MAX_SETTLE_IDS = 500;

// NEXT_PUBLIC_* はビルド時に埋め込まれるため、参照は字句どおりに書く
const API_BASE = deriveApiBase(process.env.NEXT_PUBLIC_API_BASE, process.env.NEXT_PUBLIC_AUTH_ENDPOINT);

/** API のベース URL があるか（無ければ確認・精算のボタンを無効にする） */
export function isHouseholdApiConfigured(): boolean {
  return API_BASE !== null;
}

export class HouseholdApiError extends Error {
  readonly code: HouseholdErrorCode;
  readonly status: number | null;

  constructor(code: HouseholdErrorCode, status: number | null = null) {
    super(`household api: ${code}`);
    this.name = 'HouseholdApiError';
    this.code = code;
    this.status = status;
  }
}

export function householdErrorCode(error: unknown): HouseholdErrorCode {
  return error instanceof HouseholdApiError ? error.code : 'failed';
}

/** 失敗時のトーストの語（T.toast のキー） */
export function householdErrorToast(error: unknown): ToastKey {
  return toastKeyForHouseholdError(householdErrorCode(error));
}

interface RawResponse {
  status: number;
  body: unknown;
}

async function send(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<RawResponse> {
  const base = API_BASE;
  if (!base) throw new HouseholdApiError('unavailable');
  ensureFirebaseInitialized();
  const user = auth?.currentUser;
  if (!user || user.isAnonymous) throw new HouseholdApiError('unavailable');

  // 再試行を含めた呼び出し全体の期限（1 回ごとに 25 秒を使わない）
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;

  const attempt = async (forceRefresh: boolean): Promise<RawResponse> => {
    let token: string;
    try {
      token = await user.getIdToken(forceRefresh);
    } catch {
      throw new HouseholdApiError('unauthenticated');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new HouseholdApiError('network');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const res = await fetch(`${base}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } catch {
      throw new HouseholdApiError('network');
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await attempt(false);
  // トークンの期限切れ・失効は 1 回だけ取り直して再試行する
  if (first.status === 401) return attempt(true);
  return first;
}

function fail(res: RawResponse): never {
  throw new HouseholdApiError(classifyHouseholdFailure(res.status, res.body), res.status);
}

/** 確認（LINE の OK と同じ処理）。成功したら画面に反映する項目を返す */
export async function confirmExpense(expenseId: string): Promise<ConfirmedExpensePatch> {
  if (!isValidDocId(expenseId)) throw new HouseholdApiError('invalid_request');
  const res = await send(`/household/expenses/${encodeURIComponent(expenseId)}/actions`, {
    method: 'POST',
    body: { action: 'confirm' },
  });
  if (res.status !== 200) fail(res);
  const patch = parseConfirmResponse(res.body);
  if (!patch || patch.id !== expenseId) throw new HouseholdApiError('failed', res.status);
  return patch;
}

/** ふたりの精算（未精算の立替の全件） */
export async function fetchSettlement(groupId: string): Promise<SettlementResponse> {
  if (!isValidDocId(groupId)) throw new HouseholdApiError('invalid_request');
  const res = await send(`/household/settlement?groupId=${encodeURIComponent(groupId)}`, { method: 'GET' });
  if (res.status !== 200) fail(res);
  const data = parseSettlementResponse(res.body);
  if (!data) throw new HouseholdApiError('failed', res.status);
  return data;
}

export type SettleOutcome = ({ ok: true } & SettleResult) | { ok: false; stale: SettlementResponse };

/**
 * 精算を記録する。表示した対象（expectedExpenseIds）・精算額（expectedSettlement）とサーバーの
 * 現在の内容が食い違うときは、例外ではなく最新の内容（stale）を返すので、画面を差し替えてもう一度押してもらう。
 */
export async function settle(
  groupId: string,
  expectedExpenseIds: readonly string[],
  expectedSettlement?: SettlementTransfer | null
): Promise<SettleOutcome> {
  const ids = Array.from(new Set(expectedExpenseIds));
  if (!isValidDocId(groupId) || ids.length === 0 || ids.length > MAX_SETTLE_IDS || !ids.every(isValidDocId)) {
    throw new HouseholdApiError('invalid_request');
  }
  const res = await send('/household/settlement/settle', {
    method: 'POST',
    body: {
      groupId,
      expectedExpenseIds: ids,
      ...(expectedSettlement !== undefined
        ? {
            expectedSettlement: expectedSettlement
              ? {
                  fromUserId: expectedSettlement.fromUserId,
                  toUserId: expectedSettlement.toUserId,
                  amount: expectedSettlement.amount,
                }
              : null,
          }
        : {}),
    },
  });
  if (res.status === 409) {
    const body = res.body as { error?: unknown; current?: unknown } | null;
    if (body && body.error === 'stale') {
      const current = parseSettlementResponse(body.current);
      if (current) return { ok: false, stale: current };
    }
    fail(res);
  }
  if (res.status !== 200) fail(res);
  const result = parseSettleResult(res.body);
  if (!result) throw new HouseholdApiError('failed', res.status);
  return { ok: true, ...result };
}
