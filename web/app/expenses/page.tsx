'use client';

// 明細: 見出し（検索の丸・月ピル）/ すべて・要確認 n・立替 / 日付見出し（今日・昨日・M月D日）/
// 展開カード（1 件だけ）とたたんだ行カード。
// 詳しい情報・予算に含める・削除・レシートは ⋯ の詳細シート、編集は鉛筆の編集シート、
// 検索・絞り込み・並び・集計は検索シートにまとめる（画面に説明文は出さない）。
// - ?filter=pending|advance を最初のセグメントにする（ホームの要確認・LINE からのリンク）
// - LINE の「修正」リンク（?edit=<id>&lineId=<uid>）は認証の確定を待ってから、その支出の期間へ移り、
//   行を展開して編集シートを 1 回だけ開く。URL の lineId は読まない
// - 確認はサーバー（/household）経由。成功したら一覧に反映し、要確認なら次の要確認が展開される
import React, { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dayjs from 'dayjs';
import { Eye, Inbox, RotateCw, Search } from 'lucide-react';
import { useLineAuth, useExpenses, useHousehold } from '../../lib/hooks';
import type { Expense } from '../../lib/hooks';
import {
  DEFAULT_FILTER,
  canServerConfirm,
  countPending,
  filterExpenses,
  groupByDate,
  isFilterActive,
  isPending,
  matchesSegment,
  parseSegment,
  relativeDateLabel,
  sortForList,
  type ExpenseFilter,
  type Segment,
} from '../../lib/expenseState';
import { getSampleExpenses } from '../../lib/sampleData';
import { isHouseholdApiConfigured } from '../../lib/householdApi';
import { T } from '../../lib/uiText';
import { ScreenHeader } from '../../components/layout/ScreenHeader';
import { usePeriod } from '../../components/period/PeriodProvider';
import { IconButton } from '../../components/ui/IconButton';
import { MonthPill } from '../../components/ui/MonthPill';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import { CommonSheets, useCommonSheet } from '../../components/sheets/CommonSheets';
import { FilterSheet } from '../../components/sheets/FilterSheet';
import { ExpenseSheets, useConfirmExpense, useExpenseSheet } from '../../components/expense/ExpenseSheets';
import { ExpenseCard } from '../../components/expense/ExpenseCard';
import { ExpenseRowCard } from '../../components/expense/ExpenseRowCard';
import { useEditDeepLink } from '../../components/expense/useEditDeepLink';

/** 展開: null は自動（要確認のときだけ先頭を展開）、COLLAPSED は利用者がたたんだ状態 */
const COLLAPSED = '';

// Suspense boundary for useSearchParams
export default function ExpensesPage() {
  return (
    <Suspense
      fallback={
        <>
          <ScreenHeader title={T.expenses.title} />
          <SegmentSkeleton />
          <ListSkeleton />
        </>
      }
    >
      <ExpensesPageContent />
    </Suspense>
  );
}

function SegmentSkeleton() {
  return (
    <SkeletonGroup className="mx-4 mt-[22px]">
      <Skeleton className="h-[52px] rounded-full" />
    </SkeletonGroup>
  );
}

function ListSkeleton() {
  return (
    <SkeletonGroup className="px-4 pt-[33px]">
      <Skeleton className="mx-2 h-[18px] w-12 rounded-md" />
      <Skeleton className="mt-3 h-[300px] rounded-kb-card" />
      <Skeleton className="mt-4 h-[82px] rounded-kb-row" />
    </SkeletonGroup>
  );
}

function ExpensesPageContent() {
  const { lineId, settled } = useLineAuth();
  const { label, range, settingsLoaded, setCurrentDate } = usePeriod();
  const ready = settled && settingsLoaded;
  const isGuest = ready && !lineId;

  // edit はドキュメント ID であり、本人特定には使わない（URL の lineId は読まない）
  const router = useRouter();
  const searchParams = useSearchParams();
  const editExpenseId = searchParams.get('edit');
  const segment = parseSegment(searchParams.get('filter'));

  const householdState = useHousehold(lineId);
  const { sheet: commonSheet, setSheet: setCommonSheet } = useCommonSheet();
  const { sheet: expenseSheet, setSheet: setExpenseSheet } = useExpenseSheet();
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<ExpenseFilter>(DEFAULT_FILTER);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // シートは同時に 1 つだけ
  const closeAll = () => {
    setCommonSheet(null);
    setExpenseSheet(null);
    setFilterOpen(false);
  };

  const changeSegment = (next: Segment) => {
    if (next === segment) return;
    setExpandedId(null);
    router.replace(next === 'all' ? '/expenses/' : `/expenses/?filter=${next}`, { scroll: false });
  };

  // LINE の「修正」リンク: 読めた支出を先に持っておき（一覧に現れる前でも編集できる）、行を展開してスクロールする
  const [deepLinkTarget, setDeepLinkTarget] = useState<Expense | null>(null);
  const pendingScrollRef = useRef<string | null>(null);
  const openFromDeepLink = useCallback(
    (target: Expense) => {
      setDeepLinkTarget(target);
      setExpandedId(target.id);
      setCommonSheet(null);
      setFilterOpen(false);
      setExpenseSheet({ kind: 'edit', id: target.id });
      pendingScrollRef.current = target.id;
    },
    [setCommonSheet, setExpenseSheet]
  );
  const { shouldFetch, fallbackId } = useEditDeepLink(editExpenseId, {
    lineId,
    settled,
    settingsLoaded,
    setCurrentDate,
    onOpen: openFromDeepLink,
  });

  // 認証と期間の設定が確定し、?edit= の期間が決まってから取得する（二重取得を防ぐ）
  const fetchUserId = ready && shouldFetch ? lineId : null;
  const {
    expenses,
    loading,
    error,
    updateExpense,
    deleteExpense,
    patchLocal,
    refetch: refetchExpenses,
  } = useExpenses(fetchUserId, 0, 500, range.startDate);

  // 「修正」リンクの対象を直接読めなかったときは、一覧を読み終えてから一覧で探して開く
  // （見つからなくても一度探したら終わり）
  const fallbackDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!fallbackId || fallbackDoneRef.current === fallbackId || !fetchUserId || loading) return;
    fallbackDoneRef.current = fallbackId;
    const target = expenses.find((e) => e.id === fallbackId);
    if (target) openFromDeepLink(target);
  }, [fallbackId, fetchUserId, loading, expenses, openFromDeepLink]);

  const sampleExpenses = useMemo(() => getSampleExpenses(), []);
  const list = isGuest ? sampleExpenses : expenses;

  // 対象の行が一覧に現れたらスクロールして見せる
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (!id || !list.some((e) => e.id === id)) return;
    pendingScrollRef.current = null;
    const timer = setTimeout(() => {
      document.getElementById(`expense-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    return () => clearTimeout(timer);
  }, [list]);

  const pendingCount = useMemo(() => countPending(list), [list]);
  const visible = useMemo(
    () => sortForList(filterExpenses(list, filter), filter.sortBy).filter((e) => matchesSegment(e, segment)),
    [list, filter, segment]
  );
  const groups = useMemo(
    // 金額順のときは日付でまとめない（並びを崩さない）
    () => (filter.sortBy === 'date' ? groupByDate(visible) : [{ date: '', items: visible }]),
    [visible, filter.sortBy]
  );

  // 展開は同時に 1 件。要確認のときは先頭を自動で展開する（確認すると次の要確認が展開される）
  const shownExpandedId =
    expandedId === COLLAPSED
      ? null
      : expandedId && visible.some((e) => e.id === expandedId)
        ? expandedId
        : segment === 'pending'
          ? (visible[0]?.id ?? null)
          : null;

  const apiAvailable = isHouseholdApiConfigured();
  const confirmExpense = useConfirmExpense({ patchLocal });
  // 展開・たたみ・確認で押したボタンが消えるので、描画のあとで対応するボタンへフォーカスを移す
  // （キーボードやスイッチ操作で一覧の位置を見失わないように）
  const pendingFocusRef = useRef<{
    kind: 'toggle' | 'row' | 'afterConfirm' | 'afterDelete';
    id: string;
  } | null>(null);
  const confirm = async (expense: Expense) => {
    if (isGuest || confirmingId) return;
    setConfirmingId(expense.id);
    await confirmExpense(expense.id);
    pendingFocusRef.current = { kind: 'afterConfirm', id: expense.id };
    setConfirmingId(null);
  };

  // 詳細シートから削除すると開いたボタンごと消えるので、隣の行へフォーカスを移す
  const deleteAndKeepPlace = async (id: string) => {
    const index = visible.findIndex((e) => e.id === id);
    const neighbor = index >= 0 ? (visible[index + 1] ?? visible[index - 1]) : undefined;
    await deleteExpense(id);
    pendingFocusRef.current = { kind: 'afterDelete', id: neighbor?.id ?? '' };
  };

  const expandRow = (id: string) => {
    pendingFocusRef.current = { kind: 'toggle', id };
    setExpandedId(id);
  };
  const collapseRow = (id: string) => {
    pendingFocusRef.current = { kind: 'row', id };
    setExpandedId(COLLAPSED);
  };
  // 依存配列は付けない: 対象の行が DOM に現れる描画・シートが閉じ切った後の描画のどれで
  // 動かせるかが決まっていないため、毎回の描画の後に確かめる（予約が無ければすぐ戻る）
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    const byId = (domId: string) => document.getElementById(domId) as HTMLElement | null;
    if (target.kind === 'afterDelete') {
      const active = document.activeElement;
      // シートが閉じ切るまで待つ（フォーカスがシートの中にある間は動かさない）
      if (active && active.closest('[role="dialog"]')) return;
      pendingFocusRef.current = null;
      if (active && active !== document.body) return;
      const next = target.id ? (byId(`expense-${target.id}-toggle`) ?? byId(`expense-${target.id}`)) : null;
      (next ?? document.querySelector<HTMLElement>('.kb-seg [aria-pressed="true"]'))?.focus();
      return;
    }
    pendingFocusRef.current = null;
    if (target.kind === 'toggle') {
      byId(`expense-${target.id}-toggle`)?.focus();
    } else if (target.kind === 'row') {
      byId(`expense-${target.id}`)?.focus();
    } else {
      // 確認ボタンが消えてフォーカスが外れたときだけ動かす
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const next =
        byId(`expense-${target.id}-toggle`) ??
        (shownExpandedId ? byId(`expense-${shownExpandedId}-toggle`) : null) ??
        byId(`expense-${target.id}`);
      next?.focus();
    }
  });

  const header = (
    <ScreenHeader
      title={T.expenses.title}
      right={
        <>
          {isGuest && (
            // ゲスト案内はシートにだけ置く（画面には文字を足さない）
            <IconButton
              label={T.sheet.guest}
              icon={Eye}
              aria-haspopup="dialog"
              onClick={() => {
                closeAll();
                setCommonSheet({ kind: 'guest' });
              }}
            />
          )}
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
          {ready ? (
            <MonthPill
              label={label}
              onClick={() => {
                closeAll();
                setCommonSheet({ kind: 'period' });
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

  const segments = (
    <SegmentedControl
      className="mx-4 mt-[22px]"
      ariaLabel={T.aria.filter}
      items={[
        { key: 'all', label: T.expenses.all },
        { key: 'pending', label: T.expenses.pending, count: ready ? pendingCount : 0 },
        { key: 'advance', label: T.expenses.advance },
      ]}
      value={segment}
      onChange={changeSegment}
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
        expenses={list}
      />
      <ExpenseSheets
        sheet={expenseSheet}
        setSheet={setExpenseSheet}
        expenses={list}
        fallback={deepLinkTarget}
        me={lineId}
        isGuest={isGuest || !lineId}
        household={householdState.household}
        activeGroupIds={householdState.activeGroupIds}
        updateExpense={updateExpense}
        deleteExpense={deleteAndKeepPlace}
        patchLocal={patchLocal}
        refetch={refetchExpenses}
      />
    </>
  );

  const waiting = !ready || (!!lineId && (!shouldFetch || loading));
  if (waiting) {
    return (
      <>
        {header}
        {sheets}
        {segments}
        <ListSkeleton />
      </>
    );
  }

  const today = dayjs().format('YYYY-MM-DD');

  return (
    <>
      {header}
      {sheets}
      {segments}

      <div className="pb-2">
        {error && list.length === 0 ? (
          <div className="flex justify-center py-12">
            <IconButton label={T.aria.retry} icon={RotateCw} onClick={refetchExpenses} />
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <Inbox size={32} strokeWidth={1.8} aria-hidden="true" className="text-ink-4" />
            <p className="text-kb-row text-ink-3">{T.expenses.empty}</p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.date || 'all'} className="[&>*:nth-child(2)]:!mt-3">
              {group.date ? (
                <h2 className="mx-6 mt-[36px] text-kb-group text-ink-soft">{relativeDateLabel(group.date, today)}</h2>
              ) : (
                <span aria-hidden="true" className="block h-[21px]" />
              )}
              {group.items.map((expense) => {
                const pending = isPending(expense);
                return expense.id === shownExpandedId ? (
                  <ExpenseCard
                    key={expense.id}
                    expense={expense}
                    pending={pending}
                    confirmable={
                      !isGuest &&
                      apiAvailable &&
                      (!confirmingId || confirmingId === expense.id) &&
                      canServerConfirm(expense, lineId, householdState.activeGroupIds)
                    }
                    confirming={confirmingId === expense.id}
                    onConfirm={() => confirm(expense)}
                    onDetail={() => {
                      closeAll();
                      setExpenseSheet({ kind: 'detail', id: expense.id });
                    }}
                    onEdit={() => {
                      closeAll();
                      setExpenseSheet({ kind: 'edit', id: expense.id });
                    }}
                    onCollapse={() => collapseRow(expense.id)}
                  />
                ) : (
                  <ExpenseRowCard
                    key={expense.id}
                    expense={expense}
                    pending={pending}
                    onExpand={() => expandRow(expense.id)}
                  />
                );
              })}
            </section>
          ))
        )}
      </div>
    </>
  );
}
