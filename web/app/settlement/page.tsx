'use client';

// 精算: 期間の精算（折半）。期間内の世帯の支出を折半し、立替は全額を加算して、指定したメンバーから集金する額
// （PeriodSplitCard）。立替を全額にする前に「自分が立替」にした支出が残っていれば、精算済みにするお知らせ
// （LeftoverAdvancesCard）を下に出す。
import React, { useMemo, useState } from 'react';
import { HandCoins, RefreshCw, Users } from 'lucide-react';
import PreviewModeBanner from '../../components/PreviewModeBanner';
import PeriodSplitCard from '../../components/PeriodSplitCard';
import LeftoverAdvancesCard from '../../components/LeftoverAdvancesCard';
import { useLegacyAdvances, useHousehold, useLineAuth, patchCachedExpenses, invalidateStatsCache } from '../../lib/hooks';
import { isHouseholdApiConfigured } from '../../lib/householdApi';

export default function SettlementPage() {
  const { lineId, loading: authLoading } = useLineAuth();
  const isGuest = !authLoading && !lineId;
  const householdState = useHousehold(lineId);
  const household = householdState.household;
  const groupId = household ? household.groupId : null;
  const advancesState = useLegacyAdvances(groupId);
  const apiAvailable = isHouseholdApiConfigured();
  const advances = advancesState.data;

  const names = useMemo(
    () => Object.fromEntries((household?.members ?? []).map((m) => [m.lineId, m.displayName])),
    [household]
  );
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const loading = authLoading || householdState.loading;
  const householdFailed = !!householdState.error && !household;

  if (loading) {
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
          <p className="mt-1.5 text-sm text-muted">LINEボットから届くリンクで開くと、期間の精算額を確認できます。</p>
        </div>
      ) : householdFailed ? (
        <div className="glass rounded-2xl p-6 text-center shadow-glass">
          <p className="text-sm text-muted">精算の情報を読み込めませんでした</p>
          <button
            type="button"
            onClick={householdState.refetch}
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
          {lineId && (
            <PeriodSplitCard
              lineId={lineId}
              groupId={household.groupId}
              members={household.members}
              collectFrom={household.splitCollectFrom}
              onSaved={householdState.refetch}
              canSave={apiAvailable}
            />
          )}

          {/* 全額にする前の立替が残っているときだけ（0 件・読み込み中・読めないときは出さない） */}
          {advances && advances.items.length > 0 && (
            <LeftoverAdvancesCard
              groupId={household.groupId}
              data={advances}
              names={names}
              canSettle={apiAvailable}
              onSettled={(ids, settled, skipped) => {
                // ほかの画面（支出の一覧・期間の精算）が古い状態を出さないよう、読み込み済みの一覧も精算済みにする
                // （飛ばしたものがあればどれか分からないので、次に読み込むときに任せる）
                if (skipped === 0) patchCachedExpenses(ids, { status: 'advance_settled' });
                invalidateStatsCache();
                advancesState.setData({ ...advances, items: [], expenseIds: [] });
                advancesState.refetch();
                setMessage({ type: 'success', text: `${settled}件を精算済みにしました` });
              }}
              onStale={(latest) => {
                advancesState.setData(latest);
                if (latest.items.length > 0) {
                  setMessage({ type: 'info', text: '立替の内容が更新されました。件数を確認してから、もう一度精算済みにしてください' });
                }
              }}
              onError={(text) => setMessage({ type: 'error', text })}
            />
          )}
        </div>
      )}
    </div>
  );
}
