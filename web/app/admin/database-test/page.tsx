'use client'

import { useState } from 'react'
import { collection, addDoc, getDocs, query, where, limit } from 'firebase/firestore'
import { db } from '../../../lib/firebase'

export default function DatabaseTestPage() {
  const [testResult, setTestResult] = useState<string>('')
  const [loading, setLoading] = useState(false)

  const testFirebaseConnection = async () => {
    setLoading(true)
    setTestResult('')
    
    try {
      console.log('=== Firebase接続テスト開始 ===')
      
      if (!db) {
        setTestResult('❌ Firebase未初期化')
        return
      }
      
      // 1. テストデータの作成
      console.log('1. テストデータ作成中...')
      const testExpense = {
        lineId: 'test-user-123',
        lineGroupId: 'test-group-456',
        userDisplayName: 'テストユーザー',
        amount: 1500,
        description: 'テスト支出 - コーヒー',
        date: '2025-09-06',
        category: '食費',
        confirmed: false,
        createdAt: new Date(),
        updatedAt: new Date()
      }
      
      const docRef = await addDoc(collection(db, 'expenses'), testExpense)
      console.log('テストデータ作成成功:', docRef.id)
      
      // 2. データの読み取りテスト
      console.log('2. データ読み取りテスト...')
      const q = query(
        collection(db, 'expenses'),
        where('lineId', '==', 'test-user-123'),
        limit(5)
      )
      
      const querySnapshot = await getDocs(q)
      console.log('クエリ結果:', querySnapshot.docs.length, '件')
      
      let result = '✅ Firebase接続成功！\n\n'
      result += `📝 作成したテストデータ ID: ${docRef.id}\n`
      result += `📊 取得したデータ数: ${querySnapshot.docs.length}件\n\n`
      result += '📋 取得したデータ:\n'
      
      querySnapshot.docs.forEach((doc, index) => {
        const data = doc.data()
        result += `${index + 1}. ${data.description} - ¥${data.amount}\n`
        result += `   日付: ${data.date}, カテゴリ: ${data.category}\n`
        result += `   承認状態: ${data.confirmed ? '承認済み' : '未承認'}\n\n`
      })
      
      setTestResult(result)
      
    } catch (error) {
      console.error('Firebase接続エラー:', error)
      setTestResult(`❌ エラー: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  const createDummyData = async () => {
    setLoading(true)
    setTestResult('')
    
    try {
      if (!db) {
        setTestResult('❌ Firebase未初期化')
        return
      }
      
      console.log('=== ダミーデータ作成開始 ===')
      
      const dummyExpenses = [
        {
          lineId: 'U1234567890abcdef1234567890abcdef',
          lineGroupId: 'C1234567890abcdef1234567890abcdef',
          userDisplayName: '田中太郎',
          amount: 2500,
          description: '昼食 - ラーメン',
          date: '2025-09-06',
          category: '食費',
          confirmed: true,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        {
          lineId: 'U1234567890abcdef1234567890abcdef',
          lineGroupId: 'C1234567890abcdef1234567890abcdef',
          userDisplayName: '田中太郎',
          amount: 800,
          description: 'コンビニ - 飲み物',
          date: '2025-09-06',
          category: '食費',
          confirmed: false,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        {
          lineId: 'U2234567890abcdef1234567890abcdef',
          lineGroupId: 'C1234567890abcdef1234567890abcdef',
          userDisplayName: '佐藤花子',
          amount: 15000,
          description: '電気代',
          date: '2025-09-05',
          category: '光熱費',
          confirmed: true,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        {
          lineId: 'U1234567890abcdef1234567890abcdef',
          amount: 3500,
          description: '個人支出 - 本',
          date: '2025-09-04',
          category: '娯楽',
          confirmed: true,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        {
          lineId: 'U2234567890abcdef1234567890abcdef',
          lineGroupId: 'C1234567890abcdef1234567890abcdef',
          userDisplayName: '佐藤花子',
          amount: 4200,
          description: 'スーパー - 食材',
          date: '2025-09-03',
          category: '食費',
          confirmed: false,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ]
      
      let result = '📝 ダミーデータ作成中...\n\n'
      
      for (let i = 0; i < dummyExpenses.length; i++) {
        const expense = dummyExpenses[i]
        const docRef = await addDoc(collection(db, 'expenses'), expense)
        result += `${i + 1}. ${expense.description} - ¥${expense.amount} (${docRef.id})\n`
      }
      
      result += '\n✅ ダミーデータ作成完了！\n'
      result += '\n🔍 ダッシュボードでデータを確認してください。\n'
      result += '\n📊 作成されたデータ:\n'
      result += `- 承認済み: ${dummyExpenses.filter(e => e.confirmed).length}件\n`
      result += `- 未承認: ${dummyExpenses.filter(e => !e.confirmed).length}件\n`
      result += `- グループ支出: ${dummyExpenses.filter(e => e.lineGroupId).length}件\n`
      result += `- 個人支出: ${dummyExpenses.filter(e => !e.lineGroupId).length}件\n`
      
      setTestResult(result)
      
    } catch (error) {
      console.error('ダミーデータ作成エラー:', error)
      setTestResult(`❌ エラー: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">
          🔧 Firebase データベーステスト
        </h1>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <button
            onClick={testFirebaseConnection}
            disabled={loading}
            className="p-6 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 transition-colors"
          >
            {loading ? '実行中...' : '🔍 Firebase接続テスト'}
          </button>
          
          <button
            onClick={createDummyData}
            disabled={loading}
            className="p-6 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 transition-colors"
          >
            {loading ? '作成中...' : '📝 ダミーデータ作成'}
          </button>
        </div>
        
        {testResult && (
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold mb-4">テスト結果</h2>
            <pre className="bg-gray-100 p-4 rounded text-sm overflow-auto whitespace-pre-wrap">
              {testResult}
            </pre>
          </div>
        )}
        
        <div className="mt-8 bg-yellow-50 border border-yellow-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-yellow-800 mb-2">
            💡 使い方
          </h3>
          <ul className="text-yellow-700 space-y-2">
            <li>1. 「Firebase接続テスト」でデータベース接続を確認</li>
            <li>2. 「ダミーデータ作成」でテスト用のデータを作成</li>
            <li>3. ダッシュボードページで正常にデータが表示されるか確認</li>
            <li>4. 作成されたデータには承認済み・未承認の両方が含まれます</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
