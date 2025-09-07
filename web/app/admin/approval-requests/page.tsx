'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useLineAuth } from '@/lib/hooks';
import { 
  getApprovalRequests, 
  approveRequest, 
  rejectRequest,
  validateAdminPassword,
  ApprovalRequest,
  isApprover
} from '@/lib/approvalSettings';

export default function ApprovalRequestsPage() {
  const { user, loading: authLoading } = useLineAuth();
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [processingRequest, setProcessingRequest] = useState<string | null>(null);
  const [userIsApprover, setUserIsApprover] = useState(false);

  const checkApproverStatus = useCallback(async () => {
    if (!user) return;
    
    try {
      const approverStatus = await isApprover(user.uid);
      setUserIsApprover(approverStatus);
    } catch (error) {
      console.error('Error checking approver status:', error);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      checkApproverStatus();
    }
  }, [user, checkApproverStatus]);

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (validateAdminPassword(adminPassword)) {
      setIsAuthenticated(true);
      setError(null);
      fetchRequests();
    } else {
      setError('パスワードが正しくありません');
    }
  };

  const fetchRequests = async () => {
    try {
      setLoading(true);
      setError(null); // エラー状態をリセット
      const fetchedRequests = await getApprovalRequests();
      setRequests(fetchedRequests);
    } catch (error) {
      console.error('Error fetching requests:', error);
      
      // より詳細なエラー情報を提供
      if (error instanceof Error) {
        if (error.message.includes('permission-denied')) {
          setError('権限がありません。Firestore Security Rulesを確認してください。');
        } else if (error.message.includes('unavailable')) {
          setError('Firestoreサービスが利用できません。ネットワーク接続を確認してください。');
        } else {
          setError(`申請一覧の取得に失敗しました: ${error.message}`);
        }
      } else {
        setError('申請一覧の取得に失敗しました');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (requestId: string) => {
    if (!user || !requestId) return;
    
    setProcessingRequest(requestId);
    try {
      await approveRequest(requestId, user.uid);
      await fetchRequests(); // 一覧を再取得
      alert('申請を承認しました');
    } catch (error) {
      console.error('Error approving request:', error);
      alert('承認処理に失敗しました');
    } finally {
      setProcessingRequest(null);
    }
  };

  const handleReject = async (requestId: string) => {
    if (!user || !requestId) return;
    
    if (!confirm('この申請を拒否しますか？')) return;
    
    setProcessingRequest(requestId);
    try {
      await rejectRequest(requestId, user.uid);
      await fetchRequests(); // 一覧を再取得
      alert('申請を拒否しました');
    } catch (error) {
      console.error('Error rejecting request:', error);
      alert('拒否処理に失敗しました');
    } finally {
      setProcessingRequest(null);
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
          <p className="text-gray-600">承認者申請管理にアクセスするにはログインしてください。</p>
        </div>
      </div>
    );
  }

  if (!userIsApprover && !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md w-full bg-white rounded-lg shadow-md p-6">
          <h1 className="text-2xl font-bold text-gray-900 mb-6 text-center">管理者認証</h1>
          <form onSubmit={handlePasswordSubmit}>
            <div className="mb-4">
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                管理者パスワード
              </label>
              <input
                type="password"
                id="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
            {error && (
              <div className="mb-4 text-sm text-red-600">
                {error}
              </div>
            )}
            <button
              type="submit"
              className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              認証する
            </button>
          </form>
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

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">承認者申請管理</h1>
          <p className="mt-2 text-gray-600">
            承認者になりたいユーザーからの申請を確認・承認できます
          </p>
        </div>

        {requests.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-6 text-center">
            <p className="text-gray-500">承認者申請はありません</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-medium text-gray-900">申請一覧</h2>
            </div>
            <div className="divide-y divide-gray-200">
              {requests.map((request) => (
                <div key={request.id} className="px-6 py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center space-x-3">
                        <h3 className="text-lg font-medium text-gray-900">
                          {request.displayName}
                        </h3>
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                          request.status === 'pending' 
                            ? 'bg-yellow-100 text-yellow-800'
                            : request.status === 'approved'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-100 text-red-800'
                        }`}>
                          {request.status === 'pending' ? '保留中' : 
                           request.status === 'approved' ? '承認済み' : '拒否済み'}
                        </span>
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        申請日時: {request.requestedAt?.toLocaleString()}
                      </p>
                      {request.message && (
                        <p className="text-sm text-gray-700 mt-2">
                          メッセージ: {request.message}
                        </p>
                      )}
                      {request.processedAt && (
                        <p className="text-sm text-gray-500 mt-1">
                          処理日時: {request.processedAt.toLocaleString()}
                        </p>
                      )}
                    </div>
                    
                    {request.status === 'pending' && (
                      <div className="flex space-x-3">
                        <button
                          onClick={() => handleApprove(request.id!)}
                          disabled={processingRequest === request.id}
                          className="bg-green-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50"
                        >
                          {processingRequest === request.id ? '処理中...' : '承認'}
                        </button>
                        <button
                          onClick={() => handleReject(request.id!)}
                          disabled={processingRequest === request.id}
                          className="bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50"
                        >
                          {processingRequest === request.id ? '処理中...' : '拒否'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        <div className="mt-6 text-center">
          <button
            onClick={fetchRequests}
            className="bg-blue-600 text-white px-6 py-2 rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            一覧を更新
          </button>
        </div>
      </div>
    </div>
  );
}