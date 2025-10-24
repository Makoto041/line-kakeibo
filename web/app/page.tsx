'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useLineAuth, useMonthlyStats } from '../lib/hooks';
import { CategoryPieChart, DailyLineChart } from '../components/Charts';
import { getDateRangeSettings, getEffectiveDateRange, getDisplayTitle, type DateRangeSettings } from '../lib/dateSettings';
import Header from '../components/Header';
import dayjs from 'dayjs';
import { db } from '../lib/firebase';

export default function Dashboard() {
  const { user, loading: authLoading, getUrlWithLineId } = useLineAuth();
  const [currentDate, setCurrentDate] = useState(dayjs());
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>({ mode: 'monthly' });
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [firebaseError, setFirebaseError] = useState(false);

  useEffect(() => {
    // Check if Firebase is properly initialized
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
        // Use default settings if loading fails
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
    if (dateSettings.mode === 'custom') return; // Don't navigate in custom mode
    
    if (direction === 'prev') {
      setCurrentDate(prev => prev.subtract(1, 'month'));
    } else {
      setCurrentDate(prev => prev.add(1, 'month'));
    }
  };

  if (firebaseError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-50 via-white to-orange-50">
        <div className="text-center max-w-md p-8 bg-white rounded-lg shadow-lg">
          <div className="text-red-500 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">設定エラー</h2>
          <p className="text-gray-600 mb-6">
            アプリケーションの初期化に失敗しました。<br />
            システム管理者にお問い合わせください。
          </p>
          <div className="bg-gray-100 rounded-lg p-4 text-left">
            <p className="text-sm text-gray-600 font-mono">
              Firebase configuration is missing.<br />
              Please check environment variables.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (authLoading || settingsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">
            {authLoading ? '読み込み中...' : '設定を読み込み中...'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 relative overflow-hidden">
      {/* Glassmorphism background effects */}
      <div className="absolute inset-0">
        <div className="absolute top-20 left-10 w-72 h-72 bg-gradient-to-r from-blue-300/20 to-purple-300/20 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob"></div>
        <div className="absolute top-40 right-10 w-72 h-72 bg-gradient-to-r from-purple-300/20 to-pink-300/20 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob animation-delay-2000"></div>
        <div className="absolute -bottom-8 left-20 w-72 h-72 bg-gradient-to-r from-pink-300/20 to-orange-300/20 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob animation-delay-4000"></div>
      </div>
      <Header 
        title="LINEレシート家計簿" 
        getUrlWithLineId={getUrlWithLineId}
        currentPage="dashboard"
      />

      <main className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Date Navigation */}
        <div className="bg-white/90 backdrop-blur-sm rounded-lg shadow-sm border p-4 mb-6">
          <div className="flex items-center justify-between gap-4">
            <button
              onClick={() => navigateMonth('prev')}
              className={`px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors text-sm font-medium ${
                dateSettings.mode === 'custom' ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              disabled={dateSettings.mode === 'custom'}
            >
              ← 前月
            </button>
            
            <div className="text-center">
              <h2 className="text-xl font-bold text-gray-900">
                {getDisplayTitle(currentDate, dateSettings)}
              </h2>
              {dateSettings.mode === 'custom' && (
                <p className="text-sm text-gray-600 mt-1">固定期間設定</p>
              )}
              {dateSettings.mode === 'monthly' && dateSettings.customStartDay && dateSettings.customStartDay !== 1 && (
                <p className="text-sm text-gray-600 mt-1">{dateSettings.customStartDay}日起算</p>
              )}
            </div>
            
            <button
              onClick={() => navigateMonth('next')}
              className={`px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors text-sm font-medium ${
                dateSettings.mode === 'custom' ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              disabled={dateSettings.mode === 'custom'}
            >
              次月 →
            </button>
          </div>
          
          {/* Settings link */}
          <div className="border-t pt-4 mt-4 text-center">
            <Link
              href={getUrlWithLineId("/settings")}
              className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              ⚙️ 集計期間を変更する
            </Link>
          </div>
        </div>

        {statsLoading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
            <p className="mt-4 text-gray-600">データを読み込み中...</p>
          </div>
        ) : (
          <>
            {/* Summary Cards - Compact Style */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
              <div className="bg-white/90 backdrop-blur-sm rounded-lg shadow-sm p-4 border border-gray-200">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-gray-600">💰 今月の支出総額</h3>
                </div>
                <p className="text-xl font-bold text-red-600">
                  ¥{stats?.totalAmount.toLocaleString() || 0}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  前月比: データなし
                </p>
              </div>
              
              <div className="bg-white/90 backdrop-blur-sm rounded-lg shadow-sm p-4 border border-gray-200">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-gray-600">📊 支出回数</h3>
                </div>
                <p className="text-xl font-bold text-blue-600">
                  {stats?.expenseCount || 0}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  回数
                </p>
              </div>
              
              <div className="bg-white/90 backdrop-blur-sm rounded-lg shadow-sm p-4 border border-gray-200 sm:col-span-2 lg:col-span-1">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-gray-600">📈 1日平均</h3>
                </div>
                <p className="text-xl font-bold text-green-600">
                  ¥{stats ? (() => {
                    const days = dayjs(effectiveRange.endDate).diff(dayjs(effectiveRange.startDate), 'day') + 1;
                    return Math.round(stats.totalAmount / days).toLocaleString();
                  })() : 0}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  1日あたり
                </p>
              </div>
            </div>

            {/* Charts - Compact Style */}
            {stats && stats.totalAmount > 0 ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white/90 backdrop-blur-sm rounded-lg shadow-sm p-4 border border-gray-200">
                  <CategoryPieChart data={stats.categoryTotals} />
                </div>
                
                <div className="bg-white/90 backdrop-blur-sm rounded-lg shadow-sm p-4 border border-gray-200">
                  <DailyLineChart 
                    data={stats.dailyTotals} 
                    startDate={effectiveRange.startDate}
                    endDate={effectiveRange.endDate}
                    mode={dateSettings.mode}
                  />
                </div>
              </div>
            ) : (
              <div className="bg-white/90 backdrop-blur-sm rounded-lg shadow-sm p-8 border border-gray-200 text-center">
                <div className="text-gray-400 mb-4">
                  <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">まだ支出データがありません</h3>
                <p className="text-gray-600 mb-4">
                  LINEでレシート画像を送信して家計簿を始めましょう！
                </p>
                <div className="bg-blue-50 rounded-lg p-4 max-w-md mx-auto">
                  <h4 className="font-semibold text-blue-900 mb-2">使い方</h4>
                  <ol className="text-left text-blue-800 text-sm space-y-1">
                    <li>1. LINEでBotを友達追加</li>
                    <li>2. レシート画像を送信</li>
                    <li>3. 自動で読み取り・保存</li>
                    <li>4. このページで確認・分析</li>
                  </ol>
                </div>
              </div>
            )}

          </>
        )}
      </main>
    </div>
  );
}