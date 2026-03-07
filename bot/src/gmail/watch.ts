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
 * Gmail Watchを登録
 * 新着メールがあるとPub/Subにメッセージが送信される
 */
export async function registerWatch(): Promise<GmailWatchState> {
  const gmail = await getGmailClient();

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

  const watchState: GmailWatchState = {
    historyId: historyId.toString(),
    watchExpiration: parseInt(expiration, 10),
  };

  // Firestoreに保存
  await saveWatchState(watchState);

  console.log(`Gmail Watch registered successfully. Expires at: ${new Date(watchState.watchExpiration).toISOString()}`);
  return watchState;
}

/**
 * Gmail Watchを更新（6日ごとに呼び出す）
 */
export async function renewWatch(): Promise<GmailWatchState> {
  console.log('Renewing Gmail Watch...');

  // 既存のWatchを停止してから再登録
  try {
    await stopWatch();
  } catch (error) {
    // Watchが存在しない場合はエラーを無視
    console.warn('Failed to stop existing watch (may not exist):', error);
  }

  return registerWatch();
}

/**
 * Gmail Watchを停止
 */
export async function stopWatch(): Promise<void> {
  const gmail = await getGmailClient();

  await gmail.users.stop({
    userId: 'me',
  });

  console.log('Gmail Watch stopped');
}

/**
 * Watch状態をFirestoreに保存
 */
async function saveWatchState(state: GmailWatchState): Promise<void> {
  const db = getFirestore();
  await db.collection('system').doc('gmailState').set({
    ...state,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Watch状態をFirestoreから読み込み
 */
export async function getWatchState(): Promise<GmailWatchState | null> {
  const db = getFirestore();
  const doc = await db.collection('system').doc('gmailState').get();

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

/**
 * historyIdを更新
 */
export async function updateHistoryId(historyId: string): Promise<void> {
  const db = getFirestore();
  await db.collection('system').doc('gmailState').update({
    historyId,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Watchが有効期限切れかどうかチェック
 * 期限の1日前から更新を推奨
 */
export async function isWatchExpiringSoon(): Promise<boolean> {
  const state = await getWatchState();

  if (!state) {
    return true; // 状態がない場合は更新が必要
  }

  // 1日のバッファを持って期限切れをチェック
  const oneDayMs = 24 * 60 * 60 * 1000;
  return state.watchExpiration < Date.now() + oneDayMs;
}

/**
 * Watchの有効期限を取得
 */
export async function getWatchExpiration(): Promise<Date | null> {
  const state = await getWatchState();

  if (!state) {
    return null;
  }

  return new Date(state.watchExpiration);
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
