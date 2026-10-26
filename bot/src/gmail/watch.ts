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
 * 応答の値は、取込と同じく mailboxHistoryIdToSave で形を確かめてから使う（正規の形の文字列にする）。応答に historyId が無い・
 * 使えない形のときは書かない。保存値が使える形なら残して続け（固定文の警告）、保存値が無い・使えない形なら gmailState に何も
 * 書かずに投げる（固定文の警告。renewGmailWatch は 2 回までやり直し、/gmail/register-watch は 500 を返す）。
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

  if (!expiration) {
    throw new Error('Failed to register Gmail Watch');
  }
  // 無い・使えない形なら null（保存値が使える形なら残す。saveWatchState）。値はログに出さない
  const historyIdFromWatch = mailboxHistoryIdToSave(historyId);

  // 連携中のアカウントのアドレス（ログには出さない）
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const emailAddress = normalizeEmailAddress(profile.data.emailAddress) ?? undefined;
  if (!emailAddress) {
    console.warn('Gmail profile has no email address; keeping the saved one for the notification account check');
  }

  const { state, source } = await saveWatchState(historyIdFromWatch, parseInt(expiration, 10), emailAddress);

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
 * 取込（updateHistoryId）は、メールボックスの現在位置を正規の形の文字列で保存する（mailboxHistoryIdToSave）。
 * watch の登録・更新（registerWatch）も、watch の応答の historyId を同じ関数で確かめてから書く。
 * 以前（#298 より前）は Pub/Sub 通知の JSON の値をそのまま保存していて、数値のまま入っている可能性もあるため、
 * 0 以上の整数も使える値として扱う
 * （取込は Pub/Sub の通知の historyId と、保存してある historyId もこれで確かめる。handler.ts の handleGmailPubSub・processNewEmails）
 *
 * 文字列は 10 進の正規の形（先頭ゼロなし・20 桁以内）で uint64 以下のものだけ。先頭にゼロを並べた値は BigInt では
 * 小さい数と同じになるので大小の比較をすり抜け、長さに上限の無い文字列が保存・ログ・history.list に渡ってしまう。
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
 * - 応答の値（`fromWatch`。mailboxHistoryIdToSave で確かめた値）が null（応答に無い・使えない形）のとき、保存値が使える形なら
 *   残し（`kept`）、保存値が無い・使えない形なら null（書ける値が無い。呼び出し側は何も書かない）
 */
export function resolveWatchHistoryId(
  stored: unknown,
  fromWatch: string | null
): { historyId: string; source: WatchHistoryIdSource } | null {
  if (!stored) {
    return fromWatch === null ? null : { historyId: fromWatch, source: 'initialized' };
  }
  if (isUsableHistoryId(stored)) {
    return { historyId: String(stored), source: 'kept' };
  }
  return fromWatch === null ? null : { historyId: fromWatch, source: 'replaced' };
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
 *
 * watch の応答の historyId が無い・使えない形（historyIdFromWatch が null）のときは、保存値が使える形なら残して続け、
 * 固定文の警告を出す。保存値も無い・使えない形なら（resolveWatchHistoryId が null）、トランザクションの中で何も書かずに終え、
 * 固定文の警告を出して投げる（値は出さない）。
 */
async function saveWatchState(
  historyIdFromWatch: string | null,
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
    // 書ける historyId が無い。set の前に抜ける（何も書かない）
    if (resolved === null) return null;
    const storedAddress = normalizeEmailAddress(storedData?.emailAddress);

    transaction.set(ref, watchStateFields(resolved, watchExpiration, Timestamp.now(), emailAddress), { merge: true });

    return {
      state: { historyId: resolved.historyId, watchExpiration },
      source: resolved.source,
      accountChanged: !!emailAddress && storedAddress !== null && storedAddress !== emailAddress,
    };
  });

  if (result === null) {
    console.warn('Gmail watch response has no usable historyId and no usable historyId is stored; saved nothing (register the watch again)');
    throw Object.assign(new Error('Gmail watch response has no usable historyId'), { name: 'GmailWatchHistoryIdError' });
  }
  if (historyIdFromWatch === null) {
    console.warn('Gmail watch response has no usable historyId; kept the stored historyId');
  }
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

/**
 * 取込（handler.ts の processNewEmails）で保存する historyId。メールボックスの現在位置（Gmail の応答の historyId）を
 * 10 進の正規の形の文字列にして返す。使えない値（無い・数値として読めない・先頭ゼロ・uint64 超。isUsableHistoryId）なら null
 * （呼び出し側は保存値を進めない。範囲は次の通知でもう一度処理され、重複は gmailMessageId で弾く）
 * watch の登録・更新（registerWatch）も、watch の応答の historyId をこれで確かめる（null なら書かない。saveWatchState）。
 *
 * 現在位置は `history.list` の最初のページの historyId（最初の要求の時点の位置。404 の経路では `users.getProfile` の historyId、
 * 保存値が使えない形のときの置き換えも `users.getProfile` の historyId）。googleapis の gmail v1 の型定義（users.history.list の
 * startHistoryId の説明）が保存してよいとするのは最後のページ（nextPageToken の無い応答）の値だが、ページ送りの途中に増えた
 * 記録が後のページに載るかは確かめていないので、最初のページの値にする（載らないなら最後のページの値では取りこぼし、
 * 載るなら最初のページの値でも再処理で済む。processNewEmails）。
 *
 * Pub/Sub の通知の historyId は使わない（取込を起こす合図としてだけ使う）。通知は topic に publish できる者なら作れる
 * （通知の emailAddress の照合では偽装を防げない）。#295 では「通知の値と現在位置の小さい方」を保存していたため、偽の通知で
 * 保存値を（保存値, 現在位置］の任意の数に置けた。Gmail の history ID は連番ではなく、実在しない番号を startHistoryId に
 * 渡すと 404 になりうる（同じ型定義の説明）ので、Gmail が返した値だけを保存する。
 */
export function mailboxHistoryIdToSave(mailboxHistoryId: unknown): string | null {
  return isUsableHistoryId(mailboxHistoryId) ? BigInt(mailboxHistoryId).toString() : null;
}

/**
 * メールボックスの現在位置が、取込の開始位置（実行の開始時に読んだ保存値）より前か。どちらも 10 進の文字列（uint64 以下）
 *
 * Gmail の history ID は時間とともに増え、減らない。正当な保存値は、どれも Gmail がそれより前に返した位置（history.list・
 * getProfile・watch の応答）なので、あとで取った現在位置以下になる。現在位置が開始位置より前なら、保存値はこのメールボックスの
 * 位置ではない（#295 より前に偽の通知で入った値・revoke をせずに別のアカウントへ切り替えた後の値）。同時に走った実行が
 * 保存値を先へ進めても、開始位置は実行の開始時に読んだ値なので、この条件にはならない。等しい（新着が無い）のは正常。
 * ただし、Gmail が一時的に食い違った位置を返すことが無いかは確かめていない（直すのは同じ警告が複数の通知で続くときだけ。
 * handler.ts の warnIfMailboxBehindStart）。
 * uint64 は Number では桁が落ちるので BigInt で比べる。
 */
export function isMailboxBehindStart(mailboxHistoryId: string, startHistoryId: string): boolean {
  return BigInt(mailboxHistoryId) < BigInt(startHistoryId);
}

/**
 * 保存してある historyId が使えない形（isUsableHistoryId）のときだけ、メールボックスの現在位置（getProfile の historyId。
 * mailboxHistoryIdToSave で正規の形にした文字列）に置き換える（取込の自動復旧。handler.ts の processNewEmails）
 *
 * Firestore トランザクションの中で読み直し、文書があり、historyId があり、まだ使えない形のときだけ historyId と updatedAt を
 * merge で書く。ほかの項目（watchExpiration・emailAddress）は変えない。
 * - 文書が無い（/gmail/revoke が消した）: 作り直さない
 * - historyId が無い（§11.2 の手順で消した直後）: 書かない（次の watch の登録が入れる）
 * - すでに使える形（watch の更新・ほかの実行が先に置き換えた）: 書かない（前進のみ・巻き戻しの判断は updateHistoryId に任せる）
 *
 * @returns 置き換えたら true
 */
export async function replaceUnusableHistoryId(historyId: string): Promise<boolean> {
  const db = getFirestore();
  const ref = gmailStateRef();

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const current: unknown = snapshot.data()?.historyId;
    if (!current || isUsableHistoryId(current)) return false;

    transaction.set(ref, { historyId, updatedAt: Timestamp.now() }, { merge: true });
    return true;
  });
}

/**
 * historyIdを更新（前進のみ）
 *
 * Pub/Sub は at-least-once で順序保証が無く、取込は同時に走りうるため、先に終えた実行より古い位置を
 * 後から書くと historyId が巻き戻る。巻き戻ると次回の `history.list` が既知の範囲を取り直すことになり、
 * 404（履歴が古すぎる）と重なったときに取りこぼす。必ず新しい方を残す。
 * 取込は、メールボックスの現在位置（`mailboxHistoryIdToSave`。正規の形の文字列）を渡す。現在位置が実行の開始位置より前の
 * とき（`isMailboxBehindStart`。保存値がこのメールボックスの位置でない）は、取込はここを呼ばずに別の警告を出すので、
 * ここで巻き戻しを飛ばすのは、同時に走った実行が先に進めていたときと、現在位置が開始位置と同じ（新着なし）ときだけ。
 * 巻き戻しを飛ばしたときのログには、値ではなく桁数だけを出す（保存値は #295 より前に入った長い文字列でありうる）。
 */
export async function updateHistoryId(historyId: string): Promise<void> {
  const db = getFirestore();
  const ref = gmailStateRef();

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? (snapshot.data()?.historyId as string | undefined) : undefined;

    if (current && !isNewerHistoryId(historyId, current)) {
      console.log('Skipping historyId rollback', { currentDigits: String(current).length, incomingDigits: historyId.length });
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
