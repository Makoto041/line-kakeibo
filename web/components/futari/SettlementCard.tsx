'use client';

// ふたりの精算カード（design.md §3.11）。
// 今月の精算 / [払う人] → [受け取る人] / 金額 / 折半 / ◯の立替 ×人数 / 内訳 › / 精算を記録。
// 精算額が 0 のときは矢印と受け取る側を薄く、計算できないときは金額を「—」にしてメンバーの行を出さない。
import { ChevronRight, CircleCheck, MoveRight, RotateCw } from 'lucide-react';
import type { SettlementViewModel } from '@/lib/settlementView';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import { Amount } from '@/components/ui/Amount';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import { Skeleton } from '@/components/ui/Skeleton';
import { DocLines } from '@/components/ui/icons';

interface SettlementCardProps {
  vm: SettlementViewModel;
  loading: boolean;
  /** 読み込みに失敗した（金額の位置に再試行の丸を出す） */
  failed: boolean;
  onRetry: () => void;
  onOpenBreakdown: () => void;
  onSettle: () => void;
}

export function SettlementCard({ vm, loading, failed, onRetry, onOpenBreakdown, onSettle }: SettlementCardProps) {
  const busy = loading && !failed;
  return (
    <section
      aria-labelledby="futari-heading"
      aria-busy={busy || undefined}
      className="kb-card-2 mx-4 mt-7 rounded-kb-xl px-[14px] pb-4 pt-5"
    >
      <h2 id="futari-heading" className="text-center text-kb-card-label text-ink-2">
        {T.futari.heading}
      </h2>

      <div className="mt-5 flex items-center justify-center gap-[18px]">
        {busy ? (
          <>
            <Skeleton className="h-20 w-20 rounded-full" />
            <MoveRight size={32} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-ink-4" />
            <Skeleton className="h-20 w-20 rounded-full" />
          </>
        ) : (
          <>
            <Avatar initial={vm.left?.initial ?? ''} tone={vm.left?.tone ?? 'neutral'} dim={!vm.left} />
            <MoveRight
              size={32}
              strokeWidth={2.25}
              aria-hidden="true"
              className={cx('shrink-0 text-ink', vm.idle && 'opacity-40')}
            />
            <Avatar initial={vm.right?.initial ?? ''} tone={vm.right?.tone ?? 'neutral'} dim={vm.idle || !vm.right} />
          </>
        )}
      </div>

      <div className="mt-4 flex min-h-[75px] items-center justify-center">
        {failed ? (
          <IconButton label={T.aria.retry} icon={RotateCw} onClick={onRetry} />
        ) : busy ? (
          <Skeleton className="h-[62px] w-56 rounded-2xl" />
        ) : (
          <Amount value={vm.amount} base={68} className="text-ink" />
        )}
      </div>
      <p className="mt-3 text-center text-kb-note text-ink-2">{T.futari.half}</p>

      <div className="mx-1 mt-7 border-t border-divider">
        {!busy &&
          vm.rows.map((row) => (
            <div key={row.lineId} className="flex h-[68px] items-center gap-3 border-b border-divider px-0.5">
              <span className="min-w-0 flex-1 truncate text-kb-sum-label text-ink-soft">
                {row.initial}
                {T.futari.advanceOf}
              </span>
              <Amount value={row.total} base={24} className="shrink-0 text-ink" />
            </div>
          ))}
        <button
          type="button"
          aria-haspopup="dialog"
          disabled={!vm.canOpenBreakdown}
          onClick={onOpenBreakdown}
          className="flex h-[72px] w-full items-center pl-0.5 pt-[6px] text-left transition-opacity active:opacity-70 disabled:opacity-40"
        >
          <DocLines size={35} strokeWidth={1.9} className="-mr-[7px] shrink-0 text-ink" />
          <span className="ml-6 min-w-0 flex-1 truncate text-kb-sum-label text-ink-soft">{T.futari.breakdown}</span>
          <ChevronRight size={24} strokeWidth={2} aria-hidden="true" className="-mr-1.5 shrink-0 text-ink-4" />
        </button>
      </div>

      <PrimaryButton
        icon={CircleCheck}
        aria-haspopup="dialog"
        disabled={!vm.canSettle || busy}
        onClick={onSettle}
      >
        {T.futari.settle}
      </PrimaryButton>
    </section>
  );
}
