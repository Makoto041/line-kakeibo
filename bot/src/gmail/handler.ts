/**
 * Gmail Pub/Subハンドラー
 *
 * Gmailから新着メール通知を受け取り、
 * 三井住友カードの利用通知を処理して支出を自動登録
 */

import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { formatJST, toJSTDateString } from '../time';
import { getGmailClient } from './auth';
import { getWatchState, updateHistoryId } from './watch';
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
import { errorMessage, errorName, maskId } from '../logSafe';
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
    console.warn('Subcategory resolution failed', { source: 'merchant', error: errorMessage(error) });
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
 * Pub/Subメッセージを処理
 * Cloud Functions: onMessagePublished で呼び出される
 *
 * 投げると関数が失敗し、Pub/Sub が同じ通知を再送する（index.ts の gmailPubSubHandler は `retry: true`）。
 */
export async function handleGmailPubSub(data: string): Promise<void> {
  try {
    // Base64デコード
    const payload: GmailPubSubPayload = JSON.parse(
      Buffer.from(data, 'base64').toString('utf-8')
    );

    // payload にはメールアドレスが含まれるため historyId だけを出す
    console.log(`Gmail Pub/Sub received: historyId=${payload.historyId}`);

    // 新着メールを取得して処理
    await processNewEmails(payload.historyId);
  } catch (error) {
    console.error('Failed to handle Gmail Pub/Sub:', error);
    throw error;
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
 * @param eventTime CloudEvent の time（Pub/Sub の publish 時刻。再送でも変わらない）
 * 時刻が読めないときは捨てない（処理しても取りこぼし・二重登録は起きないので、処理する側に倒す）。
 */
export function isStaleGmailEvent(eventTime: string | undefined, now: Date): boolean {
  const publishedAt = typeof eventTime === 'string' ? Date.parse(eventTime) : NaN;
  if (Number.isNaN(publishedAt)) return false;
  return now.getTime() - publishedAt > STALE_GMAIL_EVENT_MS;
}

/** ログに出す例外の種類（メッセージには入力や文書のパスが入りうるので出さない） */
function errorFields(error: unknown): { errorName: string; errorCode?: string | number } {
  const name = errorName(error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'number' || typeof code === 'string' ? { errorName: name, errorCode: code } : { errorName: name };
}

/** Gmail API の 404（gaxios 7 は JSON のエラーの code を error.code に、HTTP の状態を error.status に入れる） */
function isGmailNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown } | null | undefined;
  return e?.code === 404 || e?.status === 404;
}

/**
 * 失敗したメッセージの記録。`system/gmailFailures` に messageId ごとの試行回数と、最初・最後の失敗の時刻を持つ
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
          lastError: String((error as Error)?.message ?? error).slice(0, 500),
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
    .catch((error) => console.warn(`Failed to clear failure record for ${messageId}:`, error));
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
 */
async function processNewEmails(newHistoryId: string): Promise<void> {
  const gmail = await getGmailClient();
  const watchState = await getWatchState();

  if (!watchState) {
    console.warn('Watch state not found, skipping processing');
    return;
  }

  const startHistoryId = watchState.historyId;
  const processedMessageIds: string[] = [];
  const retryableFailures: string[] = [];
  const abandonedFailures: string[] = [];

  try {
    let pageToken: string | undefined;

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

    // 全ページ処理完了後にhistoryIdを更新
    await updateHistoryId(newHistoryId);
    console.log(`Processed ${processedMessageIds.length} messages, updated historyId to ${newHistoryId}`);

    // historyId を進めたので、諦めたメールはもう再処理されない。送信待ちのカードの印も残さない
    // （店名・金額・日付が残り続けないように。cardNotice.ts）
    if (abandonedFailures.length > 0) await discardCardNotices(abandonedFailures, 'abandoned');
  } catch (error: any) {
    // historyIdが古すぎる場合は最新に更新（history.list の 404。messages.get の 404 は processMessage の中で読み飛ばすので、ここには来ない）
    if (error.code === 404) {
      console.error(
        `History ID ${startHistoryId} is too old (Gmail keeps ~1 week). ` +
          `Skipping to ${newHistoryId}; mail in between is NOT imported.`
      );
      await updateHistoryId(newHistoryId);
      // 飛ばした範囲のメールは再処理しないので、送信待ちのカードの印も消す。
      // 範囲のメッセージは取れないため、取れる範囲（失敗の記録と、この実行で失敗したもの）だけを対象にする
      await discardCardNotices(
        [...(await failedMessageIds()), ...retryableFailures, ...abandonedFailures],
        'history_skipped'
      );
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
      console.log(`Skipping duplicate message: ${messageId}`);
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
    const headers = message.payload?.headers || [];
    const from = getFromAddress(headers);
    const body = decodeEmailBody(message.payload);

    // 三井住友ゴールドVISA（NL）のメールかチェック
    if (!isSMBCGoldVISANL(from, body)) {
      console.log(`Not a SMBC Gold VISA NL notification: ${messageId}`);
      return;
    }

    console.log(`Processing SMBC card notification: ${messageId}`);

    // メールをパース
    const parsed = parseSMBCCardEmail(messageId, body);
    if (!parsed) {
      console.warn(`Failed to parse email: ${messageId}`);
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
      console.log(`Skipping duplicate (atomic): messageId: ${messageId}, existingId: ${expenseId}`);
      // 同時に処理した相手が保存のあと、カードを送る前に止まっていたら送る（相手と同じ key なので二重には届かない）
      const delivery = await deliverPendingCardNotice(messageId);
      console.log('Card notice checked for an existing expense', { expense: maskId(expenseId), result: delivery });
      return;
    }
    console.log(`Expense saved from Gmail: ${expenseId}`);

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
    console.error(`Failed to process message ${messageId}:`, error);
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
    console.error('processLatestEmail error:', error);
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
      console.log(`Expense already exists for messageId ${messageId}: ${existingExpenseId}`);
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
      console.log(`Duplicate detected (atomic): messageId: ${messageId}, existingId: ${expenseId}`);
      const cardNotice = await deliverPendingCardNotice(messageId);
      return {
        success: true,
        message: `Duplicate (same content already exists)`,
        expenseId,
        alreadyExists: true,
        cardNotice,
      };
    }
    console.log(`Expense saved from Gmail (force): ${expenseId}`);

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
    console.error('forceProcessMessage error:', error);
    return {
      success: false,
      message: `Error: ${(error as Error).message}`,
    };
  }
}
