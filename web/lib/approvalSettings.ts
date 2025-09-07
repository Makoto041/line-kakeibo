'use client';

import { 
  doc, 
  getDoc, 
  setDoc,
  addDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  orderBy,
  serverTimestamp
} from 'firebase/firestore';
import { db } from './firebase';

// 承認者設定の型定義
export interface ApprovalSettings {
  approvers: string[]; // 承認者のLINE IDのリスト
  passwordHash?: string; // パスワードのハッシュ（実際の実装では適切なハッシュ化が必要）
  updatedAt?: Date;
  updatedBy?: string;
}

// 承認者申請の型定義
export interface ApprovalRequest {
  id?: string;
  userId: string; // 申請者のLINE ID
  displayName: string; // 申請者の表示名
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: Date;
  processedAt?: Date;
  processedBy?: string; // 処理した管理者のID
  message?: string; // 申請理由やメッセージ
}

// デフォルトの承認者設定
export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = {
  approvers: [],
};

// 環境変数からパスワードを取得（フォールバックとして従来のパスワードを使用）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'makoto014';

/**
 * 承認者設定を取得
 */
export async function getApprovalSettings(): Promise<ApprovalSettings> {
  if (!db) {
    console.error('Firestore is not initialized');
    return DEFAULT_APPROVAL_SETTINGS;
  }

  try {
    const settingsDoc = await getDoc(doc(db, 'settings', 'approval'));
    
    if (settingsDoc.exists()) {
      const data = settingsDoc.data();
      return {
        approvers: data.approvers || [],
        passwordHash: data.passwordHash,
        updatedAt: data.updatedAt?.toDate(),
        updatedBy: data.updatedBy,
      };
    }
    
    return DEFAULT_APPROVAL_SETTINGS;
  } catch (error) {
    console.error('Error fetching approval settings:', error);
    return DEFAULT_APPROVAL_SETTINGS;
  }
}

/**
 * 承認者設定を保存
 */
export async function saveApprovalSettings(
  settings: ApprovalSettings,
  userId: string
): Promise<void> {
  if (!db) {
    throw new Error('Firestore is not initialized');
  }

  try {
    await setDoc(doc(db, 'settings', 'approval'), {
      ...settings,
      updatedAt: new Date(),
      updatedBy: userId,
    });
  } catch (error) {
    console.error('Error saving approval settings:', error);
    throw error;
  }
}

/**
 * パスワードを検証
 */
export function validateAdminPassword(password: string): boolean {
  return password === ADMIN_PASSWORD;
}

/**
 * ユーザーが承認者かどうかをチェック
 */
export async function isApprover(userId: string): Promise<boolean> {
  const settings = await getApprovalSettings();
  return settings.approvers.includes(userId);
}

/**
 * 未承認の支出をデフォルトで作成
 * 新規作成された支出はデフォルトで未承認状態
 */
export function createUnconfirmedExpense(expenseData: Record<string, unknown>) {
  return {
    ...expenseData,
    confirmed: false,
    createdAt: new Date(),
  };
}

/**
 * 未承認の支出の数を取得
 */
export async function getUnconfirmedExpenseCount(userId?: string): Promise<number> {
  if (!db) {
    console.error('Firestore is not initialized');
    return 0;
  }

  try {
    let q;
    if (userId) {
      // 特定のユーザーの未承認支出
      q = query(
        collection(db, 'expenses'),
        where('lineId', '==', userId),
        where('confirmed', '==', false)
      );
    } else {
      // 全体の未承認支出
      q = query(
        collection(db, 'expenses'),
        where('confirmed', '==', false)
      );
    }
    
    const snapshot = await getDocs(q);
    return snapshot.size;
  } catch (error) {
    console.error('Error fetching unconfirmed expense count:', error);
    return 0;
  }
}

/**
 * 承認者申請を送信
 */
export async function submitApprovalRequest(
  userId: string,
  displayName: string,
  message?: string
): Promise<string> {
  if (!db) {
    throw new Error('Firestore is not initialized');
  }

  // 既存の申請をチェック
  const existingRequest = await getPendingApprovalRequest(userId);
  if (existingRequest) {
    throw new Error('既に申請中です。管理者の承認をお待ちください。');
  }

  // 既に承認者かどうかチェック
  const isAlreadyApprover = await isApprover(userId);
  if (isAlreadyApprover) {
    throw new Error('既に承認者として登録されています。');
  }

  try {
    const docRef = await addDoc(collection(db, 'approvalRequests'), {
      userId,
      displayName,
      status: 'pending',
      requestedAt: serverTimestamp(),
      message: message || ''
    });
    
    return docRef.id;
  } catch (error) {
    console.error('Error submitting approval request:', error);
    throw error;
  }
}

/**
 * 承認者申請一覧を取得
 */
export async function getApprovalRequests(): Promise<ApprovalRequest[]> {
  if (!db) {
    console.error('Firestore is not initialized');
    return [];
  }

  try {
    const q = query(
      collection(db, 'approvalRequests'),
      orderBy('requestedAt', 'desc')
    );
    
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      requestedAt: doc.data().requestedAt?.toDate(),
      processedAt: doc.data().processedAt?.toDate()
    })) as ApprovalRequest[];
  } catch (error) {
    console.error('Error fetching approval requests:', error);
    
    // Firestoreエラーの詳細情報をログ出力
    if (error instanceof Error) {
      console.error('Error details:', {
        message: error.message,
        name: error.name,
        stack: error.stack
      });
    }
    
    return [];
  }
}

/**
 * 保留中の承認者申請を取得
 */
export async function getPendingApprovalRequest(userId: string): Promise<ApprovalRequest | null> {
  if (!db) {
    return null;
  }

  try {
    const q = query(
      collection(db, 'approvalRequests'),
      where('userId', '==', userId),
      where('status', '==', 'pending')
    );
    
    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      return null;
    }
    
    const doc = snapshot.docs[0];
    return {
      id: doc.id,
      ...doc.data(),
      requestedAt: doc.data().requestedAt?.toDate(),
      processedAt: doc.data().processedAt?.toDate()
    } as ApprovalRequest;
  } catch (error) {
    console.error('Error fetching pending approval request:', error);
    return null;
  }
}

/**
 * 承認者申請を承認
 */
export async function approveRequest(
  requestId: string,
  adminUserId: string
): Promise<void> {
  if (!db) {
    throw new Error('Firestore is not initialized');
  }

  try {
    // 申請を取得
    const requestDoc = await getDoc(doc(db, 'approvalRequests', requestId));
    if (!requestDoc.exists()) {
      throw new Error('申請が見つかりません。');
    }

    const request = requestDoc.data() as ApprovalRequest;
    
    // 申請を承認状態に更新
    await updateDoc(doc(db, 'approvalRequests', requestId), {
      status: 'approved',
      processedAt: serverTimestamp(),
      processedBy: adminUserId
    });

    // 承認者リストに追加
    const settings = await getApprovalSettings();
    const updatedApprovers = [...settings.approvers, request.userId];
    
    await saveApprovalSettings({
      ...settings,
      approvers: updatedApprovers
    }, adminUserId);
    
  } catch (error) {
    console.error('Error approving request:', error);
    throw error;
  }
}

/**
 * 承認者申請を拒否
 */
export async function rejectRequest(
  requestId: string,
  adminUserId: string
): Promise<void> {
  if (!db) {
    throw new Error('Firestore is not initialized');
  }

  try {
    await updateDoc(doc(db, 'approvalRequests', requestId), {
      status: 'rejected',
      processedAt: serverTimestamp(),
      processedBy: adminUserId
    });
  } catch (error) {
    console.error('Error rejecting request:', error);
    throw error;
  }
}

/**
 * 承認者を削除
 */
export async function removeApprover(
  approverUserId: string,
  adminUserId: string
): Promise<void> {
  if (!db) {
    throw new Error('Firestore is not initialized');
  }

  try {
    const settings = await getApprovalSettings();
    const updatedApprovers = settings.approvers.filter(id => id !== approverUserId);
    
    await saveApprovalSettings({
      ...settings,
      approvers: updatedApprovers
    }, adminUserId);
  } catch (error) {
    console.error('Error removing approver:', error);
    throw error;
  }
}
