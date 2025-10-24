'use client';

import { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  where, 
  limit, 
  FirestoreError,
  onSnapshot,
  getDocs,
  orderBy,
  Unsubscribe
} from 'firebase/firestore';
import { db, getFirebaseStatus } from './firebase';
import dayjs from 'dayjs';
import { normalizeCategoryName } from './categoryNormalization';
import { Expense, FirestoreExpenseData } from './hooks';

// メモリキャッシュ（5分間）
const expenseCache = new Map<string, { data: Expense[]; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5分

// Firebaseエラーハンドリングヘルパー
const handleFirestoreError = (error: unknown): string => {
  console.error('Firestore Error:', error);
  
  if (error instanceof FirestoreError) {
    switch (error.code) {
      case 'permission-denied':
        return 'アクセス権限がありません。Firebaseのセキュリティルールを確認してください。';
      case 'unavailable':
        return 'Firestoreサービスに接続できません。インターネット接続を確認してください。';
      case 'not-found':
        return 'リクエストされたデータが見つかりません。';
      default:
        return `Firestoreエラー: ${error.message}`;
    }
  }
  
  if (error instanceof Error) {
    return error.message;
  }
  
  return '不明なエラーが発生しました。';
};

// Firebase接続チェック
function checkFirebaseConnection(): boolean {
  try {
    const status = getFirebaseStatus();
    return status.isConnected && !status.error;
  } catch (error) {
    console.error('Firebase connection check failed:', error);
    return false;
  }
}

/**
 * 高速リアルタイム支出データフック
 */
export function useRealtimeExpenses(userId: string | null, periodDays: number = 50, limitCount: number = 200, customStartDate?: string) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  useEffect(() => {
    if (!userId || userId === 'guest') {
      setLoading(false);
      setExpenses([]);
      return;
    }

    // Firebase接続チェック
    if (!checkFirebaseConnection()) {
      const status = getFirebaseStatus();
      setError(`Firebase接続エラー: ${status.error?.message || '初期化に失敗しました'}`);
      setLoading(false);
      return;
    }

    // キャッシュチェック
    const cacheKey = `${userId}_${periodDays}_${limitCount}_${customStartDate || ''}`;
    const cached = expenseCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      console.log('キャッシュからデータを読み込み');
      setExpenses(cached.data);
      setLoading(false);
      setLastUpdate(new Date());
    }

    // 一時的にリアルタイム機能を無効化（デバッグ用）
    const DISABLE_REALTIME = process.env.NEXT_PUBLIC_DISABLE_REALTIME === 'true';
    
    // リアルタイムリスナーの設定
    let unsubscribe: Unsubscribe | null = null;
    
    const setupRealtimeListener = async () => {
      try {
        if (!cached) {
          setLoading(true);
        }
        setError(null);
        
        console.log("リアルタイムリスナー設定開始 - userId:", userId, "period:", periodDays);
        
        // Firebase接続の再確認
        if (!db) {
          throw new Error('Firestoreデータベースが利用できません。設定を確認してください。');
        }

        // 期間の計算
        const startDate = customStartDate 
          ? dayjs(customStartDate).startOf('day').format('YYYY-MM-DD')
          : dayjs().subtract(periodDays, 'day').format('YYYY-MM-DD');
        
        console.log("データ取得条件:", { userId, startDate, limitCount });
        
        // リアルタイムクエリの設定（最適化）
        const q = query(
          collection(db, 'expenses'),
          where('lineId', '==', userId),
          where('date', '>=', startDate),
          orderBy('date', 'desc'),
          orderBy('createdAt', 'desc'),
          limit(limitCount)
        );
        
        // リアルタイム機能が無効化されている場合は通常の読み取り
        if (DISABLE_REALTIME) {
          console.log('リアルタイム機能無効化中 - 通常読み取りを実行');
          const snapshot = await getDocs(q);
          const expenseData: Expense[] = snapshot.docs.map((doc) => {
            const data = doc.data() as FirestoreExpenseData;
            const firebaseTimestamp = data.createdAt as { seconds: number; nanoseconds: number } | undefined;
            
            return {
              id: doc.id,
              lineId: data.lineId || '',
              groupId: data.groupId,
              lineGroupId: data.lineGroupId,
              userDisplayName: data.userDisplayName,
              amount: data.amount || 0,
              description: data.description || '',
              date: data.date || dayjs().format('YYYY-MM-DD'),
              category: normalizeCategoryName(data.category) || 'その他',
              includeInTotal: data.includeInTotal !== false,
              ocrText: data.ocrText,
              items: data.items || [],
              createdAt: firebaseTimestamp ? new Date(firebaseTimestamp.seconds * 1000) : new Date(),
              updatedAt: data.updatedAt ? new Date((data.updatedAt as { seconds: number }).seconds * 1000) : new Date()
            };
          });
          
          // キャッシュ更新
          expenseCache.set(cacheKey, {
            data: expenseData,
            timestamp: Date.now()
          });
          
          setExpenses(expenseData);
          setLoading(false);
          setLastUpdate(new Date());
          setError(null);
          return;
        }

        // リアルタイムリスナーの開始
        unsubscribe = onSnapshot(q, 
          (snapshot) => {
            console.log('データ更新を検知:', snapshot.size, '件');
            
            const expenseData: Expense[] = snapshot.docs.map((doc) => {
              const data = doc.data() as FirestoreExpenseData;
              const firebaseTimestamp = data.createdAt as { seconds: number; nanoseconds: number } | undefined;
              
              return {
                id: doc.id,
                lineId: data.lineId || '',
                groupId: data.groupId,
                lineGroupId: data.lineGroupId,
                userDisplayName: data.userDisplayName,
                amount: data.amount || 0,
                description: data.description || '',
                date: data.date || dayjs().format('YYYY-MM-DD'),
                category: normalizeCategoryName(data.category) || 'その他',
                includeInTotal: data.includeInTotal !== false,
                ocrText: data.ocrText,
                items: data.items || [],
                createdAt: firebaseTimestamp ? new Date(firebaseTimestamp.seconds * 1000) : new Date(),
                updatedAt: data.updatedAt ? new Date((data.updatedAt as { seconds: number }).seconds * 1000) : new Date()
              };
            });
            
            console.log('処理済みデータ:', expenseData.length, '件');
            
            // キャッシュ更新
            expenseCache.set(cacheKey, {
              data: expenseData,
              timestamp: Date.now()
            });
            
            setExpenses(expenseData);
            setLoading(false);
            setLastUpdate(new Date());
            setError(null);
          },
          (error) => {
            console.error('リアルタイムリスナーエラー:', error);
            const errorMessage = handleFirestoreError(error);
            setError(errorMessage);
            setLoading(false);
          }
        );
        
      } catch (error) {
        console.error('リアルタイムリスナー設定エラー:', error);
        const errorMessage = handleFirestoreError(error);
        setError(errorMessage);
        setLoading(false);
      }
    };

    setupRealtimeListener();
    
    // クリーンアップ関数
    return () => {
      if (unsubscribe) {
        console.log('リアルタイムリスナーを解除');
        unsubscribe();
      }
    };
  }, [userId, periodDays, limitCount, customStartDate]);

  return { expenses, loading, error, lastUpdate };
}

// キャッシュクリーンアップ関数
export function clearExpenseCache() {
  expenseCache.clear();
  console.log('支出データキャッシュをクリアしました');
}

// 手動でデータを最新化する関数
export function refreshExpenses() {
  clearExpenseCache();
  console.log('データを手動で最新化しました');
}