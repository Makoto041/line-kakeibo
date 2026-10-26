'use client';

// 期間の折半精算: 期間内の世帯の支出を 2 人で折半し、立替は全額を加算して、指定したメンバーから集金する額を出す。
// 集金するメンバーは世帯ごとの設定（groups.splitSettings）。計算は lib/periodSplit.ts。
// この部品は取得（期間の設定・明細）と保存（集金するメンバー）を受け持ち、表示は PeriodSplitView に任せる。
import React, { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import PeriodSplitView from './PeriodSplitView';
import { useExpenses, type HouseholdMember } from '../lib/hooks';
import { saveSplitCollectFrom } from '../lib/householdApi';
import {
  DEFAULT_SETTINGS,
  fetchDateRangeSettings,
  getDisplayTitle,
  getEffectiveDateRange,
  type DateRangeSettings,
} from '../lib/dateSettings';
import { getCached, hasCached, setCached } from '../lib/swrCache';

// useExpenses の世帯クエリの上限。これに届いたら取りこぼしがありうる
const FETCH_LIMIT = 500;

interface Props {
  lineId: string;
  groupId: string;
  members: HouseholdMember[];
  collectFrom: string | null;
  /** 世帯の設定を保存できたとき（世帯の情報を取り直す） */
  onSaved: () => void;
  canSave: boolean;
}

export default function PeriodSplitCard({ lineId, groupId, members, collectFrom, onSaved, canSave }: Props) {
  // 期間の設定はホーム・設定と同じキャッシュを使い、あればすぐ計算を出す（裏で読み直す）
  const settingsKey = `dateSettings:${lineId}`;
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>(
    () => getCached<DateRangeSettings>(settingsKey) ?? DEFAULT_SETTINGS
  );
  const [settingsLoaded, setSettingsLoaded] = useState(() => hasCached(settingsKey));
  // 締まった直後の期間から見る（期間が終わってから精算する）
  const [currentMonth, setCurrentMonth] = useState(() => dayjs().subtract(1, 'month'));
  useEffect(() => {
    let cancelled = false;
    fetchDateRangeSettings(lineId).then(
      (s) => {
        if (cancelled) return;
        setCached(`dateSettings:${lineId}`, s);
        setDateSettings(s);
        setSettingsLoaded(true);
      },
      (error: unknown) => {
        // 読めなかった: キャッシュがあればそのまま、無ければ既定の期間で続ける（キャッシュは上書きしない）
        console.error('Failed to load date settings:', error);
        if (!cancelled) setSettingsLoaded(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [lineId]);
  const range = useMemo(() => getEffectiveDateRange(currentMonth, dateSettings), [currentMonth, dateSettings]);
  // 期間設定が届く前に既定（1 日始まり）の期間で取得しない
  const { expenses, loading } = useExpenses(settingsLoaded ? lineId : null, 0, FETCH_LIMIT, range.startDate);
  const busy = !settingsLoaded || loading;

  // 保存して世帯の情報を取り直すまでの間も、選んだ人で計算する。世帯の設定（collectFrom）が変われば、そちらを正とする
  const [pending, setPending] = useState<string | null>(null);
  const [seenCollectFrom, setSeenCollectFrom] = useState(collectFrom);
  if (seenCollectFrom !== collectFrom) {
    setSeenCollectFrom(collectFrom);
    setPending(null);
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = pending ?? collectFrom;

  const choose = async (id: string) => {
    if (saving || id === target) return;
    setPending(id);
    setSaving(true);
    setError(null);
    try {
      await saveSplitCollectFrom(groupId, id);
      onSaved();
    } catch (err) {
      console.error('Failed to save split settings:', err);
      setPending(null);
      setError('保存できませんでした。もう一度お試しください');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PeriodSplitView
      expenses={expenses}
      groupId={groupId}
      members={members}
      target={target}
      range={range}
      periodTitle={getDisplayTitle(currentMonth, dateSettings)}
      onPrevPeriod={() => setCurrentMonth((m) => m.subtract(1, 'month'))}
      onNextPeriod={() => setCurrentMonth((m) => m.add(1, 'month'))}
      busy={busy}
      truncated={expenses.length >= FETCH_LIMIT}
      canSave={canSave}
      saving={saving}
      error={error}
      onChoose={choose}
      listHref={(f) =>
        f.payers ? null : `/expenses?from=${range.startDate}${f.category !== undefined ? `&category=${encodeURIComponent(f.category)}` : ''}`
      }
      editHref={(id) => `/expenses?edit=${encodeURIComponent(id)}`}
    />
  );
}
