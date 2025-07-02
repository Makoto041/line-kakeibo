'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useAuth, useExpenses } from '../../lib/hooks';
import dayjs from 'dayjs';

export default function ExpensesPage() {
  const { user, loading: authLoading, signInWithGoogle, signOut, isAnonymous } = useAuth();
  const { expenses, loading, error, updateExpense, deleteExpense } = useExpenses(user?.uid || null);
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState<'date' | 'amount'>('date');
  const [showUserMenu, setShowUserMenu] = useState(false);

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

  const filteredExpenses = expenses.filter(expense => {
    if (filter === 'all') return true;
    if (filter === 'confirmed') return expense.confirmed;
    if (filter === 'unconfirmed') return !expense.confirmed;
    return expense.category === filter;
  });

  const sortedExpenses = [...filteredExpenses].sort((a, b) => {
    if (sortBy === 'date') {
      return dayjs(b.date).valueOf() - dayjs(a.date).valueOf();
    }
    return b.amount - a.amount;
  });

  const categories = [...new Set(expenses.map(e => e.category))];

  const handleConfirmExpense = async (id: string) => {
    try {
      await updateExpense(id, { confirmed: true });
    } catch {
      alert('エラーが発生しました');
    }
  };

  const handleDeleteExpense = async (id: string) => {
    if (confirm('この支出を削除しますか？')) {
      try {
        await deleteExpense(id);
      } catch {
        alert('エラーが発生しました');
      }
    }
  };

  const handleGoogleSignIn = async () => {
    try {
      await signInWithGoogle();
      setShowUserMenu(false);
    } catch (error) {
      console.error('Sign in failed:', error);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      setShowUserMenu(false);
    } catch (error) {
      console.error('Sign out failed:', error);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <h1 className="text-2xl font-bold text-gray-900">支出一覧</h1>
            <div className="flex items-center space-x-4">
              <Link 
                href="/" 
                className="text-blue-600 hover:text-blue-800 font-medium"
              >
                ダッシュボード
              </Link>
              
              {/* User Menu */}
              <div className="relative">
                <button
                  onClick={() => setShowUserMenu(!showUserMenu)}
                  className="flex items-center space-x-2 px-3 py-2 rounded-md text-gray-700 hover:bg-gray-100 transition-colors"
                >
                  {isAnonymous ? (
                    <>
                      <div className="w-8 h-8 bg-gray-300 rounded-full flex items-center justify-center">
                        <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                      </div>
                      <span className="text-sm">ゲスト</span>
                    </>
                  ) : (
                    <>
                      {user?.photoURL ? (
                        <Image 
                          src={user.photoURL} 
                          alt="Profile" 
                          width={32}
                          height={32}
                          className="w-8 h-8 rounded-full"
                        />
                      ) : (
                        <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center">
                          <span className="text-white text-sm font-medium">
                            {user?.displayName?.charAt(0) || user?.email?.charAt(0) || 'U'}
                          </span>
                        </div>
                      )}
                      <span className="text-sm">{user?.displayName || user?.email}</span>
                    </>
                  )}
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                
                {showUserMenu && (
                  <div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg ring-1 ring-black ring-opacity-5 z-10">
                    <div className="py-1">
                      {isAnonymous ? (
                        <button
                          onClick={handleGoogleSignIn}
                          className="flex items-center w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                        >
                          <svg className="w-4 h-4 mr-3" viewBox="0 0 24 24">
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                          </svg>
                          Googleでサインイン
                        </button>
                      ) : (
                        <button
                          onClick={handleSignOut}
                          className="flex items-center w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                        >
                          <svg className="w-4 h-4 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                          </svg>
                          サインアウト
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Filters */}
        <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
          <div className="flex flex-wrap gap-4 items-center">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                フィルター
              </label>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="all">すべて</option>
                <option value="confirmed">確認済み</option>
                <option value="unconfirmed">未確認</option>
                {categories.map(category => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                並び順
              </label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'date' | 'amount')}
                className="border border-gray-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="date">日付順</option>
                <option value="amount">金額順</option>
              </select>
            </div>

            <div className="ml-auto">
              <div className="text-sm text-gray-600">
                合計: {filteredExpenses.length}件 / ¥{filteredExpenses.reduce((sum, e) => sum + e.amount, 0).toLocaleString()}
              </div>
            </div>
          </div>
        </div>

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
              <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-gray-900 mb-2">支出データがありません</h3>
            <p className="text-gray-600">
              {filter === 'all' ? 'LINEでレシートを送信して始めましょう！' : '選択した条件に一致する支出がありません'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {sortedExpenses.map((expense) => (
              <div
                key={expense.id}
                className={`bg-white rounded-lg shadow-sm border p-6 ${
                  !expense.confirmed ? 'border-l-4 border-l-yellow-400' : ''
                }`}
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-gray-900">
                        {expense.description}
                      </h3>
                      {!expense.confirmed && (
                        <span className="bg-yellow-100 text-yellow-800 text-xs font-medium px-2.5 py-0.5 rounded">
                          未確認
                        </span>
                      )}
                      <span className="bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-0.5 rounded">
                        {expense.category}
                      </span>
                    </div>
                    
                    <div className="text-sm text-gray-600 mb-3">
                      <p>{dayjs(expense.date).format('YYYY年M月D日 (ddd)')}</p>
                      {expense.items && expense.items.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-blue-600 hover:text-blue-800">
                            商品詳細 ({expense.items.length}点)
                          </summary>
                          <ul className="mt-2 space-y-1 text-xs bg-gray-50 rounded p-2">
                            {expense.items.map((item, index) => (
                              <li key={index} className="flex justify-between">
                                <span>{item.name}</span>
                                <span>¥{item.price.toLocaleString()}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  </div>
                  
                  <div className="text-right">
                    <p className="text-2xl font-bold text-red-600 mb-3">
                      ¥{expense.amount.toLocaleString()}
                    </p>
                    
                    <div className="flex gap-2">
                      {!expense.confirmed && (
                        <button
                          onClick={() => handleConfirmExpense(expense.id)}
                          className="bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700 transition-colors"
                        >
                          確認
                        </button>
                      )}
                      
                      <Link
                        href={`/expenses/${expense.id}/edit`}
                        className="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700 transition-colors"
                      >
                        編集
                      </Link>
                      
                      <button
                        onClick={() => handleDeleteExpense(expense.id)}
                        className="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700 transition-colors"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}