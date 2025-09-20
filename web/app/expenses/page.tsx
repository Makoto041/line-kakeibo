"use client";

import React, { useState } from "react";
import { useLineAuth, useExpenses } from "../../lib/hooks";
import type { Expense } from "../../lib/hooks";
import Header from "../../components/Header";
import dayjs from "dayjs";

export default function ExpensesPage() {
  const { user, loading: authLoading, getUrlWithLineId } = useLineAuth();
  const [periodDays, setPeriodDays] = useState(30);

  const { expenses, loading, error, updateExpense, deleteExpense } =
    useExpenses(user?.uid || null, periodDays, 200);
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"date" | "amount">("date");
  const [editingExpense, setEditingExpense] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    amount: number;
    description: string;
    date: string;
    category: string;
    includeInTotal: boolean;
  }>({ amount: 0, description: "", date: "", category: "", includeInTotal: true });


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

  // Calculate individual person totals
  const personTotals = filteredExpenses.reduce((acc, expense) => {
    const personName = expense.userDisplayName || "個人";
    // 承認済みの項目のみ合計に含める
    if (expense.includeInTotal) {
      acc[personName] = (acc[personName] || 0) + expense.amount;
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
    setEditingExpense(expense.id);
    setEditForm({
      amount: expense.amount,
      description: expense.description,
      date: expense.date,
      category: expense.category,
      includeInTotal: expense.includeInTotal,
    });
  };

  const handleEditCancel = () => {
    setEditingExpense(null);
    setEditForm({
      amount: 0,
      description: "",
      date: "",
      category: "",
      includeInTotal: true,
    });
  };

  const handleEditSave = async (id: string) => {
    try {
      await updateExpense(id, {
        ...editForm,
        updatedAt: new Date(),
      });
      setEditingExpense(null);
    } catch {
      alert("保存に失敗しました");
    }
  };

  const handleEditInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value, type } = e.target;
    setEditForm((prev) => ({
      ...prev,
      [name]: type === "number" ? Number(value) : value,
    }));
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
                <select
                  value={periodDays}
                  onChange={(e) => setPeriodDays(Number(e.target.value))}
                  className="border border-gray-300 bg-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value={7}>過去7日</option>
                  <option value={30}>過去30日</option>
                  <option value={60}>過去60日</option>
                  <option value={90}>過去90日</option>
                  <option value={365}>過去1年</option>
                  <option value={0}>全期間</option>
                </select>
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
                            filteredExpenses.filter(
                              (e) =>
                                (e.userDisplayName || "個人") === personName
                            ).length
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
                className={`bg-white rounded-xl shadow-sm border hover:shadow-md transition-shadow duration-200 overflow-hidden ${
                  !expense.includeInTotal
                    ? "border-l-4 border-l-yellow-400 bg-gradient-to-r from-yellow-50 to-white"
                    : "border-l-4 border-l-green-400 bg-gradient-to-r from-green-50 to-white"
                }`}
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
                              👤 {expense.userDisplayName}
                            </span>
                          )}
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
