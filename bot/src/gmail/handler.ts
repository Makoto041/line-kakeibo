/**
 * Gmail Pub/Subハンドラー
 *
 * Gmailから新着メール通知を受け取り、
 * 三井住友カードの利用通知を処理して支出を自動登録
 */

import dayjs from 'dayjs';
import { getGmailClient } from './auth';
import { getWatchState, updateHistoryId } from './watch';
import {
  isSMBCGoldVISANL,
  parseSMBCCardEmail,
  decodeEmailBody,
  getFromAddress,
  isDuplicateExpense,
} from './parser';
import {
  GmailPubSubPayload,
  GmailExpense,
  getCategoryEmoji,
} from './types';
import { saveExpense } from '../firestore';
import { classifyExpenseWithGemini } from '../geminiCategoryClassifier';
import { sendCardUsageNotification } from '../line/flexMessage';

// システム用のLINE ID（Gmail自動取得用）
const GMAIL_SYSTEM_LINE_ID = 'gmail-auto-system';

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

    console.log('Gmail Pub/Sub received:', payload);

    // 新着メールを取得して処理
    await processNewEmails(payload.historyId);
  } catch (error) {
    console.error('Failed to handle Gmail Pub/Sub:', error);
    throw error;
  }
}

/**
 * 新着メールを取得して処理
 */
async function processNewEmails(newHistoryId: string): Promise<void> {
  const gmail = await getGmailClient();
  const watchState = await getWatchState();

  if (!watchState) {
    console.warn('Watch state not found, skipping processing');
    return;
  }

  const startHistoryId = watchState.historyId;

  try {
    // historyId以降の変更を取得
    const historyResponse = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
    });

    const histories = historyResponse.data.history || [];

    for (const history of histories) {
      const messagesAdded = history.messagesAdded || [];

      for (const messageAdded of messagesAdded) {
        const messageId = messageAdded.message?.id;
        if (!messageId) continue;

        await processMessage(gmail, messageId);
      }
    }

    // historyIdを更新
    await updateHistoryId(newHistoryId);
  } catch (error: any) {
    // historyIdが古すぎる場合は最新に更新
    if (error.code === 404) {
      console.warn('History ID too old, updating to latest');
      await updateHistoryId(newHistoryId);
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

    // Geminiでカテゴリを分類
    const categoryResult = await classifyExpenseWithGemini(
      GMAIL_SYSTEM_LINE_ID,
      parsed.merchant
    );
    const category = categoryResult.category || 'その他';

    // 支出データを作成
    const expense: Partial<GmailExpense> = {
      lineId: GMAIL_SYSTEM_LINE_ID, // システムユーザーとして登録
      amount: parsed.amount,
      description: parsed.merchant,
      date: dayjs(parsed.usedAt).format('YYYY-MM-DD'),
      category,
      confirmed: false, // 未確認状態
      payerId: GMAIL_SYSTEM_LINE_ID,
      // Gmail拡張フィールド
      inputSource: 'gmail_auto',
      gmailMessageId: messageId,
      status: 'pending', // 確認待ち
    };

    // Firestoreに保存
    const expenseId = await saveExpense(expense as any);
    console.log(`Expense saved from Gmail: ${expenseId}`);

    // LINEグループに通知
    const lineGroupId = process.env.LINE_GROUP_ID;
    if (lineGroupId) {
      await sendCardUsageNotification(lineGroupId, {
        expenseId,
        merchant: parsed.merchant,
        amount: parsed.amount,
        category,
        categoryEmoji: getCategoryEmoji(category),
        date: dayjs(parsed.usedAt).format('M/D'),
      });
      console.log(`LINE notification sent for expense: ${expenseId}`);
    } else {
      console.warn('LINE_GROUP_ID not configured, skipping notification');
    }
  } catch (error) {
    console.error(`Failed to process message ${messageId}:`, error);
    // 個別のメッセージ処理エラーは全体を止めない
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

      const categoryResult = await classifyExpenseWithGemini(
        GMAIL_SYSTEM_LINE_ID,
        parsed.merchant
      );

      const expense = {
        lineId: GMAIL_SYSTEM_LINE_ID,
        amount: parsed.amount,
        description: parsed.merchant,
        date: dayjs(parsed.usedAt).format('YYYY-MM-DD'),
        category: categoryResult.category || 'その他',
        confirmed: false,
        payerId: GMAIL_SYSTEM_LINE_ID,
        inputSource: 'gmail_auto' as const,
        gmailMessageId: msg.id,
        status: 'pending' as const,
      };

      const expenseId = await saveExpense(expense as any);

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
