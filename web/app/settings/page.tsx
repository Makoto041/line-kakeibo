'use client';

import React, { useState, useEffect } from 'react';
import { useLineAuth } from '../../lib/hooks';
import { getDateRangeSettings, saveDateRangeSettings, migrateLocalToFirestore, DEFAULT_SETTINGS, type DateRangeSettings } from '../../lib/dateSettings';
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
          endDate: tempEndDate,
        }),
        ...(settings.mode === 'customStart' && {
          customStartDay: tempStartDay,
        }),
      };

      await saveDateRangeSettings(user.uid, newSettings);
      setSettings(newSettings);
      setSavedMessage('設定を保存しました！');
      setTimeout(() => setSavedMessage(''), 3000);
    } catch (error) {
      console.error('Failed to save settings:', error);
      setSavedMessage('設定の保存に失敗しました');
      setTimeout(() => setSavedMessage(''), 3000);
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">ログインが必要です</h1>
          <p className="text-gray-600 mb-6">設定を変更するにはログインしてください。</p>
          <div className="inline-flex items-center gap-4">
            <a
              href={getUrlWithLineId('/')}
              className="inline-flex items-center px-6 py-3 bg-[#00B900] text-white rounded-lg hover:bg-[#009900] transition-colors font-medium"
            >
              🏠 ホームに戻る
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <Header title="設定" getUrlWithLineId={getUrlWithLineId} currentPage="settings" />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 mt-16">
        <div className="space-y-8">
          <div className="text-center">
            <h1 className="text-3xl font-bold text-gray-900 mb-2">設定</h1>
            <p className="text-gray-600">表示期間やその他の設定を管理します</p>
          </div>

          {savedMessage && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
              <p className="text-green-800 font-medium">{savedMessage}</p>
            </div>
          )}

          <div className="bg-white/90 backdrop-blur-sm rounded-lg shadow-sm border p-6">
            <h2 className="text-xl font-bold text-gray-900 mb-6">表示期間設定</h2>
            
            <div className="space-y-6">
              <div>
                <label className="text-base font-medium text-gray-900">表示期間の設定方法</label>
                <div className="mt-4 space-y-4">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="mode"
                      value="monthly"
                      checked={settings.mode === 'monthly'}
                      onChange={(e) => setSettings({ ...settings, mode: e.target.value as DateRangeSettings['mode'] })}
                      className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                    />
                    <span className="ml-3 text-sm text-gray-700">月単位で表示</span>
                  </label>
                  
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="mode"
                      value="customStart"
                      checked={settings.mode === 'customStart'}
                      onChange={(e) => setSettings({ ...settings, mode: e.target.value as DateRangeSettings['mode'] })}
                      className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                    />
                    <span className="ml-3 text-sm text-gray-700">指定日を月初として表示（例：25日〜翌月24日）</span>
                  </label>
                  
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="mode"
                      value="custom"
                      checked={settings.mode === 'custom'}
                      onChange={(e) => setSettings({ ...settings, mode: e.target.value as DateRangeSettings['mode'] })}
                      className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                    />
                    <span className="ml-3 text-sm text-gray-700">期間を指定して表示</span>
                  </label>
                </div>
              </div>

              {settings.mode === 'customStart' && (
                <div className="bg-blue-50 p-4 rounded-lg">
                  <label htmlFor="customStartDay" className="block text-sm font-medium text-gray-700 mb-2">
                    月初日として扱う日付
                  </label>
                  <select
                    id="customStartDay"
                    value={tempStartDay}
                    onChange={(e) => setTempStartDay(parseInt(e.target.value))}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map(day => (
                      <option key={day} value={day}>{day}日</option>
                    ))}
                  </select>
                  <p className="mt-2 text-xs text-gray-600">
                    例：25日を選択すると、25日〜翌月24日を1ヶ月として表示します
                  </p>
                </div>
              )}

              {settings.mode === 'custom' && (
                <div className="bg-blue-50 p-4 rounded-lg space-y-4">
                  <div>
                    <label htmlFor="startDate" className="block text-sm font-medium text-gray-700 mb-2">
                      開始日
                    </label>
                    <input
                      type="date"
                      id="startDate"
                      value={tempStartDate}
                      onChange={(e) => setTempStartDate(e.target.value)}
                      max={tempEndDate || dayjs().format('YYYY-MM-DD')}
                      className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  
                  <div>
                    <label htmlFor="endDate" className="block text-sm font-medium text-gray-700 mb-2">
                      終了日
                    </label>
                    <input
                      type="date"
                      id="endDate"
                      value={tempEndDate}
                      onChange={(e) => setTempEndDate(e.target.value)}
                      min={tempStartDate}
                      max={dayjs().format('YYYY-MM-DD')}
                      className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  onClick={saveSettings}
                  disabled={saving}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  {saving ? '保存中...' : '設定を保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}