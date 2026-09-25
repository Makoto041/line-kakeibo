'use client';

// ふたり: 見出し（月ピル）/ 今月の精算のカード。
// 表示する値はすべてサーバー（/household/settlement）の応答から作る（LINE の「立替一覧」「精算」と同じ集合）。
// 精算の範囲は未精算の立替の全件で、月ピルは 3 タブ共通の期間の表示・切り替えだけ（範囲は変えない）。
// API が使えないとき・世帯が無いときは ¥0 とボタン無効、ゲストはサンプルの支出から同じ式で出す。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import { useHousehold, useLineAuth, useSettlement, patchCachedExpenses } from '@/lib/hooks';
import { householdErrorCode, householdErrorToast, isHouseholdApiConfigured, settle } from '@/lib/householdApi';
import { buildSettlementViewModel, clearedSettlement } from '@/lib/settlementView';
import { getSampleSettlement } from '@/lib/sampleSettlement';
import { T } from '@/lib/uiText';
import { usePeriod } from '@/components/period/PeriodProvider';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { MonthPill } from '@/components/ui/MonthPill';
import { IconButton } from '@/components/ui/IconButton';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { CommonSheets, useCommonSheet } from '@/components/sheets/CommonSheets';
import { BreakdownSheet } from '@/components/sheets/BreakdownSheet';
import { SettleConfirmSheet } from '@/components/sheets/SettleConfirmSheet';
import { SettlementCard } from '@/components/futari/SettlementCard';

type FutariSheet = 'breakdown' | 'settle' | null;

export default function FutariPage() {
  const { lineId, settled } = useLineAuth();
  const { label, settingsLoaded } = usePeriod();
  const ready = settled && settingsLoaded;
  const isGuest = ready && !lineId;
  const toast = useToast();

  const householdState = useHousehold(lineId);
  const household = householdState.household;
  const groupId = !isGuest && household ? household.groupId : null;
  const settlementState = useSettlement(ready ? groupId : null);
  const apiAvailable = isHouseholdApiConfigured();

  const sample = useMemo(() => (isGuest ? getSampleSettlement() : null), [isGuest]);
  const data = isGuest ? sample : settlementState.data;
  const fallbackNames = useMemo(
    () => Object.fromEntries((household?.members ?? []).map((m) => [m.lineId, m.displayName])),
    [household]
  );
  const vm = useMemo(
    () => buildSettlementViewModel(data, { apiAvailable, guest: isGuest, fallbackNames }),
    [data, apiAvailable, isGuest, fallbackNames]
  );

  const loading = !ready || (!isGuest && (householdState.loading || settlementState.loading));
  const failed = !isGuest && ready && (!!householdState.error || !!settlementState.error);
  const retry = () => {
    if (householdState.error) householdState.refetch();
    if (settlementState.error) settlementState.refetch();
  };

  const { sheet: commonSheet, setSheet: setCommonSheet } = useCommonSheet();
  const [sheet, setSheet] = useState<FutariSheet>(null);
  const [settling, setSettling] = useState(false);
  // 精算の後は開いたボタンが無効になり、シートがフォーカスを戻せない。見出しへ移す
  const focusHeadingAfterClose = useRef(false);
  useEffect(() => {
    if (sheet !== null || !focusHeadingAfterClose.current) return;
    focusHeadingAfterClose.current = false;
    document.getElementById('futari-heading')?.focus({ preventScroll: true });
  }, [sheet]);

  const recordSettlement = async () => {
    if (!groupId || !data || settling || !vm.canSettle) return;
    setSettling(true);
    try {
      const outcome = await settle(groupId, data.expenseIds, data.settlement);
      if (outcome.ok) {
        // 他の画面（明細の立替）が古い状態を出さないように、読み込み済みの一覧も精算済みにする
        patchCachedExpenses(data.expenseIds, { status: 'advance_settled' });
        settlementState.setData(clearedSettlement(data));
        settlementState.refetch();
        focusHeadingAfterClose.current = true;
        setSheet(null);
      } else {
        // 表示していた内容が古かった: 最新の金額・件数に差し替え、もう一度押してもらう
        settlementState.setData(outcome.stale);
      }
    } catch (error) {
      console.error('Failed to record settlement:', error);
      toast.show(householdErrorToast(error));
      const code = householdErrorCode(error);
      if (code === 'nothing_to_settle' || code === 'nothing_settled' || code === 'undeterminable') {
        settlementState.refetch();
        focusHeadingAfterClose.current = true;
        setSheet(null);
      }
    } finally {
      setSettling(false);
    }
  };

  return (
    <>
      <ScreenHeader
        title={T.futari.title}
        right={
          <>
            {isGuest && (
              // ゲスト案内はシートにだけ置く（画面には文字を足さない）
              <IconButton
                label={T.sheet.guest}
                icon={Eye}
                aria-haspopup="dialog"
                onClick={() => {
                  setSheet(null);
                  setCommonSheet({ kind: 'guest' });
                }}
              />
            )}
            {ready ? (
              <MonthPill
                label={label}
                onClick={() => {
                  setSheet(null);
                  setCommonSheet({ kind: 'period' });
                }}
              />
            ) : (
              <Skeleton className="h-12 w-[110px] rounded-full" />
            )}
          </>
        }
      />
      <CommonSheets sheet={commonSheet} setSheet={setCommonSheet} household={householdState} />

      <SettlementCard
        vm={vm}
        loading={loading}
        failed={failed && !data}
        onRetry={retry}
        onOpenBreakdown={() => {
          setCommonSheet(null);
          setSheet('breakdown');
        }}
        onSettle={() => {
          setCommonSheet(null);
          setSheet('settle');
        }}
      />

      <BreakdownSheet
        open={sheet === 'breakdown'}
        onClose={() => setSheet(null)}
        data={data}
        fallbackNames={fallbackNames}
      />
      <SettleConfirmSheet
        open={sheet === 'settle'}
        onClose={() => setSheet(null)}
        vm={vm}
        settling={settling}
        onConfirm={recordSettlement}
      />
    </>
  );
}
