'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useLineAuth } from '@/lib/hooks';
import { 
  submitApprovalRequest, 
  getPendingApprovalRequest, 
  isApprover,
  ApprovalRequest
} from '@/lib/approvalSettings';

export default function RequestApprovalPage() {
  const { user, loading: authLoading } = useLineAuth();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<ApprovalRequest | null>(null);
  const [userIsApprover, setUserIsApprover] = useState(false);

  useEffect(() => {
    if (user) {
      checkStatus();
    }
  }, [user, checkStatus]);

  const checkStatus = useCallback(async () => {
    if (!user) return;
    
    try {
      setLoading(true);
      
      // 既に承認者かどうかチェック
      const approverStatus = await isApprover(user.uid);
      setUserIsApprover(approverStatus);
      
      if (!approverStatus) {
        // 保留中の申請があるかチェック
        const pending = await getPendingApprovalRequest(user.uid);
        setPendingRequest(pending);
      }
    } catch (error) {
      console.error('Error checking status:', error);
      setError('ステータスの確認に失敗しました');
    } finally {
      setLoading(false);
    }
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!user) {
      setError('ログインが必要です');
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      await submitApprovalRequest(
        user.uid,
        user.displayName || user.email || 'Unknown User',
        message.trim() || undefined
      );
      
      setSuccess('申請を送信しました。管理者の承認をお待ちください。');
      setMessage('');
      
      // ステータスを再確認
      await checkStatus();
      
    } catch (error: unknown) {
      console.error('Error submitting request:', error);
      const errorMessage = error instanceof Error ? error.message : '申請の送信に失敗しました';
      setError(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">ログインが必要です</h1>
          <p className="text-gray-600">承認者申請を行うにはログインしてください。</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">読み込み中...</p>
        </div>
      </div>
    );
  }

  // 既に承認者の場合
  if (userIsApprover) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md w-full bg-white rounded-lg shadow-md p-6 text-center">
          <div className="mb-6">
            <div className="mx-auto w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-4">承認者として登録済み</h1>
          <p className="text-gray-600 mb-6">
            あなたは既に承認者として登録されています。支出の承認業務を行うことができます。
          </p>
          <a 
            href="/expenses"
            className="inline-block bg-blue-600 text-white px-6 py-2 rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            支出管理に戻る
          </a>
        </div>
      </div>
    );
  }

  // 保留中の申請がある場合
  if (pendingRequest) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md w-full bg-white rounded-lg shadow-md p-6">
          <div className="text-center mb-6">
            <div className="mx-auto w-12 h-12 bg-yellow-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-4 text-center">申請処理中</h1>
          <div className="space-y-3 text-sm text-gray-600">
            <p><strong>申請日時:</strong> {pendingRequest.requestedAt?.toLocaleString()}</p>
            {pendingRequest.message && (
              <p><strong>申請理由:</strong> {pendingRequest.message}</p>
            )}
          </div>
          <p className="text-gray-600 mt-4 text-center">
            管理者による承認をお待ちください。承認されると通知が届きます。
          </p>
          <div className="mt-6 text-center">
            <button
              onClick={checkStatus}
              className="bg-blue-600 text-white px-6 py-2 rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              ステータスを更新
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 申請フォーム
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">承認者申請</h1>
            <p className="mt-2 text-gray-600">
              支出の承認権限を持つ承認者になるための申請を行います
            </p>
          </div>

          <div className="bg-blue-50 border-l-4 border-blue-400 p-4 mb-6">
            <div className="flex">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                <p className="text-sm text-blue-700">
                  <strong>注意:</strong> 承認者になると、他のユーザーの支出を承認・拒否する権限を持ちます。
                  申請は管理者による審査が必要です。
                </p>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="mb-6">
              <label htmlFor="user-info" className="block text-sm font-medium text-gray-700 mb-2">
                申請者情報
              </label>
              <div className="p-3 bg-gray-50 rounded-md">
                <p className="text-sm text-gray-600">
                  <strong>名前:</strong> {user.displayName || user.email || 'Unknown User'}
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  <strong>ユーザーID:</strong> {user.uid}
                </p>
              </div>
            </div>

            <div className="mb-6">
              <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-2">
                申請理由・メッセージ（任意）
              </label>
              <textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="承認者になりたい理由や、管理者へのメッセージを入力してください（任意）"
              />
              <p className="mt-1 text-sm text-gray-500">
                {message.length}/500文字
              </p>
            </div>

            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}

            {success && (
              <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-md">
                <p className="text-sm text-green-600">{success}</p>
              </div>
            )}

            <div className="flex space-x-4">
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? '送信中...' : '申請を送信'}
              </button>
              <a
                href="/expenses"
                className="flex-1 bg-gray-200 text-gray-700 py-2 px-4 rounded-md text-sm font-medium text-center hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                キャンセル
              </a>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}