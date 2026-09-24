'use client';

// ホームの月切替 [‹][9月][›]。月ラベルを押すと期間シート。期間指定では前後に動かさない。
// 丸は 48、並びは 48 / 156 / 48 を中央に（design.md §3.2）。
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { T } from '@/lib/uiText';
import { IconButton } from '@/components/ui/IconButton';
import { Skeleton } from '@/components/ui/Skeleton';

interface MonthStepperProps {
  /** 期間の設定を読み終えるまでは null（形だけ出す。サーバー描画と最初の描画を揃える） */
  label: string | null;
  canShift: boolean;
  onShift: (delta: number) => void;
  onOpenPeriod: () => void;
}

export function MonthStepper({ label, canShift, onShift, onOpenPeriod }: MonthStepperProps) {
  return (
    <div className="mt-[25px] grid grid-cols-[48px_156px_48px] items-center justify-center">
      <IconButton
        label={T.aria.prevMonth}
        icon={ChevronLeft}
        iconSize={24}
        strokeWidth={2.25}
        disabled={!canShift || label === null}
        onClick={() => onShift(-1)}
      />
      {label === null ? (
        <Skeleton className="mx-auto h-7 w-16 rounded-lg" />
      ) : (
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={onOpenPeriod}
          className="mx-auto max-w-full truncate rounded-full px-3 py-1 text-center text-kb-month text-ink transition-opacity active:opacity-70"
        >
          {label}
        </button>
      )}
      <IconButton
        label={T.aria.nextMonth}
        icon={ChevronRight}
        iconSize={24}
        strokeWidth={2.25}
        disabled={!canShift || label === null}
        onClick={() => onShift(1)}
      />
    </div>
  );
}
