'use client';

import { 
  doc, 
  getDoc, 
  setDoc,
  collection,
  query,
  where,
  getDocs
} from 'firebase/firestore';
import { db } from './firebase';

// 承認者設定の型定義
export interface ApprovalSettings {
  approvers: string[]; // 承認者のLINE IDのリスト
  passwordHash?: string; // パスワードのハッシュ（実際の実装では適切なハッシュ化が必要）
  updatedAt?: Date;
  updatedBy?: string;
}

// デフォルトの承認者設定
export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = {
  approvers: [],
};

// ハードコードされたパスワード（本番環境では環境変数にすべき）
const ADMIN_PASSWORD = 'makoto014';

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
export function createUnconfirmedExpense(expenseData: any) {
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
