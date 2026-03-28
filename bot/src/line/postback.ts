/**
 * LINE Postback処理
 *
 * カード利用通知・テキスト入力のボタン押下を処理
 */

import { WebhookEvent, PostbackEvent, Client } from '@line/bot-sdk';
import { getFirestore } from 'firebase-admin/firestore';
import { PostbackActionData, ExpenseStatus } from '../gmail/types';
import { sendStatusUpdateConfirmation, sendTextMessage, buildCategorySelectCarousel, CategorySelectInfo } from './flexMessage';

/**
 * 拡張されたPostbackアクションデータ
 */
interface ExtendedPostbackActionData extends PostbackActionData {
  source?: 'gmail' | 'text';  // 入力元
  currentCategory?: string;   // カテゴリ選択用
  category?: string;          // 設定するカテゴリ
  merchant?: string;          // 店舗名
  amount?: number;            // 金額
}

// LINEクライアントの初期化
let lineClient: Client | null = null;

function getLineClient(): Client {
  if (!lineClient) {
    const channelAccessToken = process.env.LINE_CHANNEL_TOKEN;
    const channelSecret = process.env.LINE_CHANNEL_SECRET;

    if (!channelAccessToken || !channelSecret) {
      throw new Error('LINE credentials not configured');
    }

    lineClient = new Client({
      channelAccessToken,
      channelSecret,
    });
  }
  return lineClient;
}

/**
 * Postbackイベントを処理
 */
export async function handlePostback(event: PostbackEvent): Promise<void> {
  try {
    const data = event.postback.data;

    // JSONパースを試行
    let actionData: ExtendedPostbackActionData;
    try {
      actionData = JSON.parse(data);
    } catch {
      console.log('Non-JSON postback data, skipping:', data);
      return;
    }

    // 有効なPostbackかチェック
    if (!actionData.action || !actionData.expenseId) {
      console.log('Not a valid postback, skipping');
      return;
    }

    const { action, expenseId, source } = actionData;

    // カテゴリ選択表示の場合
    if (action === 'show_category_select') {
      await handleShowCategorySelect(event, actionData);
      return;
    }

    // カテゴリ設定の場合
    if (action === 'set_category') {
      await handleSetCategory(event, actionData);
      return;
    }

    // テキスト入力からのPostbackの場合
    if (source === 'text') {
      await handleTextExpensePostback(event, actionData);
      return;
    }

    // Gmail自動取得からのPostback（既存処理）
    const newStatus = getStatusFromAction(action);
    if (!newStatus) {
      console.warn('Unknown action:', action);
      return;
    }

    // Firestoreを更新
    const db = getFirestore();
    const expenseRef = db.collection('expenses').doc(expenseId);
    const expenseDoc = await expenseRef.get();

    if (!expenseDoc.exists) {
      console.warn('Expense not found:', expenseId);
      return;
    }

    const expenseData = expenseDoc.data();
    if (!expenseData) {
      console.warn('Expense data is empty:', expenseId);
      return;
    }

    // ステータスを更新
    // includeInTotal: 共同費/立替は合計に含める、個人費は含めない
    const includeInTotal = action !== 'personal';

    const updateData: Record<string, any> = {
      status: newStatus,
      confirmed: true,
      includeInTotal,
      updatedAt: new Date(),
    };

    // 立替の場合は立替者を記録
    if (action === 'advance') {
      const userId = event.source.userId;
      if (!userId) {
        console.error('Cannot process advance: userId is missing', {
          expenseId,
          sourceType: event.source.type,
        });
        return; // 立替者不明では処理できない
      }
      // ボタンを押したユーザーを立替者として記録
      updateData.advanceBy = userId;
    }

    await expenseRef.update(updateData);

    console.log(`Expense ${expenseId} status updated to ${newStatus}`);

    // 確認メッセージを送信
    const replyTarget = event.source.type === 'group'
      ? (event.source as any).groupId
      : event.source.userId;

    if (replyTarget && (action === 'shared' || action === 'personal' || action === 'advance')) {
      await sendStatusUpdateConfirmation(
        replyTarget,
        action,
        expenseData.description || '不明',
        expenseData.amount || 0
      );
    }
  } catch (error) {
    console.error('Failed to handle postback:', error);
    throw error;
  }
}

/**
 * テキスト入力からのPostbackを処理
 */
async function handleTextExpensePostback(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData
): Promise<void> {
  const { action, expenseId } = actionData;
  const db = getFirestore();
  const expenseRef = db.collection('expenses').doc(expenseId);
  const expenseDoc = await expenseRef.get();

  if (!expenseDoc.exists) {
    console.warn('Expense not found:', expenseId);
    return;
  }

  const expenseData = expenseDoc.data();
  if (!expenseData) {
    console.warn('Expense data is empty:', expenseId);
    return;
  }

  const replyTarget = event.source.type === 'group'
    ? (event.source as any).groupId
    : event.source.userId;

  switch (action) {
    case 'confirm':
      // 確認済みにする（共同費として合計に含める）
      await expenseRef.update({
        confirmed: true,
        status: 'shared',
        includeInTotal: true,
        updatedAt: new Date(),
      });
      if (replyTarget) {
        await sendTextMessage(
          replyTarget,
          `✅ 確認しました\n${expenseData.description} ¥${expenseData.amount?.toLocaleString()}`
        );
      }
      break;

    case 'edit':
      // 修正フラグを立てる（後で編集できるようにする）
      await expenseRef.update({
        needsEdit: true,
        updatedAt: new Date(),
      });
      if (replyTarget) {
        const editUrl = `https://line-kakeibo.vercel.app/expenses?edit=${expenseId}&lineId=${event.source.userId}`;
        await sendTextMessage(
          replyTarget,
          `✏️ 以下のリンクから修正できます\n${editUrl}`
        );
      }
      break;

    case 'advance': {
      // 立替として記録（合計に含める）
      const userId = event.source.userId;
      if (!userId) {
        console.error('Cannot process text expense advance: userId is missing', {
          expenseId,
          sourceType: event.source.type,
        });
        return; // 立替者不明では処理できない
      }
      await expenseRef.update({
        status: 'advance_pending',
        advanceBy: userId,
        confirmed: true,
        includeInTotal: true,
        updatedAt: new Date(),
      });
      if (replyTarget) {
        await sendTextMessage(
          replyTarget,
          `↩️ 立替として記録しました\n${expenseData.description} ¥${expenseData.amount?.toLocaleString()}\n月末精算に含めます`
        );
      }
      break;
    }

    default:
      console.warn('Unknown text expense action:', action);
  }

  console.log(`Text expense ${expenseId} action ${action} processed`);
}

/**
 * アクションからステータスを取得
 */
function getStatusFromAction(action: string): ExpenseStatus | null {
  const statusMap: Record<string, ExpenseStatus> = {
    shared: 'shared',
    personal: 'personal',
    advance: 'advance_pending',
  };

  return statusMap[action] || null;
}

/**
 * Postbackイベントかどうかチェック
 */
export function isPostbackEvent(event: WebhookEvent): event is PostbackEvent {
  return event.type === 'postback';
}

/**
 * Gmail関連のPostbackかどうかチェック
 */
export function isGmailPostback(data: string): boolean {
  try {
    const parsed = JSON.parse(data);
    return (
      parsed.action &&
      parsed.expenseId &&
      ['shared', 'personal', 'advance'].includes(parsed.action) &&
      parsed.source !== 'text'
    );
  } catch {
    return false;
  }
}

/**
 * テキスト入力関連のPostbackかどうかチェック
 */
export function isTextExpensePostback(data: string): boolean {
  try {
    const parsed = JSON.parse(data);
    return (
      parsed.action &&
      parsed.expenseId &&
      parsed.source === 'text' &&
      ['confirm', 'edit', 'advance'].includes(parsed.action)
    );
  } catch {
    return false;
  }
}

/**
 * カテゴリ選択Carouselを表示
 */
async function handleShowCategorySelect(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData
): Promise<void> {
  const { expenseId, currentCategory, source, merchant, amount } = actionData;

  const replyTarget = event.source.type === 'group'
    ? (event.source as any).groupId
    : event.source.userId;

  if (!replyTarget) {
    console.warn('Cannot determine reply target for category select');
    return;
  }

  const carouselInfo: CategorySelectInfo = {
    expenseId,
    currentCategory: currentCategory || 'その他',
    source: source || 'gmail',
    merchant: merchant || '不明',
    amount: amount || 0,
  };

  const carousel = buildCategorySelectCarousel(carouselInfo);
  const client = getLineClient();

  await client.pushMessage(replyTarget, carousel);
  console.log(`Category select carousel sent for expense ${expenseId}`);
}

/**
 * カテゴリを設定
 */
async function handleSetCategory(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData
): Promise<void> {
  const { expenseId, category } = actionData;

  if (!category) {
    console.warn('Category is missing in set_category action');
    return;
  }

  const db = getFirestore();
  const expenseRef = db.collection('expenses').doc(expenseId);
  const expenseDoc = await expenseRef.get();

  if (!expenseDoc.exists) {
    console.warn('Expense not found:', expenseId);
    return;
  }

  const expenseData = expenseDoc.data();
  if (!expenseData) {
    console.warn('Expense data is empty:', expenseId);
    return;
  }

  // カテゴリを更新
  await expenseRef.update({
    category,
    updatedAt: new Date(),
  });

  const replyTarget = event.source.type === 'group'
    ? (event.source as any).groupId
    : event.source.userId;

  if (replyTarget) {
    await sendTextMessage(
      replyTarget,
      `🏷️ カテゴリを「${category}」に変更しました\n${expenseData.description} ¥${expenseData.amount?.toLocaleString()}`
    );
  }

  console.log(`Expense ${expenseId} category updated to ${category}`);
}
