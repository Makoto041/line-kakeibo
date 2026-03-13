"use client";

import React, { useState, useMemo, useEffect } from "react";
import { useLineAuth, useExpenses, useGroupMembers, useLineGroupMembers } from "../../lib/hooks";
import type { Expense } from "../../lib/hooks";
import Header from "../../components/Header";
import dayjs from "dayjs";
import { getDateRangeSettings, getEffectiveDateRange, getDisplayTitle, DEFAULT_SETTINGS, type DateRangeSettings } from "../../lib/dateSettings";

export default function ExpensesPage() {
  const { user, loading: authLoading, getUrlWithLineId } = useLineAuth();
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>(DEFAULT_SETTINGS);
  const [currentMonth, setCurrentMonth] = useState(dayjs());
  const [dateRange, setDateRange] = useState<{startDate: string; endDate: string} | null>(null);

  // URLからパラメータを取得
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const lineIdFromUrl = urlParams.get('lineId');
  const editExpenseId = urlParams.get('edit');
  
  console.log("=== EXPENSES PAGE DEBUG ===");
  console.log("user?.uid:", user?.uid);
  console.log("lineIdFromUrl:", lineIdFromUrl);
  console.log("user object:", user);
  
  // LINE IDがある場合は直接それを使用、なければuser.uidを使用
  const effectiveUserId = lineIdFromUrl || user?.uid || null;
  console.log("effectiveUserId:", effectiveUserId);

  // Load date settings from Firestore on mount
  useEffect(() => {
    const loadSettings = async () => {
      if (effectiveUserId && effectiveUserId !== 'guest') {
        const settings = await getDateRangeSettings(effectiveUserId);
        setDateSettings(settings);
      }
    };
    loadSettings();
  }, [effectiveUserId]);

  // Calculate effective date range when settings or currentMonth changes
  useEffect(() => {
    const range = getEffectiveDateRange(currentMonth, dateSettings);
    setDateRange({ startDate: range.startDate, endDate: range.endDate });
  }, [currentMonth, dateSettings]);

  const { expenses, loading, error, updateExpense, deleteExpense } =
    useExpenses(effectiveUserId, 0, 500, dateRange?.startDate); // Use custom date range
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"date" | "amount">("date");
  const [editingExpense, setEditingExpense] = useState<string | null>(null);
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


  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">読み込み中...</p>
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
  const allCategories = [
    "食費",
    "交通費",
    "日用品",
    "娯楽",
    "衣服",
    "医療・健康",
    "教育",
    "通信費",
    "光熱費",
    "美容・理容",
    "その他",
  ];

  // Calculate individual person totals based on payer
  const personTotals = filteredExpenses.reduce((acc, expense) => {
    // 支払い者ベースで集計
    const payerId = expense.payerId || expense.lineId;
    // payerDisplayNameを最優先で使用（userDisplayNameは使わない）
    let payerName = expense.payerDisplayName || expense.userDisplayName || "個人";

    // payerDisplayNameが「メンバー」「Unknown_」「User_」「個人」の場合、支出履歴から正しい名前を取得
    if (payerName === 'メンバー' || payerName === '個人' || payerName.startsWith('Unknown_') || payerName.startsWith('User_')) {
      const historicalUser = allHistoricalUsers.find(u => u.lineId === payerId);
      if (historicalUser) {
        payerName = historicalUser.displayName;
      }
    }

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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 relative overflow-hidden">
      {/* Glassmorphism background effects */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-20 left-10 w-72 h-72 bg-gradient-to-r from-blue-300/20 to-purple-300/20 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob pointer-events-none"></div>
        <div className="absolute top-40 right-10 w-72 h-72 bg-gradient-to-r from-purple-300/20 to-pink-300/20 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob animation-delay-2000 pointer-events-none"></div>
        <div className="absolute -bottom-8 left-20 w-72 h-72 bg-gradient-to-r from-pink-300/20 to-orange-300/20 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob animation-delay-4000 pointer-events-none"></div>
      </div>
      <Header 
        title="支出一覧" 
        getUrlWithLineId={getUrlWithLineId}
        currentPage="expenses"
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Filters - Compact Style */}
        <div className="bg-white/90 backdrop-blur-sm rounded-xl shadow-lg border border-gray-200 p-4 mb-6">
          <div className="flex flex-wrap items-center gap-4 justify-between">
            <div className="flex flex-wrap gap-4">
              <div className="min-w-0">
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  📂 フィルター
                </label>
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="border border-gray-300 bg-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">すべて</option>
                  <option value="included">合計に含む</option>
                  <option value="excluded">合計から除外</option>
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-0">
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  🔄 並び順
                </label>
                <select
                  value={sortBy}
                  onChange={(e) =>
                    setSortBy(e.target.value as "date" | "amount")
                  }
                  className="border border-gray-300 bg-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="date">日付順</option>
                  <option value="amount">金額順</option>
                </select>
              </div>

              <div className="min-w-0">
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  📅 期間
                </label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentMonth(prev => prev.subtract(1, 'month'))}
                    className="border border-gray-300 bg-white rounded-lg px-3 py-2 text-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    title="前月"
                  >
                    ◀
                  </button>
                  <div className="border border-gray-300 bg-white rounded-lg px-3 py-2 text-sm whitespace-nowrap">
                    {getDisplayTitle(currentMonth, dateSettings)}
                  </div>
                  <button
                    onClick={() => setCurrentMonth(prev => prev.add(1, 'month'))}
                    className="border border-gray-300 bg-white rounded-lg px-3 py-2 text-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    title="次月"
                  >
                    ▶
                  </button>
                </div>
              </div>
            </div>
            {sortedPersonTotals.length > 0 && (
                <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {sortedPersonTotals.map(([personName, total]) => (
                    <div
                      key={personName}
                      className="bg-gradient-to-r from-green-50 to-blue-50 rounded-lg p-4 border border-green-200"
                    >
                      <div className="text-center">
                        <div className="text-sm font-medium text-gray-700 mb-1">
                          {personName}
                        </div>
                        <div className="text-xl font-bold text-green-600">
                          ¥{total.toLocaleString()}
                        </div>
                        <div className="text-xs text-gray-500">
                          {
                            filteredExpenses.filter((e) => {
                              const payerId = e.payerId || e.lineId;
                              // payerDisplayNameを最優先で使用
                              let expensePayerName = e.payerDisplayName || e.userDisplayName || "個人";

                              // payerDisplayNameが「メンバー」「Unknown_」「User_」「個人」の場合、支出履歴から正しい名前を取得
                              if (expensePayerName === 'メンバー' || expensePayerName === '個人' || expensePayerName.startsWith('Unknown_') || expensePayerName.startsWith('User_')) {
                                const historicalUser = allHistoricalUsers.find(u => u.lineId === payerId);
                                if (historicalUser) {
                                  expensePayerName = historicalUser.displayName;
                                }
                              }

                              return expensePayerName === personName;
                            }).length
                          }
                          件
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
            )}

            <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-200">
              <div className="text-center">
                <div className="text-xs font-medium text-gray-600 mb-1">
                  💼 合計
                </div>
                <div className="text-lg font-bold text-blue-800">
                  {filteredExpenses.length}件
                </div>
                <div className="text-2xl font-black text-red-600 my-1">
                  ¥
                  {filteredExpenses
                    .filter(e => e.includeInTotal) // 合計に含むもののみ
                    .reduce((sum, e) => sum + e.amount, 0)
                    .toLocaleString()}
                </div>
                <div className="text-xs text-gray-500">合計総支出額</div>
                {filteredExpenses.some(e => !e.includeInTotal) && (
                  <div className="text-xs text-yellow-600 mt-1">
                    除外: {filteredExpenses.filter(e => !e.includeInTotal).length}件
                  </div>
                )}
                
              </div>
            </div>
          </div>
        </div>

        {/* Individual Person Totals */}
        {/* {sortedPersonTotals.length > 0 && (
          <div className="bg-white/90 backdrop-blur-sm rounded-xl shadow-lg border border-gray-200 p-4 mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              👥 個人別合計
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {sortedPersonTotals.map(([personName, total]) => (
                <div
                  key={personName}
                  className="bg-gradient-to-r from-green-50 to-blue-50 rounded-lg p-4 border border-green-200"
                >
                  <div className="text-center">
                    <div className="text-sm font-medium text-gray-700 mb-1">
                      {personName}
                    </div>
                    <div className="text-xl font-bold text-green-600">
                      ¥{total.toLocaleString()}
                    </div>
                    <div className="text-xs text-gray-500">
                      {
                        filteredExpenses.filter(
                          (e) => (e.userDisplayName || "個人") === personName
                        ).length
                      }
                      件
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )} */}

        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
            <p className="mt-4 text-gray-600">データを読み込み中...</p>
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800">{error}</p>
          </div>
        ) : sortedExpenses.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm border p-12 text-center">
            <div className="text-gray-400 mb-4">
              <svg
                className="w-16 h-16 mx-auto"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-gray-900 mb-2">
              支出データがありません
            </h3>
            <p className="text-gray-600">
              {filter === "all"
                ? "LINEでレシートを送信して始めましょう！"
                : "選択した条件に一致する支出がありません"}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {sortedExpenses.map((expense) => (
              <div
                key={expense.id}
                id={`expense-${expense.id}`}
                className={`bg-white rounded-xl shadow-sm border hover:shadow-md transition-shadow duration-200 overflow-hidden ${
                  !expense.includeInTotal
                    ? "border-l-4 border-l-yellow-400 bg-gradient-to-r from-yellow-50 to-white"
                    : "border-l-4 border-l-green-400 bg-gradient-to-r from-green-50 to-white"
                } ${editingExpense === expense.id ? "ring-2 ring-blue-500" : ""}`}
              >
                <div className="p-4 sm:p-6">
                  {editingExpense === expense.id ? (
                    // Edit form
                    <div className="space-y-6 bg-gray-50 rounded-lg p-4">
                      <h4 className="text-lg font-semibold text-gray-900 border-b border-gray-200 pb-2">
                        支出の編集
                      </h4>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="sm:col-span-2">
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            説明
                          </label>
                          <input
                            type="text"
                            name="description"
                            value={editForm.description}
                            onChange={handleEditInputChange}
                            className="w-full border border-gray-300 rounded-lg px-4 py-3 text-base text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            placeholder="例: ランチ代"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            金額 (円)
                          </label>
                          <input
                            type="number"
                            name="amount"
                            value={editForm.amount}
                            onChange={handleEditInputChange}
                            className="w-full border border-gray-300 rounded-lg px-4 py-3 text-base text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            placeholder="1000"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            日付
                          </label>
                          <input
                            type="date"
                            name="date"
                            value={editForm.date}
                            onChange={handleEditInputChange}
                            className="w-full border border-gray-300 rounded-lg px-4 py-3 text-base text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            カテゴリ
                          </label>
                          <select
                            name="category"
                            value={editForm.category}
                            onChange={handleEditInputChange}
                            className="w-full border border-gray-300 rounded-lg px-4 py-3 text-base text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          >
                            {allCategories.map((category) => (
                              <option key={category} value={category}>
                                {category}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="sm:col-span-2">
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            💳 支払い者
                          </label>
                          <select
                            name="payerId"
                            value={editForm.payerId}
                            onChange={handleEditInputChange}
                            className="w-full border border-gray-300 rounded-lg px-4 py-3 text-base text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          >
                            {/* availableMembersが空の場合、現在の支出リストから直接ユーザーを生成 */}
                            {availableMembers.length === 0 ? (
                              // フォールバック: 現在表示中の支出からユーザーを抽出
                              (() => {
                                console.log("=== フォールバック処理 ===");
                                console.log("availableMembers.length:", availableMembers.length);
                                console.log("expenses.length:", expenses.length);
                                
                                const fallbackUsers = new Map();
                                expenses.forEach(exp => {
                                  if (exp.lineId !== editingExpenseData?.lineId && exp.userDisplayName && exp.userDisplayName !== "個人") {
                                    fallbackUsers.set(exp.lineId, exp.userDisplayName);
                                  }
                                });
                                
                                // 支出データもない場合は、サンプルユーザーを追加（テスト用）
                                if (fallbackUsers.size === 0) {
                                  console.log("支出データなし - サンプルユーザーを追加");
                                  fallbackUsers.set("sample1", "田中太郎");
                                  fallbackUsers.set("sample2", "佐藤花子");
                                  fallbackUsers.set("sample3", "鈴木一郎");
                                }
                                
                                console.log("フォールバックユーザー:", Array.from(fallbackUsers.entries()));
                                return Array.from(fallbackUsers.entries()).map(([lineId, displayName]) => (
                                  <option key={lineId} value={lineId}>
                                    {displayName} {lineId.startsWith('sample') ? '(テスト)' : '(支出履歴から)'}
                                  </option>
                                ));
                              })()
                            ) : (
                              // 通常: availableMembersから選択肢を生成（自分も含める）
                              availableMembers
                                .map((member) => {
                                  let label = '';
                                  switch(member.source) {
                                    case 'group':
                                      label = '(グループメンバー)';
                                      break;
                                    case 'group-history':
                                      label = '(このグループ)';
                                      break;
                                    case 'all-history':
                                      label = '(他グループ)';
                                      break;
                                    default:
                                      label = '';
                                  }
                                  return (
                                    <option key={member.lineId} value={member.lineId}>
                                      {member.displayName} {label}
                                    </option>
                                  );
                                })
                            )}
                              
                            {/* 既存の支払い者が上記に含まれていない場合は追加 */}
                            {editForm.payerId && 
                             editForm.payerId !== editingExpenseData?.lineId &&
                             !availableMembers.some(member => member.lineId === editForm.payerId) &&
                             !expenses.some(expense => expense.lineId === editForm.payerId) && (
                              <option key={editForm.payerId} value={editForm.payerId}>
                                {editForm.payerDisplayName || "不明なユーザー"}
                              </option>
                            )}
                          </select>
                          <p className="text-xs text-gray-500 mt-1">
                            デフォルトは入力者と同じです
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center bg-white rounded-lg p-3 border border-gray-200">
                        <input
                          type="checkbox"
                          name="includeInTotal"
                          checked={editForm.includeInTotal}
                          onChange={handleEditCheckboxChange}
                          className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <label className="ml-3 text-sm font-medium text-gray-700">
                          合計に含める
                        </label>
                      </div>

                      <div className="flex flex-col sm:flex-row gap-4 pt-4">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            console.log(
                              "Save button clicked for expense:",
                              expense.id
                            );
                            handleEditSave(expense.id);
                          }}
                          className="bg-green-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600 transition-colors flex items-center gap-1 cursor-pointer"
                          style={{ pointerEvents: "auto" }}
                        >
                          <span className="text-sm">💾</span>
                          保存
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            console.log("Cancel button clicked");
                            handleEditCancel();
                          }}
                          className="bg-gray-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-600 transition-colors flex items-center gap-1 cursor-pointer"
                          style={{ pointerEvents: "auto" }}
                        >
                          <span className="text-sm">❌</span>
                          キャンセル
                        </button>
                      </div>
                    </div>
                  ) : (
                    // Display mode
                    <div className="space-y-4">
                      {/* Header with title and amount */}
                      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <h3 className="text-lg font-semibold text-gray-900 mb-2 break-words">
                            {expense.description}
                          </h3>
                          <p className="text-sm text-gray-600">
                            {dayjs(expense.date).format("YYYY年M月D日 (ddd)")}
                          </p>
                        </div>

                        <div className="flex-shrink-0">
                          <p className="text-xl sm:text-2xl font-bold text-red-600 text-right">
                            ¥{expense.amount.toLocaleString()}
                          </p>
                        </div>
                      </div>

                      {/* Tags */}
                      <div className="flex flex-wrap gap-2">
                        <span className="bg-gray-100 text-gray-800 text-xs font-medium px-2.5 py-0.5 rounded">
                          {expense.category}
                        </span>
                        {expense.userDisplayName &&
                          expense.userDisplayName !== "個人" && (
                            <span className="bg-green-100 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded">
                              👤 入力者: {expense.userDisplayName}
                            </span>
                          )}
                        {(() => {
                          // 支払い者の名前を取得（payerDisplayNameを最優先）
                          const payerId = expense.payerId || expense.lineId;
                          let payerName = expense.payerDisplayName || expense.userDisplayName || "個人";
                          const isDefaultPayer = !expense.payerId || expense.payerId === expense.lineId;

                          // payerDisplayNameが「メンバー」「Unknown_」「User_」「個人」の場合、支出履歴から正しい名前を取得
                          if (payerName === 'メンバー' || payerName === '個人' || payerName.startsWith('Unknown_') || payerName.startsWith('User_')) {
                            const historicalUser = allHistoricalUsers.find(u => u.lineId === payerId);
                            if (historicalUser) {
                              payerName = historicalUser.displayName;
                            }
                          }

                          return payerName !== "個人" && (
                            <span className={`text-xs font-medium px-2.5 py-0.5 rounded ${
                              isDefaultPayer
                                ? "bg-green-100 text-green-800"
                                : "bg-purple-100 text-purple-800"
                            }`}>
                              💳 支払い者: {payerName}
                            </span>
                          );
                        })()}
                        {expense.lineGroupId && (
                          <span className="bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-0.5 rounded">
                            📱 LINEグループ
                          </span>
                        )}
                        {!expense.includeInTotal && (
                          <span className="bg-red-100 text-red-800 text-xs font-medium px-2.5 py-0.5 rounded">
                            合計から除外
                          </span>
                        )}
                      </div>

                      {/* Items details */}
                      {expense.items && expense.items.length > 0 && (
                        <details className="group">
                          <summary className="cursor-pointer text-blue-600 hover:text-blue-800 text-sm font-medium list-none">
                            <div className="flex items-center gap-1">
                              <span className="group-open:rotate-90 transform transition-transform duration-200">
                                ▶
                              </span>
                              商品詳細 ({expense.items.length}点)
                            </div>
                          </summary>
                          <div className="mt-3 bg-gray-50 rounded-lg p-3">
                            <ul className="space-y-2">
                              {expense.items.map((item, index) => (
                                <li
                                  key={index}
                                  className="flex justify-between items-center text-sm"
                                >
                                  <span className="text-gray-700 flex-1 min-w-0 mr-2 break-words">
                                    {item.name}
                                  </span>
                                  <span className="text-gray-900 font-medium flex-shrink-0">
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
                        className="flex flex-wrap gap-2 pt-3 border-t border-gray-100"
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
                          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1 cursor-pointer ${
                            expense.includeInTotal 
                              ? "bg-green-500 text-white hover:bg-green-600"
                              : "bg-gray-500 text-white hover:bg-gray-600"
                          }`}
                          style={{ pointerEvents: "auto" }}
                        >
                          <span className="text-sm">
                            {expense.includeInTotal ? "✓" : "✗"}
                          </span>
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
                          className="bg-blue-500 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors flex items-center gap-1 cursor-pointer"
                          style={{ pointerEvents: "auto" }}
                        >
                          <span className="text-sm">✏️</span>
                          編集
                        </button>

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
                          className="bg-red-500 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-red-600 transition-colors flex items-center gap-1 cursor-pointer"
                          style={{ pointerEvents: "auto" }}
                        >
                          <span className="text-sm">🗑️</span>
                          削除
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
