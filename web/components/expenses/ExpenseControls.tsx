"use client";

import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { ExpenseSummary, Segment, SortKey } from "../../lib/expenseState";
import ExpenseTotals from "./ExpenseTotals";

interface Props {
  segment: Segment;
  onSegmentChange: (segment: Segment) => void;
  pendingCount: number;
  query: string;
  onQueryChange: (query: string) => void;
  periodTitle: string;
  onPrevPeriod: () => void;
  onNextPeriod: () => void;
  /** 期間内に支出があるか（フィルター・並び順・合計はあるときだけ出す） */
  hasExpenses: boolean;
  /** "all" / "included" / "excluded" / カテゴリ名 */
  filter: string;
  onFilterChange: (filter: string) => void;
  categories: string[];
  sortBy: SortKey;
  onSortChange: (sortBy: SortKey) => void;
  summary: ExpenseSummary;
}

/**
 * 明細の操作カード: 状態で絞り込み・検索・期間の移動・フィルター・並び順・合計。
 * 期間の移動は支出が無い期間でも常に出し（他の月へ移れるように）、フィルター・並び順・合計は支出があるときだけ出す。
 */
export default function ExpenseControls({
  segment,
  onSegmentChange,
  pendingCount,
  query,
  onQueryChange,
  periodTitle,
  onPrevPeriod,
  onNextPeriod,
  hasExpenses,
  filter,
  onFilterChange,
  categories,
  sortBy,
  onSortChange,
  summary,
}: Props) {
  return (
    <div className="glass mb-4 rounded-2xl p-4 shadow-glass">
      {/* 状態で絞り込み（すべて / 要確認 / 立替）と検索 */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div role="group" aria-label="状態で絞り込み" className="flex gap-1 rounded-xl bg-fg/[0.04] p-1">
          {([
            { key: "all", label: "すべて" },
            { key: "pending", label: "要確認" },
            { key: "advance", label: "立替" },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={segment === key}
              onClick={() => onSegmentChange(key)}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors sm:flex-none ${
                segment === key ? "bg-accent text-accent-fg shadow-sm" : "text-muted hover:bg-fg/5 hover:text-fg"
              }`}
            >
              {label}
              {key === "pending" && pendingCount > 0 && (
                <span
                  className={`rounded-full px-1.5 text-xs tabular-nums ${
                    segment === key ? "bg-white/25" : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  }`}
                >
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="内容・カテゴリで検索"
            aria-label="検索"
            className="w-full rounded-lg border border-line bg-card py-2 pl-9 pr-3 text-base text-fg focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Period navigation (always) */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onPrevPeriod}
            className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-card text-muted transition-colors hover:bg-fg/5 hover:text-fg"
            aria-label="前の期間"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="whitespace-nowrap rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-fg">
            {periodTitle}
          </div>
          <button
            onClick={onNextPeriod}
            className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-card text-muted transition-colors hover:bg-fg/5 hover:text-fg"
            aria-label="次の期間"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* Filter & sort (only with data) */}
        {hasExpenses && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filter}
              onChange={(e) => onFilterChange(e.target.value)}
              aria-label="フィルター"
              className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-fg focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">すべて</option>
              <option value="included">合計に含む</option>
              <option value="excluded">合計から除外</option>
              {categories.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
            <select
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value as SortKey)}
              aria-label="並び順"
              className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-fg focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="date">日付順</option>
              <option value="amount">金額順</option>
            </select>
          </div>
        )}
      </div>

      {/* Totals (only with data) */}
      {hasExpenses && <ExpenseTotals summary={summary} />}
    </div>
  );
}
