'use client';

// 精算: 未精算の立替から「誰が誰にいくら払うか」を出し、精算を記録する。
// 値はすべてサーバー（/household/settlement）の応答から作る（LINE の「立替一覧」「精算」と同じ集合・同じ式）。
import React, { useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { ArrowRight, CircleCheck, HandCoins, Loader2, RefreshCw, Users } from 'lucide-react';
import PreviewModeBanner from '../../components/PreviewModeBanner';
import { useHousehold, useLineAuth, useSettlement, patchCachedExpenses } from '../../lib/hooks';
import { householdErrorCode, isHouseholdApiConfigured, settle } from '../../lib/householdApi';
import { buildSettlementViewModel, clearedSettlement, groupSettlementItems } from '../../lib/settlementView';
import { getCategoryVisual } from '../../lib/categoryVisuals';

const yen = (n: number) => `¥${n.toLocaleString()}`;

function settleErrorMessage(error: unknown): string {
  switch (householdErrorCode(error)) {
    case 'forbidden':
      return 'この世帯の精算を記録する権限がありません';
    case 'nothing_to_settle':
    case 'nothing_settled':
      return '未精算の立替はありません（ほかの端末で精算済みの可能性があります）';
    case 'undeterminable':
      return '精算の相手が決められないため記録できません';
    case 'rate_limited':
      return '操作が多すぎます。少し待ってからやり直してください';
    default:
      return '精算の記録に失敗しました。時間をおいてやり直してください';
  }
}

export default function SettlementPage() {
  const { lineId, loading: authLoading } = useLineAuth();
  const isGuest = !authLoading && !lineId;
  const householdState = useHousehold(lineId);
  const household = householdState.household;
  const groupId = household ? household.groupId : null;
  const settlementState = useSettlement(groupId);
  const apiAvailable = isHouseholdApiConfigured();
  const data = settlementState.data;

  const fallbackNames = useMemo(
    () => Object.fromEntries((household?.members ?? []).map((m) => [m.lineId, m.displayName])),
    [household]
  );
  const vm = useMemo(
    () => buildSettlementViewModel(data, { apiAvailable, guest: isGuest, fallbackNames }),
    [data, apiAvailable, isGuest, fallbackNames]
  );
  const breakdown = useMemo(() => (data ? groupSettlementItems(data, fallbackNames) : []), [data, fallbackNames]);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [settling, setSettling] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const loading = authLoading || householdState.loading || settlementState.loading;
  const failed = !!householdState.error || !!settlementState.error;

  const retry = () => {
    if (householdState.error) householdState.refetch();
    if (settlementState.error) settlementState.refetch();
  };

  const record = async () => {
    if (!groupId || !data || settling || !vm.canSettle) return;
    setSettling(true);
    setMessage(null);
    try {
      const outcome = await settle(groupId, data.expenseIds, data.settlement);
      if (outcome.ok) {
        // ほかの画面（支出の一覧）が古い状態を出さないよう、読み込み済みの一覧も精算済みにする
        patchCachedExpenses(data.expenseIds, { status: 'advance_settled' });
        settlementState.setData(clearedSettlement(data));
        settlementState.refetch();
        setConfirmOpen(false);
        setMessage({ type: 'success', text: `精算を記録しました（${outcome.settled}件）` });
      } else {
        // 表示していた内容が古かった: 最新の金額・件数に差し替えて、もう一度確かめてもらう
        settlementState.setData(outcome.stale);
        setMessage({ type: 'info', text: '立替の内容が更新されました。金額を確認してから、もう一度記録してください' });
      }
    } catch (error) {
      console.error('Failed to record settlement:', error);
      setMessage({ type: 'error', text: settleErrorMessage(error) });
      const code = householdErrorCode(error);
      if (code === 'nothing_to_settle' || code === 'nothing_settled' || code === 'undeterminable') {
        settlementState.refetch();
        setConfirmOpen(false);
      }
    } finally {
      setSettling(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="mt-3 text-sm text-muted">読み込み中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-5 md:px-8 md:py-7">
      {isGuest && (
        <div className="mb-4">
          <PreviewModeBanner />
        </div>
      )}

      {message && (
        <div
          role={message.type === 'error' ? 'alert' : 'status'}
          className={`mb-4 rounded-xl p-3 text-sm ${
            message.type === 'success'
              ? 'border border-emerald-500/20 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
              : message.type === 'info'
              ? 'border border-amber-500/20 bg-amber-500/12 text-amber-700 dark:text-amber-300'
              : 'border border-rose-500/20 bg-rose-500/12 text-rose-700 dark:text-rose-300'
          }`}
        >
          {message.text}
        </div>
      )}

      {isGuest ? (
        <div className="glass rounded-2xl p-6 text-center shadow-glass">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent/12 text-accent">
            <HandCoins className="h-6 w-6" />
          </span>
          <h2 className="text-base font-semibold text-fg">ふたりの精算</h2>
          <p className="mt-1.5 text-sm text-muted">LINEボットから届くリンクで開くと、立替の精算額を確認・記録できます。</p>
        </div>
      ) : failed && !data ? (
        <div className="glass rounded-2xl p-6 text-center shadow-glass">
          <p className="text-sm text-muted">精算の情報を読み込めませんでした</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-4 py-2 text-sm font-medium text-fg hover:bg-fg/5"
          >
            <RefreshCw className="h-4 w-4" />
            再読み込み
          </button>
        </div>
      ) : !household ? (
        <div className="glass rounded-2xl p-6 text-center shadow-glass">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-fg/5 text-muted">
            <Users className="h-6 w-6" />
          </span>
          <p className="text-sm text-muted">世帯（LINEグループ）に参加すると、ふたりの精算を確認できます</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* 精算額 */}
          <div className="glass animate-fade-up rounded-2xl p-5 shadow-glass">
            <div className="flex items-center justify-between">
              <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-fg">
                <HandCoins className="h-4 w-4 text-accent" />
                未精算の立替の精算
              </h2>
              <span className="text-xs text-muted">{vm.count}件</span>
            </div>

            {vm.undeterminable ? (
              <p className="mt-4 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                世帯のメンバーが2人そろっていないため、精算額を計算できません
              </p>
            ) : (
              <>
                <div className="mt-5 flex items-center justify-center gap-3">
                  <PersonBadge name={vm.left?.name} initial={vm.left?.initial} dim={!vm.left} />
                  <ArrowRight className={`h-5 w-5 shrink-0 text-muted ${vm.idle ? 'opacity-40' : ''}`} />
                  <PersonBadge name={vm.right?.name} initial={vm.right?.initial} dim={vm.idle || !vm.right} />
                </div>
                <p className="mt-4 text-center text-4xl font-black tabular-nums text-fg">{yen(vm.amount ?? 0)}</p>
                <p className="mt-1 text-center text-xs text-muted">
                  {vm.idle ? '精算は不要です' : `${vm.left?.name || '左の人'}が${vm.right?.name || '右の人'}に送金（立替の差額の半分）`}
                </p>

                {vm.rows.length > 0 && (
                  <div className="mt-5 grid grid-cols-2 gap-3">
                    {vm.rows.map((row) => (
                      <div key={row.lineId} className="rounded-xl border border-line bg-fg/[0.02] p-3 text-center">
                        <p className="truncate text-xs text-muted">{fallbackNames[row.lineId] || row.initial}の立替</p>
                        <p className="mt-0.5 text-lg font-bold tabular-nums text-fg">{yen(row.total)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {confirmOpen ? (
              <div className="mt-5 rounded-xl border border-accent/25 bg-accent/[0.06] p-4">
                <p className="text-sm font-medium text-fg">
                  {vm.count}件の立替を精算済みにします。{!vm.idle && `${yen(vm.amount ?? 0)} の送金が済んでから記録してください。`}
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={settling}
                    onClick={() => setConfirmOpen(false)}
                    className="flex-1 rounded-xl border border-line bg-card py-2.5 text-sm font-medium text-fg hover:bg-fg/5 disabled:opacity-50"
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    disabled={settling || !vm.canSettle}
                    onClick={record}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent py-2.5 text-sm font-medium text-accent-fg shadow-sm hover:opacity-90 disabled:opacity-50"
                  >
                    {settling ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleCheck className="h-4 w-4" />}
                    記録する
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={!vm.canSettle}
                onClick={() => {
                  setMessage(null);
                  setConfirmOpen(true);
                }}
                className="mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent py-3 font-medium text-accent-fg shadow-sm transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CircleCheck className="h-4 w-4" />
                精算を記録
              </button>
            )}
          </div>

          {/* 内訳 */}
          {breakdown.length > 0 && (
            <div className="glass rounded-2xl p-5 shadow-glass">
              <h3 className="mb-3 text-sm font-semibold text-fg">内訳</h3>
              <div className="space-y-4">
                {breakdown.map((group) => (
                  <div key={group.lineId || 'unknown'}>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-medium text-fg">{group.name || fallbackNames[group.lineId] || 'メンバー外'}</span>
                      <span className="text-sm font-bold tabular-nums text-fg">{yen(group.total)}</span>
                    </div>
                    <ul className="divide-y divide-line rounded-xl border border-line">
                      {group.items.map((item) => {
                        const v = getCategoryVisual(item.category);
                        const Icon = v.icon;
                        return (
                          <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                            <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${v.bg} ${v.fg}`}>
                              <Icon className="h-3.5 w-3.5" strokeWidth={2.1} />
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm text-fg">{item.description || item.category}</p>
                              <p className="text-xs text-muted">{dayjs(item.date).format('M月D日')}</p>
                            </div>
                            <span className="shrink-0 text-sm font-medium tabular-nums text-fg">{yen(item.amount)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PersonBadge({ name, initial, dim }: { name?: string; initial?: string; dim?: boolean }) {
  return (
    <div className={`flex w-24 flex-col items-center gap-1.5 ${dim ? 'opacity-40' : ''}`}>
      <span className="grid h-12 w-12 place-items-center rounded-full bg-accent/12 text-lg font-bold text-accent">
        {initial || '?'}
      </span>
      <span className="max-w-full truncate text-xs text-muted">{name || '　'}</span>
    </div>
  );
}
