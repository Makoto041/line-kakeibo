'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Wallet,
  Receipt,
  TrendingUp,
  TrendingDown,
  PieChart as PieChartIcon,
  LineChart as LineChartIcon,
  Sparkles,
  Inbox,
  AlertTriangle,
  Clock,
} from 'lucide-react';
import { useLineAuth, useMonthlyStats, useBudgetConfig, useExpenses } from '../lib/hooks';
import { countPending } from '../lib/expenseState';
import Link from 'next/link';
import { CategoryPieChart, DailyLineChart } from '../components/Charts';
import { getDateRangeSettings, getEffectiveDateRange, getDisplayTitle, type DateRangeSettings } from '../lib/dateSettings';
import PreviewModeBanner from '../components/PreviewModeBanner';
import GuestGuide from '../components/GuestGuide';
import { getSampleStats } from '../lib/sampleData';
import { yen } from '../lib/money';
import { computePeriodInsights } from '../lib/budgetAnalytics';
import { GlassCard } from '../components/home/GlassCard';
import { SummaryCard } from '../components/home/SummaryCard';
import { BudgetProgress } from '../components/home/BudgetProgress';
import { getCached, setCached, hasCached } from '../lib/swrCache';
import dayjs from 'dayjs';
import { db } from '../lib/firebase';

/* ------------------------------- Page ----------------------------------- */
export default function Dashboard() {
  const { lineId, loading: authLoading } = useLineAuth();
  const dsCacheKey = lineId ? `dateSettings:${lineId}` : '';
  const [currentDate, setCurrentDate] = useState(dayjs());
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>(
    () => (dsCacheKey && getCached<DateRangeSettings>(dsCacheKey)) || { mode: 'monthly' }
  );
  // 設定がキャッシュ済みなら全画面スピナーを出さない（再訪時の点滅防止）
  const [settingsLoading, setSettingsLoading] = useState(() => !(dsCacheKey && hasCached(dsCacheKey)));
  const [firebaseError, setFirebaseError] = useState(false);

  const { config: budgetConfig, loading: budgetLoading, error: budgetError, refetch: refetchBudget } =
    useBudgetConfig(lineId);

  const sampleStats = useMemo(() => getSampleStats(), []);

  useEffect(() => {
    if (typeof window !== 'undefined' && !db) setFirebaseError(true);
  }, []);

  useEffect(() => {
    const load = async () => {
      if (!lineId) {
        setSettingsLoading(false);
        return;
      }
      const key = `dateSettings:${lineId}`;
      const cached = getCached<DateRangeSettings>(key);
      // キャッシュがあれば即表示して裏で再取得（スピナーを出さない）
      if (cached) {
        setDateSettings(cached);
        setSettingsLoading(false);
      } else {
        setSettingsLoading(true);
      }
      try {
        const fresh = await getDateRangeSettings(lineId);
        setCached(key, fresh);
        setDateSettings(fresh);
      } catch (e) {
        console.error('Failed to load date settings:', e);
        if (!cached) setDateSettings({ mode: 'monthly' });
      } finally {
        setSettingsLoading(false);
      }
    };
    load();
  }, [lineId]);

  const effectiveRange = getEffectiveDateRange(currentDate, dateSettings);
  const { stats, loading: statsLoading } = useMonthlyStats(
    lineId,
    currentDate.year(),
    currentDate.month() + 1,
    dateSettings.customStartDay || 1,
    effectiveRange.startDate,
    effectiveRange.endDate,
  );

  // Previous period — used for the month-over-month insight.
  const prevDate = currentDate.subtract(1, 'month');
  const prevRange = getEffectiveDateRange(prevDate, dateSettings);
  const { stats: prevStats } = useMonthlyStats(
    lineId,
    prevDate.year(),
    prevDate.month() + 1,
    dateSettings.customStartDay || 1,
    prevRange.startDate,
    prevRange.endDate,
  );

  // 要確認の件数（支出一覧と同じ取得条件なので、一覧を開いたときはキャッシュが使われる）
  // 期間の設定を読み終えてから取得する（既定の期間で一度取ってから取り直さないように）
  const { expenses: periodExpenses } = useExpenses(settingsLoading ? null : lineId, 0, 500, effectiveRange.startDate);
  const pendingCount = countPending(periodExpenses);

  const navigateMonth = (dir: 'prev' | 'next') => {
    if (dateSettings.mode === 'custom') return;
    setCurrentDate((prev) => (dir === 'prev' ? prev.subtract(1, 'month') : prev.add(1, 'month')));
  };

  if (firebaseError) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md items-center px-4">
        <GlassCard className="w-full p-8 text-center">
          <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/12 text-rose-500">
            <AlertTriangle className="h-7 w-7" />
          </span>
          <h2 className="text-lg font-semibold text-fg">接続エラー</h2>
          <p className="mt-2 text-sm text-muted">アプリの初期化に失敗しました。時間をおいて再度お試しください。</p>
        </GlassCard>
      </div>
    );
  }

  if (authLoading || settingsLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="mt-3 text-sm text-muted">読み込み中...</p>
        </div>
      </div>
    );
  }

  const isGuest = !lineId;
  const displayStats = isGuest ? sampleStats : stats;

  // --- サマリーと判断インサイト（予算・前月比・残ペース） ---
  // 固定のカスタム期間では前期間が現在と同一になる（＝自分自身と比較して常に0%）ため、前月比は出さない。
  const {
    totalExpense,
    expenseCount,
    dailyAverage,
    budgetPct,
    budgetRemaining,
    daysLeft,
    perDayAvailable,
    momPct,
    prevTotal,
  } = computePeriodInsights({
    stats: displayStats,
    prevStats: isGuest ? null : prevStats,
    monthlyBudget: budgetConfig?.monthlyBudget,
    range: effectiveRange,
    mode: dateSettings.mode,
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-8 md:py-7">
      {isGuest && (
        <div className="mb-4">
          <PreviewModeBanner />
        </div>
      )}

      {/* Period navigation */}
      <GlassCard className="animate-fade-up p-2.5">
        <div className="flex items-center justify-between">
          <button
            onClick={() => navigateMonth('prev')}
            disabled={dateSettings.mode === 'custom'}
            aria-label="前の期間"
            className="grid h-10 w-10 place-items-center rounded-xl text-muted transition-colors hover:bg-fg/5 hover:text-fg disabled:opacity-30"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="text-center">
            <h1 className="text-base font-semibold tracking-tight text-fg">
              {getDisplayTitle(currentDate, dateSettings)}
            </h1>
            {dateSettings.mode === 'monthly' && dateSettings.customStartDay && dateSettings.customStartDay !== 1 && (
              <p className="text-[11px] text-muted">{dateSettings.customStartDay}日起算</p>
            )}
          </div>
          <button
            onClick={() => navigateMonth('next')}
            disabled={dateSettings.mode === 'custom'}
            aria-label="次の期間"
            className="grid h-10 w-10 place-items-center rounded-xl text-muted transition-colors hover:bg-fg/5 hover:text-fg disabled:opacity-30"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </GlassCard>

      {!isGuest && pendingCount > 0 && (
        <Link
          href="/expenses?filter=pending"
          className="mt-4 flex items-center gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-amber-800 transition-colors hover:bg-amber-500/15 dark:text-amber-200"
        >
          <Clock className="h-5 w-5 shrink-0" />
          <span className="flex-1 text-sm font-semibold">要確認の支出が {pendingCount}件 あります</span>
          <span className="text-xs font-medium">確認する</span>
          <ChevronRight className="h-4 w-4 shrink-0" />
        </Link>
      )}

      {statsLoading ? (
        <div className="py-16 text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="mt-3 text-sm text-muted">データを読み込み中...</p>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {isGuest && (
            <div className="flex justify-center">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent">
                <Sparkles className="h-3.5 w-3.5" />
                サンプルデータを表示しています
              </span>
            </div>
          )}

          {/* Summary */}
          <div className="grid grid-cols-3 gap-3">
            <SummaryCard label="今月の支出" value={yen(totalExpense)} Icon={Wallet} tone="bg-accent/12 text-accent" />
            <SummaryCard label="支出回数" value={`${expenseCount}回`} Icon={Receipt} tone="bg-sky-500/12 text-sky-600 dark:text-sky-400" />
            <SummaryCard label="1日平均" value={yen(dailyAverage)} Icon={TrendingUp} tone="bg-violet-500/12 text-violet-600 dark:text-violet-400" />
          </div>

          {/* 判断インサイト */}
          {(budgetPct !== null || momPct !== null) && (
            <GlassCard className="p-4">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                {budgetPct !== null && (
                  <div>
                    <p className="text-[11px] font-medium text-muted">予算進捗</p>
                    <p className="mt-0.5 text-lg font-bold tabular-nums text-fg">{budgetPct}%</p>
                    <p className={`text-xs tabular-nums ${budgetRemaining! >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {budgetRemaining! >= 0 ? `残り ${yen(budgetRemaining!)}` : `超過 ${yen(-budgetRemaining!)}`}
                    </p>
                  </div>
                )}
                {perDayAvailable !== null && (
                  <div>
                    <p className="text-[11px] font-medium text-muted">あと使える / 日</p>
                    <p className="mt-0.5 text-lg font-bold tabular-nums text-fg">{yen(perDayAvailable)}</p>
                    <p className="text-xs text-muted">残り{daysLeft}日</p>
                  </div>
                )}
                {momPct !== null && (
                  <div>
                    <p className="text-[11px] font-medium text-muted">前月比</p>
                    <p className={`mt-0.5 inline-flex items-center gap-1 text-lg font-bold tabular-nums ${momPct > 0 ? 'text-rose-600 dark:text-rose-400' : momPct < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-fg'}`}>
                      {momPct > 0 ? <TrendingUp className="h-4 w-4" /> : momPct < 0 ? <TrendingDown className="h-4 w-4" /> : null}
                      {momPct > 0 ? '+' : ''}{momPct}%
                    </p>
                    <p className="text-xs tabular-nums text-muted">前月 {yen(prevTotal)}</p>
                  </div>
                )}
              </div>
            </GlassCard>
          )}

          {/* Main (charts) + insight rail (budget). On desktop this becomes a
              2/3 + 1/3 layout; on mobile budget stays above the charts.
              DOM order is budget-first (mobile); explicit column placement
              moves budget to the right rail on large screens. */}
          <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
            {/* Insight rail: budget (sticky on desktop) */}
            <div className="lg:col-span-1 lg:col-start-3 lg:row-start-1 lg:sticky lg:top-20">
              {budgetLoading ? (
                <GlassCard className="p-5">
                  <div className="animate-pulse space-y-3">
                    <div className="h-4 w-1/4 rounded bg-fg/10" />
                    <div className="h-2.5 w-full rounded bg-fg/10" />
                    <div className="h-2.5 w-2/3 rounded bg-fg/10" />
                  </div>
                </GlassCard>
              ) : budgetError ? (
                <GlassCard className="p-5 text-center">
                  <p className="text-sm text-rose-500">予算設定の読み込みに失敗しました</p>
                  <button onClick={refetchBudget} className="mt-2 text-xs font-medium text-accent hover:underline">
                    再試行
                  </button>
                </GlassCard>
              ) : (
                <BudgetProgress stats={displayStats} budgetConfig={budgetConfig} />
              )}
            </div>

            {/* Main column: charts */}
            <div className="space-y-4 lg:col-span-2 lg:col-start-1 lg:row-start-1">
              {displayStats && displayStats.totalAmount > 0 ? (
                <>
                  <GlassCard className="p-5">
                    <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-fg">
                      <PieChartIcon className="h-[18px] w-[18px] text-accent" strokeWidth={2.2} />
                      カテゴリ別支出
                    </h2>
                    <CategoryPieChart data={displayStats.categoryTotals} />
                  </GlassCard>
                  <GlassCard className="p-5">
                    <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-fg">
                      <LineChartIcon className="h-[18px] w-[18px] text-accent" strokeWidth={2.2} />
                      日別の推移
                    </h2>
                    <DailyLineChart
                      data={displayStats.dailyTotals}
                      startDate={effectiveRange.startDate}
                      endDate={effectiveRange.endDate}
                      mode={dateSettings.mode}
                    />
                  </GlassCard>
                </>
              ) : (
                <GlassCard className="p-8 text-center">
                  <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-fg/5 text-muted">
                    <Inbox className="h-7 w-7" strokeWidth={1.8} />
                  </span>
                  <h3 className="text-base font-semibold text-fg">支出データがありません</h3>
                  <p className="mt-1.5 text-sm text-muted">
                    LINEでレシートやメモを送ると、ここに自動で記録されます。
                  </p>
                </GlassCard>
              )}
            </div>
          </div>

          {isGuest && <GuestGuide />}
        </div>
      )}
    </div>
  );
}
