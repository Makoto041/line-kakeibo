/**
 * 📊 固定費・変動費分析ロジック
 * 支出データを固定費・変動費に分類して分析する機能
 */

import { Expense } from './hooks';
import dayjs from 'dayjs';

// ====================
// インターフェース定義
// ====================

/**
 * カテゴリ別サマリー
 */
export interface CategorySummary {
  category: string;
  amount: number;
  count: number;
  percentage: number;
  isFixed: boolean;
}

/**
 * トレンドデータ
 */
export interface TrendData {
  month: string;
  totalExpense: number;
  fixedExpense: number;
  variableExpense: number;
  movingAverage?: number;
}

/**
 * 予算比較データ
 */
export interface BudgetComparison {
  budgetAmount: number;
  actualAmount: number;
  variance: number;
  variancePercentage: number;
  isOverBudget: boolean;
}

/**
 * 月次分析データ
 */
export interface MonthlyAnalytics {
  totalExpense: number;
  fixedExpense: number;
  variableExpense: number;
  categoryBreakdown: CategorySummary[];
  monthlyTrend: TrendData[];
  budgetComparison: BudgetComparison | null;
  monthOverMonthGrowth: number;
  averageDailyExpense: number;
  anomalies: AnomalyData[];
}

/**
 * 異常値データ
 */
export interface AnomalyData {
  date: string;
  category: string;
  amount: number;
  reason: string;
  severity: 'low' | 'medium' | 'high';
}

/**
 * 季節性分析データ
 */
export interface SeasonalityData {
  month: number;
  averageExpense: number;
  seasonalIndex: number;
}

// ====================
// 固定費カテゴリの定義
// ====================

const FIXED_EXPENSE_CATEGORIES = [
  '通信費',
  '光熱費',
  '家賃',
  '保険',
  'サブスクリプション',
  'ローン',
];

// ====================
// ヘルパー関数
// ====================

/**
 * カテゴリが固定費かどうかを判定
 */
export function isFixedExpense(category: string): boolean {
  return FIXED_EXPENSE_CATEGORIES.some(fixedCat => 
    category.includes(fixedCat) || fixedCat.includes(category)
  );
}


// ====================
// メイン分析関数
// ====================

/**
 * 月次分析を実行
 */
export async function analyzeMonthlyExpenses(
  expenses: Expense[],
  yearMonth: string,
  budget?: number
): Promise<MonthlyAnalytics> {
  // 対象月のデータをフィルタリング
  const monthExpenses = expenses.filter(expense => 
    expense.date.startsWith(yearMonth)
  );

  // 基本統計の計算
  const totalExpense = monthExpenses.reduce((sum, exp) => sum + exp.amount, 0);
  const fixedExpense = monthExpenses
    .filter(exp => isFixedExpense(exp.category))
    .reduce((sum, exp) => sum + exp.amount, 0);
  const variableExpense = totalExpense - fixedExpense;

  // カテゴリ別集計
  const categoryBreakdown = calculateCategoryBreakdown(monthExpenses);

  // トレンド分析（過去6ヶ月）
  const monthlyTrend = calculateMonthlyTrend(expenses, yearMonth, 6);

  // 予算比較
  const budgetComparison = budget
    ? calculateBudgetComparison(totalExpense, budget)
    : null;

  // 前月比成長率
  const previousMonth = dayjs(yearMonth + '-01').subtract(1, 'month').format('YYYY-MM');
  const previousMonthExpenses = expenses
    .filter(expense => expense.date.startsWith(previousMonth))
    .reduce((sum, exp) => sum + exp.amount, 0);
  
  const monthOverMonthGrowth = previousMonthExpenses > 0
    ? ((totalExpense - previousMonthExpenses) / previousMonthExpenses) * 100
    : 0;

  // 平均日次支出
  const daysInMonth = dayjs(yearMonth + '-01').daysInMonth();
  const averageDailyExpense = totalExpense / daysInMonth;

  // 異常値検知
  const anomalies = detectAnomalies(monthExpenses, expenses);

  return {
    totalExpense,
    fixedExpense,
    variableExpense,
    categoryBreakdown,
    monthlyTrend,
    budgetComparison,
    monthOverMonthGrowth,
    averageDailyExpense,
    anomalies,
  };
}

/**
 * カテゴリ別の内訳を計算
 */
export function calculateCategoryBreakdown(expenses: Expense[]): CategorySummary[] {
  const categoryMap = new Map<string, { amount: number; count: number }>();
  const totalAmount = expenses.reduce((sum, exp) => sum + exp.amount, 0);

  // カテゴリごとに集計
  expenses.forEach(expense => {
    const current = categoryMap.get(expense.category) || { amount: 0, count: 0 };
    categoryMap.set(expense.category, {
      amount: current.amount + expense.amount,
      count: current.count + 1,
    });
  });

  // CategorySummary配列に変換
  const breakdown: CategorySummary[] = [];
  categoryMap.forEach((value, category) => {
    breakdown.push({
      category,
      amount: value.amount,
      count: value.count,
      percentage: totalAmount > 0 ? (value.amount / totalAmount) * 100 : 0,
      isFixed: isFixedExpense(category),
    });
  });

  // 金額の降順でソート
  return breakdown.sort((a, b) => b.amount - a.amount);
}

/**
 * 月次トレンドを計算
 */
export function calculateMonthlyTrend(
  expenses: Expense[],
  currentMonth: string,
  monthsToAnalyze: number = 6
): TrendData[] {
  const trend: TrendData[] = [];
  const startDate = dayjs(currentMonth + '-01').subtract(monthsToAnalyze - 1, 'month');

  for (let i = 0; i < monthsToAnalyze; i++) {
    const targetMonth = startDate.add(i, 'month').format('YYYY-MM');
    const monthExpenses = expenses.filter(exp => exp.date.startsWith(targetMonth));
    
    const totalExpense = monthExpenses.reduce((sum, exp) => sum + exp.amount, 0);
    const fixedExpense = monthExpenses
      .filter(exp => isFixedExpense(exp.category))
      .reduce((sum, exp) => sum + exp.amount, 0);
    const variableExpense = totalExpense - fixedExpense;

    trend.push({
      month: targetMonth,
      totalExpense,
      fixedExpense,
      variableExpense,
    });
  }

  // 3ヶ月移動平均を計算
  for (let i = 2; i < trend.length; i++) {
    const movingAverage = (
      trend[i].totalExpense + 
      trend[i - 1].totalExpense + 
      trend[i - 2].totalExpense
    ) / 3;
    trend[i].movingAverage = Math.round(movingAverage);
  }

  return trend;
}

/**
 * 予算比較を計算
 */
export function calculateBudgetComparison(
  actualAmount: number,
  budgetAmount: number
): BudgetComparison {
  const variance = actualAmount - budgetAmount;
  const variancePercentage = budgetAmount > 0 
    ? (variance / budgetAmount) * 100 
    : 0;

  return {
    budgetAmount,
    actualAmount,
    variance,
    variancePercentage,
    isOverBudget: variance > 0,
  };
}

/**
 * 異常値を検知
 */
export function detectAnomalies(
  monthExpenses: Expense[],
  historicalExpenses: Expense[]
): AnomalyData[] {
  const anomalies: AnomalyData[] = [];

  // カテゴリごとの統計を計算
  const categoryStats = new Map<string, { mean: number; stdDev: number }>();
  
  const categories = Array.from(new Set(historicalExpenses.map(e => e.category)));
  
  categories.forEach(category => {
    const categoryExpenses = historicalExpenses
      .filter(e => e.category === category)
      .map(e => e.amount);
    
    if (categoryExpenses.length > 0) {
      const mean = categoryExpenses.reduce((sum, val) => sum + val, 0) / categoryExpenses.length;
      const variance = categoryExpenses.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / categoryExpenses.length;
      const stdDev = Math.sqrt(variance);
      
      categoryStats.set(category, { mean, stdDev });
    }
  });

  // 各支出をチェック
  monthExpenses.forEach(expense => {
    const stats = categoryStats.get(expense.category);
    
    if (stats && stats.stdDev > 0) {
      const zScore = Math.abs((expense.amount - stats.mean) / stats.stdDev);
      
      // Z-scoreが2以上の場合は異常値として検出
      if (zScore >= 2) {
        let severity: 'low' | 'medium' | 'high';
        let reason: string;
        
        if (zScore >= 3) {
          severity = 'high';
          reason = `通常の${expense.category}支出の3倍以上の標準偏差`;
        } else if (zScore >= 2.5) {
          severity = 'medium';
          reason = `通常の${expense.category}支出の2.5倍以上の標準偏差`;
        } else {
          severity = 'low';
          reason = `通常の${expense.category}支出の2倍以上の標準偏差`;
        }
        
        anomalies.push({
          date: expense.date,
          category: expense.category,
          amount: expense.amount,
          reason,
          severity,
        });
      }
    }
    
    // 単一の高額支出の検出（全体の平均の5倍以上）
    const overallMean = historicalExpenses.reduce((sum, e) => sum + e.amount, 0) / historicalExpenses.length;
    if (expense.amount > overallMean * 5) {
      anomalies.push({
        date: expense.date,
        category: expense.category,
        amount: expense.amount,
        reason: '全体平均の5倍以上の高額支出',
        severity: 'high',
      });
    }
  });

  // 重複を除去して日付順にソート
  const uniqueAnomalies = Array.from(
    new Map(anomalies.map(a => [`${a.date}-${a.category}-${a.amount}`, a])).values()
  );
  
  return uniqueAnomalies.sort((a, b) => b.amount - a.amount);
}

/**
 * 季節性を分析
 */
export function analyzeSeasonality(
  expenses: Expense[]
): SeasonalityData[] {
  const monthlyTotals = new Map<number, number[]>();
  
  // 月ごとにデータを集計
  expenses.forEach(expense => {
    const date = dayjs(expense.date);
    const month = date.month() + 1; // 1-12
    
    if (!monthlyTotals.has(month)) {
      monthlyTotals.set(month, []);
    }
    
    const totals = monthlyTotals.get(month)!;
    
    // 同じ年月のデータを集約
    totals.push(expense.amount);
  });

  // 各月の平均を計算
  const seasonalData: SeasonalityData[] = [];
  const overallTotal = expenses.reduce((sum, e) => sum + e.amount, 0);
  const overallAverage = overallTotal / 12;

  for (let month = 1; month <= 12; month++) {
    const monthData = monthlyTotals.get(month) || [];
    const averageExpense = monthData.length > 0
      ? monthData.reduce((sum, val) => sum + val, 0) / monthData.length
      : 0;
    
    const seasonalIndex = overallAverage > 0
      ? averageExpense / overallAverage
      : 1;

    seasonalData.push({
      month,
      averageExpense,
      seasonalIndex,
    });
  }

  return seasonalData;
}

/**
 * 支出パターンを分析
 */
export interface SpendingPattern {
  dayOfWeek: number;
  averageAmount: number;
  frequency: number;
  peakCategories: string[];
}

export function analyzeSpendingPatterns(expenses: Expense[]): SpendingPattern[] {
  const patterns = new Map<number, { amounts: number[]; categories: string[] }>();

  // 曜日ごとにデータを集計
  expenses.forEach(expense => {
    const dayOfWeek = dayjs(expense.date).day();
    
    if (!patterns.has(dayOfWeek)) {
      patterns.set(dayOfWeek, { amounts: [], categories: [] });
    }
    
    const pattern = patterns.get(dayOfWeek)!;
    pattern.amounts.push(expense.amount);
    pattern.categories.push(expense.category);
  });

  // パターンデータを生成
  const spendingPatterns: SpendingPattern[] = [];
  
  for (let day = 0; day < 7; day++) {
    const pattern = patterns.get(day) || { amounts: [], categories: [] };
    
    const averageAmount = pattern.amounts.length > 0
      ? pattern.amounts.reduce((sum, val) => sum + val, 0) / pattern.amounts.length
      : 0;
    
    // カテゴリの頻度を計算
    const categoryFreq = new Map<string, number>();
    pattern.categories.forEach(cat => {
      categoryFreq.set(cat, (categoryFreq.get(cat) || 0) + 1);
    });
    
    // 上位3カテゴリを取得
    const peakCategories = Array.from(categoryFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat]) => cat);

    spendingPatterns.push({
      dayOfWeek: day,
      averageAmount,
      frequency: pattern.amounts.length,
      peakCategories,
    });
  }

  return spendingPatterns;
}

/**
 * キャッシュマネージャー
 */
export class AnalyticsCache {
  private cache = new Map<string, { data: unknown; timestamp: number }>();
  private ttl = 60 * 60 * 1000; // 1時間

  set(key: string, data: unknown): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  get(key: string): unknown | null {
    const cached = this.cache.get(key);
    
    if (!cached) {
      return null;
    }

    if (Date.now() - cached.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return cached.data;
  }

  clear(): void {
    this.cache.clear();
  }
}

// グローバルキャッシュインスタンス
export const analyticsCache = new AnalyticsCache();

/**
 * パフォーマンス最適化された分析実行
 */
export async function performOptimizedAnalysis(
  expenses: Expense[],
  yearMonth: string,
  budget?: number,
  useCache: boolean = true
): Promise<MonthlyAnalytics> {
  const cacheKey = `analysis-${yearMonth}-${budget || 'no-budget'}`;
  
  if (useCache) {
    const cached = analyticsCache.get(cacheKey) as MonthlyAnalytics | null;
    if (cached) {
      return cached;
    }
  }

  // バッチ処理でデータを分析
  const startTime = performance.now();
  
  const result = await analyzeMonthlyExpenses(expenses, yearMonth, budget);
  
  const endTime = performance.now();
  const processingTime = endTime - startTime;
  
  // パフォーマンス要件（2秒以内）をチェック
  if (processingTime > 2000) {
    console.warn(`Analysis took ${processingTime}ms, exceeding 2s requirement`);
  }

  if (useCache) {
    analyticsCache.set(cacheKey, result);
  }

  return result;
}
