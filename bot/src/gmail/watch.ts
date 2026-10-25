/**
 * Gmail Watch管理
 *
 * Gmail Push Notificationを使用して新着メールを監視
 * Watchは7日間の有効期限があるため、6日ごとに自動更新
 */

import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getGmailClient } from './auth';
import { GmailWatchState } from './types';

// Pub/Subトピック名
const PUBSUB_TOPIC = 'projects/line-kakeibo-0410/topics/gmail-notifications';

/**
 * Gmail Watchを登録（初回・更新・管理 API の register-watch で共通）
 * 新着メールがあるとPub/Subにメッセージが送信される
 *
 * 保存してある historyId は上書きしない（`resolveWatchHistoryId`）。watch の応答の historyId は
 * 「今のメールボックスの位置」なので、取込が失敗して historyId が止まっている間にこれで上書きすると、
 * 未処理の範囲が二度と `history.list` に載らず取りこぼす。応答の値を使うのは、保存値が無いとき
 * （初回・/gmail/revoke の後）と、保存値が数値として読めないときだけ。
 *
 * @returns 保存後に有効な状態（historyId は残した値か入れた値）
 */
export async function registerWatch(): Promise<GmailWatchState> {
  const gmail = await getGmailClient();

  // watch はトランザクションの外で 1 回だけ呼ぶ（トランザクションは競合すると再実行されるため）
  const response = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: PUBSUB_TOPIC,
      labelIds: ['INBOX'], // INBOXのみを監視
    },
  });

  const { historyId, expiration } = response.data;

  if (!historyId || !expiration) {
    throw new Error('Failed to register Gmail Watch');
  }

  const { state, source } = await saveWatchState(historyId.toString(), parseInt(expiration, 10));

  console.log('Gmail Watch registered', {
    expiresAt: new Date(state.watchExpiration).toISOString(),
    historyIdSource: source,
  });
  return state;
}

/**
 * Gmail Watchを更新（6日ごとに呼び出す）
 *
 * stop は呼ばずに watch を呼び直す。Gmail API の users.watch は「Set up or update a push
 * notification watch」で、push ガイドの「Renew mailbox watch」も 7 日以内に watch を呼び直すこと
 * だけを求めている。以前の stop → watch の順では、watch が失敗すると次の実行まで通知が止まっていた。
 * watch が失敗しても、既存の watch は期限まで生きたまま（次の実行でやり直す）。
 */
export async function renewWatch(): Promise<GmailWatchState> {
  console.log('Renewing Gmail Watch...');
  return registerWatch();
}

/** Watch 状態の保存先（Firestore: system/gmailState）。管理 API もここを使う */
export function gmailStateRef() {
  return getFirestore().collection('system').doc('gmailState');
}

/**
 * 保存値が historyId として使えるか。historyId は uint64 の 10 進文字列。
 * 取込（updateHistoryId）は Pub/Sub 通知の JSON の値をそのまま保存するため、
 * 数値のまま入っている可能性も考え、0 以上の整数も使える値として扱う
 */
function isUsableHistoryId(value: unknown): value is string | number {
  if (typeof value === 'string') return /^\d+$/.test(value);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 保存する historyId をどこから取ったか（`resolveWatchHistoryId`） */
export type WatchHistoryIdSource = 'kept' | 'initialized' | 'replaced';

/**
 * watch の登録・更新で保存する historyId を決める
 *
 * - 保存値が数値として読めれば、応答の値より大きくても小さくても保存値を残す（`kept`）。
 *   小さい（未処理がある）ときに進めると取りこぼし、大きいときに戻すと巻き戻りになる
 * - 保存値が無い（`getWatchState` と同じく空も無し扱い）ときは応答の値を入れる（`initialized`）
 * - 保存値が数値として読めないときは `history.list` に使えないため応答の値に置き換える（`replaced`）
 */
export function resolveWatchHistoryId(
  stored: unknown,
  fromWatch: string
): { historyId: string; source: WatchHistoryIdSource } {
  if (!stored) {
    return { historyId: fromWatch, source: 'initialized' };
  }
  if (isUsableHistoryId(stored)) {
    return { historyId: String(stored), source: 'kept' };
  }
  return { historyId: fromWatch, source: 'replaced' };
}

/**
 * watch の登録・更新で `system/gmailState` に merge で書く項目
 *
 * historyId を書くのは、保存値が無い・使えないとき（`initialized` / `replaced`）だけ。
 * 保存値を残すとき（`kept`）は historyId の項目自体を含めず、watchExpiration と updatedAt だけを書く。
 */
export function watchStateFields(
  resolved: { historyId: string; source: WatchHistoryIdSource },
  watchExpiration: number,
  updatedAt: unknown
): Record<string, unknown> {
  const fields: Record<string, unknown> = { watchExpiration, updatedAt };
  if (resolved.source !== 'kept') {
    fields.historyId = resolved.historyId;
  }
  return fields;
}

/**
 * Watch状態をFirestoreに保存
 *
 * historyId の読み書きはトランザクションで行い、同時に走る `updateHistoryId`（取込の完了）を
 * 上書きしない。watchExpiration・updatedAt は merge で更新する。
 */
async function saveWatchState(
  historyIdFromWatch: string,
  watchExpiration: number
): Promise<{ state: GmailWatchState; source: WatchHistoryIdSource }> {
  const db = getFirestore();
  const ref = gmailStateRef();

  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const stored = snapshot.exists ? snapshot.data()?.historyId : undefined;
    const resolved = resolveWatchHistoryId(stored, historyIdFromWatch);

    transaction.set(ref, watchStateFields(resolved, watchExpiration, Timestamp.now()), { merge: true });

    return { state: { historyId: resolved.historyId, watchExpiration }, source: resolved.source };
  });

  if (result.source === 'replaced') {
    console.warn('Stored Gmail historyId was not numeric; replaced it with the watch response');
  }
  return result;
}

/**
 * Watch状態をFirestoreから読み込み
 */
export async function getWatchState(): Promise<GmailWatchState | null> {
  const doc = await gmailStateRef().get();

  if (!doc.exists) {
    return null;
  }

  const data = doc.data();
  if (!data?.historyId) {
    return null;
  }

  return {
    historyId: data.historyId,
    watchExpiration: data.watchExpiration,
  };
}

/** historyId は uint64 の文字列。桁があふれるので BigInt で比較する */
function isNewerHistoryId(candidate: string, current: string): boolean {
  try {
    return BigInt(candidate) > BigInt(current);
  } catch {
    // 数値として読めない値が入っていたら、比較を諦めて更新を許す
    return true;
  }
}

/**
 * historyIdを更新（前進のみ）
 *
 * Pub/Sub は at-least-once で順序保証が無いため、古い通知が後着すると historyId が
 * 巻き戻る。巻き戻ると次回の `history.list` が既知の範囲を取り直すことになり、
 * 404（履歴が古すぎる）と重なったときに取りこぼす。必ず新しい方を残す。
 */
export async function updateHistoryId(historyId: string): Promise<void> {
  const db = getFirestore();
  const ref = gmailStateRef();

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? (snapshot.data()?.historyId as string | undefined) : undefined;

    if (current && !isNewerHistoryId(historyId, current)) {
      console.log(`Skipping historyId rollback: current=${current}, incoming=${historyId}`);
      return;
    }

    transaction.set(ref, { historyId, updatedAt: Timestamp.now() }, { merge: true });
  });
}

/**
 * Watch状態のサマリーを取得（デバッグ用）
 */
export async function getWatchStatus(): Promise<{
  isConfigured: boolean;
  historyId: string | null;
  expiresAt: Date | null;
  isExpiringSoon: boolean;
}> {
  const state = await getWatchState();

  if (!state) {
    return {
      isConfigured: false,
      historyId: null,
      expiresAt: null,
      isExpiringSoon: true,
    };
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  const isExpiringSoon = state.watchExpiration < Date.now() + oneDayMs;

  return {
    isConfigured: true,
    historyId: state.historyId,
    expiresAt: new Date(state.watchExpiration),
    isExpiringSoon,
  };
}
