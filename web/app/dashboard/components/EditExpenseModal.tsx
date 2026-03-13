'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Expense } from '../../../lib/hooks'

interface EditExpenseModalProps {
  expense: Expense | null
  isOpen: boolean
  onClose: () => void
  onSave: (id: string, updates: Partial<Expense>) => Promise<void>
}

const categories = [
  { name: '食費', emoji: '🍽️' },
  { name: '日用品', emoji: '🛒' },
  { name: '交通費', emoji: '🚃' },
  { name: '医療費', emoji: '🏥' },
  { name: '娯楽費', emoji: '🎮' },
  { name: '衣服費', emoji: '👕' },
  { name: '教育費', emoji: '📚' },
  { name: '通信費', emoji: '📱' },
  { name: '光熱費', emoji: '💡' },
  { name: '住居費', emoji: '🏠' },
  { name: '保険', emoji: '🛡️' },
  { name: '税金', emoji: '📋' },
  { name: '美容', emoji: '💅' },
  { name: 'ペット', emoji: '🐶' },
  { name: '趣味', emoji: '🎨' },
  { name: '交際費', emoji: '🎁' },
  { name: 'その他', emoji: '📦' },
]

export default function EditExpenseModal({ expense, isOpen, onClose, onSave }: EditExpenseModalProps) {
  const [formData, setFormData] = useState({
    description: '',
    amount: 0,
    date: '',
    category: '',
    includeInTotal: true,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // expense が変更されたらフォームを更新
  useEffect(() => {
    if (expense) {
      setFormData({
        description: expense.description,
        amount: expense.amount,
        date: expense.date,
        category: expense.category,
        includeInTotal: expense.includeInTotal ?? true,
      })
    }
  }, [expense])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!expense) return

    setSaving(true)
    setError(null)

    try {
      await onSave(expense.id, {
        description: formData.description,
        amount: formData.amount,
        date: formData.date,
        category: formData.category,
        includeInTotal: formData.includeInTotal,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* オーバーレイ */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-40"
          />

          {/* モーダル */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="fixed inset-x-4 top-1/2 -translate-y-1/2 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-full md:max-w-md z-50"
          >
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden">
              {/* ヘッダー */}
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                  ✏️ 支出を編集
                </h3>
                <button
                  onClick={onClose}
                  className="p-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  ✕
                </button>
              </div>

              {/* フォーム */}
              <form onSubmit={handleSubmit} className="p-6 space-y-4">
                {error && (
                  <div className="p-3 bg-red-100 text-red-700 rounded-lg text-sm">
                    {error}
                  </div>
                )}

                {/* 説明 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    説明
                  </label>
                  <input
                    type="text"
                    value={formData.description}
                    onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent"
                    required
                  />
                </div>

                {/* 金額 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    金額
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">¥</span>
                    <input
                      type="number"
                      value={formData.amount}
                      onChange={(e) => setFormData(prev => ({ ...prev, amount: parseInt(e.target.value) || 0 }))}
                      className="w-full pl-8 pr-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent"
                      required
                      min="0"
                    />
                  </div>
                </div>

                {/* 日付 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    日付
                  </label>
                  <input
                    type="date"
                    value={formData.date}
                    onChange={(e) => setFormData(prev => ({ ...prev, date: e.target.value }))}
                    className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent"
                    required
                  />
                </div>

                {/* カテゴリ */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    カテゴリ
                  </label>
                  <select
                    value={formData.category}
                    onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                    className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent"
                    required
                  >
                    <option value="">カテゴリを選択</option>
                    {categories.map((cat) => (
                      <option key={cat.name} value={cat.name}>
                        {cat.emoji} {cat.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 合計に含める */}
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="includeInTotal"
                    checked={formData.includeInTotal}
                    onChange={(e) => setFormData(prev => ({ ...prev, includeInTotal: e.target.checked }))}
                    className="w-5 h-5 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <label htmlFor="includeInTotal" className="text-sm text-gray-700 dark:text-gray-300">
                    合計に含める
                  </label>
                </div>

                {/* ボタン */}
                <div className="flex gap-3 pt-4">
                  <button
                    type="button"
                    onClick={onClose}
                    className="flex-1 px-4 py-2 text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    キャンセル
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex-1 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {saving ? '保存中...' : '💾 保存'}
                  </button>
                </div>
              </form>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
