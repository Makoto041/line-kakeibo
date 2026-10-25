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
import { errorMessage, maskId } from '../logSafe';
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
 * 同じメッセージで諦めるまでの試行回数
 *
 * 恒久的に処理できないメール（パースできない等）で historyId が永久に止まるのを防ぐ。
 */
const MAX_MESSAGE_ATTEMPTS = 3;

/** 失敗したメッセージの記録。`system/gmailFailures` に messageId ごとの試行回数を持つ */
async function recordMessageFailure(messageId: string, error: unknown): Promise<number> {
  const db = getFirestore();
  const ref = db.collection('system').doc('gmailFailures');

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const failures = (snapshot.exists ? snapshot.data() : {}) || {};
    const previous = (failures[messageId]?.attempts as number | undefined) ?? 0;
    const attempts = previous + 1;

    transaction.set(
      ref,
      {
        [messageId]: {
          attempts,
          lastError: String((error as Error)?.message ?? error).slice(0, 500),
          lastFailedAt: Timestamp.now(),
        },
      },
      { merge: true }
    );

    return attempts;
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
 * 1通でも処理に失敗したら historyId を進めない。以前は個別の失敗を握り潰したまま
 * historyId を進めていたため、一過性のエラー（Gemini/LINE/Firestore の失敗や
 * トランザクション競合）で落ちたカード利用が**二度と再処理されず消えていた**。
 * Pub/Sub の再送に委ねる（重複は gmailMessageId で弾かれる）。
 * ただし同じメッセージが MAX_MESSAGE_ATTEMPTS 回失敗したら、その1通は諦めて先へ進む
 * （恒久的に処理できない1通で以降の取り込みが止まらないようにする）。
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
            await processMessage(gmail, messageId);
            await clearMessageFailure(messageId);
          } catch (messageError) {
            const attempts = await recordMessageFailure(messageId, messageError);
            console.error(
              `Failed to process message ${messageId} (attempt ${attempts}/${MAX_MESSAGE_ATTEMPTS}):`,
              messageError
            );
            if (attempts >= MAX_MESSAGE_ATTEMPTS) {
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
      console.error(
        `Giving up on ${abandonedFailures.length} message(s) after ${MAX_MESSAGE_ATTEMPTS} attempts: ` +
          `${abandonedFailures.join(', ')}. ` +
          'Re-run manually with POST /gmail/force-process/:messageId after fixing the cause ' +
          '(cards of expenses that were already saved are not resent).'
      );
    }

    if (retryableFailures.length > 0) {
      // historyId を進めずに投げ直す。Pub/Sub が再送し、次回この範囲をやり直す。
      // 諦めたメールも同じ範囲で再処理されるので、送信待ちのカードの印はここでは消さない（次の再送で送れることがある）
      throw new Error(
        `${retryableFailures.length} message(s) failed, keeping historyId at ${startHistoryId} for retry: ` +
          retryableFailures.join(', ')
      );
    }

    // 全ページ処理完了後にhistoryIdを更新
    await updateHistoryId(newHistoryId);
    console.log(`Processed ${processedMessageIds.length} messages, updated historyId to ${newHistoryId}`);

    // historyId を進めたので、諦めたメールはもう再処理されない。送信待ちのカードの印も残さない
    // （店名・金額・日付が残り続けないように。cardNotice.ts）
    if (abandonedFailures.length > 0) await discardCardNotices(abandonedFailures, 'abandoned');
  } catch (error: any) {
    // historyIdが古すぎる場合は最新に更新
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
    const messageResponse = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

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
