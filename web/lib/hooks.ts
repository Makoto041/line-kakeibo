'use client';

import { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  where, 
  limit, 
  getDocs,
  getDoc,
  doc,
  updateDoc,
  deleteDoc,
  FirestoreError
} from 'firebase/firestore';
import { db, getFirebaseStatus } from './firebase';
import dayjs from 'dayjs';
import { normalizeCategoryName } from './categoryNormalization';

// Firestore document data shape for expenses (avoids explicit any)
export type FirestoreExpenseData = Partial<Expense> & { category?: string };

// Group interface for shared household budgets
export interface Group {
  id: string;
  name: string;
  inviteCode: string;
  createdBy: string;
  lineGroupId?: string;     // LINE Group ID if created from LINE group
  createdAt?: Date | { seconds: number; nanoseconds: number };
  updatedAt?: Date | { seconds: number; nanoseconds: number };
}

// Group membership interface
export interface GroupMember {
  groupId: string;
  lineId: string;
  displayName: string;
  joinedAt?: Date | { seconds: number; nanoseconds: number };
  isActive: boolean;
}

// Enhanced Expense interface with group support
export interface Expense {
  id: string;
  lineId: string;           // LINE User ID (who made the expense)
  groupId?: string;         // Optional: if this expense belongs to a group
  lineGroupId?: string;     // LINE Group ID if from LINE group
  userDisplayName?: string; // Display name of the user who made the expense
  amount: number;
  description: string;
  date: string;             // YYYY-MM-DD format
  category: string;
  includeInTotal: boolean;  // 合計に含めるかどうか（旧confirmed）
  payerId?: string;          // LINE User ID of the person who paid (defaults to lineId)
  payerDisplayName?: string; // Display name of the person who paid (defaults to userDisplayName)
  ocrText?: string;
  items?: Array<{
    name: string;
    price: number;
    quantity?: number;
  }>;
  createdAt?: Date | { seconds: number; nanoseconds: number };
  updatedAt?: Date | { seconds: number; nanoseconds: number };
}

// 統計情報インターフェース
export interface ExpenseStats {
  totalAmount: number;
  expenseCount: number;
  categoryTotals: Record<string, number>;
  dailyTotals: Record<string, number>;
}

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
      case 'already-exists':
        return 'データが既に存在します。';
      case 'failed-precondition':
        return '操作の前提条件が満たされていません。';
      case 'resource-exhausted':
        return 'リソースの上限に達しました。しばらくしてから再試行してください。';
      case 'invalid-argument':
        return '無効な引数が提供されました。';
      case 'unauthenticated':
        return '認証が必要です。再度ログインしてください。';
      default:
        return `Firestoreエラー: ${error.message}`;
    }
  }
  
  if (error instanceof Error) {
    return `エラー: ${error.message}`;
  }
  
  return '予期しないエラーが発生しました。';
};

// Firebase接続チェック関数
const checkFirebaseConnection = (): boolean => {
  const status = getFirebaseStatus();
  
  if (!status.isInitialized) {
    console.error('Firebase is not initialized', status);
    return false;
  }
  
  if (status.hasError) {
    console.error('Firebase initialization error:', status.error);
    return false;
  }
  
  if (!db) {
    console.error('Firestore database is not available');
    return false;
  }
  
  return true;
};

export function useLineAuth() {
  const [user, setUser] = useState<{ uid: string; isAnonymous: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // LINE IDベースの認証では、URLパラメータからLINE IDを取得
    // 静的サイトでのクライアントサイドルーティング対応
    const getLineIdFromUrl = () => {
      if (typeof window === 'undefined') return null;
      
      // Try multiple ways to get the LINE ID
      const urlParams = new URLSearchParams(window.location.search);
      let lineId = urlParams.get('lineId');
      
      // If not found in search params, try hash
      if (!lineId && window.location.hash) {
        const hashParams = new URLSearchParams(window.location.hash.replace('#', ''));
        lineId = hashParams.get('lineId');
      }
      
      // If still not found, try parsing the full URL
      if (!lineId) {
        const match = window.location.href.match(/[?&]lineId=([^&]+)/);
        if (match) {
          lineId = decodeURIComponent(match[1]);
        }
      }
      
      return lineId;
    };
    
    const lineId = getLineIdFromUrl();
    
    console.log('LINE ID from URL:', lineId);
    console.log('Current URL:', window.location.href);
    console.log('Search params:', window.location.search);
    console.log('Hash:', window.location.hash);
    
    if (lineId) {
      // LINE IDが存在する場合は、それをユーザーIDとして使用
      console.log('Setting user with LINE ID:', lineId);
      setUser({ uid: lineId, isAnonymous: false });
    } else {
      // LINE IDが存在しない場合はゲストユーザーとして扱う
      console.log('No LINE ID found, setting guest user');
      setUser({ uid: 'guest', isAnonymous: true });
    }
    
    setLoading(false);
  }, []);

  const signOutUser = async () => {
    // LINE IDベースの認証では、URLを変更してLINE IDを削除
    const url = new URL(window.location.href);
    url.searchParams.delete('lineId');
    window.history.replaceState({}, '', url.toString());
    
    // ゲストユーザーに戻す
    setUser({ uid: 'guest', isAnonymous: true });
  };

  // URLパラメータを保持してページ遷移するためのヘルパー関数
  const getUrlWithLineId = (path: string) => {
    if (typeof window === 'undefined') return path;
    const urlParams = new URLSearchParams(window.location.search);
    const lineId = urlParams.get('lineId');
    if (lineId) {
      return `${path}?lineId=${encodeURIComponent(lineId)}`;
    }
    return path;
  };

  return { 
    user, 
    loading, 
    signOut: signOutUser,
    isAnonymous: user?.isAnonymous || true,
    getUrlWithLineId
  };
}

export function useExpenses(userId: string | null, periodDays: number = 50, limitCount: number = 200, customStartDate?: string) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

    const fetchExpenses = async () => {
      try {
        setLoading(true);
        setError(null);
        
        console.log("データ取得開始 - userId:", userId, "period:", periodDays);
        
        // Firebase接続の再確認
        if (!db) {
          throw new Error('Firestoreデータベースが利用できません。設定を確認してください。');
        }
        
        // DEBUG: First try simple query like the bot does
        console.log("=== DEBUG: シンプルクエリテスト ===");
        try {
          const simpleQuery = query(
            collection(db, 'expenses'),
            where('lineId', '==', userId),
            limit(10)
          );
          const simpleSnapshot = await getDocs(simpleQuery);
          console.log("シンプルクエリ結果:", simpleSnapshot.docs.length, "件");
          
          if (simpleSnapshot.docs.length === 0) {
            console.log("警告: ユーザーの支出データが見つかりません。新規ユーザーの可能性があります。");
          }
          
          simpleSnapshot.docs.forEach(doc => {
            const data = doc.data();
            console.log("- 支出:", {
              id: doc.id,
              amount: data.amount,
              description: data.description,
              lineId: data.lineId,
              groupId: data.groupId,
              lineGroupId: data.lineGroupId,
              date: data.date
            });
          });
        } catch (debugError) {
          console.error("デバッグクエリエラー:", debugError);
          // デバッグクエリが失敗しても続行
        }
        
        // NOTE: 一般的なグループ機能は廃止、LINEグループのみを使用
        
        // Get user's personal expenses
        console.log("=== 個人の支出取得 ===");
        let personalQuery;
        if (customStartDate) {
          const startDate = customStartDate;
          const endDate = dayjs(customStartDate).add(1, 'month').subtract(1, 'day').format('YYYY-MM-DD');
          personalQuery = query(
            collection(db, 'expenses'),
            where('lineId', '==', userId),
            where('date', '>=', startDate),
            where('date', '<=', endDate),
            limit(limitCount)
          );
        } else if (periodDays > 0) {
          const endDate = dayjs().format('YYYY-MM-DD');
          const startDate = dayjs().subtract(periodDays, 'day').format('YYYY-MM-DD');
          personalQuery = query(
            collection(db, 'expenses'),
            where('lineId', '==', userId),
            where('date', '>=', startDate),
            where('date', '<=', endDate),
            limit(limitCount)
          );
        } else {
          personalQuery = query(
            collection(db, 'expenses'),
            where('lineId', '==', userId),
            limit(limitCount)
          );
        }
        
        const personalSnapshot = await getDocs(personalQuery);
        const personalExpenses = personalSnapshot.docs.map(doc => {
          const data = doc.data() as FirestoreExpenseData;
          return {
            id: doc.id,
            ...data,
            category: normalizeCategoryName(data.category)
          } as Expense;
        });
        
        console.log("個人の支出:", personalExpenses.length, "件");
        
        // Get LINE group expenses where this user participates
        console.log("=== LINEグループの支出取得 ===");
        let lineGroupExpenses: Expense[] = [];
        
        try {
          // First, get all user's expenses to find LINE group IDs they've participated in
          console.log("=== ユーザーの全支出からLINEグループIDを検索 ===");
          const allUserExpensesQuery = query(
            collection(db, 'expenses'),
            where('lineId', '==', userId),
            limit(200) // Increase limit to get more data
          );
          
          const allUserExpensesSnapshot = await getDocs(allUserExpensesQuery);
          const userLineGroupIds = new Set<string>();
          
          console.log("ユーザーの全支出件数:", allUserExpensesSnapshot.docs.length);
          
          allUserExpensesSnapshot.docs.forEach(doc => {
            const data = doc.data();
            console.log("支出データ:", {
              id: doc.id,
              amount: data.amount,
              description: data.description,
              lineGroupId: data.lineGroupId,
              date: data.date
            });
            
            if (data.lineGroupId) {
              userLineGroupIds.add(data.lineGroupId);
              console.log("LINEグループID発見:", data.lineGroupId);
            }
          });
          
          console.log("ユーザーが参加するLINEグループID:", Array.from(userLineGroupIds));
          console.log("検出されたLINEグループ数:", userLineGroupIds.size);
          
          // Get expenses from each LINE group
          for (const lineGroupId of userLineGroupIds) {
            console.log("=== LINEグループ", lineGroupId, "の支出を取得中... ===");
            
            let lineGroupQuery;
            let startDate, endDate;
            
            if (customStartDate) {
              startDate = customStartDate;
              endDate = dayjs(customStartDate).add(1, 'month').subtract(1, 'day').format('YYYY-MM-DD');
              console.log("カスタム期間:", startDate, "〜", endDate);
              lineGroupQuery = query(
                collection(db, 'expenses'),
                where('lineGroupId', '==', lineGroupId),
                where('date', '>=', startDate),
                where('date', '<=', endDate),
                limit(Math.max(limitCount, 500)) // Ensure we get enough data
              );
            } else if (periodDays > 0) {
              endDate = dayjs().format('YYYY-MM-DD');
              startDate = dayjs().subtract(periodDays, 'day').format('YYYY-MM-DD');
              console.log("期間指定:", periodDays, "日間 (", startDate, "〜", endDate, ")");
              lineGroupQuery = query(
                collection(db, 'expenses'),
                where('lineGroupId', '==', lineGroupId),
                where('date', '>=', startDate),
                where('date', '<=', endDate),
                limit(Math.max(limitCount, 500)) // Ensure we get enough data
              );
            } else {
              console.log("全期間での取得");
              lineGroupQuery = query(
                collection(db, 'expenses'),
                where('lineGroupId', '==', lineGroupId),
                limit(Math.max(limitCount, 500)) // Ensure we get enough data
              );
            }
            
            console.log("クエリ実行開始...");
            const lineGroupSnapshot = await getDocs(lineGroupQuery);
            console.log("クエリ結果:", lineGroupSnapshot.docs.length, "件");
            
            const lineGroupExpenseList = lineGroupSnapshot.docs.map(doc => {
              const data = doc.data() as FirestoreExpenseData;
              return {
                id: doc.id,
                ...data,
                category: normalizeCategoryName(data.category)
              } as Expense;
            });
            
            // Log each expense found in the LINE group
            lineGroupExpenseList.forEach((expense, index) => {
              console.log(`LINEグループ支出 ${index + 1}:`, {
                id: expense.id,
                amount: expense.amount,
                description: expense.description,
                userDisplayName: expense.userDisplayName,
                lineId: expense.lineId,
                date: expense.date
              });
            });
            
            console.log("LINEグループ", lineGroupId, "の支出:", lineGroupExpenseList.length, "件");
            lineGroupExpenses = [...lineGroupExpenses, ...lineGroupExpenseList];
          }
          
          console.log("LINEグループの支出合計:", lineGroupExpenses.length, "件");
        } catch (groupError) {
          console.error("LINEグループ支出取得エラー:", groupError);
          // LINEグループの取得が失敗しても個人支出は表示
        }
        
        // Combine all expenses and remove duplicates
        const allExpensesMap = new Map<string, Expense>();
        
        console.log("=== 支出の統合処理 ===");
        console.log("個人の支出数:", personalExpenses.length);
        console.log("LINEグループの支出数:", lineGroupExpenses.length);
        
        [...personalExpenses, ...lineGroupExpenses].forEach(expense => {
          allExpensesMap.set(expense.id, expense);
        });
        
        const allExpenses = Array.from(allExpensesMap.values());
        
        console.log("統合後の全体支出数:", allExpenses.length, "件");
        console.log("=== 統合された支出一覧 ===");
        allExpenses.forEach((expense, index) => {
          console.log(`支出 ${index + 1}:`, {
            id: expense.id,
            amount: expense.amount,
            description: expense.description,
            userDisplayName: expense.userDisplayName,
            lineGroupId: expense.lineGroupId ? "グループ" : "個人",
            date: expense.date
          });
        });
        
        // Sort in memory to avoid index requirement
        const sortedExpenses = allExpenses.sort((a, b) => {
          const aTime = a.createdAt ? 
            (typeof a.createdAt === 'object' && 'seconds' in a.createdAt ? 
              a.createdAt.seconds * 1000 : 
              (a.createdAt as Date).getTime()) : 0;
          const bTime = b.createdAt ? 
            (typeof b.createdAt === 'object' && 'seconds' in b.createdAt ? 
              b.createdAt.seconds * 1000 : 
              (b.createdAt as Date).getTime()) : 0;
          return bTime - aTime; // desc order
        });
        
        setExpenses(sortedExpenses);
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching expenses:', err);
        setError(errorMessage);
        setExpenses([]);
      } finally {
        setLoading(false);
      }
    };

    fetchExpenses();
  }, [userId, periodDays, limitCount, customStartDate]);

  const updateExpense = async (id: string, updates: Partial<Expense>) => {
    if (!checkFirebaseConnection()) {
      throw new Error('Firebase接続エラー: データベースが利用できません');
    }
    
    if (!db) {
      throw new Error('Firestoreデータベースが初期化されていません');
    }
    
    try {
      const normalizedUpdates = {
        ...updates,
        category: updates.category ? normalizeCategoryName(updates.category) : updates.category,
      } as Partial<Expense>;

      // Remove undefined values to avoid Firestore errors
      const cleanUpdates = Object.fromEntries(
        Object.entries(normalizedUpdates).filter(([_, value]) => value !== undefined)
      );

      await updateDoc(doc(db, 'expenses', id), {
        ...cleanUpdates,
        updatedAt: new Date()
      });
      
      // Update local state
      setExpenses(prev => 
        prev.map(expense => 
          expense.id === id ? { ...expense, ...normalizedUpdates } : expense
        )
      );
    } catch (err) {
      const errorMessage = handleFirestoreError(err);
      console.error('Error updating expense:', err);
      throw new Error(errorMessage);
    }
  };

  const deleteExpense = async (id: string) => {
    if (!checkFirebaseConnection()) {
      throw new Error('Firebase接続エラー: データベースが利用できません');
    }
    
    if (!db) {
      throw new Error('Firestoreデータベースが初期化されていません');
    }
    
    try {
      await deleteDoc(doc(db, 'expenses', id));
      
      // Update local state
      setExpenses(prev => prev.filter(expense => expense.id !== id));
    } catch (err) {
      const errorMessage = handleFirestoreError(err);
      console.error('Error deleting expense:', err);
      throw new Error(errorMessage);
    }
  };

  return { 
    expenses, 
    loading, 
    error, 
    updateExpense, 
    deleteExpense,
    refetch: () => {
      if (userId) {
        setLoading(true);
        // Re-trigger useEffect
        setExpenses([]);
      }
    }
  };
}

export function useMonthlyStats(userId: string | null, year: number, month: number, startDay: number = 1, customStartDate?: string, customEndDate?: string) {
  const [stats, setStats] = useState<ExpenseStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || userId === 'guest') {
      setLoading(false);
      return;
    }

    // Firebase接続チェック
    if (!checkFirebaseConnection()) {
      const status = getFirebaseStatus();
      setError(`Firebase接続エラー: ${status.error?.message || '初期化に失敗しました'}`);
      setLoading(false);
      return;
    }

    const fetchStats = async () => {
      try {
        setLoading(true);
        setError(null);
        
        if (!db) {
          throw new Error('Firestoreデータベースが利用できません');
        }
        
        console.log("月次統計取得開始 - userId:", userId, "year:", year, "month:", month);
        
        let startDate: string;
        let endDate: string;
        
        if (customStartDate && customEndDate) {
          startDate = customStartDate;
          endDate = customEndDate;
          console.log("カスタム日付範囲:", startDate, "〜", endDate);
        } else {
          startDate = dayjs(`${year}-${month.toString().padStart(2, '0')}-${startDay.toString().padStart(2, '0')}`).format('YYYY-MM-DD');
          endDate = dayjs(startDate).add(1, 'month').subtract(1, 'day').format('YYYY-MM-DD');
          console.log("月次統計範囲:", startDate, "〜", endDate);
        }
        
        // NOTE: 一般的なグループ機能は廃止、LINEグループのみを使用
        
        // Get personal expenses for monthly stats
        const personalQuery = query(
          collection(db, 'expenses'),
          where('lineId', '==', userId),
          where('date', '>=', startDate),
          where('date', '<=', endDate)
        );
        
        const personalSnapshot = await getDocs(personalQuery);
        const personalExpenses = personalSnapshot.docs.map(doc => ({ 
          id: doc.id, 
          ...doc.data() 
        } as Expense));
        
        console.log("月次統計 - 個人の支出:", personalExpenses.length, "件");
        
        // Get LINE group expenses for monthly stats
        let lineGroupExpenses: Expense[] = [];
        
        try {
          // Get all user's expenses to find LINE group IDs they've participated in
          const allUserExpensesQuery = query(
            collection(db, 'expenses'),
            where('lineId', '==', userId),
            limit(100)
          );
          
          const allUserExpensesSnapshot = await getDocs(allUserExpensesQuery);
          const userLineGroupIds = new Set<string>();
          
          allUserExpensesSnapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data.lineGroupId) {
              userLineGroupIds.add(data.lineGroupId);
            }
          });
          
          // Get expenses from LINE groups for the specified period
          for (const lineGroupId of userLineGroupIds) {
            const lineGroupQuery = query(
              collection(db, 'expenses'),
              where('lineGroupId', '==', lineGroupId),
              where('date', '>=', startDate),
              where('date', '<=', endDate)
            );
            
            const lineGroupSnapshot = await getDocs(lineGroupQuery);
            const lineGroupExpenseList = lineGroupSnapshot.docs.map(doc => ({ 
              id: doc.id, 
              ...doc.data() 
            } as Expense));
            
            lineGroupExpenses = [...lineGroupExpenses, ...lineGroupExpenseList];
          }
          
          console.log("月次統計 - LINEグループの支出:", lineGroupExpenses.length, "件");
        } catch (groupError) {
          console.error("月次統計 - LINEグループ支出取得エラー:", groupError);
        }
        
        // Combine all expenses and remove duplicates
        const allExpensesMap = new Map<string, Expense>();
        
        [...personalExpenses, ...lineGroupExpenses].forEach(expense => {
          allExpensesMap.set(expense.id, expense);
        });
        
        const allExpenses = Array.from(allExpensesMap.values());
        
        console.log("月次統計 - 全体の支出:", allExpenses.length, "件");
        
        // Sort in memory by date desc
        const expenses = allExpenses.sort((a, b) => b.date.localeCompare(a.date));
        
        // 合計に含める支出のみを統計計算に含める
        const includedExpenses = expenses.filter(expense => expense.includeInTotal);
        
        const totalAmount = includedExpenses.reduce((sum, expense) => sum + expense.amount, 0);
        
        const categoryTotals = includedExpenses.reduce((acc, expense) => {
          acc[expense.category] = (acc[expense.category] || 0) + expense.amount;
          return acc;
        }, {} as Record<string, number>);
        
        const dailyTotals = includedExpenses.reduce((acc, expense) => {
          acc[expense.date] = (acc[expense.date] || 0) + expense.amount;
          return acc;
        }, {} as Record<string, number>);
        
        setStats({
          totalAmount,
          expenseCount: includedExpenses.length,
          categoryTotals,
          dailyTotals
        });
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching monthly stats:', err);
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [userId, year, month, startDay, customStartDate, customEndDate]);

  return { stats, loading, error };
}

export function useUserGroups(userId: string | null) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || userId === 'guest') {
      setLoading(false);
      return;
    }

    // Firebase接続チェック
    if (!checkFirebaseConnection()) {
      const status = getFirebaseStatus();
      setError(`Firebase接続エラー: ${status.error?.message || '初期化に失敗しました'}`);
      setLoading(false);
      return;
    }

    const fetchGroups = async () => {
      try {
        setLoading(true);
        setError(null);
        
        if (!db) {
          throw new Error('Firestoreデータベースが利用できません');
        }
        
        console.log("ユーザーグループ取得開始 - userId:", userId);
        
        // Get user's group memberships
        const membershipQuery = query(
          collection(db, 'groupMembers'),
          where('lineId', '==', userId),
          where('isActive', '==', true)
        );
        
        const membershipSnapshot = await getDocs(membershipQuery);
        
        if (membershipSnapshot.empty) {
          setGroups([]);
          setError(null);
          return;
        }
        
        // Get group details for each membership
        const groupPromises = membershipSnapshot.docs.map(async (memberDoc) => {
          const memberData = memberDoc.data();
          const groupDoc = await getDoc(doc(db!, 'groups', memberData.groupId));
          
          if (groupDoc.exists()) {
            return {
              id: groupDoc.id,
              ...groupDoc.data()
            } as Group;
          }
          return null;
        });
        
        const groupResults = await Promise.all(groupPromises);
        const validGroups = groupResults.filter(group => group !== null) as Group[];
        
        console.log("取得したグループ:", validGroups);
        
        setGroups(validGroups);
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching user groups:', err);
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchGroups();
  }, [userId]);

  return { groups, loading, error };
}

export function useGroupExpenses(groupId: string | null, limitCount: number = 50) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!groupId) {
      setLoading(false);
      return;
    }

    // Firebase接続チェック
    if (!checkFirebaseConnection()) {
      const status = getFirebaseStatus();
      setError(`Firebase接続エラー: ${status.error?.message || '初期化に失敗しました'}`);
      setLoading(false);
      return;
    }

    const fetchGroupExpenses = async () => {
      try {
        setLoading(true);
        setError(null);
        
        if (!db) {
          throw new Error('Firestoreデータベースが利用できません');
        }
        
        console.log("グループ支出取得開始 - groupId:", groupId);
        
        const q = query(
          collection(db, 'expenses'),
          where('groupId', '==', groupId),
          limit(limitCount)
        );
        
        const querySnapshot = await getDocs(q);
        console.log("グループ支出クエリ結果:", querySnapshot.docs.length, "件");
        
        const expenseList = querySnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        } as Expense));
        
        console.log("取得したグループ支出:", expenseList);
        
        // Sort in memory by creation time desc
        const sortedExpenses = expenseList.sort((a, b) => {
          const aTime = a.createdAt ? 
            (typeof a.createdAt === 'object' && 'seconds' in a.createdAt ? 
              a.createdAt.seconds * 1000 : 
              (a.createdAt as Date).getTime()) : 0;
          const bTime = b.createdAt ? 
            (typeof b.createdAt === 'object' && 'seconds' in b.createdAt ? 
              b.createdAt.seconds * 1000 : 
              (b.createdAt as Date).getTime()) : 0;
          return bTime - aTime; // desc order
        });
        
        setExpenses(sortedExpenses);
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching group expenses:', err);
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchGroupExpenses();
  }, [groupId, limitCount]);

  return { expenses, loading, error };
}

export function useLineGroupExpenses(lineGroupId: string | null, limitCount: number = 50) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!lineGroupId) {
      setLoading(false);
      return;
    }

    // Firebase接続チェック
    if (!checkFirebaseConnection()) {
      const status = getFirebaseStatus();
      setError(`Firebase接続エラー: ${status.error?.message || '初期化に失敗しました'}`);
      setLoading(false);
      return;
    }

    const fetchLineGroupExpenses = async () => {
      try {
        setLoading(true);
        setError(null);
        
        if (!db) {
          throw new Error('Firestoreデータベースが利用できません');
        }
        
        console.log("LINEグループ支出取得開始 - lineGroupId:", lineGroupId);
        
        const q = query(
          collection(db, 'expenses'),
          where('lineGroupId', '==', lineGroupId),
          limit(limitCount)
        );
        
        const querySnapshot = await getDocs(q);
        console.log("LINEグループ支出クエリ結果:", querySnapshot.docs.length, "件");
        
        const expenseList = querySnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        } as Expense));
        
        console.log("取得したLINEグループ支出:", expenseList);
        
        // Sort in memory by creation time desc
        const sortedExpenses = expenseList.sort((a, b) => {
          const aTime = a.createdAt ? 
            (typeof a.createdAt === 'object' && 'seconds' in a.createdAt ? 
              a.createdAt.seconds * 1000 : 
              (a.createdAt as Date).getTime()) : 0;
          const bTime = b.createdAt ? 
            (typeof b.createdAt === 'object' && 'seconds' in b.createdAt ? 
              b.createdAt.seconds * 1000 : 
              (b.createdAt as Date).getTime()) : 0;
          return bTime - aTime; // desc order
        });
        
        setExpenses(sortedExpenses);
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching LINE group expenses:', err);
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchLineGroupExpenses();
  }, [lineGroupId, limitCount]);

  return { expenses, loading, error };
}

// グループメンバーを取得するフック
export function useGroupMembers(groupId: string | null) {
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!groupId) {
      setLoading(false);
      setMembers([]);
      return;
    }

    if (!checkFirebaseConnection()) {
      setError('Firebaseに接続できません');
      setLoading(false);
      return;
    }

    const fetchGroupMembers = async () => {
      try {
        setLoading(true);
        console.log("グループメンバー取得開始 - groupId:", groupId);

        const membersQuery = query(
          collection(db!, 'groupMembers'),
          where('groupId', '==', groupId),
          where('isActive', '==', true)
        );

        const snapshot = await getDocs(membersQuery);
        
        if (snapshot.empty) {
          console.log("グループメンバーが見つかりません");
          setMembers([]);
          setError(null);
          return;
        }

        const memberList: GroupMember[] = snapshot.docs.map(doc => {
          const data = doc.data();
          console.log("--- GroupMember生データ ---");
          console.log("Document ID:", doc.id);
          console.log("Raw data:", data);
          console.log("displayName:", data.displayName, typeof data.displayName);
          console.log("lineId:", data.lineId);
          console.log("groupId:", data.groupId);
          console.log("isActive:", data.isActive);
          
          return {
            id: doc.id,
            groupId: data.groupId,
            lineId: data.lineId,
            displayName: data.displayName || `Unknown_${data.lineId?.slice(-6) || 'NoID'}`,
            joinedAt: data.joinedAt,
            isActive: data.isActive
          } as GroupMember;
        });

        console.log("処理後のグループメンバー:", memberList);
        setMembers(memberList);
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching group members:', err);
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchGroupMembers();
  }, [groupId]);

  return { members, loading, error };
}

// LINE Group IDベースでメンバーを取得するフック（フォールバック用）
export function useLineGroupMembers(lineGroupId: string | null) {
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!lineGroupId) {
      setLoading(false);
      setMembers([]);
      return;
    }

    if (!checkFirebaseConnection()) {
      setError('Firebaseに接続できません');
      setLoading(false);
      return;
    }

    const fetchLineGroupMembers = async () => {
      try {
        setLoading(true);
        console.log("LINE グループメンバー取得開始 - lineGroupId:", lineGroupId);

        // まずlineGroupIdに対応するグループを探す
        const groupQuery = query(
          collection(db!, 'groups'),
          where('lineGroupId', '==', lineGroupId)
        );

        const groupSnapshot = await getDocs(groupQuery);
        
        if (groupSnapshot.empty) {
          console.log("LINE Group IDに対応するグループが見つかりません");
          setMembers([]);
          setError(null);
          return;
        }

        const group = groupSnapshot.docs[0];
        const groupId = group.id;
        
        console.log("対応するgroupId:", groupId);

        // そのグループのメンバーを取得
        const membersQuery = query(
          collection(db!, 'groupMembers'),
          where('groupId', '==', groupId),
          where('isActive', '==', true)
        );

        const membersSnapshot = await getDocs(membersQuery);
        
        if (membersSnapshot.empty) {
          console.log("グループメンバーが見つかりません");
          setMembers([]);
          setError(null);
          return;
        }

        const memberList: GroupMember[] = membersSnapshot.docs.map(doc => {
          const data = doc.data();
          console.log("--- LINE GroupMember生データ ---");
          console.log("Document ID:", doc.id);
          console.log("Raw data:", data);
          console.log("displayName:", data.displayName, typeof data.displayName);
          console.log("lineId:", data.lineId);
          console.log("groupId:", data.groupId);
          console.log("isActive:", data.isActive);
          
          return {
            id: doc.id,
            groupId: data.groupId,
            lineId: data.lineId,
            displayName: data.displayName || `LineUnknown_${data.lineId?.slice(-6) || 'NoID'}`,
            joinedAt: data.joinedAt,
            isActive: data.isActive
          } as GroupMember;
        });

        console.log("処理後のLINE グループメンバー:", memberList);
        setMembers(memberList);
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching LINE group members:', err);
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchLineGroupMembers();
  }, [lineGroupId]);

  return { members, loading, error };
}
