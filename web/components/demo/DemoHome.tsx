'use client';

// デモのホーム。本番のホーム（app/(app)/page.tsx）と同じ部品を、架空データ（lib/demo/demoData.ts）で描く。
// 集計は本番と同じ純関数（toDrillItems・computePeriodInsights など）で出す。内訳シートから一覧・編集へのリンクは出さない。
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  LineChart as LineChartIcon,
  Receipt,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { countPending, isPending, resolvePayerName } from '../../lib/expenseState';
import { collectHistoricalUsers } from '../../lib/expenseEdit';
import { toDrillItems } from '../../lib/drilldown';
import { subCategoriesOf } from '../../lib/categoryTaxonomy';
import { normalizeCategoryName } from '../../lib/categoryNormalization';
import { computePeriodInsights } from '../../lib/budgetAnalytics';
import { yen } from '../../lib/money';
import DrillSheet, { type DrillView } from '../drilldown/DrillSheet';
import { CategoryBreakdownCard } from '../home/CategoryBreakdownCard';
import { GlassCard } from '../home/GlassCard';
import { SummaryCard } from '../home/SummaryCard';
import { BudgetProgress } from '../home/BudgetProgress';
import { DailyLineChart } from '../Charts';
import {
  DEMO_BUDGET,
  DEMO_DEFAULT_MONTH_INDEX,
  DEMO_EXPENSES,
  DEMO_MONTHS,
  DEMO_NOW,
  DEMO_TODAY,
  demoStats,
  inDemoRange,
} from '../../lib/demo/demoData';

const USERS = collectHistoricalUsers(DEMO_EXPENSES);

export default function DemoHome() {
  const [monthIndex, setMonthIndex] = useState(DEMO_DEFAULT_MONTH_INDEX);
  const month = DEMO_MONTHS[monthIndex];
  const prevMonth = monthIndex > 0 ? DEMO_MONTHS[monthIndex - 1] : null;
  const range = month.range;

  const stats = useMemo(() => demoStats(DEMO_EXPENSES, range), [range]);
  // 前の月のデータが無い最初の月は、前月比・前期比を出さない
  const prevStats = useMemo(() => (prevMonth ? demoStats(DEMO_EXPENSES, prevMonth.range) : null), [prevMonth]);
  const prevCategoryTotals = useMemo(() => {
    if (!prevStats) return null;
    const totals: Record<string, number> = {};
    for (const [category, amount] of Object.entries(prevStats.categoryTotals)) {
      const key = normalizeCategoryName(category);
      totals[key] = (totals[key] ?? 0) + amount;
    }
    return totals;
  }, [prevStats]);

  const pendingCount = useMemo(() => countPending(DEMO_EXPENSES.filter((e) => inDemoRange(e, range))), [range]);
  const drillItems = useMemo(
    () =>
      toDrillItems(DEMO_EXPENSES, {
        range,
        included: (e) => !!e.includeInTotal,
        payer: (e) => {
          const name = resolvePayerName(e, USERS);
          return { key: name, name };
        },
        pending: isPending,
        subCategoriesOf,
      }),
    [range]
  );
  const [drill, setDrill] = useState<DrillView[] | null>(null);
  const closeDrill = useCallback(() => setDrill(null), []);

  const { totalExpense, expenseCount, dailyAverage, budgetPct, budgetRemaining, daysLeft, perDayAvailable, momPct, prevTotal } =
    computePeriodInsights({
      stats,
      prevStats,
      monthlyBudget: DEMO_BUDGET.monthlyBudget,
      range,
      mode: 'monthly',
      now: DEMO_NOW,
    });
  // 予算のペースは、過ぎた月ならその月の末日で測る（デモの「今日」で測ると、暦月の経過が別の月になる）
  const budgetNow = range.endDate < DEMO_TODAY ? new Date(`${range.endDate}T12:00:00`) : DEMO_NOW;

  return (
    <div>
      {/* 期間の切り替え（デモのデータがある月だけ） */}
      <GlassCard className="animate-fade-up p-2.5">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setMonthIndex((i) => Math.max(0, i - 1))}
            disabled={!prevMonth}
            aria-label="前の期間"
            className="grid h-10 w-10 place-items-center rounded-xl text-muted transition-colors hover:bg-fg/5 hover:text-fg disabled:opacity-30"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="text-base font-semibold tracking-tight text-fg">{month.title}</h1>
          <button
            type="button"
            onClick={() => setMonthIndex((i) => Math.min(DEMO_MONTHS.length - 1, i + 1))}
            disabled={monthIndex >= DEMO_MONTHS.length - 1}
            aria-label="次の期間"
            className="grid h-10 w-10 place-items-center rounded-xl text-muted transition-colors hover:bg-fg/5 hover:text-fg disabled:opacity-30"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </GlassCard>

      {pendingCount > 0 && (
        <Link
          href="/demo/expenses/?filter=pending"
          className="mt-4 flex items-center gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-amber-800 transition-colors hover:bg-amber-500/15 dark:text-amber-200"
        >
          <Clock className="h-5 w-5 shrink-0" />
          <span className="flex-1 text-sm font-semibold">要確認の支出が {pendingCount}件 あります</span>
          <span className="text-xs font-medium">確認する</span>
          <ChevronRight className="h-4 w-4 shrink-0" />
        </Link>
      )}

      <div className="mt-4 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <SummaryCard label="今月の支出" value={yen(totalExpense)} Icon={Wallet} tone="bg-accent/12 text-accent" />
          <SummaryCard label="支出回数" value={`${expenseCount}回`} Icon={Receipt} tone="bg-sky-500/12 text-sky-600 dark:text-sky-400" />
          <SummaryCard label="1日平均" value={yen(dailyAverage)} Icon={TrendingUp} tone="bg-violet-500/12 text-violet-600 dark:text-violet-400" />
        </div>

        {(budgetPct !== null || momPct !== null) && (
          <GlassCard className="p-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              {budgetPct !== null && budgetRemaining !== null && (
                <div>
                  <p className="text-[11px] font-medium text-muted">予算進捗</p>
                  <p className="mt-0.5 text-lg font-bold tabular-nums text-fg">{budgetPct}%</p>
                  <p className={`text-xs tabular-nums ${budgetRemaining >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                    {budgetRemaining >= 0 ? `残り ${yen(budgetRemaining)}` : `超過 ${yen(-budgetRemaining)}`}
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
                  <p
                    className={`mt-0.5 inline-flex items-center gap-1 text-lg font-bold tabular-nums ${
                      momPct > 0 ? 'text-rose-600 dark:text-rose-400' : momPct < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-fg'
                    }`}
                  >
                    {momPct > 0 ? <TrendingUp className="h-4 w-4" /> : momPct < 0 ? <TrendingDown className="h-4 w-4" /> : null}
                    {momPct > 0 ? '+' : ''}
                    {momPct}%
                  </p>
                  <p className="text-xs tabular-nums text-muted">前月 {yen(prevTotal)}</p>
                </div>
              )}
            </div>
          </GlassCard>
        )}

        {/* 本番と同じ並び: モバイルは予算が上、デスクトップは右の列 */}
        <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
          <div className="lg:sticky lg:top-40lg:col-span-1 lg:col-start-3 lg:row-start-1">
            <BudgetProgress stats={stats} budgetConfig={DEMO_BUDGET} now={budgetNow} />
          </div>
          <div className="space-y-4 lg:col-span-2 lg:col-start-1 lg:row-start-1">
            <CategoryBreakdownCard items={drillItems} prevCategoryTotals={prevCategoryTotals} loading={false} onOpen={setDrill} />
            <GlassCard className="p-5">
              <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-fg">
                <LineChartIcon className="h-[18px] w-[18px] text-accent" strokeWidth={2.2} />
                日別の推移
              </h2>
              <DailyLineChart data={stats.dailyTotals} startDate={range.startDate} endDate={range.endDate} mode="monthly" />
            </GlassCard>
          </div>
        </div>
      </div>

      {drill && (
        <DrillSheet initial={drill} items={drillItems} range={range} prevCategoryTotals={prevCategoryTotals} onClose={closeDrill} />
      )}
    </div>
  );
}
