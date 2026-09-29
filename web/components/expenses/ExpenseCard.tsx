"use client";

import dayjs from "dayjs";
import {
  ChevronRight,
  Pencil,
  Trash2,
  Check,
  Ban,
  Paperclip,
  CreditCard,
  Smartphone,
  CircleCheck,
  Clock,
  Loader2,
} from "lucide-react";
import type { Expense } from "../../lib/hooks";
import {
  isPending,
  splitChip,
  canClientWrite,
  canClientDelete,
  canServerConfirm,
  isCardSource,
} from "../../lib/expenseState";
import { getCategoryVisual } from "../../lib/categoryVisuals";
import { toSafeImageUrl } from "../../lib/imageUrl";
import { yen } from "../../lib/money";

interface Props {
  expense: Expense;
  /** 編集ドロワーで開いている */
  editing: boolean;
  /** 支払い者名（resolvePayerName で解決済み。合計の集計と同じ名前） */
  payerName: string;
  lineId: string | null;
  isGuest: boolean;
  apiAvailable: boolean;
  activeGroupIds: readonly string[] | null;
  /** 確認の送信中 */
  confirming: boolean;
  onConfirm: () => void;
  onToggleInclude: () => void;
  onEdit: () => void;
  /** https / blob に正規化したレシート画像の URL */
  onPreviewReceipt: (url: string) => void;
  onDelete: () => void;
}

/** 明細の 1 件（表示のみ。編集は EditDrawer で行う） */
export default function ExpenseCard({
  expense,
  editing,
  payerName,
  lineId,
  isGuest,
  apiAvailable,
  activeGroupIds,
  confirming,
  onConfirm,
  onToggleInclude,
  onEdit,
  onPreviewReceipt,
  onDelete,
}: Props) {
  return (
    <div
      id={`expense-${expense.id}`}
      className={`glass overflow-hidden rounded-2xl border-l-4 shadow-glass transition-shadow hover:shadow-glass-lg ${
        !expense.includeInTotal ? "border-l-amber-400" : "border-l-accent"
      } ${editing ? "ring-2 ring-ring" : ""}`}
    >
      <div className="p-4 sm:p-5">
        {/* Display mode (editing happens in the drawer below) */}
        <div className="space-y-4">
          {/* Header with title and amount */}
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="mb-1 break-words text-base font-semibold text-fg">
                {expense.description}
              </h3>
              <p className="text-sm text-muted">
                {dayjs(expense.date).format("YYYY年M月D日 (ddd)")}
              </p>
            </div>

            <div className="shrink-0">
              <p className="text-right text-xl font-bold tabular-nums text-fg sm:text-2xl">
                {yen(expense.amount)}
              </p>
            </div>
          </div>

          {/* Tags */}
          <div className="flex flex-wrap items-center gap-2">
            {(() => {
              const v = getCategoryVisual(expense.category);
              const Icon = v.icon;
              return (
                <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${v.bg} ${v.fg}`}>
                  <Icon className="h-3 w-3" strokeWidth={2.2} />
                  {expense.category}
                </span>
              );
            })()}
            {expense.userDisplayName &&
              expense.userDisplayName !== "個人" && (
                <span className="rounded-md bg-fg/5 px-2 py-0.5 text-xs font-medium text-muted">
                  入力: {expense.userDisplayName}
                </span>
              )}
            {(() => {
              // 支払い者の名前は共通ルールで解決済み（金額/件数集計と一致させる）
              const isDefaultPayer = !expense.payerId || expense.payerId === expense.lineId;

              return payerName !== "個人" && (
                <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
                  isCardSource(expense)
                    ? "bg-sky-500/12 text-sky-600 dark:text-sky-400"
                    : isDefaultPayer
                    ? "bg-fg/5 text-muted"
                    : "bg-violet-500/12 text-violet-600 dark:text-violet-400"
                }`}>
                  <CreditCard className="h-3 w-3" />
                  {payerName}
                </span>
              );
            })()}
            {isPending(expense) && (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                <Clock className="h-3 w-3" />
                要確認
              </span>
            )}
            {(() => {
              const chip = splitChip(expense);
              const label = { shared: "共同費", personal: "個人", advance: "立替", settled: "精算済み" }[chip];
              const tone = {
                shared: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
                personal: "bg-fg/5 text-muted",
                advance: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
                settled: "bg-fg/5 text-muted",
              }[chip];
              // 要確認のうちは区分がまだ決まっていないので出さない
              return isPending(expense) ? null : (
                <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
              );
            })()}
            {expense.inputSource === 'recurring' && (
              <span className="rounded-md bg-fg/5 px-2 py-0.5 text-xs font-medium text-muted">固定費</span>
            )}
            {expense.lineGroupId && (
              <span className="inline-flex items-center gap-1 rounded-md bg-sky-500/12 px-2 py-0.5 text-xs font-medium text-sky-600 dark:text-sky-400">
                <Smartphone className="h-3 w-3" />
                グループ
              </span>
            )}
            {!expense.includeInTotal && (
              <span className="rounded-md bg-rose-500/12 px-2 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-400">
                合計から除外
              </span>
            )}
            {expense.receiptUrl && (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/12 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                <Paperclip className="h-3 w-3" />
                レシートあり
              </span>
            )}
          </div>

          {/* Items details */}
          {expense.items && expense.items.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-accent">
                <ChevronRight className="h-4 w-4 transition-transform duration-200 group-open:rotate-90" />
                商品詳細 ({expense.items.length}点)
              </summary>
              <div className="mt-3 rounded-lg bg-fg/[0.03] p-3">
                <ul className="space-y-2">
                  {expense.items.map((item, index) => (
                    <li
                      key={index}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="mr-2 min-w-0 flex-1 break-words text-muted">
                        {item.name}
                      </span>
                      <span className="shrink-0 font-medium tabular-nums text-fg">
                        {yen(item.price)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}

          {/* Action buttons */}
          <div
            className="flex flex-wrap gap-2 border-t border-line pt-3"
            style={{ position: "relative", zIndex: 10 }}
          >
            {/* 要確認の支出を確認（LINE の OK と同じ。サーバー経由） */}
            {isPending(expense) && !isGuest && apiAvailable && canServerConfirm(expense, lineId, activeGroupIds) && (
              <button
                type="button"
                disabled={confirming}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onConfirm();
                }}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg shadow-sm transition-colors hover:opacity-90 disabled:opacity-60"
                style={{ pointerEvents: "auto" }}
              >
                {confirming ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CircleCheck className="h-4 w-4" />
                )}
                確認
              </button>
            )}

            {/* 合計に含める/除外する切り替えボタン */}
            {canClientWrite(expense, lineId, activeGroupIds) && (<>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleInclude();
              }}
              className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                expense.includeInTotal
                  ? "bg-accent/12 text-accent hover:bg-accent/20"
                  : "bg-fg/5 text-muted hover:bg-fg/10"
              }`}
              style={{ pointerEvents: "auto" }}
            >
              {expense.includeInTotal ? <Check className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
              {expense.includeInTotal ? "合計に含む" : "合計から除外"}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onEdit();
              }}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-fg/5"
              style={{ pointerEvents: "auto" }}
            >
              <Pencil className="h-4 w-4" />
              編集
            </button>
            </>)}

            {/* レシート: 編集の隣に並べて発見しやすく。新規タブではなくアプリ内でプレビュー */}
            {expense.receiptUrl ? (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  // URLを正規化し https/blob のみ採用（XSS対策・CodeQLサニタイズ）
                  const safe = toSafeImageUrl(expense.receiptUrl);
                  if (safe) onPreviewReceipt(safe);
                }}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-amber-500/12 px-3 py-2 text-sm font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
                style={{ pointerEvents: "auto" }}
                title="レシートを表示"
              >
                <Paperclip className="h-4 w-4" />
                レシート
              </button>
            ) : (
              <a
                href={`/attach?expenseId=${encodeURIComponent(expense.id)}`}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-fg/5"
                title="レシートを添付"
              >
                <Paperclip className="h-4 w-4" />
                レシート添付
              </a>
            )}

            {canClientDelete(expense, lineId, activeGroupIds) && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete();
              }}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-rose-600 transition-colors hover:bg-rose-500/10 dark:text-rose-400"
              style={{ pointerEvents: "auto" }}
            >
              <Trash2 className="h-4 w-4" />
              削除
            </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
