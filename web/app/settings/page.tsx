'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useLineAuth } from '../../lib/hooks';
import { getDateRangeSettings, saveDateRangeSettings, migrateLocalToFirestore, DEFAULT_SETTINGS, type DateRangeSettings } from '../../lib/dateSettings';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import Header from '../../components/Header';
import dayjs from 'dayjs';

// 予算設定インターフェース
interface BudgetConfig {
  monthlyBudget: number;
  categoryBudgets: Record<string, number>;
  alertThreshold: number;
}

const defaultBudgetConfig: BudgetConfig = {
  monthlyBudget: 200000,
  categoryBudgets: {},
  alertThreshold: 20,
};

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
];

function normalizeBudgetConfig(data: unknown): BudgetConfig {
  const raw = data as Partial<BudgetConfig> | undefined;
  const normalizedCategoryBudgets: Record<string, number> = {};

  if (raw?.categoryBudgets && typeof raw.categoryBudgets === 'object' && !Array.isArray(raw.categoryBudgets)) {
    for (const [key, value] of Object.entries(raw.categoryBudgets)) {
      const numValue = typeof value === 'string' ? parseFloat(value) : value;
      if (typeof numValue === 'number' && Number.isFinite(numValue) && numValue >= 0) {
        normalizedCategoryBudgets[key] = numValue;
      }
    }
  }

  return {
    monthlyBudget: typeof raw?.monthlyBudget === 'number' && raw.monthlyBudget > 0
      ? raw.monthlyBudget
      : defaultBudgetConfig.monthlyBudget,
    categoryBudgets: normalizedCategoryBudgets,
    alertThreshold: typeof raw?.alertThreshold === 'number' && raw.alertThreshold >= 0 && raw.alertThreshold <= 100
      ? raw.alertThreshold
      : defaultBudgetConfig.alertThreshold,
  };
}

export default function Settings() {
  const { user, loading: authLoading, getUrlWithLineId } = useLineAuth();

  // 期間設定
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>(DEFAULT_SETTINGS);
  const [tempStartDate, setTempStartDate] = useState('');
  const [tempEndDate, setTempEndDate] = useState('');
  const [tempStartDay, setTempStartDay] = useState(1);

  // 予算設定
  const [budgetConfig, setBudgetConfig] = useState<BudgetConfig>(defaultBudgetConfig);
  const [budgetHasLoaded, setBudgetHasLoaded] = useState(false);
  const [budgetLoadError, setBudgetLoadError] = useState(false);

  // 共通
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'period' | 'budget'>('budget');

  useEffect(() => {
    const loadAllSettings = async () => {
      if (!user?.uid) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);

        // 期間設定の読み込み
        await migrateLocalToFirestore(user.uid);
        const loadedDateSettings = await getDateRangeSettings(user.uid);
        setDateSettings(loadedDateSettings);
        setTempStartDate(loadedDateSettings.startDate || '');
        setTempEndDate(loadedDateSettings.endDate || '');
        setTempStartDay(loadedDateSettings.customStartDay || 1);

        // 予算設定の読み込み
        if (db) {
          const docRef = doc(db, 'budgetSettings', user.uid);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            const normalizedConfig = normalizeBudgetConfig(docSnap.data());
            setBudgetConfig(normalizedConfig);
          }
          setBudgetHasLoaded(true);
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
        setBudgetLoadError(true);
        setMessage({ type: 'error', text: '設定の読み込みに失敗しました' });
      } finally {
        setLoading(false);
      }
    };

    loadAllSettings();
  }, [user?.uid]);

  const saveDateSettingsHandler = async () => {
    if (!user?.uid) return;

    const newSettings: DateRangeSettings = {
      mode: dateSettings.mode,
      ...(dateSettings.mode === 'custom' && tempStartDate && tempEndDate && {
        startDate: tempStartDate,
        endDate: tempEndDate,
      }),
      ...(dateSettings.mode === 'customStart' && {
        customStartDay: tempStartDay,
      }),
    };

    await saveDateRangeSettings(user.uid, newSettings);
    setDateSettings(newSettings);
  };

  const saveBudgetSettingsHandler = async () => {
    if (!user?.uid || !db) return;

    if (budgetLoadError || !budgetHasLoaded) {
      setMessage({ type: 'error', text: '設定を正常に読み込めていないため、保存できません' });
      return;
    }

    if (!Number.isFinite(budgetConfig.monthlyBudget) || budgetConfig.monthlyBudget <= 0) {
      setMessage({ type: 'error', text: '月間予算は1円以上の正の数を入力してください' });
      return;
    }

    const docRef = doc(db, 'budgetSettings', user.uid);
    await setDoc(docRef, {
      ...budgetConfig,
      updatedAt: new Date(),
    });
  };

  const handleSaveAll = async () => {
    if (!user?.uid) {
      setMessage({ type: 'error', text: 'ユーザー情報が取得できません' });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      await saveDateSettingsHandler();
      await saveBudgetSettingsHandler();
      setMessage({ type: 'success', text: '設定を保存しました' });
    } catch (error) {
      console.error('Failed to save settings:', error);
      setMessage({ type: 'error', text: '設定の保存に失敗しました' });
    } finally {
      setSaving(false);
    }
  };

  const categoryBudgetTotal = Object.values(budgetConfig.categoryBudgets).reduce((sum, val) => sum + val, 0);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-gray-100">
        <div className="text-center">
          <div className="w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="mt-4 text-sm text-gray-500">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-gray-100">
        <div className="text-center max-w-md p-8 bg-white rounded-2xl shadow-lg">
          <h1 className="text-xl font-bold text-gray-900 mb-2">ログインが必要です</h1>
          <p className="text-gray-600 text-sm mb-4">設定を変更するにはログインしてください</p>
          <a
            href={getUrlWithLineId('/')}
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            ホームに戻る
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50">
      <Header title="設定" getUrlWithLineId={getUrlWithLineId} currentPage="settings" />

      <main className="max-w-2xl mx-auto px-4 py-6 pb-24">
        {/* Message */}
        {message && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className={`mb-4 p-3 rounded-xl text-sm ${
              message.type === 'success'
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'bg-rose-50 text-rose-700 border border-rose-200'
            }`}
          >
            {message.text}
          </motion.div>
        )}

        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6 bg-white/80 backdrop-blur-sm rounded-xl p-1 shadow-sm border border-gray-100">
          <button
            onClick={() => setActiveTab('budget')}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'budget'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            💰 予算設定
          </button>
          <button
            onClick={() => setActiveTab('period')}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'period'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            📅 期間設定
          </button>
        </div>

        {/* Budget Settings Tab */}
        {activeTab === 'budget' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            {/* Monthly Budget */}
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">月間予算総額</h3>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">¥</span>
                <input
                  type="number"
                  value={budgetConfig.monthlyBudget}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value);
                    const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
                    setBudgetConfig(prev => ({ ...prev, monthlyBudget: value }));
                  }}
                  className="w-full pl-8 pr-4 py-3 rounded-xl border border-gray-200 text-lg font-bold text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            {/* Alert Threshold */}
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">予算残り警告</h3>
              <div className="flex items-center gap-4">
                <input
                  type="range"
                  min="5"
                  max="50"
                  step="5"
                  value={budgetConfig.alertThreshold}
                  onChange={(e) => setBudgetConfig(prev => ({ ...prev, alertThreshold: parseInt(e.target.value) }))}
                  className="flex-1"
                />
                <span className="w-14 text-center font-semibold text-gray-900">
                  {budgetConfig.alertThreshold}%
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                残り予算が{budgetConfig.alertThreshold}%（¥{Math.round(budgetConfig.monthlyBudget * budgetConfig.alertThreshold / 100).toLocaleString()}）を下回ると警告
              </p>
            </div>

            {/* Category Budgets */}
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-5">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-semibold text-gray-900">カテゴリ別予算</h3>
                <span className={`text-xs ${categoryBudgetTotal > budgetConfig.monthlyBudget ? 'text-rose-500' : 'text-gray-500'}`}>
                  合計: ¥{categoryBudgetTotal.toLocaleString()}
                </span>
              </div>

              <div className="space-y-3">
                {defaultCategories.map((category) => (
                  <div key={category.id} className="flex items-center gap-3">
                    <span className="text-lg w-7">{category.emoji}</span>
                    <span className="w-16 text-sm text-gray-700 truncate">{category.name}</span>
                    <div className="flex-1 relative">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">¥</span>
                      <input
                        type="number"
                        placeholder="0"
                        value={budgetConfig.categoryBudgets[category.name] || ''}
                        onChange={(e) => {
                          const value = parseInt(e.target.value) || 0;
                          setBudgetConfig(prev => ({
                            ...prev,
                            categoryBudgets: {
                              ...prev.categoryBudgets,
                              [category.name]: value,
                            },
                          }));
                        }}
                        className="w-full pl-7 pr-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {/* Period Settings Tab */}
        {activeTab === 'period' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-5"
          >
            <h3 className="text-sm font-semibold text-gray-900 mb-4">表示期間の設定</h3>

            <div className="space-y-3">
              <label className="flex items-center p-3 rounded-xl border border-gray-200 hover:bg-gray-50 cursor-pointer transition-colors">
                <input
                  type="radio"
                  name="mode"
                  value="monthly"
                  checked={dateSettings.mode === 'monthly'}
                  onChange={(e) => setDateSettings({ ...dateSettings, mode: e.target.value as DateRangeSettings['mode'] })}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="ml-3 text-sm text-gray-700">月単位で表示</span>
              </label>

              <label className="flex items-center p-3 rounded-xl border border-gray-200 hover:bg-gray-50 cursor-pointer transition-colors">
                <input
                  type="radio"
                  name="mode"
                  value="customStart"
                  checked={dateSettings.mode === 'customStart'}
                  onChange={(e) => setDateSettings({ ...dateSettings, mode: e.target.value as DateRangeSettings['mode'] })}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="ml-3 text-sm text-gray-700">指定日を月初として表示</span>
              </label>

              <label className="flex items-center p-3 rounded-xl border border-gray-200 hover:bg-gray-50 cursor-pointer transition-colors">
                <input
                  type="radio"
                  name="mode"
                  value="custom"
                  checked={dateSettings.mode === 'custom'}
                  onChange={(e) => setDateSettings({ ...dateSettings, mode: e.target.value as DateRangeSettings['mode'] })}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="ml-3 text-sm text-gray-700">期間を指定して表示</span>
              </label>
            </div>

            {dateSettings.mode === 'customStart' && (
              <div className="mt-4 p-4 bg-blue-50 rounded-xl">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  月初日として扱う日付
                </label>
                <select
                  value={tempStartDay}
                  onChange={(e) => setTempStartDay(parseInt(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                >
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(day => (
                    <option key={day} value={day}>{day}日</option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-gray-600">
                  例：25日を選択すると、25日〜翌月24日を1ヶ月として表示
                </p>
              </div>
            )}

            {dateSettings.mode === 'custom' && (
              <div className="mt-4 p-4 bg-blue-50 rounded-xl space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">開始日</label>
                  <input
                    type="date"
                    value={tempStartDate}
                    onChange={(e) => setTempStartDate(e.target.value)}
                    max={tempEndDate || dayjs().format('YYYY-MM-DD')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">終了日</label>
                  <input
                    type="date"
                    value={tempEndDate}
                    onChange={(e) => setTempEndDate(e.target.value)}
                    min={tempStartDate}
                    max={dayjs().format('YYYY-MM-DD')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            )}
          </motion.div>
        )}

        {/* Save Button */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="mt-6"
        >
          <button
            onClick={handleSaveAll}
            disabled={saving}
            className="w-full py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            {saving ? '保存中...' : '設定を保存'}
          </button>
        </motion.div>
      </main>
    </div>
  );
}
