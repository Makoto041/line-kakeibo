import dayjs from 'dayjs';
import type { Expense, ExpenseStats } from './hooks';

/**
 * ゲスト（プレビュー）モード用のサンプルデータ。
 * 実データは一切取得せず、画面の見た目・機能を体験してもらうためのハードコードデータ。
 * 金額は画面の見本（参照デザイン）の数字とは別の値にしている。
 */

// 今日からのオフセット（日数）を当月内に収めた日付文字列に変換する
function sampleDate(offsetDays: number): string {
  const today = dayjs();
  const startOfMonth = today.startOf('month');
  const date = today.subtract(offsetDays, 'day');
  return (date.isBefore(startOfMonth) ? startOfMonth : date).format('YYYY-MM-DD');
}

interface SampleState {
  /** 省略時は共同費（shared）。null は status なし（LINE で手入力した直後の未確認） */
  status?: Expense['status'] | null;
  includeInTotal?: boolean;
  confirmed?: boolean;
}

function buildSampleExpense(
  id: number,
  offsetDays: number,
  amount: number,
  description: string,
  category: string,
  state: SampleState = {}
): Expense {
  const status = state.status === undefined ? 'shared' : state.status;
  return {
    id: `sample-${id}`,
    lineId: 'guest',
    amount,
    description,
    date: sampleDate(offsetDays),
    category,
    includeInTotal: state.includeInTotal ?? true,
    confirmed: state.confirmed ?? true,
    ...(status ? { status } : {}),
    inputSource: 'line_text',
    // 同じ日の並び（登録の新しい順）を安定させる
    createdAt: new Date(dayjs().subtract(offsetDays, 'day').startOf('day').valueOf() + (100 - id) * 60_000),
  };
}

/** サンプル支出データ（要確認 2 件を含む。1 件はカード取込の未確認、1 件は手入力の未確認） */
export function getSampleExpenses(): Expense[] {
  return [
    buildSampleExpense(1, 0, 850, 'ランチ', '食費'),
    buildSampleExpense(2, 1, 3240, 'スーパーで買い物', '食費', { status: 'pending', confirmed: false }),
    buildSampleExpense(3, 1, 440, '電車代', '交通費', { status: null, includeInTotal: false, confirmed: false }),
    buildSampleExpense(4, 3, 1280, 'ドラッグストア', '日用品'),
    buildSampleExpense(5, 5, 520, 'カフェ', '食費'),
    buildSampleExpense(6, 7, 1900, '映画', '娯楽費'),
    buildSampleExpense(7, 10, 3980, '携帯料金', '通信費'),
  ];
}

/** サンプル支出から集計したダッシュボード用の統計情報（実データと同じく予算に計上するものだけを合計） */
export function getSampleStats(): ExpenseStats {
  const expenses = getSampleExpenses().filter((expense) => expense.includeInTotal);

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
