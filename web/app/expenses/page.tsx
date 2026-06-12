"use client";

import React, { useState, useMemo, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useLineAuth, useExpenses, useGroupMembers, useLineGroupMembers } from "../../lib/hooks";
import type { Expense } from "../../lib/hooks";
import AppShell from "../../components/AppShell";
import dayjs from "dayjs";
import { getDateRangeSettings, getEffectiveDateRange, getDisplayTitle, DEFAULT_SETTINGS, type DateRangeSettings } from "../../lib/dateSettings";
import { doc, getDoc } from "firebase/firestore";
import { db, ensureFirebaseInitialized } from "../../lib/firebase";

export default function ExpensesPage() {
  return (
    <Suspense fallback={<ExpensesPageLoading />}>
      <ExpensesPageContent />
    </Suspense>
  );
}

function ExpensesPageLoading() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
    </div>
  );
}

const CATEGORY_ICONS: Record<string, string> = {
  "食費": "🍽",
  "交通費": "🚃",
  "日用品": "🛒",
  "娯楽": "🎮",
  "衣服": "👕",
  "医療・健康": "💊",
  "教育": "📚",
  "通信費": "📱",
  "光熱費": "💡",
  "美容・理容": "💇",
  "住居費": "🏠",
  "その他": "📌",
};

const ALL_CATEGORIES = [
  "食費", "交通費", "日用品", "娯楽", "衣服",
  "医療・健康", "教育", "通信費", "光熱費", "美容・理容", "その他",
];

function ExpensesPageContent() {
  const { user, loading: authLoading, getUrlWithLineId } = useLineAuth();
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>(DEFAULT_SETTINGS);
  const [currentMonth, setCurrentMonth] = useState(dayjs());
  const [dateRange, setDateRange] = useState<{startDate: string; endDate: string}>(() => {
    const range = getEffectiveDateRange(dayjs(), DEFAULT_SETTINGS);
    return { startDate: range.startDate, endDate: range.endDate };
  });
  const [dateSettingsLoaded, setDateSettingsLoaded] = useState(false);
  const [editMonthResolved, setEditMonthResolved] = useState(false);
  const [editMonthSet, setEditMonthSet] = useState(false);

  const searchParams = useSearchParams();
  const lineIdFromUrl = searchParams.get('lineId');
  const editExpenseId = searchParams.get('edit');
  const effectiveUserId = lineIdFromUrl || user?.uid || null;

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

  useEffect(() => {
    if (!editExpenseId || !dateSettingsLoaded || editMonthResolved || editMonthSet) return;
    const resolveEditExpenseMonth = async () => {
      try {
        ensureFirebaseInitialized();
        if (!db) { setEditMonthResolved(true); return; }
        const expenseDoc = await getDoc(doc(db, 'expenses', editExpenseId));
        if (expenseDoc.exists()) {
          const data = expenseDoc.data();
          if (data.date) {
            setCurrentMonth(dayjs(data.date));
            setEditMonthSet(true);
            return;
          }
        }
        setEditMonthResolved(true);
      } catch {
        setEditMonthResolved(true);
      }
    };
    resolveEditExpenseMonth();
  }, [editExpenseId, dateSettingsLoaded, editMonthResolved, editMonthSet]);

  useEffect(() => {
    const range = getEffectiveDateRange(currentMonth, dateSettings);
    setDateRange({ startDate: range.startDate, endDate: range.endDate });
  }, [currentMonth, dateSettings]);

  useEffect(() => {
    if (editMonthSet && !editMonthResolved) setEditMonthResolved(true);
  }, [dateRange, editMonthSet, editMonthResolved]);

  const shouldFetch = editExpenseId ? editMonthResolved : true;
  const { expenses, loading, error, updateExpense, deleteExpense } =
    useExpenses(shouldFetch ? effectiveUserId : null, 0, 500, dateRange.startDate);

  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"date" | "amount">("date");
  const [editingExpense, setEditingExpense] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    amount: 0, description: "", date: "", category: "", includeInTotal: true, payerId: "", payerDisplayName: "",
  });
  const [editConsumed, setEditConsumed] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    if (editExpenseId && expenses.length > 0 && !editingExpense && !editConsumed) {
      const expenseToEdit = expenses.find(e => e.id === editExpenseId);
      if (expenseToEdit) {
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
        setEditConsumed(true);
        setTimeout(() => {
          document.getElementById(`expense-${editExpenseId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
      }
    }
  }, [editExpenseId, expenses, editingExpense, editConsumed]);

  const editingExpenseData = editingExpense ? expenses.find(e => e.id === editingExpense) : null;
  const editingGroupId = editingExpenseData?.groupId || null;
  const editingLineGroupId = editingExpenseData?.lineGroupId || null;
  const { members: groupMembers } = useGroupMembers(editingGroupId);
  const { members: lineGroupMembers } = useLineGroupMembers(editingLineGroupId);

  const allHistoricalUsers = useMemo(() => {
    const usersMap = new Map();
    expenses.forEach(expense => {
      if (expense.lineId && expense.userDisplayName && expense.userDisplayName !== "個人") {
        usersMap.set(expense.lineId, { lineId: expense.lineId, displayName: expense.userDisplayName });
      }
      if (expense.payerId && expense.payerDisplayName && expense.payerDisplayName !== "個人" && expense.payerId !== expense.lineId) {
        usersMap.set(expense.payerId, { lineId: expense.payerId, displayName: expense.payerDisplayName });
      }
    });
    return Array.from(usersMap.values());
  }, [expenses]);

  const availableMembers = useMemo(() => {
    const formalMembers = groupMembers.length > 0 ? groupMembers : lineGroupMembers;
    const combinedMap = new Map();
    formalMembers.forEach(member => combinedMap.set(member.lineId, { lineId: member.lineId, displayName: member.displayName, source: 'group' }));
    const groupExpenses = editingExpenseData
      ? expenses.filter(e => editingExpenseData.groupId ? e.groupId === editingExpenseData.groupId : editingExpenseData.lineGroupId ? e.lineGroupId === editingExpenseData.lineGroupId : false)
      : [];
    groupExpenses.forEach(expense => {
      if (expense.lineId && expense.userDisplayName && expense.userDisplayName !== "個人") {
        const existing = combinedMap.get(expense.lineId);
        combinedMap.set(expense.lineId, { lineId: expense.lineId, displayName: expense.userDisplayName, source: existing ? 'group' : 'group-history' });
      }
    });
    allHistoricalUsers.forEach(user => {
      if (!combinedMap.has(user.lineId)) {
        combinedMap.set(user.lineId, { ...user, source: 'all-history' });
      }
    });
    return Array.from(combinedMap.values());
  }, [groupMembers, lineGroupMembers, expenses, editingExpenseData, allHistoricalUsers]);

  if (authLoading || (editExpenseId && !editMonthResolved)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-8 h-8 border-2 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
      </div>
    );
  }

  const filteredExpenses = expenses.filter(expense => {
    if (filter === "all") return true;
    if (filter === "included") return expense.includeInTotal;
    if (filter === "excluded") return !expense.includeInTotal;
    return expense.category === filter;
  });

  const sortedExpenses = [...filteredExpenses].sort((a, b) => {
    if (sortBy === "date") return dayjs(b.date).valueOf() - dayjs(a.date).valueOf();
    return b.amount - a.amount;
  });

  const categories = [...new Set(expenses.map(e => e.category))];
  const totalIncluded = filteredExpenses.filter(e => e.includeInTotal).reduce((sum, e) => sum + e.amount, 0);

  const personTotals = filteredExpenses.reduce((acc, expense) => {
    const payerId = expense.payerId || expense.lineId;
    let payerName = expense.payerDisplayName || expense.userDisplayName || "個人";
    if (['メンバー', '個人'].includes(payerName) || payerName.startsWith('Unknown_') || payerName.startsWith('User_')) {
      const hist = allHistoricalUsers.find(u => u.lineId === payerId);
      if (hist) payerName = hist.displayName;
    }
    if (expense.includeInTotal) acc[payerName] = (acc[payerName] || 0) + expense.amount;
    return acc;
  }, {} as Record<string, number>);
  const sortedPersonTotals = Object.entries(personTotals).sort((a, b) => b[1] - a[1]);

  const handleEditStart = (expense: Expense) => {
    setEditingExpense(expense.id);
    setEditForm({
      amount: expense.amount, description: expense.description, date: expense.date,
      category: expense.category, includeInTotal: expense.includeInTotal,
      payerId: expense.payerId || expense.lineId,
      payerDisplayName: expense.payerDisplayName || expense.userDisplayName || "",
    });
  };

  const handleEditSave = async (id: string) => {
    try {
      await updateExpense(id, { ...editForm, updatedAt: new Date() });
      setEditingExpense(null);
    } catch (error) {
      alert(`保存に失敗しました: ${error instanceof Error ? error.message : '不明なエラー'}`);
    }
  };

  const handleEditInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    if (name === "payerId") {
      const member = availableMembers.find(m => m.lineId === value);
      const fromExpenses = expenses.find(exp => exp.lineId === value);
      setEditForm(prev => ({ ...prev, payerId: value, payerDisplayName: member?.displayName || fromExpenses?.userDisplayName || value }));
    } else {
      setEditForm(prev => ({ ...prev, [name]: type === "number" ? Number(value) : value }));
    }
  };

  const groupExpensesByDate = (exps: typeof sortedExpenses) => {
    const groups: Record<string, typeof sortedExpenses> = {};
    exps.forEach(e => {
      const key = e.date;
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    });
    return Object.entries(groups).sort(([a], [b]) => dayjs(b).valueOf() - dayjs(a).valueOf());
  };

  const dateGroups = sortBy === "date" ? groupExpensesByDate(sortedExpenses) : null;

  return (
    <AppShell getUrlWithLineId={getUrlWithLineId} title="支出一覧">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {/* Month navigation + summary */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setCurrentMonth(prev => prev.subtract(1, 'month'))}
              className="w-9 h-9 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h2 className="text-lg font-semibold text-gray-900">
              {getDisplayTitle(currentMonth, dateSettings)}
            </h2>
            <button
              onClick={() => setCurrentMonth(prev => prev.add(1, 'month'))}
              className="w-9 h-9 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-2xl font-bold text-gray-900 tabular-nums">¥{totalIncluded.toLocaleString()}</p>
              <p className="text-xs text-gray-400 mt-0.5">{filteredExpenses.length}件の支出</p>
            </div>
            {sortedPersonTotals.length > 1 && (
              <div className="flex gap-3">
                {sortedPersonTotals.map(([name, total]) => (
                  <div key={name} className="text-right">
                    <p className="text-xs text-gray-400">{name}</p>
                    <p className="text-sm font-semibold text-gray-700 tabular-nums">¥{total.toLocaleString()}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border transition-colors ${
              filter !== 'all' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-white border-gray-200 text-gray-600'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z" />
            </svg>
            フィルター{filter !== 'all' ? ' (1)' : ''}
          </button>
          <button
            onClick={() => setSortBy(sortBy === "date" ? "amount" : "date")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm bg-white border border-gray-200 text-gray-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
            </svg>
            {sortBy === "date" ? "日付順" : "金額順"}
          </button>
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 space-y-3">
            <div className="flex flex-wrap gap-2">
              {[
                { value: "all", label: "すべて" },
                { value: "included", label: "合計に含む" },
                { value: "excluded", label: "除外" },
                ...categories.map(c => ({ value: c, label: c })),
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={`px-3 py-1 rounded-full text-sm transition-colors ${
                    filter === opt.value
                      ? 'bg-emerald-600 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Expense list */}
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-red-700 text-sm">{error}</p>
          </div>
        ) : sortedExpenses.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 text-sm">
              {filter === "all" ? "この期間に支出はありません" : "条件に一致する支出がありません"}
            </p>
          </div>
        ) : dateGroups ? (
          /* Date-grouped list */
          <div className="space-y-4">
            {dateGroups.map(([date, exps]) => (
              <div key={date}>
                <div className="flex items-center justify-between px-1 mb-2">
                  <p className="text-xs font-medium text-gray-400">
                    {dayjs(date).format("M月D日 (ddd)")}
                  </p>
                  <p className="text-xs text-gray-400 tabular-nums">
                    ¥{exps.filter(e => e.includeInTotal).reduce((s, e) => s + e.amount, 0).toLocaleString()}
                  </p>
                </div>
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
                  {exps.map(expense => (
                    <ExpenseRow
                      key={expense.id}
                      expense={expense}
                      isEditing={editingExpense === expense.id}
                      editForm={editForm}
                      onEditStart={() => handleEditStart(expense)}
                      onEditSave={() => handleEditSave(expense.id)}
                      onEditCancel={() => setEditingExpense(null)}
                      onEditChange={handleEditInputChange}
                      onCheckboxChange={(e) => setEditForm(prev => ({ ...prev, includeInTotal: e.target.checked }))}
                      onToggleInclude={() => updateExpense(expense.id, { includeInTotal: !expense.includeInTotal })}
                      onDelete={() => { if (confirm("この支出を削除しますか？")) deleteExpense(expense.id); }}
                      availableMembers={availableMembers}
                      allHistoricalUsers={allHistoricalUsers}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Flat list (amount sort) */
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
            {sortedExpenses.map(expense => (
              <ExpenseRow
                key={expense.id}
                expense={expense}
                isEditing={editingExpense === expense.id}
                editForm={editForm}
                onEditStart={() => handleEditStart(expense)}
                onEditSave={() => handleEditSave(expense.id)}
                onEditCancel={() => setEditingExpense(null)}
                onEditChange={handleEditInputChange}
                onCheckboxChange={(e) => setEditForm(prev => ({ ...prev, includeInTotal: e.target.checked }))}
                onToggleInclude={() => updateExpense(expense.id, { includeInTotal: !expense.includeInTotal })}
                onDelete={() => { if (confirm("この支出を削除しますか？")) deleteExpense(expense.id); }}
                availableMembers={availableMembers}
                allHistoricalUsers={allHistoricalUsers}
                showDate
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

interface ExpenseRowProps {
  expense: Expense;
  isEditing: boolean;
  editForm: { amount: number; description: string; date: string; category: string; includeInTotal: boolean; payerId: string; payerDisplayName: string };
  onEditStart: () => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onEditChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onCheckboxChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onToggleInclude: () => void;
  onDelete: () => void;
  availableMembers: Array<{ lineId: string; displayName: string; source?: string }>;
  allHistoricalUsers: Array<{ lineId: string; displayName: string }>;
  showDate?: boolean;
}

function ExpenseRow({
  expense, isEditing, editForm,
  onEditStart, onEditSave, onEditCancel, onEditChange, onCheckboxChange,
  onToggleInclude, onDelete, availableMembers, allHistoricalUsers, showDate,
}: ExpenseRowProps) {
  const [expanded, setExpanded] = useState(false);

  if (isEditing) {
    return (
      <div id={`expense-${expense.id}`} className="p-4 bg-emerald-50/50 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-500 mb-1">説明</label>
            <input type="text" name="description" value={editForm.description} onChange={onEditChange}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">金額</label>
            <input type="number" name="amount" value={editForm.amount} onChange={onEditChange}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">日付</label>
            <input type="date" name="date" value={editForm.date} onChange={onEditChange}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">カテゴリ</label>
            <select name="category" value={editForm.category} onChange={onEditChange}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
              {ALL_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_ICONS[c] || ""} {c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">支払い者</label>
            <select name="payerId" value={editForm.payerId} onChange={onEditChange}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
              {availableMembers.map(m => (
                <option key={m.lineId} value={m.lineId}>{m.displayName}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2 flex items-center gap-2">
            <input type="checkbox" checked={editForm.includeInTotal} onChange={onCheckboxChange}
              className="h-4 w-4 text-emerald-600 border-gray-300 rounded focus:ring-emerald-500" />
            <span className="text-sm text-gray-600">合計に含める</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onEditSave}
            className="flex-1 bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors">
            保存
          </button>
          <button onClick={onEditCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors">
            キャンセル
          </button>
        </div>
      </div>
    );
  }

  const payerId = expense.payerId || expense.lineId;
  let payerName = expense.payerDisplayName || expense.userDisplayName || "個人";
  if (['メンバー', '個人'].includes(payerName) || payerName.startsWith('Unknown_') || payerName.startsWith('User_')) {
    const hist = allHistoricalUsers.find(u => u.lineId === payerId);
    if (hist) payerName = hist.displayName;
  }

  const icon = CATEGORY_ICONS[expense.category] || "📌";

  return (
    <div
      id={`expense-${expense.id}`}
      className={`${!expense.includeInTotal ? 'opacity-50' : ''}`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors"
      >
        <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 text-base">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{expense.description}</p>
          <p className="text-xs text-gray-400">
            {showDate && <>{dayjs(expense.date).format("M/D")} · </>}
            {expense.category}
            {payerName !== "個人" && <> · {payerName}</>}
          </p>
        </div>
        <p className="text-sm font-semibold text-gray-900 tabular-nums flex-shrink-0">
          ¥{expense.amount.toLocaleString()}
        </p>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3">
          {expense.items && expense.items.length > 0 && (
            <div className="bg-gray-50 rounded-lg p-3 space-y-1">
              {expense.items.map((item, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-gray-600">{item.name}</span>
                  <span className="text-gray-900 tabular-nums">¥{item.price.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={onToggleInclude}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                expense.includeInTotal
                  ? 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
                  : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
              }`}>
              {expense.includeInTotal ? '除外する' : '含める'}
            </button>
            <button onClick={onEditStart}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors">
              編集
            </button>
            <button onClick={onDelete}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-600 hover:bg-red-50 transition-colors">
              削除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
