// 共通型定義 - Bot と Web で共有

export interface ExpenseItem {
  name: string;
  price: number;
  quantity?: number;
}

export interface BaseExpense {
  id?: string;
  appUid: string;           // Firebase Auth UID (primary identifier)
  lineId: string;           // LINE User ID (for bot operations)
  amount: number;
  description: string;
  date: string;             // YYYY-MM-DD format
  category: string;
  confirmed: boolean;
  ocrText?: string;
  items?: ExpenseItem[];
}

// Bot側（Firebase Admin SDK用）
export interface ExpenseBotRecord extends BaseExpense {
  createdAt?: FirebaseFirestore.Timestamp;
  updatedAt?: FirebaseFirestore.Timestamp;
}

// Web側（Firebase Client SDK用）
export interface ExpenseWebRecord extends BaseExpense {
  id: string;  // Web側では必須
  createdAt?: Date | { seconds: number; nanoseconds: number };
  updatedAt?: Date | { seconds: number; nanoseconds: number };
}

// UserLinks collection
export interface UserLink {
  lineId: string;           // LINE User ID
  createdAt?: FirebaseFirestore.Timestamp | Date;
  updatedAt?: FirebaseFirestore.Timestamp | Date;
}

// LinkTokens collection
export interface LinkToken {
  lineId: string;
  createdAt: FirebaseFirestore.Timestamp | Date;
  expiresAt: FirebaseFirestore.Timestamp | Date;
  used: boolean;
  usedAt?: FirebaseFirestore.Timestamp | Date;
}

// カテゴリー定義
export const EXPENSE_CATEGORIES = [
  '食費',
  '日用品', 
  '交通費',
  '医療費',
  '娯楽費',
  '衣服費',
  '教育費',
  '通信費',
  'その他'
] as const;

export type ExpenseCategory = typeof EXPENSE_CATEGORIES[number];

// API レスポンス型
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// 統計情報
export interface ExpenseStats {
  totalAmount: number;
  expenseCount: number;
  categoryTotals: Record<string, number>;
  dailyTotals: Record<string, number>;
}