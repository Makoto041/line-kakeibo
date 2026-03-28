'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useLineAuth, useMonthlyStats, useExpenses, useBudgetConfig, Expense } from '../../lib/hooks'
import dayjs from 'dayjs'
import SummaryCards from './components/SummaryCards'
import CategoryChart from './components/CategoryChart'
import MonthlyTrendChart from './components/MonthlyTrendChart'
import BudgetAlert from './components/BudgetAlert'
import ExpenseRatioChart from './components/ExpenseRatioChart'
import ExpenseList from './components/ExpenseList'
import EditExpenseModal from './components/EditExpenseModal'
import BudgetSettings from './components/BudgetSettings'
import BudgetProgressBar from './components/BudgetProgressBar'

export default function DashboardPage() {
  const { user, loading: authLoading } = useLineAuth()
  const [currentDate] = useState(dayjs()) // setCurrentDate removed as currently unused
  const [darkMode, setDarkMode] = useState(false)
  const [activeTab, setActiveTab] = useState<'overview' | 'expenses' | 'settings'>('overview')
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null)

  // Get monthly stats for current month
  const { stats, loading: statsLoading } = useMonthlyStats(
    user?.uid || null,
    currentDate.year(),
    currentDate.month() + 1,
    1 // Start from 1st of month
  )

  // Get budget config
  const { config: budgetConfig, loading: budgetLoading } = useBudgetConfig(user?.uid || null)

  // Get expenses for the expense list
  const { expenses, loading: expensesLoading, updateExpense, deleteExpense } = useExpenses(
    user?.uid || null,
    60, // Last 60 days
    500 // Max 500 expenses
  )

  useEffect(() => {
    // Check for dark mode preference
    const isDark = localStorage.getItem('darkMode') === 'true' || 
                   window.matchMedia('(prefers-color-scheme: dark)').matches
    setDarkMode(isDark)
    if (isDark) {
      document.documentElement.classList.add('dark')
    }
  }, [])

  const toggleDarkMode = () => {
    const newDarkMode = !darkMode
    setDarkMode(newDarkMode)
    localStorage.setItem('darkMode', String(newDarkMode))
    if (newDarkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }

  const isLoading = authLoading || statsLoading || expensesLoading || budgetLoading

  // 支出編集ハンドラー
  const handleEditExpense = (expense: Expense) => {
    setEditingExpense(expense)
  }

  // 支出削除ハンドラー
  const handleDeleteExpense = async (expenseId: string) => {
    try {
      await deleteExpense(expenseId)
    } catch (error) {
      console.error('Error deleting expense:', error)
      alert('削除に失敗しました')
    }
  }

  // 支出保存ハンドラー
  const handleSaveExpense = async (id: string, updates: Partial<Expense>) => {
    await updateExpense(id, updates)
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="mt-4 text-muted-foreground">ダッシュボードを読み込み中...</p>
        </div>
      </div>
    )
  }

  if (!user || user.isAnonymous) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md p-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">認証が必要です</h2>
          <p className="text-gray-600 mb-6">
            このページにアクセスするにはLINEからのリンクが必要です。
          </p>
          <p className="text-sm text-gray-500">
            LINEで「家計簿」と送信してアクセスリンクを取得してください。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4 md:p-6 lg:p-8">
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="max-w-7xl mx-auto"
      >
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground">
            💰 家計簿ダッシュボード
          </h1>
          <button
            onClick={toggleDarkMode}
            className="p-2 rounded-lg bg-white dark:bg-gray-800 shadow-lg hover:shadow-xl transition-all duration-200"
            aria-label="Toggle dark mode"
          >
            {darkMode ? '☀️' : '🌙'}
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6 bg-white dark:bg-gray-800 p-1 rounded-xl shadow-lg w-fit">
          <button
            onClick={() => setActiveTab('overview')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'overview'
                ? 'bg-primary text-white'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            📊 概要
          </button>
          <button
            onClick={() => setActiveTab('expenses')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'expenses'
                ? 'bg-primary text-white'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            📝 明細
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'settings'
                ? 'bg-primary text-white'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            ⚙️ 設定
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <>
            {/* Budget Alerts */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="mb-6"
            >
              <BudgetAlert />
            </motion.div>

            {/* Budget Progress Bars */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.15 }}
              className="mb-6"
            >
              <BudgetProgressBar stats={stats} budgetConfig={budgetConfig} />
            </motion.div>

            {/* Summary Cards */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mb-8"
            >
              <SummaryCards stats={stats} />
            </motion.div>

            {/* Charts Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Category Chart */}
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, delay: 0.3 }}
                className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6"
              >
                <h2 className="text-xl font-semibold mb-4 text-foreground">カテゴリ別支出</h2>
                <CategoryChart stats={stats} />
              </motion.div>

              {/* Expense Ratio Chart */}
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, delay: 0.4 }}
                className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6"
              >
                <h2 className="text-xl font-semibold mb-4 text-foreground">固定費・変動費比率</h2>
                <ExpenseRatioChart stats={stats} />
              </motion.div>

              {/* Monthly Trend Chart */}
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, delay: 0.5 }}
                className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 lg:col-span-2"
              >
                <h2 className="text-xl font-semibold mb-4 text-foreground">月次推移</h2>
                <MonthlyTrendChart stats={stats} />
              </motion.div>
            </div>
          </>
        )}

        {activeTab === 'expenses' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <ExpenseList
              expenses={expenses}
              onEdit={handleEditExpense}
              onDelete={handleDeleteExpense}
            />
          </motion.div>
        )}

        {activeTab === 'settings' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <BudgetSettings userId={user?.uid || ''} />
          </motion.div>
        )}
      </motion.div>

      {/* Edit Expense Modal */}
      <EditExpenseModal
        expense={editingExpense}
        isOpen={editingExpense !== null}
        onClose={() => setEditingExpense(null)}
        onSave={handleSaveExpense}
      />
    </div>
  )
}
