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
 * あわせて、連携中のアカウントのアドレスを getProfile で取って保存する（`emailAddress`。取込が Pub/Sub の通知と照合する。
 * handler.ts の notificationAccountOf）。getProfile は watch の後に呼ぶ（先に呼んで失敗すると watch の更新まで止まるため）。
 * getProfile が失敗したら投げる（Gmail 側の watch は更新済み。renewGmailWatch は 2 回までやり直し、/gmail/register-watch は 500 を返す）。
 * 応答にアドレスが無ければ、保存してあるアドレスを変えずに警告を出す（watch の更新は止めない）。
 *
 * @returns 保存後に有効な状態（historyId は残した値か入れた値。アドレスは含めない）
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

  // 連携中のアカウントのアドレス（ログには出さない）
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const emailAddress = normalizeEmailAddress(profile.data.emailAddress) ?? undefined;
  if (!emailAddress) {
    console.warn('Gmail profile has no email address; keeping the saved one for the notification account check');
  }

  const { state, source } = await saveWatchState(historyId.toString(), parseInt(expiration, 10), emailAddress);

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

/** historyId の最大値（uint64） */
const MAX_HISTORY_ID = BigInt('18446744073709551615');

/**
 * 保存値が historyId として使えるか。historyId は uint64 の 10 進文字列。
 * 取込（updateHistoryId）は通常 Pub/Sub 通知の JSON の値をそのまま保存し（メールボックスの現在位置の上限に
 * 掛かったときだけ、現在位置の文字列を保存する。capHistoryId）、数値のまま入っている可能性もあるため、
 * 0 以上の整数も使える値として扱う
 * （取込は Pub/Sub の通知の historyId もこれで確かめる。handler.ts の handleGmailPubSub）
 *
 * 文字列は 10 進の正規の形（先頭ゼロなし・20 桁以内）で uint64 以下のものだけ。先頭にゼロを並べた値は BigInt では
 * 小さい数と同じになるので上限（capHistoryId）をすり抜け、長さに上限の無い文字列が保存・ログ・history.list に渡ってしまう。
 * 数値も uint64 以下に限る（数値の保存値は以前どおり使える）。
 */
export function isUsableHistoryId(value: unknown): value is string | number {
  if (typeof value === 'string') return /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= MAX_HISTORY_ID;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && BigInt(value) <= MAX_HISTORY_ID;
}

/**
 * メールアドレスを比べられる形にする（前後の空白を落として小文字にする）。文字列でない・空なら null
 *
 * Gmail のアドレスは大文字小文字を区別しないので、Pub/Sub の通知（handler.ts）と getProfile（registerWatch）の
 * 表記が違っても同じアカウントとみなす。
 */
export function normalizeEmailAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

/** 保存する historyId をどこから取ったか（`resolveWatchHistoryId`） */
export type WatchHistoryIdSource = 'kept' | 'initialized' | 'replaced';

/**
 * watch の登録・更新で保存する historyId を決める
 *
 * - 保存値が数値として読めれば、応答の値より大きくても小さくても保存値を残す（`kept`）。
 *   小さい（未処理がある）ときに進めると取りこぼし、大きいときに戻すと巻き戻りになる
 * - 保存値が無い（`getWatchState` と同じく空も無し扱い）ときは応答の値を入れる（`initialized`）
 * - 保存値が数値として読めないときは `history.list` に使えないため応答の値に置き換える（`replaced`）。
 *   先頭ゼロ・21 桁以上・uint64 を超える値も読めない値として扱う（isUsableHistoryId）
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
 * 連携中のアカウントのアドレス（`emailAddress`）は、渡されたときだけ書く（historyId をどう決めたかに関係なく。
 * 渡されないとき〔getProfile の応答にアドレスが無い〕は項目を含めず、保存してある値を変えない）。
 */
export function watchStateFields(
  resolved: { historyId: string; source: WatchHistoryIdSource },
  watchExpiration: number,
  updatedAt: unknown,
  emailAddress?: string
): Record<string, unknown> {
  const fields: Record<string, unknown> = { watchExpiration, updatedAt };
  if (resolved.source !== 'kept') {
    fields.historyId = resolved.historyId;
  }
  if (emailAddress) {
    fields.emailAddress = emailAddress;
  }
  return fields;
}

/**
 * Watch状態をFirestoreに保存
 *
 * historyId の読み書きはトランザクションで行い、同時に走る `updateHistoryId`（取込の完了）を
 * 上書きしない。watchExpiration・updatedAt（と、渡されたときは emailAddress）は merge で更新する。
 *
 * 保存してあるアドレスと違うアカウントで登録したとき（/gmail/revoke をせずに別のアカウントで認可し直した）は、
 * アドレスは新しい方にするが historyId は残す（resolveWatchHistoryId のまま）ので、固定文の警告を出す。
 */
async function saveWatchState(
  historyIdFromWatch: string,
  watchExpiration: number,
  emailAddress: string | undefined
): Promise<{ state: GmailWatchState; source: WatchHistoryIdSource }> {
  const db = getFirestore();
  const ref = gmailStateRef();

  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const storedData = snapshot.exists ? snapshot.data() : undefined;
    const stored = storedData?.historyId;
    const resolved = resolveWatchHistoryId(stored, historyIdFromWatch);
    const storedAddress = normalizeEmailAddress(storedData?.emailAddress);

    transaction.set(ref, watchStateFields(resolved, watchExpiration, Timestamp.now(), emailAddress), { merge: true });

    return {
      state: { historyId: resolved.historyId, watchExpiration },
      source: resolved.source,
      accountChanged: !!emailAddress && storedAddress !== null && storedAddress !== emailAddress,
    };
  });

  if (result.source === 'replaced') {
    console.warn('Stored Gmail historyId was not numeric; replaced it with the watch response');
  }
  if (result.accountChanged) {
    console.warn('Gmail account differs from the saved one; saved the new account but kept the stored historyId (run DELETE /gmail/revoke before switching accounts)');
  }
  return { state: result.state, source: result.source };
}

/**
 * Watch状態をFirestoreから読み込み
 *
 * 連携中のアカウントのアドレス（emailAddress）は、文字列で保存されているときだけ含める（取込の照合に使う。handler.ts）。
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
    ...(typeof data.emailAddress === 'string' ? { emailAddress: data.emailAddress } : {}),
  };
}

/**
 * 連携中のアカウントのアドレス（emailAddress）だけを書き直す
 *
 * 取込（handler.ts）が、保存してあるアドレスが古い（プライマリアドレスの変更など）と分かったときに使う。
 * historyId・watchExpiration は変えない。文書が無い（/gmail/revoke の後）ときは作らずに投げる（update は NOT_FOUND）。
 */
export async function updateLinkedEmailAddress(emailAddress: string): Promise<void> {
  await gmailStateRef().update({ emailAddress, updatedAt: Timestamp.now() });
}

/** historyId は uint64 の文字列。桁があふれるので BigInt で比較する */
function isNewerHistoryId(candidate: string | number, current: string): boolean {
  try {
    return BigInt(candidate) > BigInt(current);
  } catch {
    // 数値として読めない値が入っていたら、比較を諦めて更新を許す
    return true;
  }
}

/** 取込で保存する historyId（`capHistoryId`）。`capped`: 通知の値がメールボックスの現在位置より先だったので、現在位置にした */
export type CappedHistoryId = { historyId: string | number; capped: boolean };

/**
 * 取込（handler.ts の processNewEmails）で保存する historyId を決める。通知の値に、メールボックスの現在位置で上限を掛ける
 *
 * Pub/Sub の通知は topic に publish できる者なら作れる（通知の emailAddress の照合では偽装を防げない）。通知の historyId を
 * そのまま保存すると、極端に大きい値で保存値が先へ飛び（updateHistoryId は前進のみなので戻らない）、以降の `history.list` が
 * 何も返さず（または 404）、手で直すまで取りこぼす。現在位置は Gmail の応答（`history.list` の最後のページ・`users.getProfile`
 * の historyId）から取り、通知の値は 10 進の正規の形（isUsableHistoryId。先頭ゼロなし・uint64 以下）だけを受け付けるので、
 * 偽の通知で保存値を現在位置より先へ進めることはできない（現在位置以下の値は置けるが、その範囲は同じ実行で処理済み）。
 *
 * - 通知の値 ≤ 現在位置: 通知の値（数値の通知は数値のまま保存する。文字列は正規の形にして返す。isUsableHistoryId が
 *   先頭ゼロを弾くので通常は同じ値で、多重防御）。Gmail の通知の historyId はその時点の位置なので、正当な通知は通常こちら
 *   （現在位置は同じか大きい）
 * - 通知の値 > 現在位置: 現在位置（正規の形の文字列にする。resolveWatchHistoryId と同じく文字列）。`capped: true`
 * - 現在位置が無い・数値として読めない: null（呼び出し側は保存値を進めない。範囲は次の通知でもう一度処理され、重複は gmailMessageId で弾く）
 * - 通知の値が数値として読めない（handleGmailPubSub が弾くので通常は起きない）: 現在位置。`capped: true`
 *
 * 比較は BigInt（uint64。isNewerHistoryId と同じ）。
 */
export function capHistoryId(notified: string | number, mailboxHistoryId: unknown): CappedHistoryId | null {
  if (!isUsableHistoryId(mailboxHistoryId)) return null;
  const mailbox = BigInt(mailboxHistoryId);
  if (isUsableHistoryId(notified) && BigInt(notified) <= mailbox) {
    return { historyId: typeof notified === 'string' ? BigInt(notified).toString() : notified, capped: false };
  }
  return { historyId: mailbox.toString(), capped: true };
}

/**
 * historyIdを更新（前進のみ）
 *
 * Pub/Sub は at-least-once で順序保証が無いため、古い通知が後着すると historyId が
 * 巻き戻る。巻き戻ると次回の `history.list` が既知の範囲を取り直すことになり、
 * 404（履歴が古すぎる）と重なったときに取りこぼす。必ず新しい方を残す。
 * 取込は、通知の値にメールボックスの現在位置で上限を掛けてから渡す（`capHistoryId`）。
 * 数値の historyId（Pub/Sub の通知の形）は型を変えずに保存する。
 */
export async function updateHistoryId(historyId: string | number): Promise<void> {
  const db = getFirestore();
  const ref = gmailStateRef();

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? (snapshot.data()?.historyId as string | undefined) : undefined;

    if (current && !isNewerHistoryId(historyId, current)) {
      console.log('Skipping historyId rollback', { current: String(current), incoming: String(historyId) });
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
