/**
 * LINE Postback処理
 *
 * カード利用通知のボタン押下を処理
 */

import { WebhookEvent, PostbackEvent } from '@line/bot-sdk';
import { getFirestore } from 'firebase-admin/firestore';
import { PostbackActionData, ExpenseStatus } from '../gmail/types';
import { sendStatusUpdateConfirmation } from './flexMessage';

/**
 * Postbackイベントを処理
 */
export async function handlePostback(event: PostbackEvent): Promise<void> {
  try {
    const data = event.postback.data;

    // JSONパースを試行
    let actionData: PostbackActionData;
    try {
      actionData = JSON.parse(data);
    } catch {
      console.log('Non-JSON postback data, skipping:', data);
      return;
    }

    // Gmail自動取得のPostbackかチェック
    if (!actionData.action || !actionData.expenseId) {
      console.log('Not a Gmail postback, skipping');
      return;
    }

    const { action, expenseId } = actionData;

    // ステータスを更新
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

    if (replyTarget) {
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
      ['shared', 'personal', 'advance'].includes(parsed.action)
    );
  } catch {
    return false;
  }
}
