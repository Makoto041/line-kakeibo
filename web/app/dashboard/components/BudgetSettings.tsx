'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../../../lib/firebase'

interface BudgetSettingsProps {
  userId: string
  onClose?: () => void
}

interface BudgetConfig {
  monthlyBudget: number
  categoryBudgets: Record<string, number>
  alertThreshold: number // 残り予算の警告閾値（%）
}

const defaultCategories = [
  { id: 'food', name: '食費', emoji: '🍽️' },
  { id: 'daily', name: '日用品', emoji: '🛒' },
  { id: 'transport', name: '交通費', emoji: '🚃' },
  { id: 'entertainment', name: '娯楽費', emoji: '🎮' },
  { id: 'utility', name: '光熱費', emoji: '💡' },
  { id: 'communication', name: '通信費', emoji: '📱' },
  { id: 'medical', name: '医療費', emoji: '🏥' },
  { id: 'clothing', name: '衣服費', emoji: '👕' },
  { id: 'education', name: '教育費', emoji: '📚' },
  { id: 'other', name: 'その他', emoji: '📦' },
]

// デフォルト設定
const defaultConfig: BudgetConfig = {
  monthlyBudget: 200000,
  categoryBudgets: {},
  alertThreshold: 20,
}

/**
 * Firestoreから取得したデータを検証・正規化
 * 不完全なドキュメントに対して安全なデフォルト値を適用
 */
function normalizeBudgetConfig(data: unknown): BudgetConfig {
  const raw = data as Partial<BudgetConfig> | undefined

  // Normalize categoryBudgets: only include valid non-negative finite numbers
  const normalizedCategoryBudgets: Record<string, number> = {}
  if (raw?.categoryBudgets && typeof raw.categoryBudgets === 'object' && !Array.isArray(raw.categoryBudgets)) {
    for (const [key, value] of Object.entries(raw.categoryBudgets)) {
      const numValue = typeof value === 'string' ? parseFloat(value) : value
      if (typeof numValue === 'number' && Number.isFinite(numValue) && numValue >= 0) {
        normalizedCategoryBudgets[key] = numValue
      }
      // Invalid values are omitted (not included in the result)
    }
  }

  return {
    monthlyBudget: typeof raw?.monthlyBudget === 'number' && raw.monthlyBudget > 0
      ? raw.monthlyBudget
      : defaultConfig.monthlyBudget,
    categoryBudgets: normalizedCategoryBudgets,
    alertThreshold: typeof raw?.alertThreshold === 'number' && raw.alertThreshold >= 0 && raw.alertThreshold <= 100
      ? raw.alertThreshold
      : defaultConfig.alertThreshold,
  }
}

export default function BudgetSettings({ userId, onClose }: BudgetSettingsProps) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [config, setConfig] = useState<BudgetConfig>(defaultConfig)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // 設定を読み込み
  useEffect(() => {
    // Reset state at the start of each load to ensure clean state when userId changes
    setLoading(true)
    setLoadError(false)
    setHasLoaded(false)
    setConfig(defaultConfig)
    setMessage(null)

    const loadBudgetConfig = async () => {
      // Missing userId or db is not a fatal error - just bail early
      if (!userId || !db) {
        setLoading(false)
        return
      }

      try {
        const docRef = doc(db, 'budgetSettings', userId)
        const docSnap = await getDoc(docRef)

        if (docSnap.exists()) {
          // データを検証・正規化してから設定
          const normalizedConfig = normalizeBudgetConfig(docSnap.data())
          setConfig(normalizedConfig)
        }
        // ドキュメントが存在しない場合はデフォルト値のまま（新規ユーザー）
        setHasLoaded(true)
      } catch (error) {
        console.error('Error loading budget config:', error)
        setLoadError(true)
        setMessage({ type: 'error', text: '設定の読み込みに失敗しました。再読み込みしてください。' })
      } finally {
        setLoading(false)
      }
    }

    loadBudgetConfig()
  }, [userId])

  // 設定を保存
  const handleSave = async () => {
    if (!userId || !db) return

    // 読み込みエラー時は保存を許可しない（既存データの上書き防止）
    if (loadError || !hasLoaded) {
      setMessage({ type: 'error', text: '設定を正常に読み込めていないため、保存できません。' })
      return
    }

    // 月間予算のバリデーション
    if (!Number.isFinite(config.monthlyBudget) || config.monthlyBudget <= 0) {
      setMessage({ type: 'error', text: '月間予算は1円以上の正の数を入力してください。' })
      return
    }

    setSaving(true)
    setMessage(null)

    try {
      const docRef = doc(db, 'budgetSettings', userId)
      await setDoc(docRef, {
        ...config,
        updatedAt: new Date(),
      })
      setMessage({ type: 'success', text: '設定を保存しました' })
    } catch (error) {
      console.error('Error saving budget config:', error)
      setMessage({ type: 'error', text: '設定の保存に失敗しました' })
    } finally {
      setSaving(false)
    }
  }

  // カテゴリ予算の合計
  const categoryBudgetTotal = Object.values(config.categoryBudgets).reduce((sum, val) => sum + val, 0)

  if (loading) {
    return (
      <div className="p-8 text-center">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto"></div>
        <p className="mt-2 text-gray-500">読み込み中...</p>
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6"
    >
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">💰 予算設定</h2>
        {onClose && (
          <button
            onClick={onClose}
            className="p-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          >
            ✕
          </button>
        )}
      </div>

      {/* メッセージ */}
      {message && (
        <div className={`mb-4 p-3 rounded-lg ${message.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
          {message.text}
        </div>
      )}

      {/* 月間予算 */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          月間予算総額
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">¥</span>
          <input
            type="number"
            value={config.monthlyBudget}
            onChange={(e) => {
              const parsed = parseInt(e.target.value)
              // 正の整数のみ許可（空や無効な値は最小値1に）
              const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
              setConfig(prev => ({ ...prev, monthlyBudget: value }))
            }}
            className="w-full pl-8 pr-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-lg font-bold focus:ring-2 focus:ring-primary focus:border-transparent"
          />
        </div>
      </div>

      {/* 警告閾値 */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          予算残り警告（残り何%で警告するか）
        </label>
        <div className="flex items-center gap-4">
          <input
            type="range"
            min="5"
            max="50"
            step="5"
            value={config.alertThreshold}
            onChange={(e) => setConfig(prev => ({ ...prev, alertThreshold: parseInt(e.target.value) }))}
            className="flex-1"
          />
          <span className="w-16 text-center font-medium text-gray-900 dark:text-white">
            {config.alertThreshold}%
          </span>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          残り予算が{config.alertThreshold}%（¥{Math.round(config.monthlyBudget * config.alertThreshold / 100).toLocaleString()}）を下回ると警告を表示
        </p>
      </div>

      {/* カテゴリ別予算 */}
      <div className="mb-6">
        <div className="flex justify-between items-center mb-4">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            カテゴリ別予算（任意）
          </label>
          <span className={`text-sm ${categoryBudgetTotal > config.monthlyBudget ? 'text-red-500' : 'text-gray-500'}`}>
            合計: ¥{categoryBudgetTotal.toLocaleString()} / ¥{config.monthlyBudget.toLocaleString()}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {defaultCategories.map((category) => (
            <div key={category.id} className="flex items-center gap-3">
              <span className="text-xl w-8">{category.emoji}</span>
              <span className="w-20 text-sm text-gray-700 dark:text-gray-300">{category.name}</span>
              <div className="flex-1 relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">¥</span>
                <input
                  type="number"
                  placeholder="未設定"
                  value={config.categoryBudgets[category.name] || ''}
                  onChange={(e) => {
                    const value = parseInt(e.target.value) || 0
                    setConfig(prev => ({
                      ...prev,
                      categoryBudgets: {
                        ...prev.categoryBudgets,
                        [category.name]: value,
                      },
                    }))
                  }}
                  className="w-full pl-6 pr-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary focus:border-transparent"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 予算配分バー */}
      {categoryBudgetTotal > 0 && config.monthlyBudget > 0 && (
        <div className="mb-6">
          <div className="h-4 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden flex">
            {defaultCategories.map((category) => {
              const amount = config.categoryBudgets[category.name] || 0
              // 除算前にmonthlyBudgetが正であることを確認（防御的チェック）
              const percentage = config.monthlyBudget > 0 ? (amount / config.monthlyBudget) * 100 : 0
              if (percentage === 0) return null
              return (
                <motion.div
                  key={category.id}
                  initial={{ width: 0 }}
                  animate={{ width: `${percentage}%` }}
                  className="h-full bg-primary opacity-80"
                  title={`${category.name}: ¥${amount.toLocaleString()} (${percentage.toFixed(1)}%)`}
                  style={{
                    backgroundColor: `hsl(${defaultCategories.indexOf(category) * 36}, 70%, 50%)`,
                  }}
                />
              )
            })}
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {defaultCategories.map((category, index) => {
              const amount = config.categoryBudgets[category.name] || 0
              if (amount === 0) return null
              return (
                <span
                  key={category.id}
                  className="text-xs px-2 py-1 rounded-full"
                  style={{
                    backgroundColor: `hsl(${index * 36}, 70%, 90%)`,
                    color: `hsl(${index * 36}, 70%, 30%)`,
                  }}
                >
                  {category.emoji} {category.name}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* 保存ボタン */}
      <div className="flex justify-end gap-3">
        {onClose && (
          <button
            onClick={onClose}
            className="px-6 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            キャンセル
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={saving || loadError || !hasLoaded}
          className="px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={loadError ? '設定の読み込みに失敗したため保存できません' : undefined}
        >
          {saving ? '保存中...' : '💾 保存'}
        </button>
      </div>
    </motion.div>
  )
}
