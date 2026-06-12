'use client';

import React, { useState, useEffect } from 'react';
import { useLineAuth } from '../../lib/hooks';
import { getDateRangeSettings, saveDateRangeSettings, migrateLocalToFirestore, DEFAULT_SETTINGS, type DateRangeSettings } from '../../lib/dateSettings';
import AppShell from '../../components/AppShell';
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
      if (!user?.uid) { setLoading(false); return; }
      try {
        setLoading(true);
        await migrateLocalToFirestore(user.uid);
        const loadedSettings = await getDateRangeSettings(user.uid);
        setSettings(loadedSettings);
        setTempStartDate(loadedSettings.startDate || '');
        setTempEndDate(loadedSettings.endDate || '');
        setTempStartDay(loadedSettings.customStartDay || 1);
      } catch {
        setSavedMessage('設定の読み込みに失敗しました');
        setTimeout(() => setSavedMessage(''), 3000);
      } finally {
        setLoading(false);
      }
    };
    loadSettings();
  }, [user?.uid]);

  const saveSettings = async () => {
    if (!user?.uid) return;
    setSaving(true);
    try {
      const newSettings: DateRangeSettings = {
        mode: settings.mode,
        ...(settings.mode === 'custom' && tempStartDate && tempEndDate && { startDate: tempStartDate, endDate: tempEndDate }),
        ...(settings.mode === 'customStart' && { customStartDay: tempStartDay }),
      };
      await saveDateRangeSettings(user.uid, newSettings);
      setSettings(newSettings);
      setSavedMessage('保存しました');
      setTimeout(() => setSavedMessage(''), 3000);
    } catch {
      setSavedMessage('保存に失敗しました');
      setTimeout(() => setSavedMessage(''), 3000);
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="liquid-bg" aria-hidden="true" />
        <div className="w-8 h-8 border-2 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="liquid-bg" aria-hidden="true" />
        <div className="glass-card rounded-3xl p-8 text-center">
          <h1 className="text-lg font-semibold text-gray-900 mb-1">ログインが必要です</h1>
          <p className="text-sm text-gray-400">LINEから家計簿アプリにアクセスしてください。</p>
        </div>
      </div>
    );
  }

  const modeOptions = [
    { value: 'monthly' as const, label: '月単位', desc: '1日〜月末で集計' },
    { value: 'customStart' as const, label: '起算日指定', desc: '給料日などに合わせて月初を変更' },
    { value: 'custom' as const, label: '期間指定', desc: '任意の日付範囲で集計' },
  ];

  return (
    <AppShell getUrlWithLineId={getUrlWithLineId} title="設定">
      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {savedMessage && (
          <div className={`glass-card rounded-2xl px-4 py-3 text-sm font-medium text-center ${
            savedMessage.includes('失敗') ? 'text-red-700' : 'text-emerald-700'
          }`}>
            {savedMessage}
          </div>
        )}

        {/* Date range settings */}
        <div className="glass-card rounded-3xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/50">
            <h2 className="text-base font-semibold text-gray-900">集計期間</h2>
            <p className="text-xs text-gray-400 mt-0.5">家計簿の表示期間を設定します</p>
          </div>

          <div className="p-5 space-y-3">
            {modeOptions.map(opt => (
              <label
                key={opt.value}
                className={`pressable flex items-start gap-3 p-3.5 rounded-2xl cursor-pointer transition-colors ${
                  settings.mode === opt.value ? 'glass-accent' : 'hover:bg-white/40'
                }`}
              >
                <input
                  type="radio"
                  name="mode"
                  value={opt.value}
                  checked={settings.mode === opt.value}
                  onChange={(e) => setSettings({ ...settings, mode: e.target.value as DateRangeSettings['mode'] })}
                  className="mt-0.5 h-4 w-4 text-emerald-600 border-gray-300 focus:ring-emerald-500"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">{opt.label}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>

          {settings.mode === 'customStart' && (
            <div className="px-5 pb-5">
              <div className="glass-inset rounded-2xl p-4">
                <label className="block text-xs font-medium text-gray-500 mb-2">月初日</label>
                <select
                  value={tempStartDay}
                  onChange={(e) => setTempStartDay(parseInt(e.target.value))}
                  className="w-full border border-white/60 bg-white/70 backdrop-blur-sm rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(day => (
                    <option key={day} value={day}>{day}日</option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-2">
                  例: 25日 → 25日〜翌月24日を1ヶ月として集計
                </p>
              </div>
            </div>
          )}

          {settings.mode === 'custom' && (
            <div className="px-5 pb-5">
              <div className="glass-inset rounded-2xl p-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">開始日</label>
                  <input
                    type="date"
                    value={tempStartDate}
                    onChange={(e) => setTempStartDate(e.target.value)}
                    max={tempEndDate || dayjs().format('YYYY-MM-DD')}
                    className="w-full border border-white/60 bg-white/70 backdrop-blur-sm rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">終了日</label>
                  <input
                    type="date"
                    value={tempEndDate}
                    onChange={(e) => setTempEndDate(e.target.value)}
                    min={tempStartDate}
                    max={dayjs().format('YYYY-MM-DD')}
                    className="w-full border border-white/60 bg-white/70 backdrop-blur-sm rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="px-5 pb-5">
            <button
              onClick={saveSettings}
              disabled={saving}
              className="pressable w-full bg-emerald-600/90 text-white py-3 rounded-full text-sm font-medium shadow-sm hover:bg-emerald-600 disabled:opacity-50 transition-colors"
            >
              {saving ? '保存中...' : '設定を保存'}
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
