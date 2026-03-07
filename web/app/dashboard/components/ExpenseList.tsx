'use client'

import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Expense } from '../../../lib/hooks'
import dayjs from 'dayjs'

interface ExpenseListProps {
  expenses: Expense[]
  onEdit?: (expense: Expense) => void
  onDelete?: (expenseId: string) => void
}

// カテゴリの絵文字マッピング
const categoryEmojis: Record<string, string> = {
  '食費': '🍽️',
  '日用品': '🛒',
  '交通費': '🚃',
  '医療費': '🏥',
  '娯楽費': '🎮',
  '衣服費': '👕',
  '教育費': '📚',
  '通信費': '📱',
  '光熱費': '💡',
  '住居費': '🏠',
  '保険': '🛡️',
  '税金': '📋',
  '貯蓄': '💰',
  '投資': '📈',
  '美容': '💅',
  'ペット': '🐶',
  '趣味': '🎨',
  '交際費': '🎁',
  'その他': '📦',
}

// ステータスのラベルと色
const statusConfig: Record<string, { label: string; color: string; bgColor: string }> = {
  'pending': { label: '確認待ち', color: 'text-yellow-700', bgColor: 'bg-yellow-100' },
  'shared': { label: '共同費', color: 'text-green-700', bgColor: 'bg-green-100' },
  'personal': { label: '個人費', color: 'text-blue-700', bgColor: 'bg-blue-100' },
  'advance_pending': { label: '立替', color: 'text-purple-700', bgColor: 'bg-purple-100' },
  'advance_settled': { label: '精算済', color: 'text-gray-700', bgColor: 'bg-gray-100' },
}

export default function ExpenseList({ expenses, onEdit, onDelete }: ExpenseListProps) {
  // フィルター状態
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>({
    start: dayjs().startOf('month').format('YYYY-MM-DD'),
    end: dayjs().endOf('month').format('YYYY-MM-DD'),
  })
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [sortOrder, setSortOrder] = useState<'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc'>('date-desc')

  // 削除確認用の状態
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  // 利用可能なカテゴリリストを取得
  const availableCategories = useMemo(() => {
    const categories = new Set(expenses.map(e => e.category))
    return Array.from(categories).sort()
  }, [expenses])

  // フィルタリングされた支出
  const filteredExpenses = useMemo(() => {
    let filtered = [...expenses]

    // カテゴリフィルター
    if (categoryFilter) {
      filtered = filtered.filter(e => e.category === categoryFilter)
    }

    // ステータスフィルター
    if (statusFilter) {
      filtered = filtered.filter(e => (e as any).status === statusFilter)
    }

    // 日付範囲フィルター
    if (dateRange.start && dateRange.end) {
      filtered = filtered.filter(e =>
        e.date >= dateRange.start && e.date <= dateRange.end
      )
    }

    // 検索クエリ
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(e =>
        e.description.toLowerCase().includes(query) ||
        e.category.toLowerCase().includes(query)
      )
    }

    // ソート
    filtered.sort((a, b) => {
      switch (sortOrder) {
        case 'date-desc':
          return b.date.localeCompare(a.date)
        case 'date-asc':
          return a.date.localeCompare(b.date)
        case 'amount-desc':
          return b.amount - a.amount
        case 'amount-asc':
          return a.amount - b.amount
        default:
          return 0
      }
    })

    return filtered
  }, [expenses, categoryFilter, statusFilter, dateRange, searchQuery, sortOrder])

  // 合計金額
  const totalAmount = useMemo(() => {
    return filteredExpenses.reduce((sum, e) => sum + e.amount, 0)
  }, [filteredExpenses])

  // フィルターをリセット
  const resetFilters = () => {
    setCategoryFilter('')
    setStatusFilter('')
    setDateRange({
      start: dayjs().startOf('month').format('YYYY-MM-DD'),
      end: dayjs().endOf('month').format('YYYY-MM-DD'),
    })
    setSearchQuery('')
    setSortOrder('date-desc')
  }

  // 削除の確認
  const handleDeleteClick = (expenseId: string) => {
    setDeleteConfirmId(expenseId)
  }

  // 削除の実行
  const handleDeleteConfirm = (expenseId: string) => {
    if (onDelete) {
      onDelete(expenseId)
    }
    setDeleteConfirmId(null)
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg">
      {/* フィルターセクション */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex flex-wrap gap-4 mb-4">
          {/* 検索 */}
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              placeholder="🔍 検索..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent"
            />
          </div>

          {/* カテゴリフィルター */}
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          >
            <option value="">全カテゴリ</option>
            {availableCategories.map(cat => (
              <option key={cat} value={cat}>
                {categoryEmojis[cat] || '📦'} {cat}
              </option>
            ))}
          </select>

          {/* ステータスフィルター */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          >
            <option value="">全ステータス</option>
            {Object.entries(statusConfig).map(([key, config]) => (
              <option key={key} value={key}>{config.label}</option>
            ))}
          </select>

          {/* ソート */}
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as any)}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          >
            <option value="date-desc">日付 ↓</option>
            <option value="date-asc">日付 ↑</option>
            <option value="amount-desc">金額 ↓</option>
            <option value="amount-asc">金額 ↑</option>
          </select>
        </div>

        {/* 日付範囲 */}
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={dateRange.start}
              onChange={(e) => setDateRange(prev => ({ ...prev, start: e.target.value }))}
              className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            />
            <span className="text-gray-500">〜</span>
            <input
              type="date"
              value={dateRange.end}
              onChange={(e) => setDateRange(prev => ({ ...prev, end: e.target.value }))}
              className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            />
          </div>

          <button
            onClick={resetFilters}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            🔄 フィルターをリセット
          </button>
        </div>
      </div>

      {/* 集計バー */}
      <div className="px-4 py-3 bg-gray-50 dark:bg-gray-750 border-b border-gray-200 dark:border-gray-700">
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-600 dark:text-gray-400">
            {filteredExpenses.length}件の支出
          </span>
          <span className="text-lg font-bold text-gray-900 dark:text-white">
            合計: ¥{totalAmount.toLocaleString()}
          </span>
        </div>
      </div>

      {/* 支出リスト */}
      <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-[500px] overflow-y-auto">
        <AnimatePresence>
          {filteredExpenses.length === 0 ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">
              <p className="text-4xl mb-2">📭</p>
              <p>該当する支出がありません</p>
            </div>
          ) : (
            filteredExpenses.map((expense, index) => (
              <motion.div
                key={expense.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -100 }}
                transition={{ duration: 0.2, delay: index * 0.02 }}
                className="p-4 hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {/* カテゴリ絵文字 */}
                    <span className="text-2xl">
                      {categoryEmojis[expense.category] || '📦'}
                    </span>

                    <div>
                      {/* 説明 */}
                      <p className="font-medium text-gray-900 dark:text-white">
                        {expense.description}
                      </p>

                      {/* メタ情報 */}
                      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                        <span>{expense.date}</span>
                        <span>•</span>
                        <span>{expense.category}</span>
                        {expense.userDisplayName && (
                          <>
                            <span>•</span>
                            <span>👤 {expense.userDisplayName}</span>
                          </>
                        )}
                        {/* ステータスバッジ */}
                        {(expense as any).status && statusConfig[(expense as any).status] && (
                          <span className={`px-2 py-0.5 rounded-full text-xs ${statusConfig[(expense as any).status].bgColor} ${statusConfig[(expense as any).status].color}`}>
                            {statusConfig[(expense as any).status].label}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {/* 金額 */}
                    <span className="text-lg font-bold text-gray-900 dark:text-white">
                      ¥{expense.amount.toLocaleString()}
                    </span>

                    {/* アクションボタン */}
                    <div className="flex gap-2">
                      {onEdit && (
                        <button
                          onClick={() => onEdit(expense)}
                          className="p-2 text-gray-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                          title="編集"
                        >
                          ✏️
                        </button>
                      )}
                      {onDelete && (
                        <>
                          {deleteConfirmId === expense.id ? (
                            <div className="flex gap-1">
                              <button
                                onClick={() => handleDeleteConfirm(expense.id)}
                                className="px-2 py-1 text-xs text-white bg-red-500 hover:bg-red-600 rounded transition-colors"
                              >
                                削除
                              </button>
                              <button
                                onClick={() => setDeleteConfirmId(null)}
                                className="px-2 py-1 text-xs text-gray-600 bg-gray-200 hover:bg-gray-300 rounded transition-colors"
                              >
                                キャンセル
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleDeleteClick(expense.id)}
                              className="p-2 text-gray-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                              title="削除"
                            >
                              🗑️
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
