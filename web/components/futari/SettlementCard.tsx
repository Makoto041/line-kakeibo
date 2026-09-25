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
      className="kb-card-2 mx-4 mt-4 rounded-kb-xl px-4 pb-4 pt-4"
    >
      <h2 id="futari-heading" tabIndex={-1} className="text-center outline-none text-kb-card-label text-ink-2">
        {T.futari.heading}
      </h2>

      <div className="mt-4 flex items-center justify-center gap-3">
        {busy ? (
          <>
            <Skeleton className="h-14 w-14 rounded-full" />
            <MoveRight size={22} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-ink-4" />
            <Skeleton className="h-14 w-14 rounded-full" />
          </>
        ) : (
          <>
            <Avatar initial={vm.left?.initial ?? ''} tone={vm.left?.tone ?? 'neutral'} dim={!vm.left} />
            <MoveRight
              size={22}
              strokeWidth={2.25}
              aria-hidden="true"
              className={cx('shrink-0 text-ink', vm.idle && 'opacity-40')}
            />
            <Avatar initial={vm.right?.initial ?? ''} tone={vm.right?.tone ?? 'neutral'} dim={vm.idle || !vm.right} />
          </>
        )}
      </div>

      <div className="mt-3 flex min-h-[50px] items-center justify-center">
        {failed ? (
          <IconButton label={T.aria.retry} icon={RotateCw} onClick={onRetry} />
        ) : busy ? (
          <Skeleton className="h-11 w-40 rounded-xl" />
        ) : (
          <Amount value={vm.amount} base={44} className="text-ink" />
        )}
      </div>
      <p className="mt-1 text-center text-kb-note text-ink-3">{T.futari.half}</p>

      <div className="mt-4 border-t border-divider">
        {!busy &&
          vm.rows.map((row) => (
            <div key={row.lineId} className="flex h-12 items-center gap-3 border-b border-divider px-0.5">
              <span className="min-w-0 flex-1 truncate text-kb-sum-label text-ink-soft">
                {row.initial}
                {T.futari.advanceOf}
              </span>
              <Amount value={row.total} base={18} className="shrink-0 text-ink" />
            </div>
          ))}
        <button
          type="button"
          aria-haspopup="dialog"
          disabled={!vm.canOpenBreakdown}
          onClick={onOpenBreakdown}
          className="mb-3 flex h-12 w-full items-center pl-0.5 text-left transition-opacity active:opacity-70 disabled:opacity-40"
        >
          <DocLines size={20} strokeWidth={1.9} className="shrink-0 text-ink" />
          <span className="ml-3 min-w-0 flex-1 truncate text-kb-sum-label text-ink-soft">{T.futari.breakdown}</span>
          <ChevronRight size={16} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-ink-4" />
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
