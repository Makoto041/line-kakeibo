import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import dayjs from 'dayjs';

let db: ReturnType<typeof getFirestore> | null = null;

function getDb() {
  if (!db) {
    db = getFirestore();
  }
  return db;
}

// 理想設計に準拠したExpenseインターフェース
export interface Expense {
  id?: string;
  appUid: string;           // Firebase Auth UID (primary identifier)
  lineId: string;           // LINE User ID (for bot operations)
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
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

// 統計情報インターフェース
export interface ExpenseStats {
  totalAmount: number;
  expenseCount: number;
  categoryTotals: Record<string, number>;
  dailyTotals: Record<string, number>;
}

// UserLink インターフェース
export interface UserLink {
  lineId: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export async function saveExpense(expense: Omit<Expense, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
  try {
    const now = Timestamp.now();
    const docRef = await getDb().collection('expenses').add({
      ...expense,
      createdAt: now,
      updatedAt: now
    });
    
    console.log(`Expense saved with ID: ${docRef.id}, appUid: ${expense.appUid}`);
    return docRef.id;
  } catch (error) {
    console.error('Error saving expense:', error);
    throw error;
  }
}

// appUidベースのクエリに変更（理想設計準拠）
export async function getExpenses(appUid: string, limit: number = 50): Promise<Expense[]> {
  try {
    const snapshot = await getDb()
      .collection('expenses')
      .where('appUid', '==', appUid)
      .limit(limit)
      .get();

    // Sort in memory to avoid index requirement
    const expenses = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    } as Expense));

    return expenses.sort((a, b) => {
      const aTime = a.createdAt?.toMillis() || 0;
      const bTime = b.createdAt?.toMillis() || 0;
      return bTime - aTime; // desc order
    });
  } catch (error) {
    console.error('Error getting expenses:', error);
    throw error;
  }
}

// appUidベースのクエリに変更（理想設計準拠）
export async function getExpensesByDateRange(
  appUid: string, 
  startDate: string, 
  endDate: string
): Promise<Expense[]> {
  try {
    const snapshot = await getDb()
      .collection('expenses')
      .where('appUid', '==', appUid)
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .get();

    // Sort in memory to avoid index requirement
    const expenses = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    } as Expense));

    return expenses.sort((a, b) => b.date.localeCompare(a.date)); // desc order by date
  } catch (error) {
    console.error('Error getting expenses by date range:', error);
    throw error;
  }
}

export async function updateExpense(id: string, updates: Partial<Expense>): Promise<void> {
  try {
    await getDb().collection('expenses').doc(id).update({
      ...updates,
      updatedAt: Timestamp.now()
    });
  } catch (error) {
    console.error('Error updating expense:', error);
    throw error;
  }
}

export async function deleteExpense(id: string): Promise<void> {
  try {
    await getDb().collection('expenses').doc(id).delete();
  } catch (error) {
    console.error('Error deleting expense:', error);
    throw error;
  }
}

// appUidベースの統計取得（理想設計準拠）
export async function getMonthlyStats(appUid: string, year: number, month: number): Promise<ExpenseStats> {
  try {
    const startDate = dayjs(`${year}-${month.toString().padStart(2, '0')}-01`).format('YYYY-MM-DD');
    const endDate = dayjs(startDate).endOf('month').format('YYYY-MM-DD');
    
    const expenses = await getExpensesByDateRange(appUid, startDate, endDate);
    
    const totalAmount = expenses.reduce((sum, expense) => sum + expense.amount, 0);
    const categoryTotals = expenses.reduce((acc, expense) => {
      acc[expense.category] = (acc[expense.category] || 0) + expense.amount;
      return acc;
    }, {} as Record<string, number>);
    
    const dailyTotals = expenses.reduce((acc, expense) => {
      acc[expense.date] = (acc[expense.date] || 0) + expense.amount;
      return acc;
    }, {} as Record<string, number>);
    
    return {
      totalAmount,
      expenseCount: expenses.length,
      categoryTotals,
      dailyTotals
    };
  } catch (error) {
    console.error('Error getting monthly stats:', error);
    throw error;
  }
}

// UserLinks管理機能
export async function createUserLink(appUid: string, lineId: string): Promise<void> {
  try {
    const now = Timestamp.now();
    await getDb().collection('userLinks').doc(appUid).set({
      lineId,
      createdAt: now,
      updatedAt: now
    });
    console.log(`UserLink created: ${appUid} -> ${lineId}`);
  } catch (error) {
    console.error('Error creating user link:', error);
    throw error;
  }
}

export async function getUserLink(appUid: string): Promise<UserLink | null> {
  try {
    const doc = await getDb().collection('userLinks').doc(appUid).get();
    if (doc.exists) {
      return doc.data() as UserLink;
    }
    return null;
  } catch (error) {
    console.error('Error getting user link:', error);
    throw error;
  }
}

export async function findAppUidByLineId(lineId: string): Promise<string | null> {
  try {
    const snapshot = await getDb()
      .collection('userLinks')
      .where('lineId', '==', lineId)
      .limit(1)
      .get();
    
    if (snapshot.empty) {
      return null;
    }
    
    return snapshot.docs[0].id; // document ID is the appUid
  } catch (error) {
    console.error('Error finding appUid by lineId:', error);
    throw error;
  }
}