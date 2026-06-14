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
} from 'lucide-react';
import { useLineAuth, useMonthlyStats, useBudgetConfig, ExpenseStats, BudgetConfig } from '../lib/hooks';
import { CategoryPieChart, DailyLineChart } from '../components/Charts';
import { getDateRangeSettings, getEffectiveDateRange, getDisplayTitle, type DateRangeSettings } from '../lib/dateSettings';
import { getCategoryVisual } from '../lib/categoryVisuals';
import PreviewModeBanner from '../components/PreviewModeBanner';
import GuestGuide from '../components/GuestGuide';
import { getSampleStats } from '../lib/sampleData';
import dayjs from 'dayjs';
import { db } from '../lib/firebase';

const yen = (v: number) => `¥${Number(v).toLocaleString()}`;

// 予算カテゴリ名 → 支出データのカテゴリ名（表記ゆれ吸収）
const budgetToExpenseCategory: Record<string, string[]> = {
  食費: ['食費'],
  日用品: ['日用品'],
  交通費: ['交通費'],
  娯楽費: ['娯楽費', '娯楽'],
  光熱費: ['光熱費'],
  通信費: ['通信費'],
  医療費: ['医療費', '医療・健康'],
  衣服費: ['衣服費', '衣服'],
  教育費: ['教育費', '教育'],
  その他: ['その他'],
};

function getActualSpending(budgetCategory: string, categoryTotals: Record<string, number>): number {
  const mapped = budgetToExpenseCategory[budgetCategory] || [budgetCategory];
  return mapped.reduce((sum, cat) => sum + (categoryTotals[cat] || 0), 0);
}

type Pace = 'good' | 'warning' | 'danger';

function calculatePace(actual: number, budget: number): { pace: Pace; label: string } {
  const today = dayjs();
  const prorated = (budget / today.daysInMonth()) * today.date();
  if (budget === 0) return { pace: 'good', label: '未設定' };
  const ratio = actual / prorated;
  if (ratio <= 1) return { pace: 'good', label: '順調' };
  if (ratio <= 1.2) return { pace: 'warning', label: 'やや超過' };
  return { pace: 'danger', label: '超過' };
}

function progressColor(pct: number): string {
  if (pct <= 80) return 'bg-emerald-500';
  if (pct <= 100) return 'bg-amber-500';
  return 'bg-rose-500';
}

function paceBadge(pace: Pace): string {
  if (pace === 'good') return 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400';
  if (pace === 'warning') return 'bg-amber-500/12 text-amber-600 dark:text-amber-400';
  return 'bg-rose-500/12 text-rose-600 dark:text-rose-400';
}

/* -------------------------------- Card ---------------------------------- */
function GlassCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`glass rounded-2xl shadow-glass ${className}`}>{children}</div>;
}

/* ---------------------------- Summary card ------------------------------ */
function SummaryCard({
  label,
  value,
  Icon,
  tone,
}: {
  label: string;
  value: string;
  Icon: typeof Wallet;
  tone: string;
}) {
  return (
    <GlassCard className="p-4">
      <span className={`inline-grid h-9 w-9 place-items-center rounded-xl ${tone}`}>
        <Icon className="h-[18px] w-[18px]" strokeWidth={2.1} />
      </span>
      <p className="mt-3 text-[11px] font-medium text-muted">{label}</p>
      <p className="mt-0.5 text-xl font-bold tracking-tight text-fg tabular-nums">{value}</p>
    </GlassCard>
  );
}

/* --------------------------- Budget progress ---------------------------- */
function BudgetProgress({ stats, budgetConfig }: { stats: ExpenseStats | null; budgetConfig: BudgetConfig | null }) {
  if (!budgetConfig) return null;
  const categoryTotals = stats?.categoryTotals || {};
  const { categoryBudgets, monthlyBudget } = budgetConfig;

  const cats = Object.entries(categoryBudgets)
    .filter(([, b]) => b > 0)
    .map(([category, budget]) => ({ category, budget, actual: getActualSpending(category, categoryTotals) }))
    .sort((a, b) => b.actual / b.budget - a.actual / a.budget);

  const totalActual = stats?.totalAmount || 0;
  const totalPct = monthlyBudget > 0 ? (totalActual / monthlyBudget) * 100 : 0;
  const totalRemaining = monthlyBudget - totalActual;
  const totalPace = calculatePace(totalActual, monthlyBudget);
  const idealProgress = (dayjs().date() / dayjs().daysInMonth()) * 100;

  return (
    <GlassCard className="p-5">
      <h2 className="mb-4 flex items-center gap-2 text-[15px] font-semibold text-fg">
        <Wallet className="h-[18px] w-[18px] text-accent" strokeWidth={2.2} />
        予算管理
      </h2>

      {/* Monthly total */}
      <div className="rounded-xl border border-line/70 bg-fg/[0.02] p-4">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="text-sm font-medium text-fg">月間予算</span>
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${paceBadge(totalPace.pace)}`}>
            {totalPace.label}
          </span>
        </div>
        <div className="relative h-2.5 overflow-hidden rounded-full bg-fg/10">
          <div
            className="absolute inset-y-0 z-10 w-px bg-accent/70"
            style={{ left: `${Math.min(idealProgress, 100)}%` }}
            aria-hidden
          />
          <div
            className={`h-full rounded-full ${progressColor(totalPct)} transition-[width] duration-500`}
            style={{ width: `${Math.min(totalPct, 100)}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-sm">
          <span className="tabular-nums text-muted">
            {yen(totalActual)} / {yen(monthlyBudget)}
          </span>
          <span className={`font-semibold tabular-nums ${totalRemaining >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
            {totalRemaining >= 0 ? `残り ${yen(totalRemaining)}` : `超過 ${yen(Math.abs(totalRemaining))}`}
          </span>
        </div>
      </div>

      {/* Category budgets */}
      {cats.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">カテゴリ別予算が未設定です</p>
      ) : (
        <ul className="mt-4 space-y-3.5">
          {cats.slice(0, 5).map(({ category, budget, actual }) => {
            const pct = budget > 0 ? (actual / budget) * 100 : 0;
            const remaining = budget - actual;
            const v = getCategoryVisual(category);
            const Icon = v.icon;
            return (
              <li key={category}>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className={`inline-grid h-6 w-6 place-items-center rounded-lg ${v.bg} ${v.fg}`}>
                    <Icon className="h-3.5 w-3.5" strokeWidth={2.2} />
                  </span>
                  <span className="text-sm font-medium text-fg">{category}</span>
                  <span className="ml-auto tabular-nums text-xs text-muted">
                    {yen(actual)} / {yen(budget)}
                  </span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-fg/10">
                  <div
                    className={`h-full rounded-full ${progressColor(pct)} transition-[width] duration-500`}
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </div>
                <div className="mt-1 text-right text-xs">
                  <span className={remaining >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                    {remaining >= 0 ? `残 ${yen(remaining)}` : `超 ${yen(Math.abs(remaining))}`}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </GlassCard>
  );
}

/* ------------------------------- Page ----------------------------------- */
export default function Dashboard() {
  const { user, loading: authLoading } = useLineAuth();
  const [currentDate, setCurrentDate] = useState(dayjs());
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>({ mode: 'monthly' });
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [firebaseError, setFirebaseError] = useState(false);

  const { config: budgetConfig, loading: budgetLoading, error: budgetError, refetch: refetchBudget } =
    useBudgetConfig(user?.uid || null);

  const sampleStats = useMemo(() => getSampleStats(), []);

  useEffect(() => {
    if (typeof window !== 'undefined' && !db) setFirebaseError(true);
  }, []);

  useEffect(() => {
    const load = async () => {
      if (!user?.uid) {
        setSettingsLoading(false);
        return;
      }
      try {
        setSettingsLoading(true);
        setDateSettings(await getDateRangeSettings(user.uid));
      } catch (e) {
        console.error('Failed to load date settings:', e);
        setDateSettings({ mode: 'monthly' });
      } finally {
        setSettingsLoading(false);
      }
    };
    load();
  }, [user?.uid]);

  const effectiveRange = getEffectiveDateRange(currentDate, dateSettings);
  const { stats, loading: statsLoading } = useMonthlyStats(
    user?.uid || null,
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
    user?.uid || null,
    prevDate.year(),
    prevDate.month() + 1,
    dateSettings.customStartDay || 1,
    prevRange.startDate,
    prevRange.endDate,
  );

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

  const isGuest = user?.uid === 'guest' || user?.isAnonymous === true;
  const displayStats = isGuest ? sampleStats : stats;

  const totalExpense = displayStats?.totalAmount || 0;
  const expenseCount = displayStats?.expenseCount || 0;
  const days = dayjs(effectiveRange.endDate).diff(dayjs(effectiveRange.startDate), 'day') + 1;
  const dailyAverage = totalExpense > 0 ? Math.round(totalExpense / days) : 0;

  // --- 判断インサイト（予算・前月比・残ペース） ---
  const monthlyBudget = budgetConfig?.monthlyBudget || 0;
  const budgetPct = monthlyBudget > 0 ? Math.round((totalExpense / monthlyBudget) * 100) : null;
  const budgetRemaining = monthlyBudget > 0 ? monthlyBudget - totalExpense : null;

  // この期間の残り日数（今日が期間内なら今日〜終了日、過ぎていれば0扱い）
  const today = dayjs();
  const endD = dayjs(effectiveRange.endDate);
  const daysLeft = endD.isBefore(today, 'day')
    ? 0
    : endD.diff(today.isBefore(dayjs(effectiveRange.startDate)) ? dayjs(effectiveRange.startDate) : today, 'day') + 1;
  const perDayAvailable =
    monthlyBudget > 0 && budgetRemaining !== null && budgetRemaining > 0 && daysLeft > 0
      ? Math.floor(budgetRemaining / daysLeft)
      : null;

  const prevTotal = isGuest ? 0 : prevStats?.totalAmount || 0;
  // 固定のカスタム期間では getEffectiveDateRange が prevDate を無視し、前期間が
  // 現在と同一になる（＝自分自身と比較して常に0%）。その場合は前月比を出さない。
  const momPct =
    dateSettings.mode !== 'custom' && prevTotal > 0
      ? Math.round(((totalExpense - prevTotal) / prevTotal) * 100)
      : null;

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
