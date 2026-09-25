'use client';

// ホーム: 家計簿（見出し・ふたり/ゲスト・設定）/ ‹ 9月 › / 予算残り / 要確認 / 最近の明細。
// 画面の文字は参照デザインの語だけにし、詳しい数字・グラフは予算シート、明細の中身は詳細シートに置く。
// 集計は刷新前と同じ（useMonthlyStats・useBudgetConfig を同じ引数で使う）。
// 一覧は明細タブと同じ引数の useExpenses（キャッシュも要確認の件数も明細と揃う）。
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { Eye, RotateCw, Settings, TriangleAlert, Users } from 'lucide-react';
import { useLineAuth, useMonthlyStats, useBudgetConfig, useExpenses, useHousehold, DEFAULT_MONTHLY_BUDGET } from '../lib/hooks';
import { countPending, sortForList } from '../lib/expenseState';
import { getSampleExpenses, getSampleStats } from '../lib/sampleData';
import { db } from '../lib/firebase';
import { T } from '../lib/uiText';
import { usePeriod } from '../components/period/PeriodProvider';
import { ScreenHeader } from '../components/layout/ScreenHeader';
import { HeaderPill } from '../components/ui/HeaderPill';
import { IconButton } from '../components/ui/IconButton';
import { useToast } from '../components/ui/Toast';
import { CommonSheets, useCommonSheet } from '../components/sheets/CommonSheets';
import { MonthStepper } from '../components/home/MonthStepper';
import { BudgetHero } from '../components/home/BudgetHero';
import { ReviewBanner } from '../components/home/ReviewBanner';
import { RecentList } from '../components/home/RecentList';
import { ExpenseSheets, useExpenseSheet } from '../components/expense/ExpenseSheets';

// 予算シートはグラフ（recharts）を含むので、開いたときに読み込む（ホームの初回読み込みを軽くする）
const BudgetSheet = dynamic(() => import('../components/sheets/BudgetSheet').then((m) => m.BudgetSheet), {
  ssr: false,
});

/** 最近の明細に出す件数（参照デザインと同じ） */
const RECENT_COUNT = 3;

const noopSubscribe = () => () => {};

export default function HomePage() {
  const { lineId, settled } = useLineAuth();
  const { currentDate, dateSettings, settingsLoaded, range, label, canShift, shift } = usePeriod();
  // 認証と期間の設定が確定するまでは、ゲスト表示もサンプルも出さずに形だけ出す
  const ready = settled && settingsLoaded;
  const isGuest = ready && !lineId;
  const userId = ready ? lineId : null;

  // 初期化に失敗した（Firestore が無い）ときの表示。サーバー描画では出さない
  const firebaseError = useSyncExternalStore(
    noopSubscribe,
    () => !db,
    () => false
  );
  // 失敗は画面に文を出さず、短いトーストと再試行の丸で知らせる
  const toast = useToast();
  useEffect(() => {
    if (firebaseError) toast.show('network');
  }, [firebaseError, toast]);

  const { sheet: commonSheet, setSheet: setCommonSheet } = useCommonSheet();
  const { sheet: expenseSheet, setSheet: setExpenseSheet } = useExpenseSheet();
  const [budgetOpen, setBudgetOpen] = useState(false);
  // シートは同時に 1 つだけ
  const openCommon = useCallback(
    (next: Parameters<typeof setCommonSheet>[0]) => {
      setExpenseSheet(null);
      setBudgetOpen(false);
      setCommonSheet(next);
    },
    [setCommonSheet, setExpenseSheet]
  );

  const householdState = useHousehold(lineId);
  const {
    config: budgetConfig,
    loading: budgetLoading,
    error: budgetError,
    refetch: refetchBudget,
  } = useBudgetConfig(userId);
  const {
    stats,
    loading: statsLoading,
    error: statsError,
    refetch: refetchStats,
  } = useMonthlyStats(
    userId,
    currentDate.year(),
    currentDate.month() + 1,
    dateSettings.customStartDay || 1,
    range.startDate,
    range.endDate
  );
  const {
    expenses,
    loading: expensesLoading,
    error: expensesError,
    updateExpense,
    deleteExpense,
    patchLocal,
    refetch: refetchExpenses,
  } = useExpenses(userId, 0, 500, range.startDate);

  const sampleExpenses = useMemo(() => getSampleExpenses(), []);
  const sampleStats = useMemo(() => getSampleStats(), []);
  const list = isGuest ? sampleExpenses : expenses;
  const shownStats = isGuest ? sampleStats : stats;
  const recent = useMemo(() => sortForList(list).slice(0, RECENT_COUNT), [list]);
  const pendingCount = useMemo(() => countPending(list), [list]);

  // 集計を読めなかった（キャッシュも無い）ときは、形だけのままにせず再試行を出す
  const statsFailed = !isGuest && !!statsError && !stats;
  // キャッシュを表示し続けている間の取得失敗も、短いトーストで知らせる
  useEffect(() => {
    if (!isGuest && (expensesError || statsError)) toast.show('network');
  }, [isGuest, expensesError, statsError, toast]);
  const heroLoading =
    !ready || (!isGuest && !statsFailed && (statsLoading || !shownStats || budgetLoading || !budgetConfig));
  const listLoading = !ready || (!isGuest && expensesLoading);
  const listFailed = !isGuest && !listLoading && !!expensesError && expenses.length === 0;
  // ゲストは最初の描画から既定の予算を出す（useBudgetConfig の既定値は effect で入るため）
  const heroBudget = isGuest
    ? (budgetConfig?.monthlyBudget ?? DEFAULT_MONTHLY_BUDGET)
    : budgetError || statsFailed
      ? null
      : (budgetConfig?.monthlyBudget ?? null);

  const header = (
    <ScreenHeader
      title={T.home.title}
      right={
        <>
          {isGuest && <HeaderPill icon={Eye} label={T.home.guest} onClick={() => openCommon({ kind: 'guest' })} />}
          {ready && lineId && householdState.household && (
            <HeaderPill icon={Users} label={T.home.household} onClick={() => openCommon({ kind: 'household' })} />
          )}
          <IconButton
            label={T.aria.settings}
            icon={Settings}
            aria-haspopup="dialog"
            onClick={() => openCommon({ kind: 'settings', tab: 'budget' })}
          />
        </>
      }
    />
  );

  const commonSheets = (
    <CommonSheets
      sheet={commonSheet}
      setSheet={setCommonSheet}
      household={householdState}
      onSettingsSaved={refetchBudget}
    />
  );

  if (firebaseError) {
    return (
      <>
        {header}
        {commonSheets}
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center">
          <TriangleAlert size={28} strokeWidth={1.9} aria-hidden="true" className="text-danger" />
          <IconButton label={T.aria.retry} icon={RotateCw} onClick={() => window.location.reload()} />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      {commonSheets}

      <MonthStepper
        label={ready ? label : null}
        canShift={canShift}
        onShift={shift}
        onOpenPeriod={() => openCommon({ kind: 'period' })}
      />

      <BudgetHero
        loading={heroLoading}
        spent={shownStats?.totalAmount ?? 0}
        budget={heroBudget}
        onOpen={() => {
          setCommonSheet(null);
          setExpenseSheet(null);
          setBudgetOpen(true);
        }}
        onRetry={() => {
          if (budgetError) refetchBudget();
          if (statsFailed) refetchStats();
        }}
      />

      {!listLoading && pendingCount > 0 && <ReviewBanner count={pendingCount} />}

      <RecentList
        items={recent}
        loading={listLoading}
        onRetry={listFailed ? refetchExpenses : undefined}
        onOpen={(id) => {
          setCommonSheet(null);
          setBudgetOpen(false);
          setExpenseSheet({ kind: 'detail', id });
        }}
      />

      <BudgetSheet
        open={budgetOpen}
        onClose={() => setBudgetOpen(false)}
        lineId={isGuest ? null : userId}
        stats={shownStats}
        budgetConfig={budgetConfig}
        budgetLoading={!isGuest && budgetLoading}
        budgetError={!isGuest && !!budgetError}
        onRetryBudget={refetchBudget}
        currentDate={currentDate}
        dateSettings={dateSettings}
        range={range}
      />

      <ExpenseSheets
        sheet={expenseSheet}
        setSheet={setExpenseSheet}
        expenses={list}
        me={lineId}
        isGuest={isGuest || !ready}
        household={householdState.household}
        activeGroupIds={householdState.activeGroupIds}
        updateExpense={updateExpense}
        deleteExpense={deleteExpense}
        patchLocal={patchLocal}
        refetch={refetchExpenses}
        onChanged={refetchStats}
      />
    </>
  );
}
