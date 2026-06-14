'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Wallet, CalendarRange } from 'lucide-react';
import { useLineAuth } from '../../lib/hooks';
import { getDateRangeSettings, saveDateRangeSettings, migrateLocalToFirestore, DEFAULT_SETTINGS, type DateRangeSettings } from '../../lib/dateSettings';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import PreviewModeBanner from '../../components/PreviewModeBanner';
import { getCategoryVisual } from '../../lib/categoryVisuals';
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
  { id: 'food', name: '食費' },
  { id: 'daily', name: '日用品' },
  { id: 'transport', name: '交通費' },
  { id: 'entertainment', name: '娯楽費' },
  { id: 'utility', name: '光熱費' },
  { id: 'communication', name: '通信費' },
  { id: 'medical', name: '医療費' },
  { id: 'clothing', name: '衣服費' },
  { id: 'education', name: '教育費' },
  { id: 'other', name: 'その他' },
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
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="mt-3 text-sm text-muted">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md items-center px-4">
        <div className="glass w-full rounded-2xl p-8 text-center shadow-glass">
          <h1 className="text-lg font-semibold text-fg">ログインが必要です</h1>
          <p className="mt-1.5 text-sm text-muted">設定を変更するにはログインしてください</p>
          <a
            href={getUrlWithLineId('/')}
            className="mt-4 inline-flex items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:opacity-90"
          >
            ホームに戻る
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-5 md:px-8 md:py-7">
      {(user.uid === 'guest' || user.isAnonymous) && (
        <div className="mb-4">
          <PreviewModeBanner />
        </div>
      )}

      <main>
        {/* Message */}
        {message && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className={`mb-4 p-3 rounded-xl text-sm ${
              message.type === 'success'
                ? 'border border-emerald-500/20 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                : 'border border-rose-500/20 bg-rose-500/12 text-rose-700 dark:text-rose-300'
            }`}
          >
            {message.text}
          </motion.div>
        )}

        {/* Tab Navigation */}
        <div className="glass mb-5 flex gap-1 rounded-2xl p-1 shadow-glass">
          <button
            onClick={() => setActiveTab('budget')}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'budget'
                ? 'bg-accent text-accent-fg shadow-sm'
                : 'text-muted hover:bg-fg/5 hover:text-fg'
            }`}
          >
            <Wallet className="h-4 w-4" />
            予算設定
          </button>
          <button
            onClick={() => setActiveTab('period')}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'period'
                ? 'bg-accent text-accent-fg shadow-sm'
                : 'text-muted hover:bg-fg/5 hover:text-fg'
            }`}
          >
            <CalendarRange className="h-4 w-4" />
            期間設定
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
            <div className="glass rounded-2xl shadow-glass p-5">
              <h3 className="text-sm font-semibold text-fg mb-3">月間予算総額</h3>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">¥</span>
                <input
                  type="number"
                  value={budgetConfig.monthlyBudget}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value);
                    const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
                    setBudgetConfig(prev => ({ ...prev, monthlyBudget: value }));
                  }}
                  className="w-full rounded-xl border border-line bg-card py-3 pl-8 pr-4 text-lg font-bold text-fg focus:border-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            </div>

            {/* Alert Threshold */}
            <div className="glass rounded-2xl shadow-glass p-5">
              <h3 className="text-sm font-semibold text-fg mb-3">予算残り警告</h3>
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
                <span className="w-14 text-center font-semibold text-fg">
                  {budgetConfig.alertThreshold}%
                </span>
              </div>
              <p className="text-xs text-muted mt-2">
                残り予算が{budgetConfig.alertThreshold}%（¥{Math.round(budgetConfig.monthlyBudget * budgetConfig.alertThreshold / 100).toLocaleString()}）を下回ると警告
              </p>
            </div>

            {/* Category Budgets */}
            <div className="glass rounded-2xl shadow-glass p-5">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-semibold text-fg">カテゴリ別予算</h3>
                <span className={`text-xs ${categoryBudgetTotal > budgetConfig.monthlyBudget ? 'text-rose-500' : 'text-muted'}`}>
                  合計: ¥{categoryBudgetTotal.toLocaleString()}
                </span>
              </div>

              <div className="space-y-3">
                {defaultCategories.map((category) => {
                  const v = getCategoryVisual(category.name);
                  const Icon = v.icon;
                  return (
                  <div key={category.id} className="flex items-center gap-3">
                    <span className={`grid h-7 w-7 flex-shrink-0 place-items-center rounded-lg ${v.bg} ${v.fg}`}>
                      <Icon className="h-4 w-4" strokeWidth={2.1} />
                    </span>
                    <span className="w-16 truncate text-sm text-fg">{category.name}</span>
                    <div className="relative flex-1">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted">¥</span>
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
                        className="w-full rounded-lg border border-line bg-card py-2 pl-7 pr-3 text-sm text-fg focus:border-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}

        {/* Period Settings Tab */}
        {activeTab === 'period' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-2xl shadow-glass p-5"
          >
            <h3 className="text-sm font-semibold text-fg mb-4">表示期間の設定</h3>

            <div className="space-y-3">
              <label className="flex cursor-pointer items-center rounded-xl border border-line p-3 transition-colors hover:bg-fg/5">
                <input
                  type="radio"
                  name="mode"
                  value="monthly"
                  checked={dateSettings.mode === 'monthly'}
                  onChange={(e) => setDateSettings({ ...dateSettings, mode: e.target.value as DateRangeSettings['mode'] })}
                  className="h-4 w-4 text-accent focus:ring-ring"
                />
                <span className="ml-3 text-sm text-fg">月単位で表示</span>
              </label>

              <label className="flex cursor-pointer items-center rounded-xl border border-line p-3 transition-colors hover:bg-fg/5">
                <input
                  type="radio"
                  name="mode"
                  value="customStart"
                  checked={dateSettings.mode === 'customStart'}
                  onChange={(e) => setDateSettings({ ...dateSettings, mode: e.target.value as DateRangeSettings['mode'] })}
                  className="h-4 w-4 text-accent focus:ring-ring"
                />
                <span className="ml-3 text-sm text-fg">指定日を月初として表示</span>
              </label>

              <label className="flex cursor-pointer items-center rounded-xl border border-line p-3 transition-colors hover:bg-fg/5">
                <input
                  type="radio"
                  name="mode"
                  value="custom"
                  checked={dateSettings.mode === 'custom'}
                  onChange={(e) => setDateSettings({ ...dateSettings, mode: e.target.value as DateRangeSettings['mode'] })}
                  className="h-4 w-4 text-accent focus:ring-ring"
                />
                <span className="ml-3 text-sm text-fg">期間を指定して表示</span>
              </label>
            </div>

            {dateSettings.mode === 'customStart' && (
              <div className="mt-4 rounded-xl bg-accent/[0.06] p-4">
                <label className="mb-2 block text-sm font-medium text-fg">
                  月初日として扱う日付
                </label>
                <select
                  value={tempStartDay}
                  onChange={(e) => setTempStartDay(parseInt(e.target.value))}
                  className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(day => (
                    <option key={day} value={day}>{day}日</option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-muted">
                  例：25日を選択すると、25日〜翌月24日を1ヶ月として表示
                </p>
              </div>
            )}

            {dateSettings.mode === 'custom' && (
              <div className="mt-4 rounded-xl bg-accent/[0.06] p-4 space-y-3">
                <div>
                  <label className="mb-2 block text-sm font-medium text-fg">開始日</label>
                  <input
                    type="date"
                    value={tempStartDate}
                    onChange={(e) => setTempStartDate(e.target.value)}
                    max={tempEndDate || dayjs().format('YYYY-MM-DD')}
                    className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-fg">終了日</label>
                  <input
                    type="date"
                    value={tempEndDate}
                    onChange={(e) => setTempEndDate(e.target.value)}
                    min={tempStartDate}
                    max={dayjs().format('YYYY-MM-DD')}
                    className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            className="w-full rounded-xl bg-accent py-3 font-medium text-accent-fg shadow-sm transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? '保存中...' : '設定を保存'}
          </button>
        </motion.div>
      </main>
    </div>
  );
}
