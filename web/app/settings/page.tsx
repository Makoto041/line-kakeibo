'use client';

import React, { useState, useEffect } from 'react';
import { useLineAuth } from '../../lib/hooks';
import { getDateRangeSettings, saveDateRangeSettings, migrateLocalToFirestore, DEFAULT_SETTINGS, type DateRangeSettings } from '../../lib/dateSettings';
import { getApprovalSettings, saveApprovalSettings, validateAdminPassword, isApprover, type ApprovalSettings } from '../../lib/approvalSettings';
import Header from '../../components/Header';
import dayjs from 'dayjs';

export default function Settings() {
  const { user, loading: authLoading, getUrlWithLineId } = useLineAuth();
  const [settings, setSettings] = useState<DateRangeSettings>(DEFAULT_SETTINGS);
  const [tempStartDate, setTempStartDate] = useState('');
  const [tempEndDate, setTempEndDate] = useState('');
  const [tempStartDay, setTempStartDay] = useState(1);
  const [savedMessage, setSavedMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  // 承認者設定の状態
  const [approvalSettings, setApprovalSettings] = useState<ApprovalSettings>({ approvers: [] });
  const [isUserApprover, setIsUserApprover] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [newApprover, setNewApprover] = useState('');
  const [showPasswordInput, setShowPasswordInput] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      if (!user?.uid) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        
        // First, try to migrate any existing localStorage settings
        await migrateLocalToFirestore(user.uid);
        
        // Load settings from Firestore
        const loadedSettings = await getDateRangeSettings(user.uid);
        setSettings(loadedSettings);
        setTempStartDate(loadedSettings.startDate || '');
        setTempEndDate(loadedSettings.endDate || '');
        setTempStartDay(loadedSettings.customStartDay || 1);
        
        // Load approval settings
        const loadedApprovalSettings = await getApprovalSettings();
        setApprovalSettings(loadedApprovalSettings);
        
        // Check if current user is an approver
        const userIsApprover = await isApprover(user.uid);
        setIsUserApprover(userIsApprover);
      } catch (error) {
        console.error('Failed to load settings:', error);
        setSavedMessage('設定の読み込みに失敗しました');
        setTimeout(() => setSavedMessage(''), 3000);
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
  }, [user?.uid]);

  const saveSettings = async () => {
    if (!user?.uid) {
      setSavedMessage('ユーザー情報が取得できません');
      setTimeout(() => setSavedMessage(''), 3000);
      return;
    }

    setSaving(true);
    try {
      const newSettings: DateRangeSettings = {
        mode: settings.mode,
        ...(settings.mode === 'custom' && tempStartDate && tempEndDate && {
          startDate: tempStartDate,
          endDate: tempEndDate
        }),
        ...(settings.mode === 'monthly' && {
          customStartDay: tempStartDay
        })
      };

      await saveDateRangeSettings(user.uid, newSettings);
      setSettings(newSettings);
      setSavedMessage('設定を保存しました');
      
      // Clear message after 3 seconds
      setTimeout(() => setSavedMessage(''), 3000);
    } catch (error) {
      console.error('Failed to save settings:', error);
      setSavedMessage('設定の保存に失敗しました');
      setTimeout(() => setSavedMessage(''), 3000);
    } finally {
      setSaving(false);
    }
  };

  const resetSettings = async () => {
    if (!user?.uid) {
      setSavedMessage('ユーザー情報が取得できません');
      setTimeout(() => setSavedMessage(''), 3000);
      return;
    }

    setSaving(true);
    try {
      await saveDateRangeSettings(user.uid, DEFAULT_SETTINGS);
      setSettings(DEFAULT_SETTINGS);
      setTempStartDate('');
      setTempEndDate('');
      setTempStartDay(1);
      setSavedMessage('設定をリセットしました');
      
      // Clear message after 3 seconds
      setTimeout(() => setSavedMessage(''), 3000);
    } catch (error) {
      console.error('Failed to reset settings:', error);
      setSavedMessage('設定のリセットに失敗しました');
      setTimeout(() => setSavedMessage(''), 3000);
    } finally {
      setSaving(false);
    }
  };

  // 承認者を追加
  const handleAddApprover = async () => {
    if (!newApprover) {
      setSavedMessage('LINE IDを入力してください');
      setTimeout(() => setSavedMessage(''), 3000);
      return;
    }

    if (!validateAdminPassword(adminPassword)) {
      setSavedMessage('パスワードが正しくありません');
      setTimeout(() => setSavedMessage(''), 3000);
      return;
    }

    try {
      const updatedApprovers = [...approvalSettings.approvers, newApprover];
      const updatedSettings = { ...approvalSettings, approvers: updatedApprovers };
      await saveApprovalSettings(updatedSettings, user?.uid || '');
      setApprovalSettings(updatedSettings);
      setNewApprover('');
      setAdminPassword('');
      setShowPasswordInput(false);
      setSavedMessage('承認者を追加しました');
      setTimeout(() => setSavedMessage(''), 3000);
    } catch (error) {
      console.error('Failed to add approver:', error);
      setSavedMessage('承認者の追加に失敗しました');
      setTimeout(() => setSavedMessage(''), 3000);
    }
  };

  // 承認者を削除
  const handleRemoveApprover = async (approverId: string) => {
    if (!validateAdminPassword(adminPassword)) {
      setSavedMessage('パスワードが正しくありません');
      setTimeout(() => setSavedMessage(''), 3000);
      return;
    }

    try {
      const updatedApprovers = approvalSettings.approvers.filter(id => id !== approverId);
      const updatedSettings = { ...approvalSettings, approvers: updatedApprovers };
      await saveApprovalSettings(updatedSettings, user?.uid || '');
      setApprovalSettings(updatedSettings);
      setSavedMessage('承認者を削除しました');
      setTimeout(() => setSavedMessage(''), 3000);
    } catch (error) {
      console.error('Failed to remove approver:', error);
      setSavedMessage('承認者の削除に失敗しました');
      setTimeout(() => setSavedMessage(''), 3000);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">
            {authLoading ? '読み込み中...' : '設定を読み込み中...'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 relative overflow-hidden">
      {/* Glassmorphism background effects */}
      <div className="absolute inset-0">
        <div className="absolute top-20 left-10 w-72 h-72 bg-gradient-to-r from-blue-300/20 to-purple-300/20 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob"></div>
        <div className="absolute top-40 right-10 w-72 h-72 bg-gradient-to-r from-purple-300/20 to-pink-300/20 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob animation-delay-2000"></div>
        <div className="absolute -bottom-8 left-20 w-72 h-72 bg-gradient-to-r from-pink-300/20 to-orange-300/20 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob animation-delay-4000"></div>
      </div>

      <Header 
        title="設定" 
        getUrlWithLineId={getUrlWithLineId}
        currentPage="settings"
      />

      <main className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* 集計期間設定 */}
        <div className="bg-white/90 backdrop-blur-sm rounded-lg shadow-sm border p-6 mb-6">
          <h2 className="text-xl font-bold text-gray-900 mb-6">集計期間設定</h2>
          
          {savedMessage && (
            <div className="mb-4 p-3 bg-green-100 border border-green-400 text-green-700 rounded-lg">
              {savedMessage}
            </div>
          )}

          <div className="space-y-6">
            {/* Mode Selection */}
            <div>
              <label className="text-base font-medium text-gray-900">集計モード</label>
              <div className="mt-3 space-y-3">
                <div className="flex items-center">
                  <input
                    id="monthly"
                    name="mode"
                    type="radio"
                    checked={settings.mode === 'monthly'}
                    onChange={() => setSettings({ ...settings, mode: 'monthly' })}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300"
                  />
                  <label htmlFor="monthly" className="ml-3 block text-sm font-medium text-gray-700">
                    月次集計
                  </label>
                </div>
                <div className="flex items-center">
                  <input
                    id="custom"
                    name="mode"
                    type="radio"
                    checked={settings.mode === 'custom'}
                    onChange={() => setSettings({ ...settings, mode: 'custom' })}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300"
                  />
                  <label htmlFor="custom" className="ml-3 block text-sm font-medium text-gray-700">
                    固定期間集計
                  </label>
                </div>
              </div>
            </div>

            {/* Monthly Mode Settings */}
            {settings.mode === 'monthly' && (
              <div className="border-t pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">月次集計設定</h3>
                <div>
                  <label htmlFor="startDay" className="block text-sm font-medium text-gray-700 mb-2">
                    月の開始日
                  </label>
                  <select
                    id="startDay"
                    value={tempStartDay}
                    onChange={(e) => setTempStartDay(Number(e.target.value))}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map(day => (
                      <option key={day} value={day}>{day}日</option>
                    ))}
                  </select>
                  <p className="mt-2 text-sm text-gray-500">
                    例：15日を選択すると、15日〜翌月14日までで集計されます
                  </p>
                </div>
              </div>
            )}

            {/* Custom Mode Settings */}
            {settings.mode === 'custom' && (
              <div className="border-t pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">固定期間集計設定</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="customStartDate" className="block text-sm font-medium text-gray-700 mb-2">
                      開始日
                    </label>
                    <input
                      type="date"
                      id="customStartDate"
                      value={tempStartDate}
                      onChange={(e) => setTempStartDate(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  
                  <div>
                    <label htmlFor="customEndDate" className="block text-sm font-medium text-gray-700 mb-2">
                      終了日
                    </label>
                    <input
                      type="date"
                      id="customEndDate"
                      value={tempEndDate}
                      onChange={(e) => setTempEndDate(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                </div>
                
                {tempStartDate && tempEndDate && (
                  <div className="mt-4 p-3 bg-blue-50 rounded-lg">
                    <p className="text-sm text-blue-800">
                      <strong>設定期間:</strong> {dayjs(tempStartDate).format('YYYY年M月D日')} 〜 {dayjs(tempEndDate).format('YYYY年M月D日')}
                      <br />
                      <strong>期間:</strong> {dayjs(tempEndDate).diff(dayjs(tempStartDate), 'day') + 1}日間
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="border-t pt-6 flex gap-4">
              <button
                onClick={saveSettings}
                disabled={saving}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {saving && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>}
                {saving ? '保存中...' : '設定を保存'}
              </button>
              
              <button
                onClick={resetSettings}
                disabled={saving}
                className="px-6 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-medium disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                リセット
              </button>
            </div>

            {/* Current Settings Display */}
            <div className="border-t pt-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">現在の設定</h3>
              <div className="bg-gray-50 p-4 rounded-lg">
                <div className="space-y-2 text-sm">
                  <div>
                    <strong>集計モード:</strong> {settings.mode === 'monthly' ? '月次集計' : '固定期間集計'}
                  </div>
                  {settings.mode === 'monthly' && settings.customStartDay && (
                    <div>
                      <strong>月の開始日:</strong> {settings.customStartDay}日
                    </div>
                  )}
                  {settings.mode === 'custom' && settings.startDate && settings.endDate && (
                    <>
                      <div>
                        <strong>開始日:</strong> {dayjs(settings.startDate).format('YYYY年M月D日')}
                      </div>
                      <div>
                        <strong>終了日:</strong> {dayjs(settings.endDate).format('YYYY年M月D日')}
                      </div>
                      <div>
                        <strong>期間:</strong> {dayjs(settings.endDate).diff(dayjs(settings.startDate), 'day') + 1}日間
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 承認者設定 */}
        <div className="bg-white/90 backdrop-blur-sm rounded-lg shadow-sm border p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-6">承認機能設定</h2>
          
          <div className="space-y-6">
            {/* 現在の承認者ステータス */}
            <div className="bg-blue-50 p-4 rounded-lg">
              <p className="text-sm text-blue-800">
                <strong>あなたのステータス:</strong>
                {isUserApprover ? (
                  <span className="ml-2 text-green-600 font-semibold">✅ 承認者</span>
                ) : (
                  <span className="ml-2 text-gray-600">承認権限なし</span>
                )}
              </p>
              <p className="text-xs text-gray-600 mt-2">
                LINE ID: {user?.uid || 'ゲスト'}
              </p>
            </div>

            {/* 承認者リスト */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">承認者一覧</h3>
              {approvalSettings.approvers.length === 0 ? (
                <p className="text-gray-500 text-sm">承認者が設定されていません</p>
              ) : (
                <ul className="space-y-2">
                  {approvalSettings.approvers.map((approverId) => (
                    <li key={approverId} className="flex items-center justify-between bg-gray-50 p-3 rounded-lg">
                      <span className="text-sm font-medium">{approverId}</span>
                      {showPasswordInput && (
                        <button
                          onClick={() => handleRemoveApprover(approverId)}
                          className="text-red-600 hover:text-red-800 text-sm font-medium"
                        >
                          削除
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 承認者を追加 */}
            <div className="border-t pt-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">承認者を追加</h3>
              
              {!showPasswordInput ? (
                <button
                  onClick={() => setShowPasswordInput(true)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                >
                  承認者設定を変更
                </button>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="adminPassword" className="block text-sm font-medium text-gray-700 mb-2">
                      管理者パスワード
                    </label>
                    <input
                      type="password"
                      id="adminPassword"
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="パスワードを入力"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      承認者を設定するには管理者パスワードが必要です
                    </p>
                  </div>

                  <div>
                    <label htmlFor="newApprover" className="block text-sm font-medium text-gray-700 mb-2">
                      新しい承認者のLINE ID
                    </label>
                    <input
                      type="text"
                      id="newApprover"
                      value={newApprover}
                      onChange={(e) => setNewApprover(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="LINE IDを入力"
                    />
                  </div>

                  <div className="flex gap-4">
                    <button
                      onClick={handleAddApprover}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
                    >
                      承認者を追加
                    </button>
                    <button
                      onClick={() => {
                        setShowPasswordInput(false);
                        setAdminPassword('');
                        setNewApprover('');
                      }}
                      className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-medium"
                    >
                      キャンセル
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 説明 */}
            <div className="bg-yellow-50 p-4 rounded-lg">
              <h4 className="text-sm font-semibold text-yellow-800 mb-2">承認機能について</h4>
              <ul className="text-xs text-yellow-700 space-y-1">
                <li>• 新規追加された支出項目はデフォルトで未承認状態になります</li>
                <li>• 未承認の項目は支出の合計値に含まれません</li>
                <li>• 承認者のみが支出項目を承認できます</li>
                <li>• 承認者の設定変更には管理者パスワードが必要です</li>
              </ul>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}