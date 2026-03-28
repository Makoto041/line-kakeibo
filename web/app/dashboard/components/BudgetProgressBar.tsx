'use client'

import { motion } from 'framer-motion'
import { ExpenseStats, BudgetConfig } from '../../../lib/hooks'
import dayjs from 'dayjs'

interface BudgetProgressBarProps {
  stats: ExpenseStats | null
  budgetConfig: BudgetConfig | null
}

// カテゴリ設定（BudgetSettingsと同期）
const categoryInfo: Record<string, { emoji: string; name: string }> = {
  '食費': { emoji: '🍽️', name: '食費' },
  '日用品': { emoji: '🛒', name: '日用品' },
  '交通費': { emoji: '🚃', name: '交通費' },
  '娯楽費': { emoji: '🎮', name: '娯楽費' },
  '光熱費': { emoji: '💡', name: '光熱費' },
  '通信費': { emoji: '📱', name: '通信費' },
  '医療費': { emoji: '🏥', name: '医療費' },
  '衣服費': { emoji: '👕', name: '衣服費' },
  '教育費': { emoji: '📚', name: '教育費' },
  'その他': { emoji: '📦', name: 'その他' },
}

// 予算設定のカテゴリ名 → 支出データのカテゴリ名（正規化後）のマッピング
// BudgetSettings uses: 娯楽費, 衣服費, 教育費, 医療費
// categoryNormalization produces: 娯楽, 衣服, 教育, 医療・健康
const budgetToExpenseCategory: Record<string, string[]> = {
  '食費': ['食費'],
  '日用品': ['日用品'],
  '交通費': ['交通費'],
  '娯楽費': ['娯楽費', '娯楽'],
  '光熱費': ['光熱費'],
  '通信費': ['通信費'],
  '医療費': ['医療費', '医療・健康'],
  '衣服費': ['衣服費', '衣服'],
  '教育費': ['教育費', '教育'],
  'その他': ['その他'],
}

// 予算カテゴリに対応する支出合計を取得
function getActualSpending(budgetCategory: string, categoryTotals: Record<string, number>): number {
  const mappedCategories = budgetToExpenseCategory[budgetCategory] || [budgetCategory]
  return mappedCategories.reduce((sum, cat) => sum + (categoryTotals[cat] || 0), 0)
}

// 消費ペースを計算
function calculatePace(actual: number, budget: number): { pace: 'good' | 'warning' | 'danger'; label: string } {
  const today = dayjs()
  const daysInMonth = today.daysInMonth()
  const currentDay = today.date()

  // 日割り予算
  const proratedBudget = (budget / daysInMonth) * currentDay

  if (budget === 0) {
    return { pace: 'good', label: '予算未設定' }
  }

  const ratio = actual / proratedBudget

  if (ratio <= 1) {
    return { pace: 'good', label: '順調' }
  } else if (ratio <= 1.2) {
    return { pace: 'warning', label: 'やや超過' }
  } else {
    return { pace: 'danger', label: 'ペース超過' }
  }
}

// 進捗バーの色を取得
function getProgressColor(percentage: number): string {
  if (percentage <= 80) {
    return 'bg-green-500'
  } else if (percentage <= 100) {
    return 'bg-yellow-500'
  } else {
    return 'bg-red-500'
  }
}

// 進捗バーの背景色を取得
function getProgressBgColor(percentage: number): string {
  if (percentage <= 80) {
    return 'bg-green-100 dark:bg-green-900/30'
  } else if (percentage <= 100) {
    return 'bg-yellow-100 dark:bg-yellow-900/30'
  } else {
    return 'bg-red-100 dark:bg-red-900/30'
  }
}

export default function BudgetProgressBar({ stats, budgetConfig }: BudgetProgressBarProps) {
  if (!stats || !budgetConfig) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">
          📊 カテゴリ別予算残高
        </h2>
        <div className="text-center py-8 text-gray-500">
          データを読み込み中...
        </div>
      </div>
    )
  }

  const { categoryTotals } = stats
  const { categoryBudgets, monthlyBudget } = budgetConfig

  // 予算が設定されているカテゴリを取得
  const categoriesWithBudget = Object.entries(categoryBudgets)
    .filter(([, budget]) => budget > 0)
    .map(([category, budget]) => ({
      category,
      budget,
      actual: getActualSpending(category, categoryTotals),
      info: categoryInfo[category] || { emoji: '📦', name: category },
    }))
    .sort((a, b) => {
      // 超過しているものを上に
      const aOverBudget = a.actual > a.budget ? 1 : 0
      const bOverBudget = b.actual > b.budget ? 1 : 0
      if (aOverBudget !== bOverBudget) return bOverBudget - aOverBudget
      // 消費率が高いものを上に
      return (b.actual / b.budget) - (a.actual / a.budget)
    })

  // 月間予算全体の状況
  const totalActual = stats.totalAmount
  const totalPercentage = monthlyBudget > 0 ? (totalActual / monthlyBudget) * 100 : 0
  const totalRemaining = monthlyBudget - totalActual
  const totalPace = calculatePace(totalActual, monthlyBudget)

  // 日割り進捗ライン（今日までの理想的な消費位置）
  const today = dayjs()
  const daysInMonth = today.daysInMonth()
  const currentDay = today.date()
  const idealProgress = (currentDay / daysInMonth) * 100

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6"
    >
      <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">
        📊 カテゴリ別予算残高
      </h2>

      {/* 月間予算全体のサマリー */}
      <div className={`mb-6 p-4 rounded-lg ${getProgressBgColor(totalPercentage)}`}>
        <div className="flex justify-between items-center mb-2">
          <span className="font-medium text-gray-900 dark:text-white">💰 月間予算全体</span>
          <span className={`text-sm font-medium px-2 py-1 rounded ${
            totalPace.pace === 'good' ? 'bg-green-200 text-green-800 dark:bg-green-800 dark:text-green-200' :
            totalPace.pace === 'warning' ? 'bg-yellow-200 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200' :
            'bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200'
          }`}>
            {totalPace.label}
          </span>
        </div>

        <div className="relative h-6 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          {/* 日割り進捗ライン */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-blue-500 z-10"
            style={{ left: `${Math.min(idealProgress, 100)}%` }}
            title={`今日の理想消費位置: ${idealProgress.toFixed(0)}%`}
          />
          {/* 実際の消費バー */}
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(totalPercentage, 100)}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className={`h-full ${getProgressColor(totalPercentage)}`}
          />
          {/* 超過部分の表示 */}
          {totalPercentage > 100 && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-bold text-white">
              +{(totalPercentage - 100).toFixed(0)}%
            </div>
          )}
        </div>

        <div className="flex justify-between items-center mt-2 text-sm">
          <span className="text-gray-600 dark:text-gray-400">
            ¥{totalActual.toLocaleString()} / ¥{monthlyBudget.toLocaleString()}
          </span>
          <span className={`font-medium ${totalRemaining >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            残り: ¥{totalRemaining.toLocaleString()}
          </span>
        </div>
      </div>

      {/* カテゴリ別予算バー */}
      {categoriesWithBudget.length === 0 ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          <p className="mb-2">カテゴリ別予算が設定されていません</p>
          <p className="text-sm">設定タブで各カテゴリの予算を設定してください</p>
        </div>
      ) : (
        <div className="space-y-4">
          {categoriesWithBudget.map(({ category, budget, actual, info }) => {
            const percentage = budget > 0 ? (actual / budget) * 100 : 0
            const remaining = budget - actual
            const pace = calculatePace(actual, budget)

            return (
              <motion.div
                key={category}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                className={`p-3 rounded-lg ${getProgressBgColor(percentage)}`}
              >
                <div className="flex justify-between items-center mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{info.emoji}</span>
                    <span className="font-medium text-gray-900 dark:text-white">{info.name}</span>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                    pace.pace === 'good' ? 'bg-green-200 text-green-800 dark:bg-green-800 dark:text-green-200' :
                    pace.pace === 'warning' ? 'bg-yellow-200 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200' :
                    'bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200'
                  }`}>
                    {pace.label}
                  </span>
                </div>

                <div className="relative h-4 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  {/* 日割り進捗ライン */}
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-blue-500 z-10"
                    style={{ left: `${Math.min(idealProgress, 100)}%` }}
                  />
                  {/* 実際の消費バー */}
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(percentage, 100)}%` }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                    className={`h-full ${getProgressColor(percentage)}`}
                  />
                </div>

                <div className="flex justify-between items-center mt-1 text-xs">
                  <span className="text-gray-600 dark:text-gray-400">
                    ¥{actual.toLocaleString()} / ¥{budget.toLocaleString()} ({percentage.toFixed(0)}%)
                  </span>
                  <span className={`font-medium ${remaining >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {remaining >= 0 ? `残り ¥${remaining.toLocaleString()}` : `超過 ¥${Math.abs(remaining).toLocaleString()}`}
                  </span>
                </div>
              </motion.div>
            )
          })}
        </div>
      )}

      {/* 凡例 */}
      <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
        <div className="flex flex-wrap gap-4 text-xs text-gray-500 dark:text-gray-400">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 bg-green-500 rounded" />
            <span>80%以下</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 bg-yellow-500 rounded" />
            <span>80-100%</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 bg-red-500 rounded" />
            <span>予算超過</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 bg-blue-500" />
            <span>今日の理想位置</span>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
