'use client';

// 設定（期間設定のタブ）の「LINEへの精算の通知」カード。
// 精算の通知は期間の起算日に自動で LINE グループへ届く（bot の settlementSummary.ts）。ここでは、その状態を見せ、
// 日付に関係なく今すぐ送れるようにする（締まった期間 = 自動と同じ内容 / 今の期間 = 今日までの途中経過）。
import React, { useCallback, useEffect, useState } from 'react';
import { Bell, Loader2, Send } from 'lucide-react';
import { useHousehold } from '../../lib/hooks';
import {
  fetchSummaryStatus,
  householdErrorCode,
  isHouseholdApiConfigured,
  sendSummaryNow,
  type SummaryPeriodKind,
  type SummaryStatus,
} from '../../lib/householdApi';
import type { DateRangeYmd, SummaryUnavailableReason } from '../../lib/householdContract';

/** 9/15〜10/14（年をまたぐときは年も付ける。LINE の通知の見出しと同じ表記） */
function rangeLabel(range: DateRangeYmd): string {
  const [sy, sm, sd] = range.startDate.split('-').map(Number);
  const [ey, em, ed] = range.endDate.split('-').map(Number);
  return sy === ey ? `${sm}/${sd}〜${em}/${ed}` : `${sy}/${sm}/${sd}〜${ey}/${em}/${ed}`;
}

function sentAtLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日に送信済み`;
}

const REASON_TEXT: Record<SummaryUnavailableReason, string> = {
  no_line_group: '世帯がLINEグループに紐づいていないため、通知は送れません',
  no_collect_from: '精算タブの「期間の精算」で送金する人を選ぶと、通知を送れます',
  not_two_members: '世帯のメンバーが2人そろうと、通知を送れます',
  fixed_period: '期間を日付で固定しているため、通知は送れません（期間を月単位にすると送れます）',
};

function sendErrorMessage(error: unknown): string {
  switch (householdErrorCode(error)) {
    case 'line_limit':
      return 'LINEの送信の上限に達しているため、送れませんでした（無料枠は月200通）';
    case 'line_failed':
      return 'LINEに送れませんでした。時間をおいてやり直してください';
    case 'rate_limited':
      return '続けて送りすぎています。10分ほど待ってからやり直してください';
    case 'unavailable':
      return 'この世帯では通知を送れません';
    case 'forbidden':
      return 'この世帯の通知を送る権限がありません';
    default:
      return '送れませんでした。時間をおいてやり直してください';
  }
}

export default function SettlementNotifyCard({ lineId, className = '' }: { lineId: string; className?: string }) {
  const { household } = useHousehold(lineId);
  const groupId = household?.groupId ?? null;
  const apiAvailable = isHouseholdApiConfigured();

  const [status, setStatus] = useState<SummaryStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [period, setPeriod] = useState<SummaryPeriodKind>('closed');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!groupId || !apiAvailable) return;
    let cancelled = false;
    fetchSummaryStatus(groupId).then(
      (value) => {
        if (cancelled) return;
        setStatus(value);
        setLoadFailed(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('Failed to load settlement summary status:', error);
        setLoadFailed(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [groupId, apiAvailable, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // 世帯に入っていない・API が使えない環境では出さない
  if (!groupId || !apiAvailable) return null;

  const send = async () => {
    if (sending || !status || status.reason) return;
    setSending(true);
    setResult(null);
    try {
      const sent = await sendSummaryNow(groupId, period);
      setConfirming(false);
      setResult({
        type: 'success',
        text: `LINEグループに送りました（${rangeLabel(sent.range)}${sent.interim ? '・途中経過' : ''}）`,
      });
      reload();
    } catch (error) {
      console.error('Failed to send settlement summary:', error);
      setResult({ type: 'error', text: sendErrorMessage(error) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`glass rounded-2xl p-5 shadow-glass ${className}`}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
        <Bell className="h-4 w-4 text-accent" />
        LINEへの精算の通知
      </h3>

      {!status ? (
        loadFailed ? (
          <div className="mt-3 text-sm text-muted">
            通知の設定を読み込めませんでした。
            <button type="button" onClick={reload} className="ml-1 font-medium text-accent hover:underline">
              再読み込み
            </button>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            読み込み中...
          </div>
        )
      ) : status.reason || !status.closed || !status.current ? (
        <p className="mt-3 rounded-xl bg-fg/[0.04] p-3 text-sm text-muted">
          {status.reason ? REASON_TEXT[status.reason] : '通知は送れません'}
        </p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted">自動で送る日</dt>
            <dd className="text-fg">毎月{status.startDay}日（期間の起算日）</dd>
            <dt className="text-muted">送り先</dt>
            <dd className="text-fg">世帯のLINEグループ</dd>
            <dt className="text-muted">前の期間</dt>
            <dd className="text-fg">
              {rangeLabel(status.closed)}
              <span className="ml-1.5 text-xs text-muted">
                {status.closedSentAt ? sentAtLabel(status.closedSentAt) : 'まだ送っていません'}
              </span>
            </dd>
          </dl>

          {confirming ? (
            <div className="mt-4 space-y-3 rounded-xl border border-accent/25 bg-accent/[0.06] p-3">
              <fieldset className="space-y-2">
                <legend className="sr-only">送る期間</legend>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-card p-3">
                  <input
                    type="radio"
                    id="notify-period-closed"
                    name="notify-period"
                    checked={period === 'closed'}
                    onChange={() => setPeriod('closed')}
                    className="mt-1 h-4 w-4 accent-accent"
                  />
                  <span className="text-sm text-fg">
                    <span className="font-medium">締まった期間</span> {rangeLabel(status.closed)}
                    <span className="block text-xs text-muted">自動の通知と同じ内容（ふたりにメンション付き）</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-card p-3">
                  <input
                    type="radio"
                    id="notify-period-current"
                    name="notify-period"
                    checked={period === 'current'}
                    onChange={() => setPeriod('current')}
                    className="mt-1 h-4 w-4 accent-accent"
                  />
                  <span className="text-sm text-fg">
                    <span className="font-medium">今の期間（途中）</span> {rangeLabel(status.current)}
                    <span className="block text-xs text-muted">今日までの分で計算した見込み（メンションなし）</span>
                  </span>
                </label>
              </fieldset>
              <p className="text-xs text-muted">LINEの送信の無料枠（月200通）を使います。</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => setConfirming(false)}
                  className="flex-1 rounded-xl border border-line bg-card py-2.5 text-sm font-medium text-fg hover:bg-fg/5 disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  disabled={sending}
                  onClick={send}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent py-2.5 text-sm font-medium text-accent-fg shadow-sm hover:opacity-90 disabled:opacity-50"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  送る
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setResult(null);
                setConfirming(true);
              }}
              className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-line bg-card py-2.5 text-sm font-medium text-fg hover:bg-fg/5"
            >
              <Send className="h-4 w-4 text-accent" />
              今すぐ送る
            </button>
          )}
        </>
      )}

      {result && (
        <p
          role={result.type === 'error' ? 'alert' : 'status'}
          className={`mt-3 rounded-xl p-3 text-sm ${
            result.type === 'success'
              ? 'border border-emerald-500/20 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
              : 'border border-rose-500/20 bg-rose-500/12 text-rose-700 dark:text-rose-300'
          }`}
        >
          {result.text}
        </p>
      )}
    </div>
  );
}
