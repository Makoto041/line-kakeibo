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
  deleteDoc 
} from 'firebase/firestore';
import { db, getFirebaseStatus } from './firebase';
import dayjs from 'dayjs';
import { normalizeCategoryName } from './categoryNormalization';

// Firestore document data shape for expenses (avoids explicit any)
type FirestoreExpenseData = Partial<Expense> & { category?: string };

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
  confirmed: boolean;
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

// Firebase接続ステータスをチェックするヘルパー関数
const checkFirebaseConnection = (): { isConnected: boolean; error: string | null } => {
  const status = getFirebaseStatus();
  
  if (!status.isInitialized) {
    return {
      isConnected: false,
      error: 'Firebase is not initialized. Please check your configuration.'
    };
  }
  
  if (status.hasError) {
    return {
      isConnected: false,
      error: status.error?.message || 'Firebase initialization failed.'
    };
  }
  
  if (!db) {
    return {
      isConnected: false,
      error: 'Firestore database is not available.'
    };
  }
  
  return {
    isConnected: true,
    error: null
  };
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
    // ゲストユーザーの場合はスキップ
    if (!userId || userId === 'guest') {
      console.log('User is guest, skipping expense fetch');
      setLoading(false);
      return;
    }

    // Firebase接続チェック
    const connectionStatus = checkFirebaseConnection();
    if (!connectionStatus.isConnected) {
      console.error('Firebase connection error:', connectionStatus.error);
      setError(connectionStatus.error || 'Firebase接続エラー');
      setLoading(false);
      return;
    }

    const fetchExpenses = async () => {
      try {
        setLoading(true);
        setError(null);
        
        console.log("データ取得開始 - userId:", userId, "period:", periodDays);
        
        // Firebase接続を再度確認
        if (!db) {
          throw new Error('Firestore database is not available');
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
          console.error("シンプルクエリエラー:", debugError);
          // エラーの詳細を解析
          if ((debugError as any)?.code === 'permission-denied') {
            throw new Error('Firestore Security Rulesにより、データへのアクセスが拒否されました。管理者に連絡してください。');
          } else if ((debugError as any)?.code === 'unavailable') {
            throw new Error('Firestoreサービスが利用できません。インターネット接続を確認してください。');
          }
          throw debugError;
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
            limit(100) // Limit to avoid performance issues
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
                limit(limitCount)
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
                limit(limitCount)
              );
            } else {
              console.log("全期間での取得");
              lineGroupQuery = query(
                collection(db, 'expenses'),
                where('lineGroupId', '==', lineGroupId),
                limit(limitCount)
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
        } catch (error) {
          console.error("LINEグループ支出取得エラー:", error);
          // Continue with empty array if LINE group fetch fails
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
        console.error('Error fetching expenses:', err);
        
        // エラーメッセージを詳細化
        let errorMessage = '支出データの取得に失敗しました';
        if (err instanceof Error) {
          errorMessage = err.message;
        } else if ((err as any)?.message) {
          errorMessage = (err as any).message;
        }
        
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchExpenses();
  }, [userId, periodDays, limitCount, customStartDate]);

  const updateExpense = async (id: string, updates: Partial<Expense>) => {
    if (!db) {
      throw new Error('Firebase not initialized. Please check your configuration.');
    }
    try {
      const normalizedUpdates = {
        ...updates,
        category: updates.category ? normalizeCategoryName(updates.category) : updates.category,
      } as Partial<Expense>;

      await updateDoc(doc(db, 'expenses', id), {
        ...normalizedUpdates,
        updatedAt: new Date()
      });
      
      // Update local state
      setExpenses(prev => 
        prev.map(expense => 
          expense.id === id ? { ...expense, ...normalizedUpdates } : expense
        )
      );
    } catch (err) {
      console.error('Error updating expense:', err);
      throw new Error('支出の更新に失敗しました');
    }
  };

  const deleteExpense = async (id: string) => {
    if (!db) {
      throw new Error('Firebase not initialized. Please check your configuration.');
    }
    try {
      await deleteDoc(doc(db, 'expenses', id));
      
      // Update local state
      setExpenses(prev => prev.filter(expense => expense.id !== id));
    } catch (err) {
      console.error('Error deleting expense:', err);
      throw new Error('支出の削除に失敗しました');
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
    // ゲストユーザーの場合はスキップ
    if (!userId || userId === 'guest') {
      setLoading(false);
      return;
    }

    // Firebase接続チェック
    const connectionStatus = checkFirebaseConnection();
    if (!connectionStatus.isConnected) {
      console.error('Firebase connection error:', connectionStatus.error);
      setError(connectionStatus.error || 'Firebase接続エラー');
      setLoading(false);
      return;
    }

    const fetchStats = async () => {
      try {
        setLoading(true);
        setError(null);
        
        console.log("月次統計取得開始 - userId:", userId, "year:", year, "month:", month);
        
        // Firebase接続を再度確認
        if (!db) {
          throw new Error('Firestore database is not available');
        }
        
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
        } catch (error) {
          console.error("月次統計 - LINEグループ支出取得エラー:", error);
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
        
        const totalAmount = expenses.reduce((sum, expense) => sum + expense.amount, 0);
        
        const categoryTotals = expenses.reduce((acc, expense) => {
          acc[expense.category] = (acc[expense.category] || 0) + expense.amount;
          return acc;
        }, {} as Record<string, number>);
        
        const dailyTotals = expenses.reduce((acc, expense) => {
          acc[expense.date] = (acc[expense.date] || 0) + expense.amount;
          return acc;
        }, {} as Record<string, number>);
        
        setStats({
          totalAmount,
          expenseCount: expenses.length,
          categoryTotals,
          dailyTotals
        });
        setError(null);
      } catch (err) {
        console.error('Error fetching monthly stats:', err);
        
        // エラーメッセージを詳細化
        let errorMessage = '月次統計の取得に失敗しました';
        if (err instanceof Error) {
          errorMessage = err.message;
        } else if ((err as any)?.message) {
          errorMessage = (err as any).message;
        }
        
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
    const connectionStatus = checkFirebaseConnection();
    if (!connectionStatus.isConnected) {
      console.error('Firebase connection error:', connectionStatus.error);
      setError(connectionStatus.error || 'Firebase接続エラー');
      setLoading(false);
      return;
    }

    const fetchGroups = async () => {
      try {
        setLoading(true);
        setError(null);
        
        console.log("ユーザーグループ取得開始 - userId:", userId);
        
        if (!db) {
          throw new Error('Firestore database is not available');
        }
        
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
          const groupDoc = await getDoc(doc(db, 'groups', memberData.groupId));
          
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
        console.error('Error fetching user groups:', err);
        
        // エラーメッセージを詳細化
        let errorMessage = 'グループ情報の取得に失敗しました';
        if (err instanceof Error) {
          errorMessage = err.message;
        } else if ((err as any)?.message) {
          errorMessage = (err as any).message;
        }
        
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
    const connectionStatus = checkFirebaseConnection();
    if (!connectionStatus.isConnected) {
      console.error('Firebase connection error:', connectionStatus.error);
      setError(connectionStatus.error || 'Firebase接続エラー');
      setLoading(false);
      return;
    }

    const fetchGroupExpenses = async () => {
      try {
        setLoading(true);
        setError(null);
        
        console.log("グループ支出取得開始 - groupId:", groupId);
        
        if (!db) {
          throw new Error('Firestore database is not available');
        }
        
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
        console.error('Error fetching group expenses:', err);
        
        // エラーメッセージを詳細化
        let errorMessage = 'グループ支出データの取得に失敗しました';
        if (err instanceof Error) {
          errorMessage = err.message;
        } else if ((err as any)?.message) {
          errorMessage = (err as any).message;
        }
        
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
    const connectionStatus = checkFirebaseConnection();
    if (!connectionStatus.isConnected) {
      console.error('Firebase connection error:', connectionStatus.error);
      setError(connectionStatus.error || 'Firebase接続エラー');
      setLoading(false);
      return;
    }

    const fetchLineGroupExpenses = async () => {
      try {
        setLoading(true);
        setError(null);
        
        console.log("LINEグループ支出取得開始 - lineGroupId:", lineGroupId);
        
        if (!db) {
          throw new Error('Firestore database is not available');
        }
        
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
        console.error('Error fetching LINE group expenses:', err);
        
        // エラーメッセージを詳細化
        let errorMessage = 'LINEグループ支出データの取得に失敗しました';
        if (err instanceof Error) {
          errorMessage = err.message;
        } else if ((err as any)?.message) {
          errorMessage = (err as any).message;
        }
        
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchLineGroupExpenses();
  }, [lineGroupId, limitCount]);

  return { expenses, loading, error };
}

// Firebase接続状態を取得するフック
export function useFirebaseStatus() {
  const [status, setStatus] = useState(getFirebaseStatus());

  useEffect(() => {
    // 初期状態を取得
    setStatus(getFirebaseStatus());
    
    // 定期的に状態を更新（オプション）
    const interval = setInterval(() => {
      setStatus(getFirebaseStatus());
    }, 5000); // 5秒ごとに更新
    
    return () => clearInterval(interval);
  }, []);

  return status;
}
