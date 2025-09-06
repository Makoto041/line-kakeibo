'use client';

import { useState, useEffect } from 'react';
import { getFirebaseStatus, testFirebaseConnection, retryFirebaseInitialization } from '@/lib/firebase';
import { collection, query, limit, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export default function FirebaseDebugPage() {
  const [status, setStatus] = useState<ReturnType<typeof getFirebaseStatus> | null>(null);
  const [connectionTest, setConnectionTest] = useState<{
    testing: boolean;
    success: boolean | null;
    message: string;
  }>({
    testing: false,
    success: null,
    message: ''
  });
  const [testData, setTestData] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    // Firebase状態を取得
    const currentStatus = getFirebaseStatus();
    setStatus(currentStatus);
  }, []);

  const handleConnectionTest = async () => {
    setConnectionTest({ testing: true, success: null, message: 'テスト中...' });
    
    try {
      const result = await testFirebaseConnection();
      
      if (result) {
        setConnectionTest({
          testing: false,
          success: true,
          message: '✅ Firebase接続テスト成功'
        });
        
        // サンプルデータを取得
        if (db) {
          try {
            const q = query(collection(db, 'expenses'), limit(5));
            const snapshot = await getDocs(q);
            const data = snapshot.docs.map(doc => ({
              id: doc.id,
              ...doc.data()
            }));
            setTestData(data);
          } catch (error) {
            console.error('サンプルデータ取得エラー:', error);
          }
        }
      } else {
        setConnectionTest({
          testing: false,
          success: false,
          message: '❌ Firebase接続テスト失敗'
        });
      }
    } catch (error) {
      setConnectionTest({
        testing: false,
        success: false,
        message: `❌ エラー: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
  };

  const handleRetryInitialization = () => {
    const newStatus = retryFirebaseInitialization();
    setStatus(newStatus);
    setConnectionTest({ testing: false, success: null, message: '' });
    setTestData([]);
  };

  const getEnvStatus = () => {
    const envVars = [
      { name: 'NEXT_PUBLIC_FIREBASE_API_KEY', value: process.env.NEXT_PUBLIC_FIREBASE_API_KEY },
      { name: 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', value: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN },
      { name: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID', value: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID },
      { name: 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', value: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET },
      { name: 'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID', value: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID },
      { name: 'NEXT_PUBLIC_FIREBASE_APP_ID', value: process.env.NEXT_PUBLIC_FIREBASE_APP_ID },
      { name: 'NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID', value: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID },
    ];

    return envVars.map(env => ({
      ...env,
      isSet: !!env.value,
      preview: env.value ? `${env.value.substring(0, 8)}...` : 'Not set'
    }));
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Firebase デバッグページ</h1>
      
      {/* Firebase初期化状態 */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">Firebase初期化状態</h2>
        {status && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span>初期化状態:</span>
              <span className={status.isInitialized ? 'text-green-600' : 'text-red-600'}>
                {status.isInitialized ? '✅ 初期化済み' : '❌ 未初期化'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>エラー状態:</span>
              <span className={status.hasError ? 'text-red-600' : 'text-green-600'}>
                {status.hasError ? '❌ エラーあり' : '✅ エラーなし'}
              </span>
            </div>
            {status.error && (
              <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded">
                <p className="text-red-700 text-sm">{status.error.message}</p>
              </div>
            )}
            <div className="mt-3 pt-3 border-t">
              <h3 className="font-medium mb-2">設定状態:</h3>
              <div className="space-y-1 text-sm">
                <div>Project ID: {status.config.projectId || 'Not set'}</div>
                <div>API Key: {status.config.hasApiKey ? '✅ 設定済み' : '❌ 未設定'}</div>
                <div>App ID: {status.config.hasAppId ? '✅ 設定済み' : '❌ 未設定'}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 環境変数チェック */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">環境変数チェック</h2>
        <div className="space-y-2">
          {getEnvStatus().map(env => (
            <div key={env.name} className="flex items-center justify-between text-sm">
              <code className="font-mono text-xs bg-gray-100 px-2 py-1 rounded">
                {env.name}
              </code>
              <span className={env.isSet ? 'text-green-600' : 'text-red-600'}>
                {env.isSet ? env.preview : env.preview}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 接続テスト */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">接続テスト</h2>
        <div className="space-y-4">
          <button
            onClick={handleConnectionTest}
            disabled={connectionTest.testing}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-400"
          >
            {connectionTest.testing ? 'テスト中...' : 'Firestore接続テスト'}
          </button>
          
          {connectionTest.message && (
            <div className={`p-3 rounded ${
              connectionTest.success 
                ? 'bg-green-50 border border-green-200' 
                : 'bg-red-50 border border-red-200'
            }`}>
              <p className={connectionTest.success ? 'text-green-700' : 'text-red-700'}>
                {connectionTest.message}
              </p>
            </div>
          )}
          
          {testData.length > 0 && (
            <div className="mt-4">
              <h3 className="font-medium mb-2">サンプルデータ (最大5件):</h3>
              <div className="bg-gray-50 p-3 rounded text-xs font-mono overflow-x-auto">
                <pre>{JSON.stringify(testData, null, 2)}</pre>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* アクション */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold mb-4">アクション</h2>
        <div className="space-y-4">
          <button
            onClick={handleRetryInitialization}
            className="px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600"
          >
            Firebase再初期化を試みる
          </button>
          
          <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded">
            <h3 className="font-medium text-blue-900 mb-2">トラブルシューティング:</h3>
            <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
              <li>環境変数が設定されていない場合は、Vercelダッシュボードで設定してください</li>
              <li>プロジェクトIDが正しいことを確認してください</li>
              <li>Firebaseコンソールでセキュリティルールを確認してください</li>
              <li>APIキーの制限設定を確認してください</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
