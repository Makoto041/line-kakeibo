import dayjs from 'dayjs';
import type { Expense, ExpenseStats } from './hooks';

/**
 * ゲスト（プレビュー）モード用のサンプルデータ。
 * 実データは一切取得せず、画面の見た目・機能を体験してもらうためのハードコードデータ。
 */

// 今日からのオフセット（日数）を当月内に収めた日付文字列に変換する
function sampleDate(offsetDays: number): string {
  const today = dayjs();
  const startOfMonth = today.startOf('month');
  const date = today.subtract(offsetDays, 'day');
  return (date.isBefore(startOfMonth) ? startOfMonth : date).format('YYYY-MM-DD');
}

function buildSampleExpense(
  id: number,
  offsetDays: number,
  amount: number,
  description: string,
  category: string
): Expense {
  return {
    id: `sample-${id}`,
    lineId: 'guest',
    amount,
    description,
    date: sampleDate(offsetDays),
    category,
    includeInTotal: true,
    confirmed: true,
    status: 'personal',
    inputSource: 'line_text',
  };
}

/** サンプル支出データ（明らかにサンプルと分かる表示は呼び出し側で付与する） */
export function getSampleExpenses(): Expense[] {
  return [
    buildSampleExpense(1, 0, 850, 'ランチ', '食費'),
    buildSampleExpense(2, 1, 3240, 'スーパーで買い物', '食費'),
    buildSampleExpense(3, 1, 440, '電車代', '交通費'),
    buildSampleExpense(4, 3, 1280, 'ドラッグストア', '日用品'),
    buildSampleExpense(5, 5, 520, 'カフェ', '食費'),
    buildSampleExpense(6, 7, 1900, '映画', '娯楽費'),
    buildSampleExpense(7, 10, 3980, '携帯料金', '通信費'),
  ];
}

/** サンプル支出から集計したダッシュボード用の統計情報 */
export function getSampleStats(): ExpenseStats {
  const expenses = getSampleExpenses();

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
    dailyTotals,
  };
}
