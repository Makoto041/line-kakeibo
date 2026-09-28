'use client';

// 期間の折半精算: 期間内の世帯の支出を 2 人で折半し、指定したメンバーから集金する額を出す。
// 集金するメンバーは世帯ごとの設定（groups.splitSettings）。計算は lib/periodSplit.ts。
import React, { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { ArrowLeftRight, ArrowRight, ChevronLeft, ChevronRight, Loader2, Scale } from 'lucide-react';
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

const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;
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
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // 締まった直後の期間から見る（期間が終わってから精算する）
  const [currentMonth, setCurrentMonth] = useState(() => dayjs().subtract(1, 'month'));
  useEffect(() => {
    let cancelled = false;
    getDateRangeSettings(lineId).then((s) => {
      if (cancelled) return;
      setDateSettings(s);
      setSettingsLoaded(true);
    });
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

  const split = useMemo(
    () => computePeriodSplit({ expenses, groupId, members, targetLineId: target, range }),
    [expenses, groupId, members, target, range]
  );
  const nameOf = (id: string | undefined) => members.find((m) => m.lineId === id)?.displayName || 'メンバー';

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
            disabled={range.mode === 'custom'}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-card text-muted hover:bg-fg/5 hover:text-fg disabled:opacity-40"
            aria-label="前の期間"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="whitespace-nowrap px-1 text-xs font-medium text-fg">{getDisplayTitle(currentMonth, dateSettings)}</span>
          <button
            type="button"
            onClick={() => setCurrentMonth((m) => m.add(1, 'month'))}
            disabled={range.mode === 'custom'}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-card text-muted hover:bg-fg/5 hover:text-fg disabled:opacity-40"
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
          {busy && expenses.length === 0 ? (
            <div className="py-8 text-center">
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted" />
            </div>
          ) : (
            <>
              {/* 図: 送金する人 → 受け取る人（立替の精算と同じ見せ方）。アイコンをタップすると「送金する人」を切り替える */}
              {(() => {
                // 未設定のときは 2 人を並べるだけ（どちらかをタップして送金する人を選ぶ）
                const from = split.transfer ? split.transfer.fromLineId : target;
                const to = split.transfer
                  ? split.transfer.toLineId
                  : target
                  ? members.find((m) => m.lineId !== target)?.lineId ?? null
                  : null;
                const left = target ? members.find((m) => m.lineId === from) ?? null : members[0] ?? null;
                const right = target ? members.find((m) => m.lineId === to) ?? null : members[1] ?? null;
                const idle = !split.transfer;
                return (
                  <div className="mt-5">
                    <div className="flex items-center justify-center gap-3">
                      <PersonButton
                        member={left}
                        role={target ? '送金する人' : undefined}
                        dim={!target}
                        disabled={!canSave || saving || !left}
                        onClick={() => left && choose(left.lineId)}
                      />
                      <div className="flex flex-col items-center gap-1">
                        <ArrowRight className={`h-5 w-5 text-muted ${idle ? 'opacity-40' : ''}`} />
                        {target && canSave && (
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => {
                              const other = members.find((m) => m.lineId !== target);
                              if (other) choose(other.lineId);
                            }}
                            className="inline-flex items-center gap-1 rounded-full border border-line bg-card px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-fg/5 hover:text-fg disabled:opacity-50"
                            aria-label="送金する人を入れ替える"
                          >
                            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowLeftRight className="h-3 w-3" />}
                            入れ替え
                          </button>
                        )}
                      </div>
                      <PersonButton
                        member={right}
                        role={target ? '受け取る人' : undefined}
                        dim={!target || idle}
                        disabled={!canSave || saving || !right}
                        onClick={() => right && choose(right.lineId)}
                      />
                    </div>

                    {split.reason === 'no_target' ? (
                      <p className="mt-4 text-center text-sm text-muted">送金する人（毎月払う人）をタップしてください</p>
                    ) : (
                      <>
                        <p className="mt-4 text-center text-4xl font-black tabular-nums text-fg">
                          {yen(split.transfer?.amount ?? 0)}
                        </p>
                        <p className="mt-1 text-center text-xs text-muted">
                          {split.transfer
                            ? `${nameOf(split.transfer.fromLineId)}が${nameOf(split.transfer.toLineId)}に送金`
                            : '精算は不要です'}
                        </p>
                      </>
                    )}
                  </div>
                );
              })()}
              {error && <p className="mt-2 text-center text-xs text-rose-600 dark:text-rose-400">{error}</p>}

              {/* 内訳: 2 人の支払いと、1 人あたりの負担 */}
              {split.target && split.counterpart && (
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-line bg-fg/[0.02] p-3 text-center">
                    <p className="truncate text-xs text-muted">{split.target.displayName || 'メンバー'}の支払い</p>
                    <p className="mt-0.5 text-lg font-bold tabular-nums text-fg">{yen(split.targetPaid)}</p>
                  </div>
                  <div className="rounded-xl border border-line bg-fg/[0.02] p-3 text-center">
                    <p className="truncate text-xs text-muted">
                      {split.counterpart.displayName || 'メンバー'}・カード・共通口座
                    </p>
                    <p className="mt-0.5 text-lg font-bold tabular-nums text-fg">{yen(split.total - split.targetPaid)}</p>
                  </div>
                </div>
              )}

              <dl className="mt-3 space-y-1 rounded-xl bg-fg/[0.03] p-3 text-xs tabular-nums">
                <div className="flex justify-between">
                  <dt className="text-muted">
                    合計（{split.count}件{split.excludedCount > 0 ? `・除外${split.excludedCount}件` : ''}
                    {split.settledCount > 0 ? `・立替精算済み${split.settledCount}件` : ''}）
                  </dt>
                  <dd className="font-medium text-fg">{yen(split.total)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">1人あたり（÷ 2）</dt>
                  <dd className="font-medium text-fg">{formatYenExact(split.half)}</dd>
                </div>
                {split.target && (
                  <div className="flex justify-between">
                    <dt className="text-muted">− {split.target.displayName || 'メンバー'}の支払い</dt>
                    <dd className="font-medium text-fg">{yen(split.targetPaid)}</dd>
                  </div>
                )}
              </dl>

              {expenses.length >= FETCH_LIMIT && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">件数が多いため、一部を数えられていない可能性があります</p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function PersonButton({
  member,
  role,
  dim,
  disabled,
  onClick,
}: {
  member: HouseholdMember | null | undefined;
  role?: string;
  dim?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const name = member?.displayName || 'メンバー';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={role ? `${name}（${role}）` : `${name}を送金する人にする`}
      className={`flex w-24 flex-col items-center gap-1 rounded-xl p-1 transition-opacity disabled:cursor-default ${dim ? 'opacity-50' : ''}`}
    >
      <span className="grid h-12 w-12 place-items-center rounded-full bg-accent/12 text-lg font-bold text-accent">
        {Array.from(name)[0] ?? '?'}
      </span>
      <span className="max-w-full truncate text-xs text-fg">{name}</span>
      {role && <span className="text-[10px] text-muted">{role}</span>}
    </button>
  );
}
