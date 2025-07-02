'use client';

import { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  where, 
  limit, 
  getDocs,
  doc,
  updateDoc,
  deleteDoc 
} from 'firebase/firestore';
import { onAuthStateChanged, User, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { db, auth, signInAnonymous } from './firebase';
import dayjs from 'dayjs';

// 共通型定義をインポート（理想設計準拠）
export interface Expense {
  id: string;
  appUid: string;           // Firebase Auth UID (primary identifier)  
  lineId: string;           // LINE User ID (for backward compatibility)
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

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        try {
          const userCredential = await signInAnonymous();
          setUser(userCredential.user);
        } catch (error) {
          console.error('Failed to sign in anonymously:', error);
        }
      } else {
        setUser(user);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const signInWithGoogle = async () => {
    if (!auth) throw new Error('Firebase auth not initialized');
    
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      return result.user;
    } catch (error) {
      console.error('Google sign-in error:', error);
      throw error;
    }
  };

  const signOutUser = async () => {
    if (!auth) throw new Error('Firebase auth not initialized');
    
    try {
      await signOut(auth);
      // After sign out, automatically sign in anonymously
      const userCredential = await signInAnonymous();
      setUser(userCredential.user);
    } catch (error) {
      console.error('Sign out error:', error);
      throw error;
    }
  };

  return { 
    user, 
    loading, 
    signInWithGoogle, 
    signOut: signOutUser,
    isAnonymous: user?.isAnonymous || false 
  };
}

export function useExpenses(userId: string | null, limitCount: number = 50) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !db) {
      setLoading(false);
      return;
    }

    const fetchExpenses = async () => {
      try {
        setLoading(true);
        
        console.log("データ取得開始 - userId:", userId);
        
        // 自分の UID だけを見る
        const q = query(
          collection(db!, 'expenses'),
          where('appUid', '==', userId),
          limit(limitCount)
        );
        
        console.log("expensesクエリ実行中...");
        
        const querySnapshot = await getDocs(q);
        console.log("クエリ結果:", querySnapshot.docs.length, "件");
        
        const expenseList = querySnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        } as Expense));
        
        console.log("取得したexpenses:", expenseList);
        
        // Sort in memory to avoid index requirement
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
        console.error('Error fetching expenses:', err);
        setError('支出データの取得に失敗しました');
      } finally {
        setLoading(false);
      }
    };

    fetchExpenses();
  }, [userId, limitCount]);

  const updateExpense = async (id: string, updates: Partial<Expense>) => {
    if (!db) throw new Error('Firebase not initialized');
    try {
      await updateDoc(doc(db!, 'expenses', id), {
        ...updates,
        updatedAt: new Date()
      });
      
      // Update local state
      setExpenses(prev => 
        prev.map(expense => 
          expense.id === id ? { ...expense, ...updates } : expense
        )
      );
    } catch (err) {
      console.error('Error updating expense:', err);
      throw new Error('支出の更新に失敗しました');
    }
  };

  const deleteExpense = async (id: string) => {
    if (!db) throw new Error('Firebase not initialized');
    try {
      await deleteDoc(doc(db!, 'expenses', id));
      
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

export function useMonthlyStats(userId: string | null, year: number, month: number) {
  const [stats, setStats] = useState<ExpenseStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId || !db) {
      setLoading(false);
      return;
    }

    const fetchStats = async () => {
      try {
        setLoading(true);
        
        console.log("月次統計取得開始 - userId:", userId, "year:", year, "month:", month);
        
        const startDate = dayjs(`${year}-${month.toString().padStart(2, '0')}-01`).format('YYYY-MM-DD');
        const endDate = dayjs(startDate).endOf('month').format('YYYY-MM-DD');
        
        // 自分の UID だけを見る + 日付範囲
        const q = query(
          collection(db!, 'expenses'),
          where('appUid', '==', userId),
          where('date', '>=', startDate),
          where('date', '<=', endDate)
        );
        
        console.log("月次統計クエリ実行中...");
        
        const querySnapshot = await getDocs(q);
        const expenseList = querySnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        } as Expense));
        
        console.log("月次統計 - 取得したexpenses:", expenseList.length, "件");
        
        // Sort in memory by date desc
        const expenses = expenseList.sort((a, b) => b.date.localeCompare(a.date));
        
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
      } catch (err) {
        console.error('Error fetching monthly stats:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [userId, year, month]);

  return { stats, loading };
}