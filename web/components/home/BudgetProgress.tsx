import { Wallet } from 'lucide-react';
import type { BudgetConfig, ExpenseStats } from '../../lib/hooks';
import { getCategoryVisual } from '../../lib/categoryVisuals';
import { yen } from '../../lib/money';
import {
  buildCategoryBudgetRows,
  calculatePace,
  idealProgress as calcIdealProgress,
  type Pace,
} from '../../lib/budgetAnalytics';
import { GlassCard } from './GlassCard';

const PACE_LABEL: Record<Pace, string> = {
  good: '順調',
  warning: 'やや超過',
  danger: '超過',
  unset: '未設定',
};

function progressColor(pct: number): string {
  if (pct <= 80) return 'bg-emerald-500';
  if (pct <= 100) return 'bg-amber-500';
  return 'bg-rose-500';
}

function paceBadge(pace: Pace): string {
  if (pace === 'good' || pace === 'unset') return 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400';
  if (pace === 'warning') return 'bg-amber-500/12 text-amber-600 dark:text-amber-400';
  return 'bg-rose-500/12 text-rose-600 dark:text-rose-400';
}

export function BudgetProgress({ stats, budgetConfig }: { stats: ExpenseStats | null; budgetConfig: BudgetConfig | null }) {
  if (!budgetConfig) return null;
  const categoryTotals = stats?.categoryTotals || {};
  const { categoryBudgets, monthlyBudget } = budgetConfig;

  // 予算>0 のカテゴリに加え、実支出があるカテゴリも表示する（予算0でも記録があれば出す）。
  // 予算ありを使用率の高い順に上へ、予算なし(0)は実支出の多い順で下へ
  const cats = buildCategoryBudgetRows(categoryTotals, categoryBudgets);

  const totalActual = stats?.totalAmount || 0;
  const totalPct = monthlyBudget > 0 ? (totalActual / monthlyBudget) * 100 : 0;
  const totalRemaining = monthlyBudget - totalActual;
  const totalPace = calculatePace(totalActual, monthlyBudget);
  const idealProgress = calcIdealProgress();

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
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${paceBadge(totalPace)}`}>
            {PACE_LABEL[totalPace]}
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
        <p className="py-6 text-center text-sm text-muted">記録がまだありません</p>
      ) : (
        <ul className="mt-4 space-y-3.5">
          {cats.map(({ category, budget, actual }) => {
            const hasBudget = budget > 0;
            const pct = hasBudget ? (actual / budget) * 100 : 0;
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
                    {hasBudget ? `${yen(actual)} / ${yen(budget)}` : yen(actual)}
                  </span>
                </div>
                {hasBudget ? (
                  <>
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
                  </>
                ) : (
                  <div className="mt-1 text-right text-[11px] text-muted">予算未設定</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </GlassCard>
  );
}
