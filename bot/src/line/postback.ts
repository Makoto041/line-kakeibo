/**
 * LINE Postback処理
 *
 * カード利用通知・テキスト入力のボタン押下を処理
 */

import { WebhookEvent, PostbackEvent } from '@line/bot-sdk';
import { getFirestore } from 'firebase-admin/firestore';
import { PostbackActionData, ExpenseStatus } from '../gmail/types';
import { sendStatusUpdateConfirmation, sendTextMessage } from './flexMessage';

/**
 * 拡張されたPostbackアクションデータ
 */
interface ExtendedPostbackActionData extends PostbackActionData {
  source?: 'gmail' | 'text';  // 入力元
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
    const updateData: Record<string, any> = {
      status: newStatus,
      confirmed: true,
      updatedAt: new Date(),
    };

    // 立替の場合は立替者を記録
    if (action === 'advance') {
      // ボタンを押したユーザーを立替者として記録
      updateData.advanceBy = event.source.userId || 'unknown';
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
      // 確認済みにする
      await expenseRef.update({
        confirmed: true,
        status: 'shared',
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
        const editUrl = `https://line-kakeibo.vercel.app/expense/${expenseId}/edit?lineId=${event.source.userId}`;
        await sendTextMessage(
          replyTarget,
          `✏️ 以下のリンクから修正できます\n${editUrl}`
        );
      }
      break;

    case 'advance':
      // 立替として記録
      await expenseRef.update({
        status: 'advance_pending',
        advanceBy: event.source.userId || 'unknown',
        confirmed: true,
        updatedAt: new Date(),
      });
      if (replyTarget) {
        await sendTextMessage(
          replyTarget,
          `↩️ 立替として記録しました\n${expenseData.description} ¥${expenseData.amount?.toLocaleString()}\n月末精算に含めます`
        );
      }
      break;

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
