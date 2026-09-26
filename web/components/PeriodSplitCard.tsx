'use client';

// 期間の折半精算: 期間内の世帯の支出を 2 人で折半し、指定したメンバーから集金する額を出す。
// 集金するメンバーは世帯ごとの設定（groups.splitSettings）。計算は lib/periodSplit.ts。
import React, { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { ArrowRight, ChevronLeft, ChevronRight, Loader2, Scale } from 'lucide-react';
import { useExpenses, type HouseholdMember } from '../lib/hooks';
import { saveSplitCollectFrom } from '../lib/householdApi';
import {
  DEFAULT_SETTINGS,
  getDateRangeSettings,
  getDisplayTitle,
  getEffectiveDateRange,
  type DateRangeSettings,
} from '../lib/dateSettings';
import { computePeriodSplit, formatYenExact } from '../lib/periodSplit';

const yen = (n: number) => `¥${n.toLocaleString()}`;

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
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>(DEFAULT_SETTINGS);
  // 締まった直後の期間から見る（期間が終わってから精算する）
  const [currentMonth, setCurrentMonth] = useState(() => dayjs().subtract(1, 'month'));
  useEffect(() => {
    let cancelled = false;
    getDateRangeSettings(lineId).then((s) => {
      if (!cancelled) setDateSettings(s);
    });
    return () => {
      cancelled = true;
    };
  }, [lineId]);
  const range = useMemo(() => getEffectiveDateRange(currentMonth, dateSettings), [currentMonth, dateSettings]);
  const { expenses, loading } = useExpenses(lineId, 0, 500, range.startDate);

  // 保存して世帯の情報を取り直すまでの間も、選んだ人で計算する。
  // 世帯の設定（collectFrom）が選んだ時点から変われば、そちらを正とする
  const [pending, setPending] = useState<{ value: string; basis: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = pending && pending.basis === collectFrom ? pending.value : collectFrom;

  const split = useMemo(
    () => computePeriodSplit({ expenses, groupId, members, targetLineId: target }),
    [expenses, groupId, members, target]
  );
  const nameOf = (id: string | undefined) => members.find((m) => m.lineId === id)?.displayName || 'メンバー';

  const choose = async (id: string) => {
    if (saving || id === target) return;
    setPending({ value: id, basis: collectFrom });
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
    <div className="glass animate-fade-up rounded-2xl p-5 shadow-glass">
      <div className="flex items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Scale className="h-4 w-4 text-accent" />
          期間の精算（折半）
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCurrentMonth((m) => m.subtract(1, 'month'))}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-card text-muted hover:bg-fg/5 hover:text-fg"
            aria-label="前の期間"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="whitespace-nowrap px-1 text-xs font-medium text-fg">{getDisplayTitle(currentMonth, dateSettings)}</span>
          <button
            type="button"
            onClick={() => setCurrentMonth((m) => m.add(1, 'month'))}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-card text-muted hover:bg-fg/5 hover:text-fg"
            aria-label="次の期間"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {split.reason === 'not_two_members' ? (
        <p className="mt-4 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          世帯のメンバーが2人そろうと計算できます
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-2">
            <span className="shrink-0 text-xs text-muted">集金する人</span>
            <div className="flex flex-1 gap-1.5">
              {members.map((m) => {
                const active = m.lineId === target;
                return (
                  <button
                    key={m.lineId}
                    type="button"
                    disabled={!canSave || saving}
                    aria-pressed={active}
                    onClick={() => choose(m.lineId)}
                    className={`flex-1 truncate rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                      active ? 'border-accent bg-accent/12 text-accent' : 'border-line bg-card text-muted hover:bg-fg/5'
                    }`}
                  >
                    {m.displayName || 'メンバー'}
                  </button>
                );
              })}
            </div>
            {saving && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted" />}
          </div>
          {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

          {loading && expenses.length === 0 ? (
            <div className="py-8 text-center">
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted" />
            </div>
          ) : (
            <>
              <dl className="mt-4 space-y-1.5 text-sm tabular-nums">
                <div className="flex justify-between">
                  <dt className="text-muted">
                    合計（{split.count}件{split.excludedCount > 0 ? `・除外${split.excludedCount}件` : ''}）
                  </dt>
                  <dd className="font-medium text-fg">{yen(split.total)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">÷ 2</dt>
                  <dd className="font-medium text-fg">{formatYenExact(split.half)}</dd>
                </div>
                {split.target && (
                  <div className="flex justify-between">
                    <dt className="text-muted">− {split.target.displayName || 'メンバー'}の支払い</dt>
                    <dd className="font-medium text-fg">{yen(split.targetPaid)}</dd>
                  </div>
                )}
              </dl>

              <div className="mt-4 border-t border-line pt-4 text-center">
                {split.reason === 'no_target' ? (
                  <p className="text-sm text-muted">集金する人を選ぶと、精算額が出ます</p>
                ) : split.transfer ? (
                  <>
                    <p className="inline-flex items-center gap-1.5 text-sm text-muted">
                      {nameOf(split.transfer.fromLineId)}
                      <ArrowRight className="h-4 w-4" />
                      {nameOf(split.transfer.toLineId)}
                    </p>
                    <p className="mt-1 text-4xl font-black tabular-nums text-fg">{yen(split.transfer.amount)}</p>
                  </>
                ) : (
                  <p className="text-sm text-muted">精算は不要です</p>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
