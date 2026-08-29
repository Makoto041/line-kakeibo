"use client";

import React, { useState, useMemo, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Save,
  X,
  Check,
  Ban,
  Paperclip,
  CreditCard,
  Smartphone,
  Inbox,
  Wallet,
  MessageCircle,
  Send,
  ListChecks,
  Link2 as LinkIcon,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { useLineAuth, useExpenses, useGroupMembers, useLineGroupMembers } from "../../lib/hooks";
import type { Expense } from "../../lib/hooks";
import PreviewModeBanner from "../../components/PreviewModeBanner";
import GuestGuide from "../../components/GuestGuide";
import { getCategoryVisual } from "../../lib/categoryVisuals";
import { CANONICAL_CATEGORIES } from "../../lib/categoryNormalization";
import { isSafeImageUrl, toSafeImageUrl } from "../../lib/imageUrl";
import dayjs from "dayjs";
import { getDateRangeSettings, getEffectiveDateRange, getDisplayTitle, DEFAULT_SETTINGS, type DateRangeSettings } from "../../lib/dateSettings";
import { doc, getDoc } from "firebase/firestore";
import { db, ensureFirebaseInitialized } from "../../lib/firebase";

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
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>(DEFAULT_SETTINGS);
  const [currentMonth, setCurrentMonth] = useState(dayjs());
  // Initialize dateRange synchronously to avoid undefined→value transition causing double fetch
  const [dateRange, setDateRange] = useState<{startDate: string; endDate: string}>(() => {
    const range = getEffectiveDateRange(dayjs(), DEFAULT_SETTINGS);
    return { startDate: range.startDate, endDate: range.endDate };
  });
  // Track whether date settings have been loaded (to avoid fetching before edit expense month is resolved)
  const [dateSettingsLoaded, setDateSettingsLoaded] = useState(false);
  // Track whether we've resolved the edit expense's month
  const [editMonthResolved, setEditMonthResolved] = useState(false);
  // Track whether the month was set for edit expense (used to defer editMonthResolved until dateRange updates)
  const [editMonthSet, setEditMonthSet] = useState(false);

  // URLからパラメータを取得（useSearchParamsでハイドレーション安全に取得）
  // edit / expenseId はドキュメントIDであり、認証（本人特定）には使わない。
  // 本人特定は検証済みクレームの lineId のみで行う（URL の lineId は信用しない）。
  const searchParams = useSearchParams();
  const editExpenseId = searchParams.get('edit');

  // データ取得は検証済み lineId クレームでのみ行う
  const effectiveUserId = lineId;

  // ゲスト（プレビュー）モード判定: 検証済み lineId がない場合
  const isGuest = !lineId;

  // Load date settings from Firestore on mount
  useEffect(() => {
    const loadSettings = async () => {
      if (effectiveUserId && effectiveUserId !== 'guest') {
        const settings = await getDateRangeSettings(effectiveUserId);
        setDateSettings(settings);
      }
      setDateSettingsLoaded(true);
    };
    loadSettings();
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

  // Calculate effective date range when settings or currentMonth changes
  useEffect(() => {
    const range = getEffectiveDateRange(currentMonth, dateSettings);
    setDateRange({ startDate: range.startDate, endDate: range.endDate });
  }, [currentMonth, dateSettings]);

  // Mark edit month as resolved AFTER dateRange has been updated
  // This ensures we fetch with the correct date range, preventing double-fetch
  useEffect(() => {
    if (editMonthSet && !editMonthResolved) {
      setEditMonthResolved(true);
    }
  }, [dateRange, editMonthSet, editMonthResolved]);

  // Don't start fetching expenses until we've resolved the edit expense's month (if applicable)
  const shouldFetch = editExpenseId ? editMonthResolved : true;
  const { expenses, loading, error, updateExpense, deleteExpense } =
    useExpenses(shouldFetch ? effectiveUserId : null, 0, 500, dateRange.startDate);
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"date" | "amount">("date");
  const [editingExpense, setEditingExpense] = useState<string | null>(null);
  // レシートのインラインプレビュー（新規タブで開かずモーダル表示）
  const [receiptPreview, setReceiptPreview] = useState<{ url: string; expenseId: string } | null>(null);
  // Edit drawer accessibility: panel ref, latest-close ref, and the element to
  // restore focus to when the drawer closes.
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeDrawerRef = useRef<() => void>(() => {});
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const [editForm, setEditForm] = useState<{
    amount: number;
    description: string;
    date: string;
    category: string;
    includeInTotal: boolean;
    payerId: string;
    payerDisplayName: string;
  }>({ amount: 0, description: "", date: "", category: "", includeInTotal: true, payerId: "", payerDisplayName: "" });
  // Flag to prevent re-triggering edit mode after user closes the editor
  const [editConsumed, setEditConsumed] = useState(false);

  // URLのeditパラメータで指定された支出を自動的に編集モードで開く
  // Note: This effect must be after the useState/useExpenses declarations to avoid TDZ
  useEffect(() => {
    // Only trigger once per editExpenseId - don't re-trigger after user cancels
    if (editExpenseId && expenses.length > 0 && !editingExpense && !editConsumed) {
      const expenseToEdit = expenses.find(e => e.id === editExpenseId);
      if (expenseToEdit) {
        console.log("Auto-opening edit mode for expense:", editExpenseId);
        setEditingExpense(expenseToEdit.id);
        setEditForm({
          amount: expenseToEdit.amount,
          description: expenseToEdit.description,
          date: expenseToEdit.date,
          category: expenseToEdit.category,
          includeInTotal: expenseToEdit.includeInTotal,
          payerId: expenseToEdit.payerId || expenseToEdit.lineId,
          payerDisplayName: expenseToEdit.payerDisplayName || expenseToEdit.userDisplayName || "",
        });
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
  const editingLineGroupId = editingExpenseData?.lineGroupId || null;
  
  // Try both group ID and LINE group ID based member fetching
  const { members: groupMembers, loading: membersLoading, error: membersError } = useGroupMembers(editingGroupId);
  const { members: lineGroupMembers, loading: lineGroupMembersLoading } = useLineGroupMembers(editingLineGroupId);
  
  // Get all users who have ever created expenses (across all groups)
  // 入力者と支払い者の両方を含める
  const allHistoricalUsers = useMemo(() => {
    const usersMap = new Map();

    console.log("=== allHistoricalUsers 生成中 ===");
    console.log("総支出件数:", expenses.length);

    expenses.forEach((expense, index) => {
      console.log(`支出[${index}]:`, {
        id: expense.id,
        lineId: expense.lineId,
        userDisplayName: expense.userDisplayName,
        payerId: expense.payerId,
        payerDisplayName: expense.payerDisplayName
      });

      // 入力者を追加
      if (expense.lineId && expense.userDisplayName && expense.userDisplayName !== "個人") {
        console.log(`入力者追加: ${expense.lineId} -> ${expense.userDisplayName}`);
        usersMap.set(expense.lineId, {
          lineId: expense.lineId,
          displayName: expense.userDisplayName
        });
      }

      // 支払い者を追加（入力者と異なる場合）
      if (expense.payerId && expense.payerDisplayName &&
          expense.payerDisplayName !== "個人" &&
          expense.payerId !== expense.lineId) {
        console.log(`支払い者追加: ${expense.payerId} -> ${expense.payerDisplayName}`);
        usersMap.set(expense.payerId, {
          lineId: expense.payerId,
          displayName: expense.payerDisplayName
        });
      }
    });

    const result = Array.from(usersMap.values());
    console.log("allHistoricalUsers 結果:", result);
    return result;
  }, [expenses]);
  
  // Get users who have expense history in this specific group
  // 入力者と支払い者の両方を含める
  const groupExpenseUsers = useMemo(() => {
    if (!editingExpenseData) return [];

    const groupFilter = editingExpenseData.groupId
      ? (e: Expense) => e.groupId === editingExpenseData.groupId
      : editingExpenseData.lineGroupId
      ? (e: Expense) => e.lineGroupId === editingExpenseData.lineGroupId
      : () => false;

    const usersMap = new Map();

    expenses
      .filter(groupFilter)
      .forEach(expense => {
        // 入力者を追加
        if (expense.lineId && expense.userDisplayName && expense.userDisplayName !== "個人") {
          usersMap.set(expense.lineId, {
            lineId: expense.lineId,
            displayName: expense.userDisplayName
          });
        }

        // 支払い者を追加（入力者と異なる場合）
        if (expense.payerId && expense.payerDisplayName &&
            expense.payerDisplayName !== "個人" &&
            expense.payerId !== expense.lineId) {
          usersMap.set(expense.payerId, {
            lineId: expense.payerId,
            displayName: expense.payerDisplayName
          });
        }
      });

    return Array.from(usersMap.values());
  }, [expenses, editingExpenseData]);
  
  // Combine all available users: formal group members, group history users, and all historical users
  // 支出履歴のdisplayNameを優先（より正確な名前が入っている）
  const availableMembers = useMemo(() => {
    const formalMembers = groupMembers.length > 0 ? groupMembers : lineGroupMembers;
    const combinedMap = new Map();

    // Priority 1: Add formal group members (メンバーシップ情報として追加)
    formalMembers.forEach(member => {
      combinedMap.set(member.lineId, {
        lineId: member.lineId,
        displayName: member.displayName,
        source: 'group'
      });
    });

    // Priority 2: Add/Update users from this group's expense history
    // 支出履歴のdisplayNameで上書き（より正確）
    groupExpenseUsers.forEach(user => {
      const existing = combinedMap.get(user.lineId);
      if (existing) {
        // 既存のグループメンバーがいる場合、displayNameだけ更新
        combinedMap.set(user.lineId, {
          ...existing,
          displayName: user.displayName, // 支出履歴の名前を優先
          source: 'group' // グループメンバーとして保持
        });
      } else {
        // 新規追加
        combinedMap.set(user.lineId, {
          lineId: user.lineId,
          displayName: user.displayName,
          source: 'group-history'
        });
      }
    });

    // Priority 3: Add/Update all historical users (from any group)
    allHistoricalUsers.forEach(user => {
      const existing = combinedMap.get(user.lineId);
      if (existing) {
        // 既存のユーザーがいる場合、displayNameが「メンバー」なら更新
        if (existing.displayName === 'メンバー' || existing.displayName.startsWith('Unknown_')) {
          combinedMap.set(user.lineId, {
            ...existing,
            displayName: user.displayName
          });
        }
      } else {
        // 新規追加
        combinedMap.set(user.lineId, {
          lineId: user.lineId,
          displayName: user.displayName,
          source: 'all-history'
        });
      }
    });

    return Array.from(combinedMap.values());
  }, [groupMembers, lineGroupMembers, groupExpenseUsers, allHistoricalUsers]);
  
  // Debug logging - より詳細な情報を追加
  if (editingExpense) {
    console.log("=== EXPENSE EDITING DEBUG (詳細版) ===");
    console.log("編集中の支出ID:", editingExpense);
    console.log("全支出データ数:", expenses.length);
    console.log("全支出データ（最初の5件）:", expenses.slice(0, 5).map(e => ({
      id: e.id,
      userDisplayName: e.userDisplayName,
      groupId: e.groupId,
      lineGroupId: e.lineGroupId,
      lineId: e.lineId,
      payerId: e.payerId,
      payerDisplayName: e.payerDisplayName
    })));
    
    console.log("--- 編集中の支出データ ---");
    console.log("EditingExpenseData:", editingExpenseData);
    console.log("EditingGroupId:", editingGroupId);
    console.log("EditingLineGroupId:", editingLineGroupId);
    
    console.log("--- ユーザー取得結果 ---");
    console.log("GroupMembers (正式メンバー):", groupMembers);
    console.log("LineGroupMembers (LINEグループメンバー):", lineGroupMembers);
    console.log("GroupExpenseUsers (このグループの履歴):", groupExpenseUsers);
    console.log("AllHistoricalUsers (全履歴ユーザー):", allHistoricalUsers);
    console.log("AvailableMembers (最終的な選択肢):", availableMembers);
    
    console.log("--- ローディング状態 ---");
    console.log("MembersLoading:", membersLoading);
    console.log("LineGroupMembersLoading:", lineGroupMembersLoading);
    console.log("MembersError:", membersError);
    
    // 選択肢の詳細を表示
    console.log("--- 選択肢の内訳 ---");
    const groupCount = availableMembers.filter(m => m.source === 'group').length;
    const groupHistoryCount = availableMembers.filter(m => m.source === 'group-history').length;
    const allHistoryCount = availableMembers.filter(m => m.source === 'all-history').length;
    console.log(`グループメンバー: ${groupCount}人`);
    console.log(`このグループの履歴: ${groupHistoryCount}人`);
    console.log(`他グループの履歴: ${allHistoryCount}人`);
    console.log(`合計: ${availableMembers.length}人`);
    
    console.log("=== END DEBUG ===");
  }


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

  const filteredExpenses = expenses.filter((expense) => {
    if (filter === "all") return true;
    if (filter === "included") return expense.includeInTotal;
    if (filter === "excluded") return !expense.includeInTotal;
    return expense.category === filter;
  });

  const sortedExpenses = [...filteredExpenses].sort((a, b) => {
    if (sortBy === "date") {
      return dayjs(b.date).valueOf() - dayjs(a.date).valueOf();
    }
    return b.amount - a.amount;
  });

  const categories = [...new Set(expenses.map((e) => e.category))];
  // カテゴリ編集の選択肢は正準カテゴリ（bot/分類器と統一）。
  // データ内の既存カテゴリや編集中の現在値も取り込み、未知カテゴリでも
  // 先頭（食費）に勝手に落ちないようにする。
  // 注: この関数は早期returnより後ろにあるため、Hook(useMemo)ではなく純粋計算で構築する。
  const allCategories = (() => {
    const set = new Set<string>(CANONICAL_CATEGORIES);
    categories.forEach((c) => {
      if (c) set.add(c);
    });
    if (editForm.category) set.add(editForm.category);
    return Array.from(set);
  })();

  // 支払い者名の解決ルール（金額/件数/チップ表示で共通利用）。
  // - クレジットカード通知（Gmail自動取得）由来は「クレジットカード」にまとめる
  // - payerDisplayName を最優先、不明系は支出履歴から表示名を補完
  const resolvePayerName = (expense: Expense): string => {
    if (expense.inputSource === 'gmail_auto') {
      return 'クレジットカード';
    }
    const payerId = expense.payerId || expense.lineId;
    let payerName = expense.payerDisplayName || expense.userDisplayName || "個人";
    if (payerName === 'メンバー' || payerName === '個人' || payerName.startsWith('Unknown_') || payerName.startsWith('User_')) {
      const historicalUser = allHistoricalUsers.find(u => u.lineId === payerId);
      if (historicalUser) {
        payerName = historicalUser.displayName;
      }
    }
    return payerName;
  };

  // Calculate individual person totals based on payer
  const personTotals = filteredExpenses.reduce((acc, expense) => {
    const payerName = resolvePayerName(expense);

    // 承認済みの項目のみ合計に含める
    if (expense.includeInTotal) {
      acc[payerName] = (acc[payerName] || 0) + expense.amount;
    }
    return acc;
  }, {} as Record<string, number>);

  const sortedPersonTotals = Object.entries(personTotals).sort(
    (a, b) => b[1] - a[1]
  );

  // Debug log for person totals
  console.log("Person totals:", personTotals);
  console.log(
    "Filtered expenses:",
    filteredExpenses.map((e) => ({
      userDisplayName: e.userDisplayName,
      amount: e.amount,
      description: e.description,
    }))
  );


  const handleEditStart = (expense: Expense) => {
    console.log("Edit button clicked for expense:", expense.id);
    console.log("Original expense data:", expense);
    
    setEditingExpense(expense.id);
    const formData = {
      amount: expense.amount,
      description: expense.description,
      date: expense.date,
      category: expense.category,
      includeInTotal: expense.includeInTotal,
      payerId: expense.payerId || expense.lineId,
      payerDisplayName: expense.payerDisplayName || expense.userDisplayName || "",
    };
    
    console.log("Setting edit form data:", formData);
    setEditForm(formData);
  };

  const handleEditCancel = () => {
    setEditingExpense(null);
    setEditForm({
      amount: 0,
      description: "",
      date: "",
      category: "",
      includeInTotal: true,
      payerId: "",
      payerDisplayName: "",
    });
  };

  // Keep the latest cancel handler available to the keydown listener.
  closeDrawerRef.current = handleEditCancel;

  const handleEditSave = async (id: string) => {
    try {
      console.log("=== SAVE DEBUG ===");
      console.log("Saving expense with data:", {
        id,
        editForm,
        originalExpense: editingExpenseData
      });
      
      const updateData = {
        ...editForm,
        updatedAt: new Date(),
      };
      
      console.log("Update data being sent:", updateData);
      
      await updateExpense(id, updateData);
      console.log("Save successful");
      setEditingExpense(null);
    } catch (error) {
      console.error("保存エラー:", error);
      alert(`保存に失敗しました: ${error instanceof Error ? error.message : '不明なエラー'}`);
    }
  };

  const handleEditInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value, type } = e.target;
    if (name === "payerId") {
      // 支払い者IDが変更されたら、対応する表示名も更新
      const selectedMember = availableMembers.find(member => member.lineId === value);
      const selectedFromHistory = expenses.find(expense => expense.lineId === value);
      const displayName = selectedMember?.displayName || selectedFromHistory?.userDisplayName || value;
      
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
    console.log("handleDeleteExpense called with id:", id);
    if (confirm("この支出を削除しますか？")) {
      try {
        console.log("Attempting to delete expense:", id);
        await deleteExpense(id);
        console.log("Expense deleted successfully:", id);
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
        {/* Controls — period navigation is ALWAYS visible so users can move
            between months even when the current period has no expenses.
            Filter/sort and totals only appear once there is data. */}
        <div className="glass mb-4 rounded-2xl p-4 shadow-glass">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Period navigation (always) */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setCurrentMonth(prev => prev.subtract(1, 'month'))}
                className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-card text-muted transition-colors hover:bg-fg/5 hover:text-fg"
                aria-label="前の期間"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="whitespace-nowrap rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-fg">
                {getDisplayTitle(currentMonth, dateSettings)}
              </div>
              <button
                onClick={() => setCurrentMonth(prev => prev.add(1, 'month'))}
                className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-card text-muted transition-colors hover:bg-fg/5 hover:text-fg"
                aria-label="次の期間"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {/* Filter & sort (only with data) */}
            {expenses.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
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
                  onChange={(e) => setSortBy(e.target.value as "date" | "amount")}
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
          {expenses.length > 0 && (
            <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-stretch">
              {sortedPersonTotals.length > 0 && (
                <div className="grid flex-1 grid-cols-3 gap-3 lg:grid-cols-4">
                  {sortedPersonTotals.map(([personName, total]) => (
                    <div key={personName} className="rounded-xl border border-line bg-fg/[0.02] p-3">
                      <div className="text-center">
                        <div className="mb-1 truncate text-sm font-medium text-fg">{personName}</div>
                        <div className="text-lg font-bold tabular-nums text-accent">¥{total.toLocaleString()}</div>
                        <div className="text-xs text-muted">
                          {
                            filteredExpenses.filter(
                              (e) => resolvePayerName(e) === personName
                            ).length
                          }
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
                  <div className="text-sm font-semibold text-fg">{filteredExpenses.length}件</div>
                  <div className="my-1 text-2xl font-black tabular-nums text-fg">
                    ¥{filteredExpenses.filter(e => e.includeInTotal).reduce((sum, e) => sum + e.amount, 0).toLocaleString()}
                  </div>
                  <div className="text-xs text-muted">合計総支出額</div>
                  {filteredExpenses.some(e => !e.includeInTotal) && (
                    <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                      除外: {filteredExpenses.filter(e => !e.includeInTotal).length}件
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

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
            // フィルタで0件
            <div className="glass rounded-2xl p-10 text-center shadow-glass">
              <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-fg/5 text-muted">
                <Inbox className="h-7 w-7" strokeWidth={1.8} />
              </span>
              <h3 className="text-base font-semibold text-fg">
                条件に一致する支出がありません
              </h3>
              <p className="mt-1.5 text-sm text-muted">
                フィルターや期間を変更してみてください。
              </p>
            </div>
          )
        ) : (
          <div className="space-y-3">
            {sortedExpenses.map((expense) => (
              <div
                key={expense.id}
                id={`expense-${expense.id}`}
                className={`glass overflow-hidden rounded-2xl border-l-4 shadow-glass transition-shadow hover:shadow-glass-lg ${
                  !expense.includeInTotal ? "border-l-amber-400" : "border-l-accent"
                } ${editingExpense === expense.id ? "ring-2 ring-ring" : ""}`}
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
                        {expense.userDisplayName &&
                          expense.userDisplayName !== "個人" && (
                            <span className="rounded-md bg-fg/5 px-2 py-0.5 text-xs font-medium text-muted">
                              入力: {expense.userDisplayName}
                            </span>
                          )}
                        {(() => {
                          // 支払い者の名前を共通ルールで解決（金額/件数集計と一致させる）
                          const isDefaultPayer = !expense.payerId || expense.payerId === expense.lineId;
                          const isCardSource = expense.inputSource === 'gmail_auto';
                          const payerName = resolvePayerName(expense);

                          return payerName !== "個人" && (
                            <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
                              isCardSource
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
                                    ¥{item.price.toLocaleString()}
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
                        {/* 合計に含める/除外する切り替えボタン */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            console.log("Toggle include in total clicked");
                            updateExpense(expense.id, { includeInTotal: !expense.includeInTotal });
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
                            console.log(
                              "Edit button clicked for expense:",
                              expense.id
                            );
                            handleEditStart(expense);
                          }}
                          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-fg/5"
                          style={{ pointerEvents: "auto" }}
                        >
                          <Pencil className="h-4 w-4" />
                          編集
                        </button>

                        {/* レシート: 編集の隣に並べて発見しやすく。新規タブではなくアプリ内でプレビュー */}
                        {expense.receiptUrl ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              // URLを正規化し https/blob のみ採用（XSS対策・CodeQLサニタイズ）
                              const safe = toSafeImageUrl(expense.receiptUrl);
                              if (safe) setReceiptPreview({ url: safe, expenseId: expense.id });
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

                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            console.log(
                              "Delete button clicked for expense:",
                              expense.id
                            );
                            handleDeleteExpense(expense.id);
                          }}
                          className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-rose-600 transition-colors hover:bg-rose-500/10 dark:text-rose-400"
                          style={{ pointerEvents: "auto" }}
                        >
                          <Trash2 className="h-4 w-4" />
                          削除
                        </button>
                      </div>
                    </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Edit drawer — mobile: bottom sheet / desktop: right side drawer */}
        {editingExpense && (
          <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="支出の編集">
            <button
              type="button"
              aria-label="閉じる"
              onClick={handleEditCancel}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <div
              ref={drawerRef}
              tabIndex={-1}
              className="glass-strong relative z-10 ml-auto flex w-full animate-fade-up flex-col overflow-y-auto p-5 shadow-glass-lg outline-hidden max-sm:mt-auto max-sm:max-h-[88vh] max-sm:rounded-t-2xl sm:h-full sm:max-w-md sm:rounded-l-2xl"
            >
              <div className="space-y-5">
                <div className="flex items-center justify-between border-b border-line pb-3">
                  <h4 className="text-base font-semibold text-fg">支出の編集</h4>
                  <button
                    type="button"
                    aria-label="閉じる"
                    onClick={handleEditCancel}
                    className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-fg/5 hover:text-fg"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="mb-2 block text-sm font-medium text-fg">説明</label>
                    <input
                      type="text"
                      name="description"
                      value={editForm.description}
                      onChange={handleEditInputChange}
                      className="w-full rounded-lg border border-line bg-card px-4 py-3 text-base text-fg focus:border-transparent focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="例: ランチ代"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-fg">金額 (円)</label>
                    <input
                      type="number"
                      name="amount"
                      value={editForm.amount}
                      onChange={handleEditInputChange}
                      className="w-full rounded-lg border border-line bg-card px-4 py-3 text-base text-fg focus:border-transparent focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="1000"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-fg">日付</label>
                    <input
                      type="date"
                      name="date"
                      value={editForm.date}
                      onChange={handleEditInputChange}
                      className="w-full rounded-lg border border-line bg-card px-4 py-3 text-base text-fg focus:border-transparent focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-fg">カテゴリ</label>
                    <select
                      name="category"
                      value={editForm.category}
                      onChange={handleEditInputChange}
                      className="w-full rounded-lg border border-line bg-card px-4 py-3 text-base text-fg focus:border-transparent focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {allCategories.map((category) => (
                        <option key={category} value={category}>{category}</option>
                      ))}
                    </select>
                  </div>

                  <div className="sm:col-span-2">
                    <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-fg">
                      <CreditCard className="h-4 w-4 text-muted" />
                      支払い者
                    </label>
                    <select
                      name="payerId"
                      value={editForm.payerId}
                      onChange={handleEditInputChange}
                      className="w-full rounded-lg border border-line bg-card px-4 py-3 text-base text-fg focus:border-transparent focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {(() => {
                        // 候補を重複排除で構築し、現在の支払い者と入力者を必ず含める
                        // （選択中の値に対応する option が消えて意図しない支払い者へ
                        // 変わってしまうのを防ぐ）。
                        const map = new Map<string, string>();
                        if (editingExpenseData?.lineId) {
                          map.set(
                            editingExpenseData.lineId,
                            `${editingExpenseData.userDisplayName || "入力者"}（入力者）`,
                          );
                        }
                        if (availableMembers.length > 0) {
                          availableMembers.forEach((member) => {
                            const label =
                              member.source === "group" ? "（グループメンバー）"
                              : member.source === "group-history" ? "（このグループ）"
                              : member.source === "all-history" ? "（他グループ）"
                              : "";
                            if (!map.has(member.lineId)) map.set(member.lineId, `${member.displayName}${label}`);
                          });
                        } else {
                          expenses.forEach((exp) => {
                            if (exp.userDisplayName && exp.userDisplayName !== "個人" && !map.has(exp.lineId)) {
                              map.set(exp.lineId, `${exp.userDisplayName}（支出履歴から）`);
                            }
                          });
                        }
                        if (editForm.payerId && !map.has(editForm.payerId)) {
                          map.set(editForm.payerId, editForm.payerDisplayName || "不明なユーザー");
                        }
                        return Array.from(map.entries()).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ));
                      })()}
                    </select>
                    <p className="mt-1 text-xs text-muted">デフォルトは入力者と同じです</p>
                  </div>
                </div>

                <label className="flex cursor-pointer items-center rounded-lg border border-line bg-card p-3">
                  <input
                    type="checkbox"
                    name="includeInTotal"
                    checked={editForm.includeInTotal}
                    onChange={handleEditCheckboxChange}
                    className="h-4 w-4 rounded border-line accent-accent"
                  />
                  <span className="ml-3 text-sm font-medium text-fg">合計に含める</span>
                </label>

                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => editingExpense && handleEditSave(editingExpense)}
                    className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-3 text-sm font-medium text-accent-fg transition-colors hover:opacity-90"
                  >
                    <Save className="h-4 w-4" />
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={handleEditCancel}
                    className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line bg-card px-4 py-3 text-sm font-medium text-fg transition-colors hover:bg-fg/5"
                  >
                    <X className="h-4 w-4" />
                    キャンセル
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* レシートのインラインプレビュー（新規タブで開かず、その場で表示＋差し替え） */}
        {receiptPreview && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-label="レシートプレビュー"
          >
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setReceiptPreview(null)}
              aria-hidden
            />
            <div className="glass-strong relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl shadow-glass">
              <div className="flex items-center justify-between border-b border-line/60 px-4 py-3">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                  <Paperclip className="h-4 w-4 text-amber-500" />
                  レシート
                </h2>
                <button
                  type="button"
                  onClick={() => setReceiptPreview(null)}
                  className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-fg/5"
                  aria-label="閉じる"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 overflow-auto bg-fg/[0.03] p-3">
                {isSafeImageUrl(receiptPreview.url) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={receiptPreview.url}
                    alt="レシート"
                    className="mx-auto max-h-[60vh] w-auto rounded-lg object-contain"
                  />
                ) : (
                  <p className="py-10 text-center text-sm text-muted">画像を表示できません</p>
                )}
              </div>
              <div className="flex gap-2 border-t border-line/60 p-3">
                <a
                  href={`/attach?expenseId=${encodeURIComponent(receiptPreview.expenseId)}`}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent/12 px-4 py-2.5 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
                >
                  <RefreshCw className="h-4 w-4" />
                  差し替え
                </a>
                {isSafeImageUrl(receiptPreview.url) && (
                  <a
                    href={receiptPreview.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1.5 rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-fg/5"
                  >
                    <ExternalLink className="h-4 w-4" />
                    新しいタブ
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
