'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useLineAuth, useMonthlyStats, useBudgetConfig, ExpenseStats, BudgetConfig } from '../lib/hooks';
import { CategoryPieChart, DailyLineChart } from '../components/Charts';
import { getDateRangeSettings, getEffectiveDateRange, getDisplayTitle, type DateRangeSettings } from '../lib/dateSettings';
import Header from '../components/Header';
import dayjs from 'dayjs';
import { db } from '../lib/firebase';

// カテゴリ設定
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
};

// 予算設定のカテゴリ名 → 支出データのカテゴリ名のマッピング
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
};

function getActualSpending(budgetCategory: string, categoryTotals: Record<string, number>): number {
  const mappedCategories = budgetToExpenseCategory[budgetCategory] || [budgetCategory];
  return mappedCategories.reduce((sum, cat) => sum + (categoryTotals[cat] || 0), 0);
}

function calculatePace(actual: number, budget: number): { pace: 'good' | 'warning' | 'danger'; label: string } {
  const today = dayjs();
  const daysInMonth = today.daysInMonth();
  const currentDay = today.date();
  const proratedBudget = (budget / daysInMonth) * currentDay;

  if (budget === 0) return { pace: 'good', label: '未設定' };
  const ratio = actual / proratedBudget;
  if (ratio <= 1) return { pace: 'good', label: '順調' };
  if (ratio <= 1.2) return { pace: 'warning', label: 'やや超過' };
  return { pace: 'danger', label: '超過' };
}

function getProgressColor(percentage: number): string {
  if (percentage <= 80) return 'from-emerald-400 to-emerald-500';
  if (percentage <= 100) return 'from-amber-400 to-amber-500';
  return 'from-rose-400 to-rose-500';
}

function getPaceBadgeStyle(pace: 'good' | 'warning' | 'danger'): string {
  if (pace === 'good') return 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200';
  if (pace === 'warning') return 'bg-amber-100 text-amber-700 ring-1 ring-amber-200';
  return 'bg-rose-100 text-rose-700 ring-1 ring-rose-200';
}

// Budget Progress Component
function BudgetProgress({ stats, budgetConfig }: { stats: ExpenseStats | null; budgetConfig: BudgetConfig | null }) {
  if (!stats || !budgetConfig) return null;

  const { categoryTotals } = stats;
  const { categoryBudgets, monthlyBudget } = budgetConfig;

  const categoriesWithBudget = Object.entries(categoryBudgets)
    .filter(([, budget]) => budget > 0)
    .map(([category, budget]) => ({
      category,
      budget,
      actual: getActualSpending(category, categoryTotals),
      info: categoryInfo[category] || { emoji: '📦', name: category },
    }))
    .sort((a, b) => {
      const aOverBudget = a.actual > a.budget ? 1 : 0;
      const bOverBudget = b.actual > b.budget ? 1 : 0;
      if (aOverBudget !== bOverBudget) return bOverBudget - aOverBudget;
      return (b.actual / b.budget) - (a.actual / a.budget);
    });

  const totalActual = stats.totalAmount;
  const totalPercentage = monthlyBudget > 0 ? (totalActual / monthlyBudget) * 100 : 0;
  const totalRemaining = monthlyBudget - totalActual;
  const totalPace = calculatePace(totalActual, monthlyBudget);

  const today = dayjs();
  const idealProgress = (today.date() / today.daysInMonth()) * 100;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-6"
    >
      <h2 className="text-lg font-semibold text-gray-900 mb-5 flex items-center gap-2">
        <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white text-sm">📊</span>
        予算管理
      </h2>

      {/* Monthly Total */}
      <div className="mb-6 p-4 rounded-xl bg-gradient-to-r from-gray-50 to-slate-50 border border-gray-100">
        <div className="flex justify-between items-center mb-3">
          <span className="font-medium text-gray-800">月間予算</span>
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${getPaceBadgeStyle(totalPace.pace)}`}>
            {totalPace.label}
          </span>
        </div>

        <div className="relative h-3 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-blue-500 z-10 opacity-60"
            style={{ left: `${Math.min(idealProgress, 100)}%`, transform: 'translateX(-50%)' }}
          />
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(totalPercentage, 100)}%` }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className={`h-full bg-gradient-to-r ${getProgressColor(totalPercentage)} rounded-full`}
          />
        </div>

        <div className="flex justify-between items-center mt-2 text-sm">
          <span className="text-gray-500">
            ¥{totalActual.toLocaleString()} / ¥{monthlyBudget.toLocaleString()}
          </span>
          <span className={`font-semibold ${totalRemaining >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
            {totalRemaining >= 0 ? `残り ¥${totalRemaining.toLocaleString()}` : `超過 ¥${Math.abs(totalRemaining).toLocaleString()}`}
          </span>
        </div>
      </div>

      {/* Category Budgets */}
      {categoriesWithBudget.length === 0 ? (
        <div className="text-center py-6 text-gray-400">
          <p className="text-sm">カテゴリ別予算が未設定です</p>
        </div>
      ) : (
        <div className="space-y-3">
          {categoriesWithBudget.slice(0, 5).map(({ category, budget, actual, info }) => {
            const percentage = budget > 0 ? (actual / budget) * 100 : 0;
            const remaining = budget - actual;
            const pace = calculatePace(actual, budget);

            return (
              <motion.div
                key={category}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="group"
              >
                <div className="flex justify-between items-center mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-base">{info.emoji}</span>
                    <span className="text-sm font-medium text-gray-700">{info.name}</span>
                  </div>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${getPaceBadgeStyle(pace.pace)}`}>
                    {pace.label}
                  </span>
                </div>

                <div className="relative h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="absolute top-0 bottom-0 w-px bg-blue-400 z-10 opacity-50"
                    style={{ left: `${Math.min(idealProgress, 100)}%` }}
                  />
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(percentage, 100)}%` }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                    className={`h-full bg-gradient-to-r ${getProgressColor(percentage)} rounded-full`}
                  />
                </div>

                <div className="flex justify-between items-center mt-1 text-xs text-gray-500">
                  <span>¥{actual.toLocaleString()} / ¥{budget.toLocaleString()}</span>
                  <span className={remaining >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                    {remaining >= 0 ? `残 ¥${remaining.toLocaleString()}` : `超 ¥${Math.abs(remaining).toLocaleString()}`}
                  </span>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Legend */}
      <div className="mt-5 pt-4 border-t border-gray-100">
        <div className="flex flex-wrap gap-3 text-[10px] text-gray-400">
          <div className="flex items-center gap-1">
            <div className="w-2.5 h-2.5 rounded-sm bg-gradient-to-r from-emerald-400 to-emerald-500" />
            <span>80%以下</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2.5 h-2.5 rounded-sm bg-gradient-to-r from-amber-400 to-amber-500" />
            <span>80-100%</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2.5 h-2.5 rounded-sm bg-gradient-to-r from-rose-400 to-rose-500" />
            <span>超過</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-px bg-blue-400" />
            <span>今日</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// Summary Card Component
function SummaryCard({
  title,
  value,
  icon,
  color,
  subtext,
  delay = 0
}: {
  title: string;
  value: string;
  icon: string;
  color: string;
  subtext?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-5 hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-gray-500 mb-1">{title}</p>
          <p className={`text-2xl font-bold ${color}`}>{value}</p>
          {subtext && <p className="text-xs text-gray-400 mt-1">{subtext}</p>}
        </div>
        <span className="text-2xl">{icon}</span>
      </div>
    </motion.div>
  );
}

export default function Dashboard() {
  const { user, loading: authLoading, getUrlWithLineId } = useLineAuth();
  const [currentDate, setCurrentDate] = useState(dayjs());
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>({ mode: 'monthly' });
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [firebaseError, setFirebaseError] = useState(false);

  const { config: budgetConfig, loading: budgetLoading, error: budgetError, refetch: refetchBudget } = useBudgetConfig(user?.uid || null);

  useEffect(() => {
    if (typeof window !== 'undefined' && !db) {
      setFirebaseError(true);
    }
  }, []);

  useEffect(() => {
    const loadSettings = async () => {
      if (!user?.uid) {
        setSettingsLoading(false);
        return;
      }

      try {
        setSettingsLoading(true);
        const settings = await getDateRangeSettings(user.uid);
        setDateSettings(settings);
      } catch (error) {
        console.error('Failed to load date settings:', error);
        setDateSettings({ mode: 'monthly' });
      } finally {
        setSettingsLoading(false);
      }
    };

    loadSettings();
  }, [user?.uid]);

  const effectiveRange = getEffectiveDateRange(currentDate, dateSettings);

  const { stats, loading: statsLoading } = useMonthlyStats(
    user?.uid || null,
    currentDate.year(),
    currentDate.month() + 1,
    dateSettings.customStartDay || 1,
    effectiveRange.startDate,
    effectiveRange.endDate
  );

  const navigateMonth = (direction: 'prev' | 'next') => {
    if (dateSettings.mode === 'custom') return;

    if (direction === 'prev') {
      setCurrentDate(prev => prev.subtract(1, 'month'));
    } else {
      setCurrentDate(prev => prev.add(1, 'month'));
    }
  };

  if (firebaseError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-gray-100">
        <div className="text-center max-w-md p-8 bg-white rounded-2xl shadow-lg">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-rose-100 flex items-center justify-center">
            <svg className="w-8 h-8 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">接続エラー</h2>
          <p className="text-gray-600 text-sm">
            アプリケーションの初期化に失敗しました。<br />
            しばらくしてから再度お試しください。
          </p>
        </div>
      </div>
    );
  }

  if (authLoading || settingsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-gray-100">
        <div className="text-center">
          <div className="w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="mt-4 text-sm text-gray-500">読み込み中...</p>
        </div>
      </div>
    );
  }

  const totalExpense = stats?.totalAmount || 0;
  const expenseCount = stats?.expenseCount || 0;
  const days = dayjs(effectiveRange.endDate).diff(dayjs(effectiveRange.startDate), 'day') + 1;
  const dailyAverage = totalExpense > 0 ? Math.round(totalExpense / days) : 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50">
      <Header
        title="家計簿"
        getUrlWithLineId={getUrlWithLineId}
        currentPage="dashboard"
      />

      <main className="max-w-4xl mx-auto px-4 py-6 pb-24">
        {/* Date Navigation */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-4 mb-6"
        >
          <div className="flex items-center justify-between">
            <button
              onClick={() => navigateMonth('prev')}
              disabled={dateSettings.mode === 'custom'}
              className={`p-2.5 rounded-xl transition-all ${
                dateSettings.mode === 'custom'
                  ? 'text-gray-300 cursor-not-allowed'
                  : 'text-gray-600 hover:bg-gray-100 active:scale-95'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            <div className="text-center">
              <h2 className="text-lg font-bold text-gray-900">
                {getDisplayTitle(currentDate, dateSettings)}
              </h2>
              {dateSettings.mode === 'monthly' && dateSettings.customStartDay && dateSettings.customStartDay !== 1 && (
                <p className="text-xs text-gray-500 mt-0.5">{dateSettings.customStartDay}日起算</p>
              )}
            </div>

            <button
              onClick={() => navigateMonth('next')}
              disabled={dateSettings.mode === 'custom'}
              className={`p-2.5 rounded-xl transition-all ${
                dateSettings.mode === 'custom'
                  ? 'text-gray-300 cursor-not-allowed'
                  : 'text-gray-600 hover:bg-gray-100 active:scale-95'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </motion.div>

        {statsLoading ? (
          <div className="text-center py-16">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
            <p className="mt-3 text-sm text-gray-500">データを読み込み中...</p>
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-3 gap-3 mb-6">
              <SummaryCard
                title="今月の支出"
                value={`¥${totalExpense.toLocaleString()}`}
                icon="💰"
                color="text-gray-900"
                delay={0.1}
              />
              <SummaryCard
                title="支出回数"
                value={`${expenseCount}`}
                icon="📝"
                color="text-blue-600"
                subtext="回"
                delay={0.15}
              />
              <SummaryCard
                title="1日平均"
                value={`¥${dailyAverage.toLocaleString()}`}
                icon="📊"
                color="text-emerald-600"
                delay={0.2}
              />
            </div>

            {/* Budget Progress */}
            {budgetLoading ? (
              <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
                <div className="animate-pulse">
                  <div className="h-5 bg-gray-200 rounded w-1/4 mb-4"></div>
                  <div className="h-3 bg-gray-200 rounded w-full mb-3"></div>
                  <div className="h-3 bg-gray-200 rounded w-2/3"></div>
                </div>
              </div>
            ) : budgetError ? (
              <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
                <div className="text-center text-rose-500">
                  <p className="text-sm">予算設定の読み込みに失敗しました</p>
                  <button
                    onClick={refetchBudget}
                    className="mt-2 text-xs text-blue-600 hover:underline"
                  >
                    再試行
                  </button>
                </div>
              </div>
            ) : (
              <div className="mb-6">
                <BudgetProgress stats={stats} budgetConfig={budgetConfig} />
              </div>
            )}

            {/* Charts */}
            {stats && stats.totalAmount > 0 ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-5"
                >
                  <CategoryPieChart data={stats.categoryTotals} />
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.35 }}
                  className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-5"
                >
                  <DailyLineChart
                    data={stats.dailyTotals}
                    startDate={effectiveRange.startDate}
                    endDate={effectiveRange.endDate}
                    mode={dateSettings.mode}
                  />
                </motion.div>
              </div>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25 }}
                className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-8 text-center"
              >
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
                  <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">支出データがありません</h3>
                <p className="text-sm text-gray-500 mb-5">
                  LINEでレシート画像を送信して<br />家計簿を始めましょう
                </p>
                <div className="inline-flex flex-col items-start bg-blue-50 rounded-xl p-4 text-left">
                  <p className="text-xs font-medium text-blue-800 mb-2">使い方</p>
                  <ol className="text-xs text-blue-700 space-y-1">
                    <li>1. LINEでBotを友達追加</li>
                    <li>2. レシート画像を送信</li>
                    <li>3. 自動で読み取り・保存</li>
                  </ol>
                </div>
              </motion.div>
            )}

            {/* Settings Link */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4 }}
              className="mt-6 text-center"
            >
              <Link
                href={getUrlWithLineId("/settings")}
                className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                設定
              </Link>
            </motion.div>
          </>
        )}
      </main>
    </div>
  );
}
