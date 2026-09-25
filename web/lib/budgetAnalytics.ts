// 予算まわりの計算（ホームの「予算残り」と予算シート）。計算式は刷新前のホームと同じ。
// node --test から直接読めるよう、他のモジュールからは型だけを import する（値の import は dayjs のみ）。
import dayjs from 'dayjs';
import type { ExpenseStats } from './hooks';

// ---- ホームの「予算残り」 --------------------------------------------------------

export interface BudgetHeroNumbers {
  spent: number;
  budget: number;
  /** 予算 − 支出（超過ならマイナス） */
  remaining: number;
  over: boolean;
  /** 使った割合（四捨五入。100 を超えることもある） */
  pct: number;
  /** バーの長さ（0〜100） */
  barPct: number;
}

/** spent / budget の表示用の値（刷新前の予算進捗と同じ Math.round(spent / budget * 100)） */
export function computeBudgetHero(spent: number, budget: number): BudgetHeroNumbers {
  const s = Number.isFinite(spent) ? spent : 0;
  const b = Number.isFinite(budget) ? budget : 0;
  const remaining = b - s;
  const pct = b > 0 ? Math.round((s / b) * 100) : 0;
  return {
    spent: s,
    budget: b,
    remaining,
    over: remaining < 0,
    pct,
    barPct: Math.max(0, Math.min(pct, 100)),
  };
}

// ---- 予算シートの数値 ----------------------------------------------------------

export interface PeriodInsights {
  totalExpense: number;
  expenseCount: number;
  dailyAverage: number;
  /** 予算進捗（%）。予算が無ければ null */
  budgetPct: number | null;
  /** 残り（マイナスは超過）。予算が無ければ null */
  budgetRemaining: number | null;
  /** 期間の残り日数（今日〜終了日。過ぎていれば 0） */
  daysLeft: number;
  /** あと使える / 日。残りが無ければ null */
  perDayAvailable: number | null;
  /** 前月比（%）。前期間が 0・期間指定のときは null */
  momPct: number | null;
  prevTotal: number;
}

export function computePeriodInsights(input: {
  stats: Pick<ExpenseStats, 'totalAmount' | 'expenseCount'> | null;
  prevStats: Pick<ExpenseStats, 'totalAmount'> | null;
  monthlyBudget: number | null | undefined;
  range: { startDate: string; endDate: string };
  mode: 'monthly' | 'customStart' | 'custom';
  now?: dayjs.ConfigType;
}): PeriodInsights {
  const totalExpense = input.stats?.totalAmount || 0;
  const expenseCount = input.stats?.expenseCount || 0;
  const start = dayjs(input.range.startDate);
  const end = dayjs(input.range.endDate);
  const days = end.diff(start, 'day') + 1;
  const dailyAverage = totalExpense > 0 ? Math.round(totalExpense / days) : 0;

  const monthlyBudget = input.monthlyBudget || 0;
  const budgetPct = monthlyBudget > 0 ? Math.round((totalExpense / monthlyBudget) * 100) : null;
  const budgetRemaining = monthlyBudget > 0 ? monthlyBudget - totalExpense : null;

  const today = dayjs(input.now ?? undefined);
  const daysLeft = end.isBefore(today, 'day') ? 0 : end.diff(today.isBefore(start) ? start : today, 'day') + 1;
  const perDayAvailable =
    monthlyBudget > 0 && budgetRemaining !== null && budgetRemaining > 0 && daysLeft > 0
      ? Math.floor(budgetRemaining / daysLeft)
      : null;

  const prevTotal = input.prevStats?.totalAmount || 0;
  // 期間指定では前の期間が今の期間と同じになる（自分自身と比べて 0%）ので出さない
  const momPct =
    input.mode !== 'custom' && prevTotal > 0 ? Math.round(((totalExpense - prevTotal) / prevTotal) * 100) : null;

  return {
    totalExpense,
    expenseCount,
    dailyAverage,
    budgetPct,
    budgetRemaining,
    daysLeft,
    perDayAvailable,
    momPct,
    prevTotal,
  };
}

// ---- カテゴリ別予算 -------------------------------------------------------------

// 予算カテゴリ名（正準）→ 支出データのカテゴリ名（旧表記ゆれも吸収）
export const BUDGET_TO_EXPENSE_CATEGORY: Record<string, string[]> = {
  食費: ['食費'],
  交通費: ['交通費'],
  日用品: ['日用品', '日用品費'],
  娯楽: ['娯楽', '娯楽費'],
  衣服: ['衣服', '衣服費', '被服費'],
  '医療・健康': ['医療・健康', '医療費', '医療', '健康'],
  教育: ['教育', '教育費'],
  光熱費: ['光熱費', '水道光熱費'],
  住居費: ['住居費', '居住費', '家賃'],
  保険: ['保険', '保険料'],
  税金: ['税金'],
  美容: ['美容', '美容費', '美容・理容'],
  通信費: ['通信費'],
  サブスク: ['サブスク', 'サブスクリプション'],
  プレゼント: ['プレゼント', 'ギフト'],
  旅行: ['旅行'],
  ペット: ['ペット'],
  貯金: ['貯金'],
  その他: ['その他'],
};

export function getActualSpending(budgetCategory: string, categoryTotals: Record<string, number>): number {
  let mapped = BUDGET_TO_EXPENSE_CATEGORY[budgetCategory];
  if (!mapped) {
    // 旧予算キー（例: 娯楽費・医療費）を逆引きして正準キーに解決する。
    // 正準キーへ統一する以前に保存された予算でも実支出と突き合うようにする。
    const canonical = Object.keys(BUDGET_TO_EXPENSE_CATEGORY).find((key) =>
      BUDGET_TO_EXPENSE_CATEGORY[key].includes(budgetCategory)
    );
    mapped = canonical ? BUDGET_TO_EXPENSE_CATEGORY[canonical] : [budgetCategory];
  }
  return mapped.reduce((sum, cat) => sum + (categoryTotals[cat] || 0), 0);
}

export type Pace = 'good' | 'warning' | 'danger' | 'unset';

/** ペース（暦月で日割りした予算との比。刷新前と同じく今日の日付で見る） */
export function calculatePace(actual: number, budget: number, now?: dayjs.ConfigType): Pace {
  const today = dayjs(now ?? undefined);
  const prorated = (budget / today.daysInMonth()) * today.date();
  if (budget === 0) return 'unset';
  const ratio = actual / prorated;
  if (ratio <= 1) return 'good';
  if (ratio <= 1.2) return 'warning';
  return 'danger';
}

/** 理想の進み具合（暦月の経過割合 %） */
export function idealProgress(now?: dayjs.ConfigType): number {
  const today = dayjs(now ?? undefined);
  return (today.date() / today.daysInMonth()) * 100;
}

export interface CategoryBudgetRow {
  category: string;
  budget: number;
  actual: number;
}

/**
 * カテゴリ別予算の行。予算 > 0 のカテゴリに加え、実支出があるカテゴリも出す（予算 0 でも記録があれば出す）。
 * 並び: 予算ありを使用率の高い順に上へ、予算なし（0）は実支出の多い順で下へ。
 */
export function buildCategoryBudgetRows(
  categoryTotals: Record<string, number>,
  categoryBudgets: Record<string, number>
): CategoryBudgetRow[] {
  const rowsMap = new Map<string, CategoryBudgetRow>();

  // 1) 正準カテゴリ: 予算あり or 実支出あり
  Object.keys(BUDGET_TO_EXPENSE_CATEGORY).forEach((category) => {
    const budget = categoryBudgets[category] || 0;
    const actual = getActualSpending(category, categoryTotals);
    if (budget > 0 || actual > 0) rowsMap.set(category, { category, budget, actual });
  });

  // 2) エイリアスに無いカスタム/旧表記の支出カテゴリも拾う
  const aliasClaimed = new Set<string>();
  Object.values(BUDGET_TO_EXPENSE_CATEGORY).forEach((arr) => arr.forEach((a) => aliasClaimed.add(a)));
  Object.entries(categoryTotals).forEach(([category, amt]) => {
    if (amt > 0 && !aliasClaimed.has(category) && !rowsMap.has(category)) {
      rowsMap.set(category, { category, budget: categoryBudgets[category] || 0, actual: amt });
    }
  });

  // 3) 予算 > 0 だが上で拾えていない旧キーも残す（後方互換）
  Object.keys(categoryBudgets).forEach((category) => {
    if (categoryBudgets[category] > 0 && !rowsMap.has(category)) {
      rowsMap.set(category, {
        category,
        budget: categoryBudgets[category],
        actual: getActualSpending(category, categoryTotals),
      });
    }
  });

  return Array.from(rowsMap.values()).sort((a, b) => {
    const ra = a.budget > 0 ? a.actual / a.budget : -1;
    const rb = b.budget > 0 ? b.actual / b.budget : -1;
    if (rb !== ra) return rb - ra;
    return b.actual - a.actual;
  });
}
