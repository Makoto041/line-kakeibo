'use client';

// 予算シート（ホームの「予算残り」から開く）。刷新前のホームにあった分析をここにまとめる（計算式は同じ）。
// 今月の支出・支出回数・1日平均、予算進捗・残り/超過・あと使える/日・残り日数・前月比、
// 月間予算のペースと理想の進み具合、カテゴリ別予算、カテゴリ別支出の円グラフ、日別の推移。
// 前の期間の集計はこのシートを開いたときだけ取りにいく。
import dayjs from 'dayjs';
import { RotateCw, TrendingDown, TrendingUp } from 'lucide-react';
import type { BudgetConfig, ExpenseStats } from '@/lib/hooks';
import { useMonthlyStats } from '@/lib/hooks';
import { getEffectiveDateRange, type DateRangeSettings } from '@/lib/dateSettings';
import {
  buildCategoryBudgetRows,
  calculatePace,
  computePeriodInsights,
  idealProgress,
  type Pace,
} from '@/lib/budgetAnalytics';
import { getCategoryVisual } from '@/lib/categoryVisuals';
import { yen } from '@/lib/money';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import { Sheet } from '@/components/ui/Sheet';
import { IconButton } from '@/components/ui/IconButton';
import { SheetSection } from '@/components/ui/Rows';
import { Skeleton, SkeletonGroup } from '@/components/ui/Skeleton';
import { CategoryPieChart, DailyLineChart } from '@/components/Charts';

interface BudgetSheetProps {
  open: boolean;
  onClose: () => void;
  /** 前の期間を取るときの利用者（ゲストは null） */
  lineId: string | null;
  stats: ExpenseStats | null;
  budgetConfig: BudgetConfig | null;
  budgetLoading: boolean;
  budgetError: boolean;
  onRetryBudget: () => void;
  currentDate: dayjs.Dayjs;
  dateSettings: DateRangeSettings;
  range: { startDate: string; endDate: string };
}

const PACE_LABEL: Record<Pace, string> = {
  good: T.budget.paceGood,
  warning: T.budget.paceWarning,
  danger: T.budget.paceDanger,
  unset: T.budget.paceUnset,
};

const PACE_BADGE: Record<Pace, string> = {
  good: 'bg-ok-bg text-ok-ink',
  unset: 'bg-ok-bg text-ok-ink',
  warning: 'bg-warn-bg text-warn-ink',
  danger: 'bg-danger/12 text-danger-ink',
};

export function BudgetSheet({
  open,
  onClose,
  lineId,
  stats,
  budgetConfig,
  budgetLoading,
  budgetError,
  onRetryBudget,
  currentDate,
  dateSettings,
  range,
}: BudgetSheetProps) {
  // 前の期間（前月比）。シートを開いている間だけ取る
  const prevDate = currentDate.subtract(1, 'month');
  const prevRange = getEffectiveDateRange(prevDate, dateSettings);
  const { stats: prevStats } = useMonthlyStats(
    open ? lineId : null,
    prevDate.year(),
    prevDate.month() + 1,
    dateSettings.customStartDay || 1,
    prevRange.startDate,
    prevRange.endDate
  );

  const insights = computePeriodInsights({
    stats,
    prevStats: lineId ? prevStats : null,
    monthlyBudget: budgetConfig?.monthlyBudget,
    range,
    mode: dateSettings.mode,
  });
  const hasSpending = !!stats && stats.totalAmount > 0;

  return (
    <Sheet open={open} onClose={onClose} title={T.budget.title}>
      <div className="grid grid-cols-3 gap-2.5 pt-1">
        <Tile label={T.budget.spent} value={yen(insights.totalExpense)} />
        <Tile label={T.budget.count} value={T.budget.countValue(insights.expenseCount)} />
        <Tile label={T.budget.dailyAverage} value={yen(insights.dailyAverage)} />
      </div>

      {(insights.budgetPct !== null || insights.momPct !== null) && (
        <dl className="mt-4">
          {insights.budgetPct !== null && insights.budgetRemaining !== null && (
            <StatRow
              label={T.budget.progress}
              value={`${insights.budgetPct}%`}
              note={
                insights.budgetRemaining >= 0
                  ? `${T.budget.remaining} ${yen(insights.budgetRemaining)}`
                  : `${T.budget.over} ${yen(-insights.budgetRemaining)}`
              }
              noteTone={insights.budgetRemaining >= 0 ? 'ok' : 'danger'}
            />
          )}
          {insights.perDayAvailable !== null && (
            <StatRow
              label={T.budget.perDay}
              value={yen(insights.perDayAvailable)}
              note={T.budget.daysLeft(insights.daysLeft)}
            />
          )}
          {insights.momPct !== null && (
            <StatRow
              label={T.budget.mom}
              value={`${insights.momPct > 0 ? '+' : ''}${insights.momPct}%`}
              valueIcon={insights.momPct > 0 ? 'up' : insights.momPct < 0 ? 'down' : null}
              valueTone={insights.momPct > 0 ? 'danger' : insights.momPct < 0 ? 'ok' : undefined}
              note={`${T.budget.prev} ${yen(insights.prevTotal)}`}
            />
          )}
        </dl>
      )}

      {budgetLoading ? (
        <SkeletonGroup className="mt-6 space-y-3">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </SkeletonGroup>
      ) : budgetError ? (
        <div className="mt-6 flex justify-center">
          <IconButton label={T.aria.retry} icon={RotateCw} onClick={onRetryBudget} />
        </div>
      ) : (
        budgetConfig && <BudgetProgress stats={stats} budgetConfig={budgetConfig} />
      )}

      {hasSpending && stats && (
        <>
          <SheetSection title={T.budget.byCategory} className="!mt-6">
            <CategoryPieChart data={stats.categoryTotals} />
          </SheetSection>
          <SheetSection title={T.budget.daily} className="!mt-6">
            <DailyLineChart
              data={stats.dailyTotals}
              startDate={range.startDate}
              endDate={range.endDate}
              mode={dateSettings.mode}
            />
          </SheetSection>
        </>
      )}
      <div className="h-2" />
    </Sheet>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="kb-glass-2 min-w-0 rounded-2xl px-3 py-3">
      <p className="truncate text-[12px] font-medium text-ink-3">{label}</p>
      <p className="mt-0.5 truncate text-[16px] font-bold tabular-nums text-ink">{value}</p>
    </div>
  );
}

type Tone = 'ok' | 'danger';
const TONE: Record<Tone, string> = { ok: 'text-ok-ink', danger: 'text-danger-ink' };

function StatRow({
  label,
  value,
  note,
  noteTone,
  valueTone,
  valueIcon,
}: {
  label: string;
  value: string;
  note?: string;
  noteTone?: Tone;
  valueTone?: Tone;
  valueIcon?: 'up' | 'down' | null;
}) {
  const Icon = valueIcon === 'up' ? TrendingUp : valueIcon === 'down' ? TrendingDown : null;
  return (
    <div className="flex min-h-12 items-center gap-3 border-b border-divider px-1 last:border-b-0">
      <dt className="min-w-0 flex-1 truncate text-[14px] text-ink-2">{label}</dt>
      <dd className="shrink-0 text-right">
        <span className={cx('inline-flex items-center gap-1 text-[16px] font-bold tabular-nums', valueTone ? TONE[valueTone] : 'text-ink')}>
          {Icon && <Icon size={16} strokeWidth={2.2} aria-hidden="true" />}
          {value}
        </span>
        {note && <span className={cx('block text-[12px]', noteTone ? TONE[noteTone] : 'text-ink-4')}>{note}</span>}
      </dd>
    </div>
  );
}

function barFill(pct: number): string {
  // 刷新前と同じ段階（80% まで / 100% まで / 超過）を青系の配色で
  if (pct <= 80) return 'var(--kb-bar-grad)';
  if (pct <= 100) return 'linear-gradient(90deg, #fbbf24, #f59e0b)';
  return 'var(--kb-danger-grad)';
}

function BudgetProgress({ stats, budgetConfig }: { stats: ExpenseStats | null; budgetConfig: BudgetConfig }) {
  const categoryTotals = stats?.categoryTotals || {};
  const { categoryBudgets, monthlyBudget } = budgetConfig;
  const rows = buildCategoryBudgetRows(categoryTotals, categoryBudgets || {});

  const totalActual = stats?.totalAmount || 0;
  const totalPct = monthlyBudget > 0 ? (totalActual / monthlyBudget) * 100 : 0;
  const totalRemaining = monthlyBudget - totalActual;
  const pace = calculatePace(totalActual, monthlyBudget);
  const ideal = idealProgress();

  return (
    <>
      <SheetSection
        title={T.budget.monthly}
        aside={<span className={cx('rounded-full px-2.5 py-0.5 text-[12px] font-semibold', PACE_BADGE[pace])}>{PACE_LABEL[pace]}</span>}
        className="!mt-6"
      >
        <div className="px-1">
          <div className="relative h-3 overflow-hidden rounded-full bg-[var(--kb-bar-track)]">
            <div
              aria-hidden="true"
              className="absolute inset-y-0 z-10 w-px bg-ink-2/70"
              style={{ left: `${Math.min(ideal, 100)}%` }}
            />
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${Math.min(totalPct, 100)}%`, background: barFill(totalPct) }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-[13px]">
            <span className="text-ink-3">
              {yen(totalActual)} / {yen(monthlyBudget)}
            </span>
            <span className={cx('font-semibold', totalRemaining >= 0 ? 'text-ok-ink' : 'text-danger-ink')}>
              {totalRemaining >= 0
                ? `${T.budget.remaining} ${yen(totalRemaining)}`
                : `${T.budget.over} ${yen(Math.abs(totalRemaining))}`}
            </span>
          </div>
        </div>
      </SheetSection>

      {rows.length > 0 && (
        <SheetSection title={T.budget.categories} className="!mt-6">
          <ul>
            {rows.map(({ category, budget, actual }) => {
              const hasBudget = budget > 0;
              const pct = hasBudget ? (actual / budget) * 100 : 0;
              const remaining = budget - actual;
              const Icon = getCategoryVisual(category).icon;
              return (
                <li key={category} className="border-b border-divider px-1 py-3 last:border-b-0">
                  <div className="flex items-center gap-2.5">
                    <Icon size={18} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-ink" />
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{category}</span>
                    <span className="shrink-0 text-[12px] tabular-nums text-ink-3">
                      {hasBudget ? `${yen(actual)} / ${yen(budget)}` : yen(actual)}
                    </span>
                  </div>
                  {hasBudget ? (
                    <>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--kb-bar-track)]">
                        <div
                          className="h-full rounded-full transition-[width] duration-500"
                          style={{ width: `${Math.min(pct, 100)}%`, background: barFill(pct) }}
                        />
                      </div>
                      <p className={cx('mt-1 text-right text-[12px]', remaining >= 0 ? 'text-ok-ink' : 'text-danger-ink')}>
                        {remaining >= 0
                          ? `${T.budget.catRemaining} ${yen(remaining)}`
                          : `${T.budget.catOver} ${yen(Math.abs(remaining))}`}
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-right text-[12px] text-ink-4">{T.budget.catUnset}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </SheetSection>
      )}
    </>
  );
}
