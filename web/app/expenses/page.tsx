"use client";

import React, { useState, useMemo, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useLineAuth, useExpenses, useGroupMembers, useHousehold, invalidateStatsCache } from "../../lib/hooks";
import {
  countPending,
  parseSegment,
  matchesSegment,
  categoriesIn,
  filterExpenses,
  resolvePayerName,
  sortForList,
  summarizeExpenses,
  type Segment,
  type SortKey,
} from "../../lib/expenseState";
import {
  validateEditForm,
  buildEditUpdate,
  hasEditChanges,
  collectHistoricalUsers,
  collectGroupExpenseUsers,
  mergeAvailableMembers,
  buildPayerOptions,
  payerDisplayNameFor,
  buildCategoryOptions,
  buildSubCategoryOptions,
  changeEditCategory,
  type EditForm,
} from "../../lib/expenseEdit";
import { subCategoriesOf } from "../../lib/categoryTaxonomy";
import { confirmExpense, isHouseholdApiConfigured, householdErrorCode } from "../../lib/householdApi";
import type { Expense } from "../../lib/hooks";
import PreviewModeBanner from "../../components/PreviewModeBanner";
import ExpenseControls from "../../components/expenses/ExpenseControls";
import ExpenseEmptyState from "../../components/expenses/ExpenseEmptyState";
import ExpenseCard from "../../components/expenses/ExpenseCard";
import EditDrawer from "../../components/expenses/EditDrawer";
import ReceiptModal from "../../components/expenses/ReceiptModal";
import { CANONICAL_CATEGORIES, normalizeCategoryName } from "../../lib/categoryNormalization";
import dayjs from "dayjs";
import { fetchDateRangeSettings, getEffectiveDateRange, getDisplayTitle, DEFAULT_SETTINGS, type DateRangeSettings } from "../../lib/dateSettings";
import { doc, getDoc } from "firebase/firestore";
import { db, ensureFirebaseInitialized } from "../../lib/firebase";
import { getCached, setCached } from "../../lib/swrCache";

// Suspense boundary for useSearchParams
export default function ExpensesPage() {
  return (
    <Suspense fallback={<ExpensesPageLoading />}>
      <ExpensesPageContent />
    </Suspense>
  );
}

function ExpensesPageLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    </div>
  );
}

function ExpensesPageContent() {
  const { lineId, loading: authLoading } = useLineAuth();
  // URLからパラメータを取得（useSearchParamsでハイドレーション安全に取得）
  // edit / expenseId はドキュメントIDであり、認証（本人特定）には使わない。
  // 本人特定は検証済みクレームの lineId のみで行う（URL の lineId は信用しない）。
  const searchParams = useSearchParams();
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>(DEFAULT_SETTINGS);
  // ?from=YYYY-MM-DD（ホーム・精算の内訳から開いたとき）: その日を含む期間を開く
  const [currentMonth, setCurrentMonth] = useState(() => {
    const from = searchParams.get('from');
    return from && /^\d{4}-\d{2}-\d{2}$/.test(from) && dayjs(from).isValid() ? dayjs(from) : dayjs();
  });
  // 期間は設定と表示中の月から同じ描画で決める（state + effect だと、設定が届いた直後の描画で
  // 前の期間のまま取得が始まり、取り直しになる）
  const dateRange = useMemo(() => {
    const range = getEffectiveDateRange(currentMonth, dateSettings);
    return { startDate: range.startDate, endDate: range.endDate };
  }, [currentMonth, dateSettings]);
  // 期間の設定を読み終えた相手（lineId。未ログインは ''）。読み終えるまで支出を取りに行かない
  // （既定の 1 日起算で一度取ってから取り直さないように）
  const [settingsLoadedFor, setSettingsLoadedFor] = useState<string | null>(null);
  // Track whether we've resolved the edit expense's month
  const [editMonthResolved, setEditMonthResolved] = useState(false);
  // Track whether the month was set for edit expense (used to defer editMonthResolved until dateRange updates)
  const [editMonthSet, setEditMonthSet] = useState(false);

  const editExpenseId = searchParams.get('edit');
  // ?filter=pending / advance（ホームの「要確認」から開いたとき）
  const [segment, setSegment] = useState<Segment>(() => parseSegment(searchParams.get('filter')));
  const [query, setQuery] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // データ取得は検証済み lineId クレームでのみ行う
  const effectiveUserId = lineId;

  // ゲスト（プレビュー）モード判定: 検証済み lineId がない場合
  const isGuest = !lineId;

  // 期間の設定（ホーム・精算と同じキャッシュを先に使い、裏で読み直す）
  const dateSettingsLoaded = settingsLoadedFor === (effectiveUserId ?? '');
  useEffect(() => {
    const userKey = effectiveUserId ?? '';
    if (!effectiveUserId || effectiveUserId === 'guest') {
      setSettingsLoadedFor(userKey);
      return;
    }
    let cancelled = false;
    const cacheKey = `dateSettings:${effectiveUserId}`;
    const cached = getCached<DateRangeSettings>(cacheKey);
    if (cached) {
      setDateSettings(cached);
      setSettingsLoadedFor(userKey);
    }
    fetchDateRangeSettings(effectiveUserId).then(
      (settings) => {
        if (cancelled) return;
        setCached(cacheKey, settings);
        setDateSettings(settings);
        setSettingsLoadedFor(userKey);
      },
      (error: unknown) => {
        // 読めなかった: キャッシュがあればそのまま、無ければ既定の期間で続ける（キャッシュは上書きしない）
        console.error('Failed to load date settings:', error);
        if (!cancelled) setSettingsLoadedFor(userKey);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [effectiveUserId]);

  // When edit param is present, fetch the expense by ID and navigate to its month
  // so the expense is guaranteed to be in the date range
  useEffect(() => {
    if (!editExpenseId || !dateSettingsLoaded || editMonthResolved || editMonthSet) return;

    const resolveEditExpenseMonth = async () => {
      try {
        ensureFirebaseInitialized();
        if (!db) {
          // No Firebase, mark as resolved directly
          setEditMonthResolved(true);
          return;
        }
        const expenseDoc = await getDoc(doc(db, 'expenses', editExpenseId));
        if (expenseDoc.exists()) {
          const data = expenseDoc.data();
          if (data.date) {
            const expenseDate = dayjs(data.date);
            // Set currentMonth to the expense's date so date range calculation includes it
            // (getEffectiveDateRange handles customStartDay correctly when given the actual date)
            setCurrentMonth(expenseDate);
            // Mark that month was set - editMonthResolved will be set after dateRange updates
            setEditMonthSet(true);
            return;
          }
        }
        // No valid date found, mark as resolved
        setEditMonthResolved(true);
      } catch (err) {
        console.error("Failed to fetch edit expense:", err);
        setEditMonthResolved(true);
      }
    };

    resolveEditExpenseMonth();
  }, [editExpenseId, dateSettingsLoaded, editMonthResolved, editMonthSet]);

  // Mark edit month as resolved AFTER dateRange has been updated
  // This ensures we fetch with the correct date range, preventing double-fetch
  useEffect(() => {
    if (editMonthSet && !editMonthResolved) {
      setEditMonthResolved(true);
    }
  }, [dateRange, editMonthSet, editMonthResolved]);

  // Don't start fetching expenses until we've resolved the edit expense's month (if applicable)
  const shouldFetch = dateSettingsLoaded && (editExpenseId ? editMonthResolved : true);
  const { expenses, loading: expensesLoading, error, updateExpense, deleteExpense, patchLocal } =
    useExpenses(shouldFetch ? effectiveUserId : null, 0, 500, dateRange.startDate);
  // 期間の設定を待っている間も読み込み中として出す（空の一覧を一瞬出さない）
  const loading = expensesLoading || (!!effectiveUserId && !shouldFetch);
  // 書き込み可否（所属の読み込み中は null = 許可扱い。最終判断はルール・サーバー）
  const { activeGroupIds } = useHousehold(effectiveUserId);
  const apiAvailable = isHouseholdApiConfigured();
  // ?category=（内訳から開いたとき）: そのカテゴリで絞り込む
  const [filter, setFilter] = useState(() => {
    const category = searchParams.get('category');
    return category && category !== 'included' && category !== 'excluded' ? category : 'all';
  });
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [editingExpense, setEditingExpense] = useState<string | null>(null);
  // レシートのインラインプレビュー（新規タブで開かずモーダル表示）
  const [receiptPreview, setReceiptPreview] = useState<{ url: string; expenseId: string } | null>(null);
  // Edit drawer accessibility: panel ref, latest-close ref, and the element to
  // restore focus to when the drawer closes.
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeDrawerRef = useRef<() => void>(() => {});
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ amount: 0, description: "", date: "", category: "", subCategory: "", includeInTotal: true, payerId: "", payerDisplayName: "" });
  // 大項目を変えて中項目を「中項目なし」に戻した（中項目を選び直すまで注記を出す）
  const [subCategoryReset, setSubCategoryReset] = useState(false);
  // Flag to prevent re-triggering edit mode after user closes the editor
  const [editConsumed, setEditConsumed] = useState(false);

  // URLのeditパラメータで指定された支出を自動的に編集モードで開く
  // Note: This effect must be after the useState/useExpenses declarations to avoid TDZ
  useEffect(() => {
    // Only trigger once per editExpenseId - don't re-trigger after user cancels
    if (editExpenseId && expenses.length > 0 && !editingExpense && !editConsumed) {
      const expenseToEdit = expenses.find(e => e.id === editExpenseId);
      if (expenseToEdit) {
        setEditingExpense(expenseToEdit.id);
        setEditForm({
          amount: expenseToEdit.amount,
          description: expenseToEdit.description,
          date: expenseToEdit.date,
          category: expenseToEdit.category,
          subCategory: expenseToEdit.subCategory ?? "",
          includeInTotal: expenseToEdit.includeInTotal,
          payerId: expenseToEdit.payerId || expenseToEdit.lineId,
          payerDisplayName: expenseToEdit.payerDisplayName || expenseToEdit.userDisplayName || "",
        });
        setSubCategoryReset(false);
        // Mark as consumed to prevent re-triggering
        setEditConsumed(true);
        // スクロールして表示
        setTimeout(() => {
          const element = document.getElementById(`expense-${editExpenseId}`);
          element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
      }
    }
  }, [editExpenseId, expenses, editingExpense, editConsumed]);

  // Accessibility for the edit drawer: when it opens, move focus into the
  // panel, trap Tab within it, close on Escape, and restore focus on close.
  // (Declared before any early return so hook order stays stable.)
  useEffect(() => {
    if (!editingExpense) return;
    const panel = drawerRef.current;
    if (!panel) return;

    lastFocusedRef.current = (document.activeElement as HTMLElement) ?? null;

    const SELECTOR =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(SELECTOR));

    // Move focus into the drawer.
    (focusables()[0] ?? panel).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeDrawerRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Restore focus to the control that opened the drawer.
      lastFocusedRef.current?.focus?.();
    };
  }, [editingExpense]);

  // Get group members for the expense being edited
  const editingExpenseData = editingExpense ? expenses.find(e => e.id === editingExpense) : null;
  const editingGroupId = editingExpenseData?.groupId || null;

  // グループ支出には必ず groupId が付くため、lineGroupId 由来のフォールバックは廃止した。
  // セキュリティルールがメンバーシップを groupId で判定するようになったこととも整合する。
  const { members: groupMembers } = useGroupMembers(editingGroupId);
  
  // 支払い者の候補: グループの正式メンバー → このグループの支出履歴 → 全体の支出履歴（入力者と支払い者の両方）
  const allHistoricalUsers = useMemo(() => collectHistoricalUsers(expenses), [expenses]);
  const groupExpenseUsers = useMemo(
    () => collectGroupExpenseUsers(expenses, editingExpenseData),
    [expenses, editingExpenseData]
  );
  const availableMembers = useMemo(
    () => mergeAvailableMembers(groupMembers, groupExpenseUsers, allHistoricalUsers),
    [groupMembers, groupExpenseUsers, allHistoricalUsers]
  );

  if (authLoading || (editExpenseId && !editMonthResolved)) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="mt-3 text-sm text-muted">読み込み中...</p>
        </div>
      </div>
    );
  }

  const pendingCount = countPending(expenses);

  // フィルターの選択肢は「すべて / 合計に含む / 合計から除外 / 各カテゴリ」の 1 つ
  const budgetFilter = filter === "included" || filter === "excluded" ? filter : "all";
  const filteredExpenses = filterExpenses(
    expenses.filter((expense) => matchesSegment(expense, segment)),
    { query, budget: budgetFilter, category: budgetFilter === "all" ? filter : "all" }
  );
  const sortedExpenses = sortForList(filteredExpenses, sortBy);

  const categories = categoriesIn(expenses);
  // カテゴリ編集の選択肢は正準カテゴリ（bot/分類器と統一）。
  // データ内の既存カテゴリや編集中の現在値も取り込み、未知カテゴリでも
  // 先頭（食費）に勝手に落ちないようにする。
  const allCategories = buildCategoryOptions(CANONICAL_CATEGORIES, expenses, editForm.category);

  // 支払い者名の解決ルール（金額/件数/チップ表示で共通利用）
  const payerNameOf = (expense: Expense) => resolvePayerName(expense, allHistoricalUsers);
  // 合計カード・支払い者別の合計（承認済みの項目のみ合計に含める）
  const summary = summarizeExpenses(filteredExpenses, payerNameOf);

  const handleEditStart = (expense: Expense) => {
    setEditError(null);
    setEditingExpense(expense.id);
    const formData = {
      amount: expense.amount,
      description: expense.description,
      date: expense.date,
      category: expense.category,
      subCategory: expense.subCategory ?? "",
      includeInTotal: expense.includeInTotal,
      payerId: expense.payerId || expense.lineId,
      payerDisplayName: expense.payerDisplayName || expense.userDisplayName || "",
    };

    setEditForm(formData);
    setSubCategoryReset(false);
  };

  const handleEditCancel = () => {
    setEditError(null);
    setEditingExpense(null);
    setEditForm({
      amount: 0,
      description: "",
      date: "",
      category: "",
      subCategory: "",
      includeInTotal: true,
      payerId: "",
      payerDisplayName: "",
    });
    setSubCategoryReset(false);
  };

  // Keep the latest cancel handler available to the keydown listener.
  closeDrawerRef.current = handleEditCancel;

  const handleEditSave = async (id: string) => {
    const original = expenses.find((e) => e.id === id);
    if (!original) return;
    // 入力チェック（変更した項目だけ）と、変更した項目だけを送る差分。精算済みは金額・日付・支払者を変えない
    const invalid = validateEditForm(editForm, original);
    if (invalid) {
      setEditError(invalid.message);
      return;
    }
    const update = buildEditUpdate(editForm, original);
    if (!hasEditChanges(update)) {
      setEditingExpense(null);
      return;
    }
    if (savingEdit) return;
    setSavingEdit(true);
    try {
      // original を渡す: 大項目を変えたとき、中項目も消す
      await updateExpense(id, { ...update, updatedAt: new Date() }, original);
      invalidateStatsCache();
      setEditError(null);
      setEditingExpense(null);
    } catch (error) {
      console.error("保存エラー:", error);
      setEditError("保存に失敗しました。権限がないか、通信に失敗しました");
    } finally {
      setSavingEdit(false);
    }
  };

  // 要確認の支出を確認する（LINE の OK ボタンと同じ処理をサーバーで行う）
  const handleConfirm = async (expense: Expense) => {
    setConfirmingId(expense.id);
    try {
      const { advanceBy, ...patch } = await confirmExpense(expense.id);
      patchLocal(expense.id, { ...patch, ...(advanceBy ? { advanceBy } : {}) });
      // ホームの集計（予算に計上される額）が古いまま出ないように
      invalidateStatsCache();
    } catch (error) {
      const code = householdErrorCode(error);
      alert(
        code === "forbidden"
          ? "この支出を確認する権限がありません"
          : code === "not_found"
          ? "支出が見つかりません（削除された可能性があります）"
          : "確認に失敗しました。時間をおいてやり直してください"
      );
    } finally {
      setConfirmingId(null);
    }
  };

  const handleEditInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value, type } = e.target;
    if (name === "category") {
      // 大項目が変わったら、中項目は「中項目なし」に戻す（選択肢も新しい大項目の一覧に替わる）
      // 別名（保存すると同じ大項目になる名前）を選んだだけなら戻さない（保存時と同じ正規化で比べる）
      const next = changeEditCategory(editForm, value, (category) => normalizeCategoryName(category));
      setEditForm(next.form);
      if (next.reset) setSubCategoryReset(true);
    } else if (name === "subCategory") {
      setSubCategoryReset(false);
      setEditForm((prev) => ({ ...prev, subCategory: value }));
    } else if (name === "payerId") {
      // 支払い者IDが変更されたら、対応する表示名も更新
      const displayName = payerDisplayNameFor(value, availableMembers, expenses);

      setEditForm((prev) => ({
        ...prev,
        payerId: value,
        payerDisplayName: displayName,
      }));
    } else {
      setEditForm((prev) => ({
        ...prev,
        [name]: type === "number" ? Number(value) : value,
      }));
    }
  };

  const handleEditCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditForm((prev) => ({
      ...prev,
      includeInTotal: e.target.checked,
    }));
  };

  const handleDeleteExpense = async (id: string) => {
    if (confirm("この支出を削除しますか？")) {
      try {
        await deleteExpense(id);
        invalidateStatsCache();
      } catch (error) {
        console.error("Error deleting expense:", error);
        alert("エラーが発生しました");
      }
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-8 md:py-7">
      {isGuest && (
        <div className="mb-4">
          <PreviewModeBanner />
        </div>
      )}

      <main>
        <ExpenseControls
          segment={segment}
          onSegmentChange={setSegment}
          pendingCount={pendingCount}
          query={query}
          onQueryChange={setQuery}
          periodTitle={getDisplayTitle(currentMonth, dateSettings)}
          onPrevPeriod={() => setCurrentMonth(prev => prev.subtract(1, 'month'))}
          onNextPeriod={() => setCurrentMonth(prev => prev.add(1, 'month'))}
          hasExpenses={expenses.length > 0}
          filter={filter}
          onFilterChange={setFilter}
          categories={categories}
          sortBy={sortBy}
          onSortChange={setSortBy}
          summary={summary}
        />

        {loading ? (
          <div className="py-16 text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <p className="mt-3 text-sm text-muted">データを読み込み中...</p>
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-rose-500/20 bg-rose-500/[0.06] p-4">
            <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
          </div>
        ) : sortedExpenses.length === 0 ? (
          <ExpenseEmptyState isGuest={isGuest} hasExpenses={expenses.length > 0} />
        ) : (
          <div className="space-y-3">
            {sortedExpenses.map((expense) => (
              <ExpenseCard
                key={expense.id}
                expense={expense}
                editing={editingExpense === expense.id}
                payerName={payerNameOf(expense)}
                lineId={lineId}
                isGuest={isGuest}
                apiAvailable={apiAvailable}
                activeGroupIds={activeGroupIds}
                confirming={confirmingId === expense.id}
                onConfirm={() => handleConfirm(expense)}
                onToggleInclude={() => updateExpense(expense.id, { includeInTotal: !expense.includeInTotal })}
                onEdit={() => handleEditStart(expense)}
                onPreviewReceipt={(url) => setReceiptPreview({ url, expenseId: expense.id })}
                onDelete={() => handleDeleteExpense(expense.id)}
              />
            ))}
          </div>
        )}

        {/* Edit drawer — mobile: bottom sheet / desktop: right side drawer */}
        {editingExpense && (
          <EditDrawer
            panelRef={drawerRef}
            form={editForm}
            settled={editingExpenseData?.status === 'advance_settled'}
            categories={allCategories}
            subCategoryOptions={buildSubCategoryOptions(subCategoriesOf(editForm.category), editForm.subCategory)}
            subCategoryReset={subCategoryReset}
            payerOptions={buildPayerOptions(editingExpenseData, availableMembers, expenses, editForm)}
            error={editError}
            saving={savingEdit}
            onChange={handleEditInputChange}
            onCheckboxChange={handleEditCheckboxChange}
            onSave={() => editingExpense && handleEditSave(editingExpense)}
            onCancel={handleEditCancel}
          />
        )}

        {/* レシートのインラインプレビュー（新規タブで開かず、その場で表示＋差し替え） */}
        {receiptPreview && (
          <ReceiptModal
            url={receiptPreview.url}
            expenseId={receiptPreview.expenseId}
            onClose={() => setReceiptPreview(null)}
          />
        )}
      </main>
    </div>
  );
}
