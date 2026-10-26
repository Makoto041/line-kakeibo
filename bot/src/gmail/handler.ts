/**
 * Gmail Pub/Subハンドラー
 *
 * Gmailから新着メール通知を受け取り、
 * 三井住友カードの利用通知を処理して支出を自動登録
 */

import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { formatJST, toJSTDateString } from '../time';
import { getGmailClient, GmailTokenMissingError } from './auth';
import {
  getWatchState,
  isMailboxBehindStart,
  isUsableHistoryId,
  mailboxHistoryIdToSave,
  normalizeEmailAddress,
  replaceUnusableHistoryId,
  updateHistoryId,
  updateLinkedEmailAddress,
} from './watch';
import {
  isSMBCGoldVISANL,
  parseSMBCCardEmail,
  decodeEmailBody,
  getFromAddress,
  isDuplicateExpense,
  getExpenseIdByGmailMessageId,
} from './parser';
import {
  GmailPubSubPayload,
  ParsedCardNotification,
  getCategoryEmoji,
} from './types';
import { saveGmailExpenseAtomic } from '../firestore';
import { classifyExpense } from '../geminiCategoryClassifier';
import type { ClassificationResult } from '../geminiCategoryClassifier';
import type { CardUsageInfo, CategoryOrigin } from '../line/flexMessage';
import { subCategoriesOf } from '../categoryTaxonomy';
import { resolveSubCategory } from '../subCategoryRules';
import { errorFields, maskId } from '../logSafe';
import { cardNoticeFor, deliverPendingCardNotice, discardCardNotices } from './cardNotice';
import type { CardNoticeDelivery } from './cardNotice';

// システム用のLINE ID（Gmail自動取得用）
const GMAIL_SYSTEM_LINE_ID = 'gmail-auto-system';

/**
 * 店名の分類結果から、カテゴリとその判定元（最初のカードの括弧に出す）を決める。
 * 店名は確信度に関係なく採用し、既定のカテゴリも使わない。決まらなければ「その他」（unclassified）
 */
export function merchantCategoryOf(r: ClassificationResult): { category: string; origin?: CategoryOrigin } {
  return r.category ? { category: r.category, origin: r.provider } : { category: 'その他', origin: 'unclassified' };
}

/**
 * カード利用通知の中項目（#235）。店名を辞書で照合し、メールに時刻があれば飲食店を朝ご飯・昼ご飯・夜ご飯にする
 * （resolveSubCategory。時刻が無いメールでは usedAt を渡さない）。
 * 決まらなければ undefined（保存で項目ごと付かない）。判定に失敗しても投げず undefined にして、保存は続ける。
 * 大項目に中項目の一覧があるとき（食費・娯楽）だけ、結果をログに出す（店名・ID は出さない）。
 */
export function merchantSubCategoryOf(
  category: string,
  parsed: Pick<ParsedCardNotification, 'merchant' | 'usedAt' | 'usedAtHasTime'>
): string | undefined {
  try {
    const sub = resolveSubCategory({
      major: category,
      text: parsed.merchant,
      source: 'merchant',
      usedAt: parsed.usedAtHasTime ? parsed.usedAt : undefined,
    });
    if (subCategoriesOf(category).length > 0) {
      console.log('Subcategory resolved', { source: 'merchant', subCategory: sub ?? null });
    }
    return sub ?? undefined;
  } catch (error) {
    console.warn('Subcategory resolution failed', { source: 'merchant', ...errorFields(error) });
    return undefined;
  }
}

/**
 * カード利用通知に出す内容（保存した値と揃える。expenseId は保存で決まるので含めない）
 */
function cardUsageOf(
  parsed: Pick<ParsedCardNotification, 'merchant' | 'amount' | 'usedAt'>,
  category: string,
  subCategory: string | undefined,
  categoryOrigin: CategoryOrigin | undefined
): Omit<CardUsageInfo, 'expenseId'> {
  return {
    merchant: parsed.merchant,
    amount: parsed.amount,
    category,
    subCategory, // 保存した中項目（決め直さない）
    categoryOrigin,
    categoryEmoji: getCategoryEmoji(category),
    date: formatJST(parsed.usedAt, 'M/D'),
    // 保存時の値と揃える（Gmail自動取得は共同費として確定で入る）
    status: 'shared',
    includeInTotal: true,
  };
}

// デフォルトのグループID（環境変数から取得）
const getDefaultGroupId = (): string | undefined => {
  return process.env.DEFAULT_GROUP_ID;
};

const getDefaultLineGroupId = (): string | undefined => {
  return process.env.LINE_GROUP_ID;
};

/**
 * Pub/Sub の通知の本文（base64 の JSON。`{ emailAddress, historyId }`）から historyId を取り出す
 *
 * JSON として読めない・オブジェクトでない・historyId が無い・数値として読めない（watch.ts の isUsableHistoryId。
 * 先頭ゼロ・21 桁以上・uint64 を超える値も含む）ときは null。どれもやり直しても直らない。
 * historyId は Gmail が数値で送るので、型は変えずにそのまま返す。通知の historyId は取込を起こす合図としてだけ使い、
 * 保存しない（保存するのはメールボックスの現在位置。processNewEmails）。それでも形を確かめるのは、読めない通知
 * （偽の通知を含む）で取込を起こさず、ログにも長い値を出さないため。
 */
export function historyIdOfPubSubData(data: unknown): string | number | null {
  if (typeof data !== 'string') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const historyId = (payload as Partial<GmailPubSubPayload>).historyId;
  return isUsableHistoryId(historyId) ? historyId : null;
}

/**
 * Pub/Sub の通知の本文から emailAddress（通知を出したアカウント）を取り出す（小文字にする。watch.ts の normalizeEmailAddress）
 *
 * JSON として読めない・オブジェクトでない・emailAddress が文字列でない・空のときは null。照合は notificationAccountOf。
 */
export function emailAddressOfPubSubData(data: unknown): string | null {
  if (typeof data !== 'string') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  return normalizeEmailAddress((payload as Partial<GmailPubSubPayload>).emailAddress);
}

/** 通知のアカウントと連携中のアカウントの照合の結果（`notificationAccountOf`） */
export type NotificationAccountCheck = 'match' | 'mismatch' | 'unchecked';

/**
 * Pub/Sub の通知が、連携中のアカウント（registerWatch が system/gmailState に保存したアドレス）のものか
 *
 * - `match`: 同じアドレス（大文字小文字と前後の空白は無視する）
 * - `mismatch`: 違うアドレス、または通知にアドレスが無い（確かめられない）。取込は、保存してあるアドレスが古いだけでなければ
 *   （followLinkedAddressChange）読み飛ばし、historyId を更新しない。
 *   アカウントを切り替えたあとも、/gmail/revoke が古いアカウントの watch を止められなかったとき（watchStopped: false）や、
 *   revoke をせずに認可し直したときは、古いアカウントの watch が最大 7 日通知しうる。その通知の historyId は別のメールボックスの
 *   番号だが、取込は通知の historyId を保存しない（保存するのは連携中のメールボックスの現在位置。processNewEmails）ので、
 *   保存する位置はずれない。この照合は、連携中でないアカウントの通知で取込を起こさないためにある。読み飛ばしても取りこぼさない
 *   （取込は保存してある historyId からの全範囲を処理するので、その範囲は連携中のアカウントの次の通知で処理される）
 * - `unchecked`: 連携中のアドレスが保存されていない（この照合を入れる前に登録した watch の状態。次の watch の更新で保存される）。
 *   照合せずに以前どおり処理する（取込を止めない）
 */
export function notificationAccountOf(notified: unknown, linked: unknown): NotificationAccountCheck {
  const linkedAddress = normalizeEmailAddress(linked);
  if (linkedAddress === null) return 'unchecked';
  return normalizeEmailAddress(notified) === linkedAddress ? 'match' : 'mismatch';
}

/**
 * 照合が合わなかった（`mismatch`）通知について、保存してあるアドレスが古いだけかを確かめる
 *
 * 連携中のアカウント（トークンのアカウント）のアドレスを users.getProfile で取り、通知のアドレスと同じなら、
 * 保存してあるアドレスが古い（プライマリアドレスの変更など）だけなので、保存値を書き直して true を返す（取込を続ける）。
 * 照合の誤判定で取込が止まらないようにするため。違うアカウントの通知・偽の通知は getProfile のアドレスと一致しないので false。
 * 呼ぶのは mismatch の通知 1 件につき最大 1 回（通知にアドレスが無ければ呼ばずに false）。
 * getProfile・保存値の書き直しの失敗は一時的な失敗として投げる（Pub/Sub に再送させる）。アドレスはログに出さない。
 */
async function followLinkedAddressChange(
  gmail: Awaited<ReturnType<typeof getGmailClient>>,
  notified: string | null
): Promise<boolean> {
  const notifiedAddress = normalizeEmailAddress(notified);
  if (notifiedAddress === null) return false;
  const profile = await gmail.users.getProfile({ userId: 'me' });
  if (normalizeEmailAddress(profile.data.emailAddress) !== notifiedAddress) return false;
  await updateLinkedEmailAddress(notifiedAddress);
  console.warn('Linked Gmail address changed; updated the saved address to the current profile and processing the notification');
  return true;
}

/**
 * Pub/Subメッセージを処理
 * Cloud Functions: onMessagePublished で呼び出される
 *
 * 投げると関数が失敗し、Pub/Sub が同じ通知を再送する（index.ts の gmailPubSubHandler は `retry: true`）。
 * やり直しても直らないとき（本文から historyId が読めない・Gmail のトークンが無い・watch の状態が無い・
 * 通知が連携中のアカウントのものでない）は、投げずに固定文の警告を出して終える（再送させない）。
 * 一時的な失敗（Gmail・Firestore・LINE の 5xx など）は投げる。
 *
 * 投げるのは、元の例外ではなく固定文の Error（名前は GmailImportError）。関数の外へ投げた例外は、実行環境
 * （functions-framework）が `console.error(err.stack || err)` で名前・文言ごとログに出すため、元の例外の種類は
 * 投げる前に errorFields でログに出す（docs/SECURITY_OPERATIONS.md §9）。元の例外は cause に付けない
 * （err.stack には cause が入らないので付けても診断には使えず、`console.error(err)` で出すと cause の文言まで出る）。
 */
export async function handleGmailPubSub(data: string): Promise<void> {
  const historyId = historyIdOfPubSubData(data);
  if (historyId === null) {
    // 本文にはメールアドレスが入るので出さない
    console.warn('Gmail Pub/Sub message has no usable historyId; dropping it (retrying does not help)');
    return;
  }

  // historyId は 20 桁以内の数字だけ（isUsableHistoryId で確かめた。長い値はここまで来ない）
  console.log('Gmail Pub/Sub received', { historyId: String(historyId) });

  try {
    // 新着メールを取得して処理（通知の historyId は渡さない。取込は保存してある historyId から始め、メールボックスの
    // 現在位置を保存する。アドレスは連携中のアカウントとの照合に使う）
    await processNewEmails(emailAddressOfPubSubData(data));
  } catch (error) {
    console.error('Failed to handle Gmail Pub/Sub', errorFields(error));
    // 投げることで Pub/Sub が再送する（投げるかどうかは元の例外と同じ）。文言は固定にする
    throw Object.assign(new Error('Gmail import failed; Pub/Sub retries the notification'), { name: 'GmailImportError' });
  }
}

/**
 * 同じメッセージを諦める条件（`shouldAbandon`）: 試行がこの回数以上で、かつ最初の失敗から MESSAGE_ABANDON_AFTER_MS 以上たったとき
 *
 * 恒久的に処理できないメールで historyId が永久に止まるのを防ぐ。回数だけで決めないのは、関数の失敗を
 * Pub/Sub が 10〜600 秒の間隔で再送する（index.ts の `retry: true`）うえ、同じ範囲を新しい通知も処理するので、
 * 3 回は数分で使い切ってしまい、一過性の障害（LINE・Firestore・Gmail API の数分〜数時間の停止）でも諦めてしまうため。
 */
const MAX_MESSAGE_ATTEMPTS = 3;

/** 最初の失敗から、諦めてよくなるまでの時間（6 時間） */
export const MESSAGE_ABANDON_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Pub/Sub の通知をこれより古ければ処理せずに捨てる（12 時間。`isStaleGmailEvent`）
 *
 * 再送は最大 24 時間続く（2nd gen の再試行期間）。Gmail の認可切れなど、メール単位の諦め（6 時間）に
 * 届かない失敗で、同じ通知を 1 日中やり直し続けないようにする。捨てても取りこぼさない: 取込は通知の
 * historyId ではなく、保存してある historyId（system/gmailState）からの全範囲を処理するので、
 * その範囲は次の新しい通知（INBOX に何か届いたとき）で処理される。
 */
export const STALE_GMAIL_EVENT_MS = 12 * 60 * 60 * 1000;

/**
 * 同じメッセージを諦めるか（試行 MAX_MESSAGE_ATTEMPTS 回以上 **かつ** 最初の失敗から MESSAGE_ABANDON_AFTER_MS 以上）
 *
 * 最初の失敗の時刻が読めない（不正な Date）ときは、時間の条件を外して回数だけで決める
 * （時刻が読めないまま historyId が永久に止まらないように。`firstFailedAtOf` は常に読める時刻を返すので、通常は起きない）。
 */
export function shouldAbandon(attempts: number, firstFailedAt: Date, now: Date): boolean {
  if (!(attempts >= MAX_MESSAGE_ATTEMPTS)) return false;
  const elapsedMs = now.getTime() - firstFailedAt.getTime();
  if (Number.isNaN(elapsedMs)) return true;
  return elapsedMs >= MESSAGE_ABANDON_AFTER_MS;
}

function millisOf(value: unknown): number {
  const ts = value as { toMillis?: () => number } | null | undefined;
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : NaN;
}

/**
 * 失敗の記録に入れる「最初の失敗の時刻」
 *
 * 前回までの記録の firstFailedAt を引き継ぐ。firstFailedAt を持たない記録（この項目を足す前の記録）は lastFailedAt で代用し、
 * どちらも読めない・now より後（時計のずれ・壊れた値）なら now にする（記録が無い初回の失敗も now）。
 */
export function firstFailedAtOf(previous: unknown, now: Date): Date {
  const record = previous as { firstFailedAt?: unknown; lastFailedAt?: unknown } | null | undefined;
  for (const candidate of [record?.firstFailedAt, record?.lastFailedAt]) {
    const ms = millisOf(candidate);
    if (Number.isFinite(ms) && ms <= now.getTime()) return new Date(ms);
  }
  return now;
}

/**
 * Pub/Sub の通知が古すぎて捨てるか（`STALE_GMAIL_EVENT_MS` より古い）
 *
 * @param eventTime Pub/Sub のメッセージの publishTime（RFC 3339。再送でも変わらない。index.ts は防御として、無いときだけ
 *   CloudEvent の time を渡すが、firebase-functions の Message は publishTime を必ず埋めるので本番では起きない）
 * 時刻が読めないときは捨てない（処理しても取りこぼし・二重登録は起きないので、処理する側に倒す）。
 */
export function isStaleGmailEvent(eventTime: string | undefined, now: Date): boolean {
  const publishedAt = typeof eventTime === 'string' ? Date.parse(eventTime) : NaN;
  if (Number.isNaN(publishedAt)) return false;
  return now.getTime() - publishedAt > STALE_GMAIL_EVENT_MS;
}

/** ログに出す例外の種類（logSafe.ts に移した。smoke-gmail-retry.js がここから読むので export を残す） */
export { errorFields };

/** Gmail API の 404（gaxios 7 は JSON のエラーの code を error.code に、HTTP の状態を error.status に入れる） */
function isGmailNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown } | null | undefined;
  return e?.code === 404 || e?.status === 404;
}

/**
 * 取込で保存する historyId を決める（watch.ts の mailboxHistoryIdToSave。メールボックスの現在位置を正規の形の文字列にする）
 *
 * 現在位置が取れなかったときは固定文の警告を出す（値・アドレスは出さない。source はどの応答の現在位置か）。
 * そのときは null（呼び出し側は historyId を進めず、送信待ちの印も消さない）。
 */
function historyIdToSave(mailboxHistoryId: unknown, source: 'history.list' | 'getProfile'): string | null {
  const next = mailboxHistoryIdToSave(mailboxHistoryId);
  if (next === null) {
    console.warn('Gmail did not return the mailbox historyId; keeping the saved historyId (the range is processed again on the next notification)', { source });
  }
  return next;
}

/**
 * メールボックスの現在位置が実行の開始位置（保存値）より前か（watch.ts の isMailboxBehindStart）。前なら固定文の警告を出して true
 *
 * そのときの保存値はこのメールボックスの位置ではなく（#295 より前に偽の通知で入った値・revoke をせずにアカウントを切り替えた後の値）、
 * 前進のみの更新では直らないので、手で直すまで何も取り込まれない（直し方は docs/GMAIL_AUTO_SPEC.md §11.2）。同時に走った実行による
 * 正当な巻き戻しの回避（updateHistoryId の `Skipping historyId rollback`）と見分けられるよう、別の警告にする。
 * 直すのは、同じ警告が複数の通知で続くときだけ（Gmail が一時的に食い違った位置を返す可能性は確かめていないため。直すと
 * 保存値から今の位置までのメールは取り込まれない）。警告の文にもそう書く。
 * 呼び出し側は historyId を書かず、送信待ちの印も消さずに終える。値は出さず、桁数と、どの応答の現在位置か（source）だけを出す。
 */
function warnIfMailboxBehindStart(next: string, startHistoryId: string, source: 'history.list' | 'getProfile'): boolean {
  if (!isMailboxBehindStart(next, startHistoryId)) return false;
  console.warn('Stored Gmail historyId is ahead of the mailbox; nothing is imported until it is reset (reset it only if this repeats on later notifications; see GMAIL_AUTO_SPEC 11.2)', {
    source,
    storedDigits: startHistoryId.length,
    mailboxDigits: next.length,
  });
  return true;
}

/**
 * 保存してある historyId が使えない形（isUsableHistoryId）のときの自動復旧（#300）
 *
 * users.getProfile の historyId（連携中のメールボックスの現在位置）を、保存値がまだ使えない形のときだけ書く
 * （watch.ts の replaceUnusableHistoryId。トランザクションの中で確かめる）。history.list は呼ばない（置き換えた位置から先は、
 * 次の通知で処理する）。書く値は Gmail が返した位置で、通知の内容に関係しないので、通知のアカウントの照合より前に行う。
 *
 * 置き換えた位置より前のメール（この通知を起こしたメールを含む）は取り込まない。history.list の 404 で先へ飛ばすときと同じで、
 * 以前（この復旧の前）も次の watch の更新（最長約 6 日）か /gmail/register-watch で watch の応答の位置に置き換わるまで取込が止まり、
 * その間のメールは取り込まれなかった。飛ばした範囲のメールは再処理しないので、404 のときと同じく、失敗の記録にあるメールの
 * 送信待ちの印も消す。
 * getProfile の失敗・historyId が無いときは、投げずに固定文の警告を出して終える（保存値は変えない。次の通知か watch の更新で直る）。
 * Firestore の失敗は一時的な失敗として投げる（Pub/Sub に再送させる）。値・アドレスはログに出さない。
 */
async function recoverUnusableHistoryId(gmail: Awaited<ReturnType<typeof getGmailClient>>): Promise<void> {
  let profileHistoryId: unknown;
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    profileHistoryId = profile.data.historyId;
  } catch (error) {
    console.warn('Stored Gmail historyId is not usable and getProfile failed; keeping it (retried on the next notification)', errorFields(error));
    return;
  }
  const next = mailboxHistoryIdToSave(profileHistoryId);
  if (next === null) {
    console.warn('Stored Gmail historyId is not usable and getProfile returned no historyId; keeping it (retried on the next notification)');
    return;
  }
  // 印を消す対象（失敗の記録）は、置き換えを確定させる前に読む。確定の後に読むと、置き換えた位置から始めた実行が記録した失敗
  // （その位置より後のメール。再処理される）の印まで消しうる。failedMessageIds は投げない（読めなければ空）
  const failed = await failedMessageIds();
  if (!(await replaceUnusableHistoryId(next))) {
    // watch の更新・ほかの実行が先に置き換えた、または revoke で消えた
    console.log('Stored Gmail historyId was already replaced or removed; skipping');
    return;
  }
  console.error('Stored Gmail historyId was not usable; replaced it with the mailbox position, and mail before it is NOT imported');
  await discardCardNotices(failed, 'history_skipped');
}

/**
 * 失敗の記録に入れる、最後の失敗の種類（errorFields の項目。文言は入れない）
 *
 * Gmail・Firestore・LINE のエラーの文言には、文書のパス（LINE の ID を含みうる）・応答の本文が入るので保存しない。
 * merge で書くため、今回の例外に無い項目は消す（前の失敗の値が残って、違う失敗の項目が混ざらないように）。
 * 以前の記録にある文言（lastError）もここで消す。
 */
function failureErrorFieldsOf(error: unknown): Record<string, unknown> {
  const fields = errorFields(error);
  return {
    errorName: fields.errorName,
    errorCode: fields.errorCode ?? FieldValue.delete(),
    errorCause: fields.errorCause ?? FieldValue.delete(),
    errorStatus: fields.errorStatus ?? FieldValue.delete(),
    lastError: FieldValue.delete(),
  };
}

/**
 * 失敗したメッセージの記録。`system/gmailFailures` に messageId ごとの試行回数と、最初・最後の失敗の時刻、
 * 最後の失敗の種類（failureErrorFieldsOf。文言は保存しない）を持つ
 *
 * @returns 今回を含めた試行回数と、最初の失敗の時刻（諦めるかは呼び出し側が `shouldAbandon` で決める）
 */
async function recordMessageFailure(
  messageId: string,
  error: unknown,
  now: Date
): Promise<{ attempts: number; firstFailedAt: Date }> {
  const db = getFirestore();
  const ref = db.collection('system').doc('gmailFailures');

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const failures = (snapshot.exists ? snapshot.data() : {}) || {};
    const previousRecord = failures[messageId];
    const previous = (previousRecord?.attempts as number | undefined) ?? 0;
    const attempts = previous + 1;
    const firstFailedAt = firstFailedAtOf(previousRecord, now);

    transaction.set(
      ref,
      {
        [messageId]: {
          attempts,
          ...failureErrorFieldsOf(error),
          firstFailedAt: Timestamp.fromDate(firstFailedAt),
          lastFailedAt: Timestamp.fromDate(now),
        },
      },
      { merge: true }
    );

    return { attempts, firstFailedAt };
  });
}

/** 失敗の記録にあるメッセージ ID（読めなければ空。呼び出し側の処理は止めない） */
async function failedMessageIds(): Promise<string[]> {
  try {
    const snapshot = await getFirestore().collection('system').doc('gmailFailures').get();
    return snapshot.exists ? Object.keys(snapshot.data() ?? {}) : [];
  } catch (error) {
    console.warn('Failed to read the Gmail failure records', { errorName: error instanceof Error ? error.name : typeof error });
    return [];
  }
}

/** 処理できたメッセージを失敗記録から外す */
async function clearMessageFailure(messageId: string): Promise<void> {
  const db = getFirestore();
  await db
    .collection('system')
    .doc('gmailFailures')
    .set({ [messageId]: FieldValue.delete() }, { merge: true })
    .catch((error) => console.warn('Failed to clear the Gmail failure record', { message: maskId(messageId), ...errorFields(error) }));
}

/**
 * 新着メールを取得して処理
 * ページネーション対応：全ページを処理してからhistoryIdを更新
 *
 * 1通でも処理に失敗したら historyId を進めずに投げる。以前は個別の失敗を握り潰したまま
 * historyId を進めていたため、一過性のエラー（Gemini/LINE/Firestore の失敗や
 * トランザクション競合）で落ちたカード利用が**二度と再処理されず消えていた**。
 * 投げると関数が失敗し、Pub/Sub が同じ通知を 10〜600 秒の間隔で再送する（index.ts の `retry: true`。
 * 最大 24 時間、12 時間を過ぎた通知は index.ts で捨てる）。再送と、その間に届く新しい通知が同じ範囲をやり直す
 * （重複は gmailMessageId で弾かれる）。
 * ただし同じメッセージが試行 MAX_MESSAGE_ATTEMPTS 回以上、かつ最初の失敗から MESSAGE_ABANDON_AFTER_MS 以上
 * 失敗し続けたら、その1通は諦めて先へ進む（恒久的に処理できない1通で以降の取り込みが止まらないようにする。`shouldAbandon`）。
 * メールが消されていた（messages.get が 404）ときは失敗として数えず、読み飛ばす（processMessage）。
 * 通知が連携中のアカウントのものでなければ（notificationAccountOf。保存してあるアドレスが古いだけのときは
 * followLinkedAddressChange で書き直して続ける）、history.list を呼ばず、historyId も更新せずに終える。
 *
 * 保存する historyId は、常にメールボックスの現在位置（historyIdToSave）。通知の historyId は使わない（取込を起こす合図としてだけ
 * 使う。偽の通知で保存値を Gmail の返していない番号に置かせないため）。現在位置は history.list の最初のページの historyId
 * （最初の要求の時点の位置 M1。#300）。googleapis の型定義が次の開始位置として保存してよいとするのは最後のページ（nextPageToken の
 * 無い応答）の値だが、ページ送りが最初の要求の時点で区切られるなら、最後のページの値では途中に増えた記録を取りこぼす。M1 なら、
 * （保存値, M1］の記録は全ページのどこかに載っていて、この実行は全ページを処理し終えてから保存するので取りこぼさない。M1 より後の
 * 記録が後のページに載っても、次の実行で M1 から処理し直すだけ（重複は gmailMessageId で弾く）。諦めたメールは最初の失敗から
 * 6 時間以上たっている（shouldAbandon の MESSAGE_ABANDON_AFTER_MS。firstFailedAtOf は常に now 以前の読める時刻を返すので、
 * 時間の条件は外れない）。関数のタイムアウトは 300 秒（index.ts の gmailPubSubHandler）なので、最初の失敗はこの実行が始まる前で、
 * そのメールの記録は最初の要求の時点で載っていた（M1 以下）。M1 に進めたあとは再処理されない（印を消してよい）。
 * 最初のページに historyId が無ければ、後のページの値は使わず historyId を進めない。保存値より前の位置は updateHistoryId が書かない（前進のみ。同時に
 * 走った実行が先に進めていたときなど）。
 * history.list が 404（開始位置が古すぎる）のときは、users.getProfile の historyId を現在位置にする（失敗したら投げて再送させる）。
 * どちらの経路でも、現在位置が実行の開始位置（保存値）より前なら、保存値がこのメールボックスの位置でないので、固定文の警告を
 * 出して書かずに終える（warnIfMailboxBehindStart。#300）。
 *
 * 保存してある historyId は、使う前に形を確かめる（isUsableHistoryId）。#295 より前に偽の通知で入った先頭ゼロ・長い値などは
 * history.list に渡しても失敗し続けるだけなので、history.list を呼ばず、getProfile の現在位置に置き換えて終える
 * （recoverUnusableHistoryId。#300。値はログに出さない。docs/GMAIL_AUTO_SPEC.md §3.2）。
 *
 * @param notifiedEmailAddress 通知の emailAddress（emailAddressOfPubSubData。無ければ null）
 */
async function processNewEmails(notifiedEmailAddress: string | null): Promise<void> {
  let gmail: Awaited<ReturnType<typeof getGmailClient>>;
  try {
    gmail = await getGmailClient();
  } catch (error) {
    // トークンが無い（OAuth の設定前・/gmail/revoke の後）ときはやり直しても直らないので、投げずに終える。
    // それ以外（Firestore の読み取り・トークンの更新の失敗など）は一時的なことがあるので投げて、Pub/Sub に再送させる
    if (error instanceof GmailTokenMissingError) {
      console.warn('Gmail token not found; skipping (run the OAuth setup; retrying does not help)');
      return;
    }
    throw error;
  }
  const watchState = await getWatchState();

  // watch の状態が無い（初回の登録前・/gmail/revoke の後）ときもやり直しても直らないので、投げずに終える
  if (!watchState) {
    console.warn('Watch state not found, skipping processing');
    return;
  }

  // 保存してある historyId の形を確かめる（isUsableHistoryId）。使えない値では history.list が失敗し続けるだけなので、
  // history.list は呼ばず、getProfile の現在位置に置き換えて終える（recoverUnusableHistoryId。#300）。
  // 照合より前に行う（置き換える値は連携中のアカウントの getProfile で決まり、通知の内容に関係しない）。値はログに出さない
  if (!isUsableHistoryId(watchState.historyId)) {
    await recoverUnusableHistoryId(gmail);
    return;
  }

  // 通知が連携中のアカウントのものか確かめる（notificationAccountOf。アドレスはログに出さない）。
  // 違うアカウント（切り替える前のアカウントの watch など）の通知は、やり直しても変わらないので投げずに終える
  const account = notificationAccountOf(notifiedEmailAddress, watchState.emailAddress);
  if (account === 'mismatch' && !(await followLinkedAddressChange(gmail, notifiedEmailAddress))) {
    console.warn('Gmail Pub/Sub notification is not for the linked account; dropping it without updating historyId');
    return;
  }
  if (account === 'unchecked') {
    console.log('Linked Gmail address is not saved yet; skipping the account check (saved on the next watch registration)');
  }

  // 数値で保存されている値（#298 より前に通知の値を数値のまま保存したもの）も、10 進の文字列にして渡す
  const startHistoryId = String(watchState.historyId);
  const processedMessageIds: string[] = [];
  const retryableFailures: string[] = [];
  const abandonedFailures: string[] = [];

  try {
    let pageToken: string | undefined;
    // メールボックスの現在位置（最初のページの historyId。処理を終えたら保存する。後のページの値は使わない）
    let mailboxHistoryId: unknown;
    let firstPage = true;

    // 全ページを処理（ページネーション対応）
    do {
      const historyResponse = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        pageToken,
      });

      const histories = historyResponse.data.history || [];

      for (const history of histories) {
        const messagesAdded = history.messagesAdded || [];

        for (const messageAdded of messagesAdded) {
          const messageId = messageAdded.message?.id;
          if (!messageId) continue;

          // 重複処理を防ぐ
          if (processedMessageIds.includes(messageId)) continue;
          processedMessageIds.push(messageId);

          try {
            // メールが消されていた（404）ときも、ここでは成功として扱う（失敗の記録を消し、historyId を止めない）
            await processMessage(gmail, messageId);
            await clearMessageFailure(messageId);
          } catch (messageError) {
            const now = new Date();
            const { attempts, firstFailedAt } = await recordMessageFailure(messageId, messageError, now);
            const abandon = shouldAbandon(attempts, firstFailedAt, now);
            console.error('Gmail message failed', {
              message: maskId(messageId),
              attempts,
              minutesSinceFirstFailure: Math.floor((now.getTime() - firstFailedAt.getTime()) / 60000),
              abandon,
              ...errorFields(messageError),
            });
            if (abandon) {
              abandonedFailures.push(messageId);
            } else {
              retryableFailures.push(messageId);
            }
          }
        }
      }

      if (firstPage) {
        mailboxHistoryId = historyResponse.data.historyId;
        firstPage = false;
      }
      pageToken = historyResponse.data.nextPageToken || undefined;
    } while (pageToken);

    if (abandonedFailures.length > 0) {
      // 原因を直したら POST /gmail/force-process/:messageId で個別に処理し直せる（保存済みの支出のカードは送り直さない）
      console.error('Giving up on Gmail messages; re-run them with POST /gmail/force-process/:messageId after fixing the cause', {
        messages: abandonedFailures.map(maskId),
      });
    }

    if (retryableFailures.length > 0) {
      // historyId を進めずに投げ直す。関数が失敗し、Pub/Sub が同じ通知を再送して、この範囲をやり直す。
      // 諦めたメールも同じ範囲で再処理されるので、送信待ちのカードの印はここでは消さない（次の再送で送れることがある）
      console.warn('Keeping the Gmail historyId for the Pub/Sub retry', { failed: retryableFailures.length });
      throw new Error('Gmail import: some messages failed; keeping historyId for the Pub/Sub retry');
    }

    // 全ページ処理完了後にhistoryIdを更新（メールボックスの現在位置を保存する。通知の値は使わない）。
    // 現在位置が取れなければ進めない（範囲は次の通知でもう一度処理されるので、諦めたメールの印もここでは消さない）。
    // 現在位置が開始位置より前（保存値がこのメールボックスの位置でない）なら、警告を出して書かない（印も消さない）
    const next = historyIdToSave(mailboxHistoryId, 'history.list');
    if (next === null) return;
    if (warnIfMailboxBehindStart(next, startHistoryId, 'history.list')) return;
    await updateHistoryId(next);
    console.log('Processed Gmail messages; updated historyId', { messages: processedMessageIds.length, historyId: next });

    // historyId を進めたので、諦めたメールはもう再処理されない。送信待ちのカードの印も残さない
    // （店名・金額・日付が残り続けないように。cardNotice.ts）
    if (abandonedFailures.length > 0) await discardCardNotices(abandonedFailures, 'abandoned');
  } catch (error: any) {
    // historyIdが古すぎる場合は最新に更新（history.list の 404。messages.get の 404 は processMessage の中で読み飛ばすので、ここには来ない）
    if (error.code === 404) {
      // history.list の応答が無いので、メールボックスの現在位置は getProfile で取る（404 のときだけ呼ぶ。失敗は投げて再送させる）。
      // 取れなければ進めず、印も消さない（次の通知でもう一度ここに来る）
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const next = historyIdToSave(profile.data.historyId, 'getProfile');
      if (next === null) return;
      // 現在位置が開始位置より前なら、古すぎるのではなく保存値がこのメールボックスの位置でない。警告を出して書かない（印も消さない）
      if (warnIfMailboxBehindStart(next, startHistoryId, 'getProfile')) return;
      // 値は出さず、桁数だけを出す
      console.error('Gmail historyId is too old (Gmail keeps ~1 week); skipping ahead, and mail in between is NOT imported', {
        fromDigits: startHistoryId.length,
        toDigits: next.length,
      });
      // 失敗の記録は、historyId の更新を確定させる前に読む（確定の後に、新しい位置から始めた実行が記録した失敗の印まで消しうる
      // 範囲を縮める。recoverUnusableHistoryId と同じ）。ほかの実行がすでに next 以上へ進めていて、そこから始めた実行が読む前に
      // 失敗を記録していた場合は、その印も消えうる（窓は狭い）。failedMessageIds は投げない（読めなければ空）
      const failed = await failedMessageIds();
      await updateHistoryId(next);
      // 飛ばした範囲のメールは再処理しないので、送信待ちのカードの印も消す。
      // 範囲のメッセージは取れないため、取れる範囲（失敗の記録と、この実行で失敗したもの）だけを対象にする
      await discardCardNotices([...failed, ...retryableFailures, ...abandonedFailures], 'history_skipped');
    } else {
      throw error;
    }
  }
}

/**
 * 個別のメッセージを処理
 */
async function processMessage(gmail: any, messageId: string): Promise<void> {
  try {
    // 前の処理が保存のあと、カードを送れずに終わっていたら送り直す（印は保存と同じトランザクションで作る。cardNotice.ts）。
    // 印があれば支出は保存済みなので、ここで終える
    const pending = await deliverPendingCardNotice(messageId);
    if (pending !== 'none') {
      console.log('Pending card notice handled', { message: maskId(messageId), result: pending });
      return;
    }

    // 重複チェック
    const isDuplicate = await isDuplicateExpense(messageId);
    if (isDuplicate) {
      console.log('Skipping a Gmail message already imported', { message: maskId(messageId) });
      return;
    }

    // メッセージの詳細を取得
    let messageResponse;
    try {
      messageResponse = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
    } catch (error) {
      // 届いたあとに消された（完全に削除された）メールは 404 になり、何度やり直しても取れない。失敗として数えず読み飛ばす
      // （送信待ちの印があれば上の deliverPendingCardNotice で処理を終えているので、ここに来るのは印が無いときだけ）
      if (isGmailNotFound(error)) {
        console.warn('Gmail message not found (deleted); skipping', { message: maskId(messageId) });
        return;
      }
      throw error;
    }

    const message = messageResponse.data;
    // name・value の無いヘッダー・payload の無いメールでも投げない（processLatestEmail・forceProcessMessage と同じ扱い）。
    // 投げると、その 1 通が失敗し続けて取込が最大 6 時間止まる（shouldAbandon）
    const rawHeaders = message.payload?.headers || [];
    const headers = rawHeaders.filter(
      (h: { name?: string | null; value?: string | null }): h is { name: string; value: string } =>
        h.name !== null && h.name !== undefined &&
        h.value !== null && h.value !== undefined
    );
    const from = getFromAddress(headers);
    const body = decodeEmailBody(message.payload);

    // 三井住友ゴールドVISA（NL）のメールかチェック
    if (!isSMBCGoldVISANL(from, body)) {
      console.log('Not a SMBC Gold VISA NL notification; skipping', { message: maskId(messageId) });
      return;
    }

    console.log('Processing SMBC card notification', { message: maskId(messageId) });

    // メールをパース
    const parsed = parseSMBCCardEmail(messageId, body);
    if (!parsed) {
      console.warn('Failed to parse the SMBC card email; skipping', { message: maskId(messageId) });
      return;
    }

    // カテゴリを判定（店名なので辞書よりモデル〔Jev → 失敗時 Gemini〕を優先。geminiCategoryClassifier.ts 参照）
    const categoryResult = await classifyExpense(
      GMAIL_SYSTEM_LINE_ID,
      parsed.merchant,
      { source: 'merchant' }
    );
    // 判定元は通知のカードに出すだけで、保存しない
    const { category, origin: categoryOrigin } = merchantCategoryOf(categoryResult);

    // グループIDを取得（グループベースの集計に必要）
    const groupId = getDefaultGroupId();
    const lineGroupId = getDefaultLineGroupId();

    // 支出データを作成
    // Gmail自動取得は基本的に会計に含める（共同費として扱う）
    const expense = {
      lineId: GMAIL_SYSTEM_LINE_ID, // システムユーザーとして登録
      amount: parsed.amount,
      description: parsed.merchant,
      date: toJSTDateString(parsed.usedAt),
      category,
      subCategory: merchantSubCategoryOf(category, parsed),
      // カード会社の通知から自動で入るので確認を求めない（要確認は手入力の支出だけ）
      confirmed: true,
      includeInTotal: true, // Gmail自動取得は基本的に会計に含める
      payerId: GMAIL_SYSTEM_LINE_ID,
      // グループ関連（ダッシュボード集計・期間の精算に必要）
      groupId,
      lineGroupId,
      // Gmail拡張フィールド
      inputSource: 'gmail_auto' as const,
      gmailMessageId: messageId,
      usedAt: parsed.usedAt, // カード利用日時（重複チェック用）
      status: 'shared' as const,
    };

    // LINEグループに送るカード。送信待ちの印として保存と同じトランザクションで書き、送れたら消す
    const notice = lineGroupId
      ? cardNoticeFor(messageId, lineGroupId, cardUsageOf(parsed, category, expense.subCategory, categoryOrigin))
      : undefined;

    // アトミックに重複チェック＋保存（並行処理での二重登録を防止）
    const { expenseId, alreadyExists } = await saveGmailExpenseAtomic(expense as any, notice);
    if (alreadyExists) {
      console.log('Skipping a duplicate Gmail expense (atomic)', { message: maskId(messageId), expense: maskId(expenseId) });
      // 同時に処理した相手が保存のあと、カードを送る前に止まっていたら送る（相手と同じ key なので二重には届かない）
      const delivery = await deliverPendingCardNotice(messageId);
      console.log('Card notice checked for an existing expense', { expense: maskId(expenseId), result: delivery });
      return;
    }
    console.log('Expense saved from Gmail', { expense: maskId(expenseId) });

    // LINEグループに通知（失敗したら投げる。印が残り、再処理で送り直す）
    if (lineGroupId) {
      const delivery = await deliverPendingCardNotice(messageId);
      console.log('Card notice delivered after saving', { expense: maskId(expenseId), result: delivery });
    } else {
      console.warn('LINE_GROUP_ID not configured, skipping notification');
    }
  } catch (error) {
    // 呼び出し元（processNewEmails）が試行回数を記録し、historyId を進めるかを決める。
    // ここで握り潰すと、失敗したメールが再処理されないまま historyId だけ進んでしまう。
    // 試行回数を付けたログは呼び出し元が出す（ここでは ID を伏せ、エラーの種類だけ）
    console.error('Gmail message processing failed', { message: maskId(messageId), ...errorFields(error) });
    throw error;
  }
}

/**
 * テスト用: 最新のメールを手動で処理
 */
export async function processLatestEmail(): Promise<{
  success: boolean;
  message: string;
  expenseId?: string;
}> {
  try {
    const gmail = await getGmailClient();

    // 最新のメールを取得
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10,
      q: 'from:vpass.ne.jp OR from:smbc-card.com',
    });

    const messages = listResponse.data.messages || [];

    for (const msg of messages) {
      if (!msg.id) continue;

      // 重複チェック
      const isDuplicate = await isDuplicateExpense(msg.id);
      if (isDuplicate) continue;

      // メッセージを処理
      const messageResponse = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const message = messageResponse.data;
      const rawHeaders = message.payload?.headers || [];
      // nullableな型をフィルタリング
      const headers = rawHeaders
        .filter((h): h is { name: string; value: string } =>
          h.name !== null && h.name !== undefined &&
          h.value !== null && h.value !== undefined
        );
      const from = getFromAddress(headers);
      const body = decodeEmailBody(message.payload);

      if (!isSMBCGoldVISANL(from, body)) continue;

      // パースして保存
      const parsed = parseSMBCCardEmail(msg.id, body);
      if (!parsed) continue;

      const categoryResult = await classifyExpense(
        GMAIL_SYSTEM_LINE_ID,
        parsed.merchant,
        { source: 'merchant' }
      );
      const { category } = merchantCategoryOf(categoryResult);

      const expense = {
        lineId: GMAIL_SYSTEM_LINE_ID,
        amount: parsed.amount,
        description: parsed.merchant,
        date: toJSTDateString(parsed.usedAt),
        category,
        subCategory: merchantSubCategoryOf(category, parsed),
        confirmed: true, // 自動で入るので確認を求めない（要確認は手入力の支出だけ）
        includeInTotal: true, // Gmail自動取得は基本的に会計に含める
        payerId: GMAIL_SYSTEM_LINE_ID,
        // グループ関連（ダッシュボード集計・期間の精算に必要）
        groupId: getDefaultGroupId(),
        lineGroupId: getDefaultLineGroupId(),
        inputSource: 'gmail_auto' as const,
        gmailMessageId: msg.id,
        usedAt: parsed.usedAt, // カード利用日時（重複チェック用）
        status: 'shared' as const,
      };

      // アトミックに重複チェック＋保存
      const { expenseId, alreadyExists } = await saveGmailExpenseAtomic(expense as any);
      if (alreadyExists) continue;

      return {
        success: true,
        message: `Processed: ${parsed.merchant} ¥${parsed.amount}`,
        expenseId,
      };
    }

    return {
      success: false,
      message: 'No new SMBC Gold VISA NL emails found',
    };
  } catch (error) {
    console.error('processLatestEmail error', errorFields(error));
    return {
      success: false,
      message: `Error: ${(error as Error).message}`,
    };
  }
}

/**
 * テスト用: 指定したメッセージIDを強制処理（冪等: 既存の支出があればそれを返す）
 *
 * 既存の支出に送信待ちのカード（cardNotice.ts）が残っていれば送り直し、結果を cardNotice で返す。
 */
export async function forceProcessMessage(messageId: string): Promise<{
  success: boolean;
  message: string;
  expenseId?: string;
  alreadyExists?: boolean;
  cardNotice?: CardNoticeDelivery;
}> {
  try {
    // 冪等性: 既存の支出があればそれを返す（重複作成を防ぐ）
    const existingExpenseId = await getExpenseIdByGmailMessageId(messageId);
    if (existingExpenseId) {
      console.log('Expense already exists for the Gmail message', { message: maskId(messageId), expense: maskId(existingExpenseId) });
      const cardNotice = await deliverPendingCardNotice(messageId);
      return {
        success: true,
        message: cardNotice === 'sent'
          ? 'Already processed (existing expense); resent the pending card notice'
          : `Already processed (existing expense)`,
        expenseId: existingExpenseId,
        alreadyExists: true,
        cardNotice,
      };
    }

    const gmail = await getGmailClient();

    // メッセージの詳細を取得
    const messageResponse = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const message = messageResponse.data;
    const rawHeaders = message.payload?.headers || [];
    const headers = rawHeaders.filter(
      (h): h is { name: string; value: string } =>
        h.name !== null && h.name !== undefined &&
        h.value !== null && h.value !== undefined
    );
    const from = getFromAddress(headers);
    const body = decodeEmailBody(message.payload);

    // 三井住友ゴールドVISA（NL）のメールかチェック
    if (!isSMBCGoldVISANL(from, body)) {
      return {
        success: false,
        message: 'Not a SMBC Gold VISA NL notification',
      };
    }

    // メールをパース
    const parsed = parseSMBCCardEmail(messageId, body);
    if (!parsed) {
      return {
        success: false,
        message: 'Failed to parse email',
      };
    }

    // カテゴリを判定（店名なので辞書よりモデル〔Jev → 失敗時 Gemini〕を優先。geminiCategoryClassifier.ts 参照）
    const categoryResult = await classifyExpense(
      GMAIL_SYSTEM_LINE_ID,
      parsed.merchant,
      { source: 'merchant' }
    );
    // 判定元は通知のカードに出すだけで、保存しない
    const { category, origin: categoryOrigin } = merchantCategoryOf(categoryResult);

    // グループIDを取得
    const groupId = getDefaultGroupId();
    const lineGroupId = getDefaultLineGroupId();

    // 支出データを作成
    // Gmail自動取得は基本的に会計に含める（共同費として扱う）
    const expense = {
      lineId: GMAIL_SYSTEM_LINE_ID,
      amount: parsed.amount,
      description: parsed.merchant,
      date: toJSTDateString(parsed.usedAt),
      category,
      subCategory: merchantSubCategoryOf(category, parsed),
      confirmed: true, // 自動で入るので確認を求めない（要確認は手入力の支出だけ）
      includeInTotal: true, // Gmail自動取得は基本的に会計に含める
      payerId: GMAIL_SYSTEM_LINE_ID,
      groupId,
      lineGroupId,
      inputSource: 'gmail_auto' as const,
      gmailMessageId: messageId,
      usedAt: parsed.usedAt, // カード利用日時（重複チェック用）
      status: 'shared' as const,
    };

    // LINEグループに送るカード（processMessage と同じく、送信待ちの印を保存と同じトランザクションで書く）
    const notice = lineGroupId
      ? cardNoticeFor(messageId, lineGroupId, cardUsageOf(parsed, category, expense.subCategory, categoryOrigin))
      : undefined;

    // アトミックに重複チェック＋保存
    const { expenseId, alreadyExists } = await saveGmailExpenseAtomic(expense as any, notice);
    if (alreadyExists) {
      console.log('Skipping a duplicate Gmail expense (atomic, force)', { message: maskId(messageId), expense: maskId(expenseId) });
      const cardNotice = await deliverPendingCardNotice(messageId);
      return {
        success: true,
        message: `Duplicate (same content already exists)`,
        expenseId,
        alreadyExists: true,
        cardNotice,
      };
    }
    console.log('Expense saved from Gmail (force)', { expense: maskId(expenseId) });

    // LINEグループに通知（新規作成時のみ。失敗したら印が残り、もう一度呼べば送り直す）
    if (lineGroupId) {
      const delivery = await deliverPendingCardNotice(messageId);
      console.log('Card notice delivered after saving', { expense: maskId(expenseId), result: delivery });
    }

    return {
      success: true,
      message: `Processed: ${parsed.merchant} ¥${parsed.amount}`,
      expenseId,
      alreadyExists: false,
    };
  } catch (error) {
    console.error('forceProcessMessage error', errorFields(error));
    return {
      success: false,
      message: `Error: ${(error as Error).message}`,
    };
  }
}
