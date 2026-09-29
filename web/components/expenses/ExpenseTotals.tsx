import { Wallet } from "lucide-react";
import type { ExpenseSummary } from "../../lib/expenseState";
import { yen } from "../../lib/money";

/** 支払い者別の合計と、合計カード（承認済みの項目のみ合計に含める） */
export default function ExpenseTotals({ summary }: { summary: ExpenseSummary }) {
  return (
    <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-stretch">
      {summary.payers.length > 0 && (
        <div className="grid flex-1 grid-cols-3 gap-3 lg:grid-cols-4">
          {summary.payers.map(({ name: personName, total, count }) => (
            <div key={personName} className="rounded-xl border border-line bg-fg/[0.02] p-3">
              <div className="text-center">
                <div className="mb-1 truncate text-sm font-medium text-fg">{personName}</div>
                <div className="text-lg font-bold tabular-nums text-accent">{yen(total)}</div>
                <div className="text-xs text-muted">
                  {count}
                  件
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-accent/20 bg-accent/[0.06] p-4 sm:w-48">
        <div className="text-center">
          <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-medium text-muted">
            <Wallet className="h-3.5 w-3.5" />
            合計
          </div>
          <div className="text-sm font-semibold text-fg">{summary.count}件</div>
          <div className="my-1 text-2xl font-black tabular-nums text-fg">
            {yen(summary.total)}
          </div>
          <div className="text-xs text-muted">合計総支出額</div>
          {summary.excludedCount > 0 && (
            <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              除外: {summary.excludedCount}件
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
