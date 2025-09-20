'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useLineAuth, useMonthlyStats } from '../../lib/hooks'
import dayjs from 'dayjs'
import SummaryCards from './components/SummaryCards'
import CategoryChart from './components/CategoryChart'
import MonthlyTrendChart from './components/MonthlyTrendChart'
import BudgetAlert from './components/BudgetAlert'
import ExpenseRatioChart from './components/ExpenseRatioChart'

export default function DashboardPage() {
  const { user, loading: authLoading } = useLineAuth()
  const [currentDate] = useState(dayjs()) // setCurrentDate removed as currently unused
  const [darkMode, setDarkMode] = useState(false)

  // Get monthly stats for current month
  const { stats, loading: statsLoading } = useMonthlyStats(
    user?.uid || null,
    currentDate.year(),
    currentDate.month() + 1,
    1 // Start from 1st of month
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

  const isLoading = authLoading || statsLoading

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
        <div className="flex justify-between items-center mb-8">
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

        {/* Budget Alerts */}
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mb-6"
        >
          <BudgetAlert />
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

          {/* 承認者申請システムへの導線 */}
        </div>
      </motion.div>
    </div>
  )
}
