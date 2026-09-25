'use client';

// 3 つのタブ（ホーム・明細・ふたり）で共通の期間。タブを移っても期間が今日に戻らないように、
// 表示中の日付（currentDate）と期間の設定（dateSettings）をここで 1 つだけ持つ。
// 期間の計算は既存の getEffectiveDateRange / getDisplayTitle をそのまま使う。
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import dayjs from 'dayjs';
import { useLineAuth } from '@/lib/hooks';
import {
  DEFAULT_SETTINGS,
  getDateRangeSettings,
  getDisplayTitle,
  getEffectiveDateRange,
  type DateRangeSettings,
} from '@/lib/dateSettings';
import { shortPeriodLabel } from '@/lib/periodLabel';
import { getCached, hasCached, setCached } from '@/lib/swrCache';
import { isBareRoute } from '@/lib/routes';

export interface PeriodContextValue {
  /** 表示中の日付（期間はこの日を含む） */
  currentDate: dayjs.Dayjs;
  setCurrentDate: (date: dayjs.Dayjs) => void;
  dateSettings: DateRangeSettings;
  /** 設定を保存したあとに呼ぶ（キャッシュも更新する） */
  setDateSettings: (settings: DateRangeSettings) => void;
  /** 認証が確定し、期間の設定を読み終えた（または不要な）状態 */
  settingsLoaded: boolean;
  range: { startDate: string; endDate: string; mode: 'monthly' | 'custom' };
  /** 月ラベル（例「9月」） */
  label: string;
  /** 正確な期間（例「2026年9月16日 〜 10月15日」） */
  title: string;
  /** 前後の期間へ動かせるか（期間指定では動かさない） */
  canShift: boolean;
  shift: (delta: number) => void;
  goToday: () => void;
}

const PeriodContext = createContext<PeriodContextValue | null>(null);

function cacheKeyFor(lineId: string | null): string {
  return lineId ? `dateSettings:${lineId}` : '';
}

export function PeriodProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  const bare = isBareRoute(pathname);
  const { lineId, settled } = useLineAuth();
  const key = cacheKeyFor(lineId);

  const [currentDate, setCurrentDate] = useState(() => dayjs());
  // 読み込んだ設定（どの利用者のものか）と、描き直し用のカウンタ（値は swrCache）
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (bare || !lineId) return;
    let cancelled = false;
    const cacheKey = cacheKeyFor(lineId);
    // キャッシュがあればそれを先に使い、裏で取り直す
    getDateRangeSettings(lineId).then(
      (fresh) => {
        if (cancelled) return;
        setCached(cacheKey, fresh);
        setLoadedKey(cacheKey);
        setVersion((v) => v + 1);
      },
      (e: unknown) => {
        console.error('Failed to load date settings:', e);
        if (cancelled) return;
        setLoadedKey(cacheKey);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [bare, lineId]);

  const dateSettings: DateRangeSettings = (key && getCached<DateRangeSettings>(key)) || DEFAULT_SETTINGS;
  const settingsLoaded = settled && (bare || !lineId || loadedKey === key || hasCached(key));

  const setDateSettings = useCallback(
    (next: DateRangeSettings) => {
      if (!key) return;
      setCached(key, next);
      setVersion((v) => v + 1);
    },
    [key, setVersion]
  );

  const canShift = dateSettings.mode !== 'custom';
  const shift = useCallback(
    (delta: number) => {
      if (!canShift || !delta) return;
      setCurrentDate((prev) => prev.add(delta, 'month'));
    },
    [canShift, setCurrentDate]
  );
  const goToday = useCallback(() => setCurrentDate(dayjs()), [setCurrentDate]);

  const range = getEffectiveDateRange(currentDate, dateSettings);
  const today = dayjs().format('YYYY-MM-DD');
  const label = shortPeriodLabel(range, today);
  const title = getDisplayTitle(currentDate, dateSettings);
  const { startDate, endDate, mode } = range;

  const value = useMemo<PeriodContextValue>(
    () => ({
      currentDate,
      setCurrentDate,
      dateSettings,
      setDateSettings,
      settingsLoaded,
      range: { startDate, endDate, mode },
      label,
      title,
      canShift,
      shift,
      goToday,
    }),
    [
      currentDate,
      setCurrentDate,
      dateSettings,
      setDateSettings,
      settingsLoaded,
      startDate,
      endDate,
      mode,
      label,
      title,
      canShift,
      shift,
      goToday,
    ]
  );

  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

export function usePeriod(): PeriodContextValue {
  const ctx = useContext(PeriodContext);
  if (!ctx) throw new Error('usePeriod must be used within PeriodProvider');
  return ctx;
}
