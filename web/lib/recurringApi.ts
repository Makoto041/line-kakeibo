'use client';

// 固定費（家賃・光熱費など）の API クライアント。bot の /household/recurring を Firebase の ID トークン付きで呼ぶ。
// 固定費の文書はクライアントから直接読み書きできない（Firestore ルールの既定の拒否）ため、必ずここを通す。
import { auth, ensureFirebaseInitialized } from './firebase';

export type RecurringPayment = 'shared' | 'advance';

export interface RecurringItem {
  id: string;
  name: string;
  amount: number;
  category: string;
  /** 引き落とし日（1〜31。31 は月末） */
  dayOfMonth: number;
  payment: RecurringPayment;
  payerLineId: string | null;
  active: boolean;
  lastPostedMonth: string | null;
}

export interface RecurringMember {
  lineId: string;
  displayName: string;
}

export type RecurringInput = Omit<RecurringItem, 'id' | 'lastPostedMonth'>;

const DEFAULT_AUTH_ENDPOINT = 'https://us-central1-line-kakeibo-0410.cloudfunctions.net/api/auth/line';

/** API のベース URL（/auth/line と同じ関数に載っている） */
function apiBase(): string {
  // NEXT_PUBLIC_* はビルド時に埋め込まれるため、参照は字句どおりに書く
  const explicit = (process.env.NEXT_PUBLIC_API_BASE ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const authEndpoint = (process.env.NEXT_PUBLIC_AUTH_ENDPOINT ?? '').trim() || DEFAULT_AUTH_ENDPOINT;
  return authEndpoint.replace(/\/auth\/line\/?$/, '');
}

export class RecurringApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`recurring api: ${status} ${code}`);
    this.name = 'RecurringApiError';
    this.status = status;
    this.code = code;
  }
}

/** 失敗したときに画面に出す文 */
export function recurringErrorMessage(error: unknown): string {
  if (error instanceof RecurringApiError) {
    if (error.status === 401) return 'ログインの有効期限が切れました。ページを開き直してください';
    if (error.status === 403) return 'この世帯の固定費を変更する権限がありません';
    if (error.status === 404) return '固定費が見つかりません（ほかの端末で削除された可能性があります）';
    if (error.status === 409 && error.code === 'too_many') return '固定費は30件まで登録できます';
    if (error.status === 400) return '入力内容を確認してください';
    if (error.status === 429) return '操作が多すぎます。少し待ってからやり直してください';
  }
  return '通信に失敗しました。時間をおいてやり直してください';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  ensureFirebaseInitialized();
  const user = auth?.currentUser;
  if (!user || user.isAnonymous) throw new RecurringApiError(401, 'unauthenticated');

  const send = async (forceRefresh: boolean) => {
    const token = await user.getIdToken(forceRefresh);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      return await fetch(`${apiBase()}/household${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await send(false);
  // トークンの期限切れは 1 回だけ取り直す
  if (res.status === 401) res = await send(true);
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new RecurringApiError(res.status, typeof json?.error === 'string' ? json.error : 'failed');
  return json as T;
}

export function listRecurring(groupId: string) {
  return request<{ items: RecurringItem[]; members: RecurringMember[] }>(
    'GET',
    `/recurring?groupId=${encodeURIComponent(groupId)}`
  );
}

export async function createRecurring(groupId: string, input: RecurringInput): Promise<RecurringItem> {
  const res = await request<{ item: RecurringItem }>('POST', '/recurring', { groupId, ...input });
  return res.item;
}

export async function updateRecurring(id: string, patch: Partial<RecurringInput>): Promise<RecurringItem> {
  const res = await request<{ item: RecurringItem }>('PATCH', `/recurring/${encodeURIComponent(id)}`, patch);
  return res.item;
}

export async function deleteRecurring(id: string): Promise<void> {
  await request<{ ok: true }>('DELETE', `/recurring/${encodeURIComponent(id)}`);
}

/** 「毎月27日」「毎月末日」 */
export function dayLabel(dayOfMonth: number): string {
  return dayOfMonth >= 31 ? '毎月末日' : `毎月${dayOfMonth}日`;
}
