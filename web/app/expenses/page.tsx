"use client";

// 明細。期間は 3 タブ共通（月ピル → 期間シート）、検索・絞り込み・並び・集計は検索シート、
// 1 件の詳細・予算に含める・確認・編集・削除・レシートは詳細／編集シートにまとめる。
// LINE の「修正」リンク（?edit=<id>&lineId=<uid>）は認証の確定を待ってから、その支出の期間へ移って編集シートを開く。
import React, { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  ChevronRight,
  CreditCard,
  Ellipsis,
  Inbox,
  MessageCircle,
  Send,
  ListChecks,
  Link2 as LinkIcon,
  Paperclip,
  Pencil,
  RotateCw,
  Search,
  Smartphone,
} from "lucide-react";
import { useLineAuth, useExpenses, useHousehold } from "../../lib/hooks";
import type { Expense } from "../../lib/hooks";
import PreviewModeBanner from "../../components/PreviewModeBanner";
import GuestGuide from "../../components/GuestGuide";
import { getCategoryVisual } from "../../lib/categoryVisuals";
import { collectHistoricalUsers, resolvePayerName } from "../../lib/expenseEdit";
import { DEFAULT_FILTER, filterExpenses, isFilterActive, sortForList, type ExpenseFilter } from "../../lib/expenseState";
import dayjs from "dayjs";
import { ScreenHeader } from "../../components/layout/ScreenHeader";
import { usePeriod } from "../../components/period/PeriodProvider";
import { IconButton } from "../../components/ui/IconButton";
import { MonthPill } from "../../components/ui/MonthPill";
import { Skeleton, SkeletonGroup } from "../../components/ui/Skeleton";
import { CommonSheets, useCommonSheet } from "../../components/sheets/CommonSheets";
import { FilterSheet } from "../../components/sheets/FilterSheet";
import { ExpenseSheets, useExpenseSheet } from "../../components/expense/ExpenseSheets";
import { useEditDeepLink } from "../../components/expense/useEditDeepLink";
import { T } from "../../lib/uiText";

// Suspense boundary for useSearchParams
export default function ExpensesPage() {
  return (
    <Suspense
      fallback={
        <>
          <ScreenHeader title={T.expenses.title} />
          <ListSkeleton />
        </>
      }
    >
      <ExpensesPageContent />
    </Suspense>
  );
}

function ListSkeleton() {
  return (
    <SkeletonGroup className="space-y-3 px-4 pt-6">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-[82px] rounded-kb-row" />
      ))}
    </SkeletonGroup>
  );
}

function ExpensesPageContent() {
  const { lineId, settled } = useLineAuth();
  const { label, range, settingsLoaded, setCurrentDate } = usePeriod();
  const isGuest = settled && !lineId;

  // edit はドキュメント ID であり、本人特定には使わない（URL の lineId は読まない）
  const searchParams = useSearchParams();
  const editExpenseId = searchParams.get("edit");

  const householdState = useHousehold(lineId);
  const { sheet: commonSheet, setSheet: setCommonSheet } = useCommonSheet();
  const { sheet: expenseSheet, setSheet: setExpenseSheet } = useExpenseSheet();
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<ExpenseFilter>(DEFAULT_FILTER);
  // シートは同時に 1 つだけ
  const closeAll = () => {
    setCommonSheet(null);
    setExpenseSheet(null);
    setFilterOpen(false);
  };

  // LINE の「修正」リンク: 読めた支出を先に持っておき（一覧に現れる前でも編集できる）、行へスクロールする
  const [deepLinkTarget, setDeepLinkTarget] = useState<Expense | null>(null);
  const pendingScrollRef = useRef<string | null>(null);
  const openFromDeepLink = useCallback(
    (target: Expense) => {
      setDeepLinkTarget(target);
      setCommonSheet(null);
      setFilterOpen(false);
      setExpenseSheet({ kind: "edit", id: target.id });
      pendingScrollRef.current = target.id;
    },
    [setCommonSheet, setExpenseSheet]
  );
  const { shouldFetch } = useEditDeepLink(editExpenseId, {
    lineId,
    settled,
    settingsLoaded,
    setCurrentDate,
    onOpen: openFromDeepLink,
  });

  // 認証と期間の設定が確定し、?edit= の期間が決まってから取得する（二重取得を防ぐ）
  const fetchUserId = settled && settingsLoaded && shouldFetch ? lineId : null;
  const {
    expenses,
    loading,
    error,
    updateExpense,
    deleteExpense,
    patchLocal,
    refetch: refetchExpenses,
  } = useExpenses(fetchUserId, 0, 500, range.startDate);

  // 対象の行が一覧に現れたらスクロールして見せる
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (!id || !expenses.some((e) => e.id === id)) return;
    pendingScrollRef.current = null;
    const timer = setTimeout(() => {
      document.getElementById(`expense-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    return () => clearTimeout(timer);
  }, [expenses]);

  const historicalUsers = useMemo(() => collectHistoricalUsers(expenses), [expenses]);
  const visible = useMemo(() => sortForList(filterExpenses(expenses, filter), filter.sortBy), [expenses, filter]);

  const header = (
    <ScreenHeader
      title={T.expenses.title}
      right={
        <>
          <IconButton
            label={T.aria.search}
            icon={Search}
            aria-haspopup="dialog"
            active={isFilterActive(filter)}
            onClick={() => {
              closeAll();
              setFilterOpen(true);
            }}
          />
          {settled && settingsLoaded ? (
            <MonthPill
              label={label}
              onClick={() => {
                closeAll();
                setCommonSheet({ kind: "period" });
              }}
            />
          ) : (
            // 期間の設定を読み終えるまでは形だけ（サーバー描画と最初の描画を揃える）
            <Skeleton className="h-12 w-[110px] rounded-full" />
          )}
        </>
      }
    />
  );

  const sheets = (
    <>
      <CommonSheets sheet={commonSheet} setSheet={setCommonSheet} household={householdState} />
      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        value={filter}
        onChange={setFilter}
        expenses={expenses}
      />
      <ExpenseSheets
        sheet={expenseSheet}
        setSheet={setExpenseSheet}
        expenses={expenses}
        fallback={deepLinkTarget}
        me={lineId}
        isGuest={!lineId}
        household={householdState.household}
        activeGroupIds={householdState.activeGroupIds}
        updateExpense={updateExpense}
        deleteExpense={deleteExpense}
        patchLocal={patchLocal}
        refetch={refetchExpenses}
      />
    </>
  );

  const waiting = !settled || !settingsLoaded || (!!lineId && (!shouldFetch || loading));
  if (waiting) {
    return (
      <>
        {header}
        {sheets}
        <ListSkeleton />
      </>
    );
  }

  return (
    <>
      {header}
      {sheets}
    <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-8 md:py-7">
      {isGuest && (
        <div className="mb-4">
          <PreviewModeBanner />
        </div>
      )}

      <main>
        {error && expenses.length === 0 ? (
          <div className="flex justify-center py-10">
            <IconButton label={T.aria.retry} icon={RotateCw} onClick={refetchExpenses} />
          </div>
        ) : visible.length === 0 ? (
          isGuest ? (
            // ゲスト（プレビュー）モード: 使い方ガイドを表示
            <div className="space-y-6">
              <div className="glass rounded-2xl p-6 text-center shadow-glass sm:p-8">
                <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-accent/12 text-accent">
                  <Inbox className="h-7 w-7" strokeWidth={1.8} />
                </span>
                <h3 className="text-lg font-semibold text-fg">
                  ここにあなたの支出が一覧表示されます
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">
                  いまはプレビューモードのためデータがありません。
                  <br className="hidden sm:block" />
                  LINEボットから届くリンクで開くと、記録した支出の確認・編集ができます。
                </p>
              </div>
              <GuestGuide />
            </div>
          ) : expenses.length === 0 ? (
            // 初回 / データ無し: 「送る → 見る」導線を主役に
            <div className="glass rounded-2xl p-6 shadow-glass sm:p-8">
              <div className="text-center">
                <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-accent/12 text-accent">
                  <MessageCircle className="h-7 w-7" strokeWidth={1.9} />
                </span>
                <h3 className="text-lg font-semibold text-fg">
                  この期間に支出はありません
                </h3>
                <p className="mt-1.5 text-sm text-muted">
                  上の矢印で他の月を確認できます。LINEに送ると、ここに支出が記録されます。
                </p>
              </div>

              <ol className="mx-auto mt-6 max-w-sm space-y-3">
                {[
                  { Icon: Send, title: "LINEで支出を送る", desc: "「500 ランチ」のように金額と内容を送るだけ。" },
                  { Icon: ListChecks, title: "「家計簿」と送る", desc: "今月の集計とあなた専用のリンクが届きます。" },
                  { Icon: LinkIcon, title: "リンクから確認・編集", desc: "届いたリンクを開くと、ここに支出が表示されます。" },
                ].map(({ Icon, title, desc }, i) => (
                  <li key={i} className="flex items-start gap-3 rounded-xl border border-line bg-fg/[0.02] p-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
                      <Icon className="h-4 w-4" strokeWidth={2.1} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-fg">{title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted">{desc}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            // 絞り込みで 0 件
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Inbox size={32} strokeWidth={1.8} aria-hidden="true" className="text-ink-4" />
              <p className="text-kb-row text-ink-3">{T.expenses.empty}</p>
            </div>
          )
        ) : (
          <div className="space-y-3">
            {visible.map((expense) => (
              <div
                key={expense.id}
                id={`expense-${expense.id}`}
                className={`glass overflow-hidden rounded-2xl border-l-4 shadow-glass ${
                  !expense.includeInTotal ? "border-l-amber-400" : "border-l-accent"
                } ${expenseSheet?.id === expense.id ? "ring-2 ring-ring" : ""}`}
              >
                <div className="space-y-4 p-4 sm:p-5">
                  {/* Header with title and amount */}
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <h3 className="mb-1 break-words text-base font-semibold text-fg">{expense.description}</h3>
                      <p className="text-sm text-muted">{dayjs(expense.date).format("YYYY年M月D日 (ddd)")}</p>
                    </div>
                    <div className="shrink-0">
                      <p className="text-right text-xl font-bold tabular-nums text-fg sm:text-2xl">
                        ¥{expense.amount.toLocaleString()}
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
                    {expense.userDisplayName && expense.userDisplayName !== "個人" && (
                      <span className="rounded-md bg-fg/5 px-2 py-0.5 text-xs font-medium text-muted">
                        入力: {expense.userDisplayName}
                      </span>
                    )}
                    {(() => {
                      const isDefaultPayer = !expense.payerId || expense.payerId === expense.lineId;
                      const isCardSource = expense.inputSource === "gmail_auto";
                      const payerName = resolvePayerName(expense, historicalUsers);
                      return (
                        payerName !== "個人" && (
                          <span
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
                              isCardSource
                                ? "bg-sky-500/12 text-sky-600 dark:text-sky-400"
                                : isDefaultPayer
                                  ? "bg-fg/5 text-muted"
                                  : "bg-violet-500/12 text-violet-600 dark:text-violet-400"
                            }`}
                          >
                            <CreditCard className="h-3 w-3" />
                            {payerName}
                          </span>
                        )
                      );
                    })()}
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
                            <li key={index} className="flex items-center justify-between text-sm">
                              <span className="mr-2 min-w-0 flex-1 break-words text-muted">{item.name}</span>
                              <span className="shrink-0 font-medium tabular-nums text-fg">¥{item.price.toLocaleString()}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </details>
                  )}

                  {/* 操作: 詳細（予算に含める・レシート・削除など）と編集はシートで */}
                  <div className="flex justify-end gap-3 border-t border-line pt-3">
                    <IconButton
                      label={T.aria.detail}
                      icon={Ellipsis}
                      variant="soft"
                      size={44}
                      iconSize={24}
                      strokeWidth={1.8}
                      aria-haspopup="dialog"
                      onClick={() => {
                        closeAll();
                        setExpenseSheet({ kind: "detail", id: expense.id });
                      }}
                    />
                    <IconButton
                      label={T.aria.edit}
                      icon={Pencil}
                      variant="soft"
                      size={44}
                      aria-haspopup="dialog"
                      onClick={() => {
                        closeAll();
                        setExpenseSheet({ kind: "edit", id: expense.id });
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
    </>
  );
}
