'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useLineAuth, useMonthlyStats } from '../lib/hooks';
import { CategoryPieChart, DailyLineChart } from '../components/Charts';
import { getDateRangeSettings, getEffectiveDateRange, getDisplayTitle, type DateRangeSettings } from '../lib/dateSettings';
import AppShell from '../components/AppShell';
import dayjs from 'dayjs';
import { db } from '../lib/firebase';

export default function Dashboard() {
  const { user, loading: authLoading, getUrlWithLineId } = useLineAuth();
  const [currentDate, setCurrentDate] = useState(dayjs());
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>({ mode: 'monthly' });
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [firebaseError, setFirebaseError] = useState(false);

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
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="text-center max-w-sm">
          <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-1">接続エラー</h2>
          <p className="text-sm text-gray-500">アプリケーションの初期化に失敗しました。</p>
        </div>
      </div>
    );
  }

  if (authLoading || settingsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
          <p className="text-sm text-gray-400">読み込み中...</p>
        </div>
      </div>
    );
  }

  const days = dayjs(effectiveRange.endDate).diff(dayjs(effectiveRange.startDate), 'day') + 1;
  const dailyAvg = stats ? Math.round(stats.totalAmount / days) : 0;

  const topCategories = stats
    ? Object.entries(stats.categoryTotals)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
    : [];

  return (
    <AppShell getUrlWithLineId={getUrlWithLineId}>
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* Month navigation */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => navigateMonth('prev')}
            disabled={dateSettings.mode === 'custom'}
            className="w-9 h-9 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 disabled:opacity-30 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h2 className="text-lg font-semibold text-gray-900">
            {getDisplayTitle(currentDate, dateSettings)}
          </h2>
          <button
            onClick={() => navigateMonth('next')}
            disabled={dateSettings.mode === 'custom'}
            className="w-9 h-9 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 disabled:opacity-30 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {statsLoading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {/* Total card */}
            <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">今月の支出</p>
              <p className="text-3xl font-bold text-gray-900 tabular-nums">
                ¥{(stats?.totalAmount || 0).toLocaleString()}
              </p>
              <div className="flex items-center gap-4 mt-3 text-sm text-gray-500">
                <span>{stats?.expenseCount || 0}件</span>
                <span className="text-gray-300">|</span>
                <span>日平均 ¥{dailyAvg.toLocaleString()}</span>
              </div>
            </div>

            {stats && stats.totalAmount > 0 ? (
              <>
                {/* Quick stats row */}
                <div className="grid grid-cols-3 gap-3">
                  {topCategories.map(([category, amount]) => (
                    <div key={category} className="bg-white rounded-xl p-3 shadow-sm border border-gray-100 text-center">
                      <p className="text-xs text-gray-400 truncate">{category}</p>
                      <p className="text-sm font-semibold text-gray-900 mt-0.5 tabular-nums">
                        ¥{amount.toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Charts */}
                <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
                  <CategoryPieChart data={stats.categoryTotals} />
                </div>

                <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
                  <DailyLineChart
                    data={stats.dailyTotals}
                    startDate={effectiveRange.startDate}
                    endDate={effectiveRange.endDate}
                    mode={dateSettings.mode}
                  />
                </div>

                {/* Link to expense list */}
                <Link
                  href={getUrlWithLineId('/expenses')}
                  className="flex items-center justify-between bg-white rounded-2xl p-4 shadow-sm border border-gray-100 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center">
                      <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">支出一覧を見る</p>
                      <p className="text-xs text-gray-400">{stats.expenseCount}件の支出を確認</p>
                    </div>
                  </div>
                  <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </>
            ) : (
              /* Empty state */
              <div className="bg-white rounded-2xl p-8 shadow-sm border border-gray-100 text-center">
                <div className="w-16 h-16 rounded-full bg-emerald-50 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="text-base font-semibold text-gray-900 mb-1">まだ支出がありません</h3>
                <p className="text-sm text-gray-400 mb-6">LINEでメッセージを送信して家計簿を始めましょう</p>
                <div className="bg-gray-50 rounded-xl p-4 text-left space-y-2 max-w-xs mx-auto">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">使い方</p>
                  <div className="space-y-1.5 text-sm text-gray-600">
                    <p>1. LINEでBotを友達追加</p>
                    <p>2. 「ランチ 800円」のように送信</p>
                    <p>3. 自動で記録・カテゴリ分類</p>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
