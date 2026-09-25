'use client';

// ホームの「予算残り」（カードなし。背景の上に直接置く）。全体が 1 つのボタンで、押すと予算シート。
// 予算残り・金額 62・バーと使った割合・使った額 / 予算（design.md §3.3）。
// 超過したら「予算超過」と超過額を赤に、バーは 100% の赤、% は実際の値。
// 読み込み中は形だけ（¥0 を出さない）。予算を読めなかったときは % の位置に再試行の丸。
import { RotateCw } from 'lucide-react';
import { computeBudgetHero } from '@/lib/budgetAnalytics';
import { yen } from '@/lib/money';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import { Amount } from '@/components/ui/Amount';
import { IconButton } from '@/components/ui/IconButton';
import { Skeleton, SkeletonGroup } from '@/components/ui/Skeleton';

interface BudgetHeroProps {
  /** 読み込み中（形だけ出す） */
  loading: boolean;
  spent: number;
  /** 予算。読めなかったときは null */
  budget: number | null;
  onOpen: () => void;
  /** 予算の読み込みに失敗したときの再試行 */
  onRetry?: () => void;
}

export function BudgetHero({ loading, spent, budget, onOpen, onRetry }: BudgetHeroProps) {
  if (loading) {
    return (
      <SkeletonGroup className="mt-4 px-5">
        <Skeleton className="h-4 w-16 rounded-md" />
        <Skeleton className="mt-1.5 h-10 w-44 rounded-xl" />
        <Skeleton className="mt-3 h-1.5 w-full rounded-full" />
        <Skeleton className="mt-2 h-3.5 w-36 rounded-md" />
      </SkeletonGroup>
    );
  }

  const failed = budget === null;
  const n = computeBudgetHero(spent, budget ?? 0);

  return (
    <div className="relative mt-4 px-5">
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={onOpen}
        className="block w-full text-left transition-opacity active:opacity-80"
      >
        <span className="block text-kb-label text-ink-2">{n.over ? T.home.over : T.home.remaining}</span>
        <span className="mt-0.5 flex">
          <Amount
            value={failed ? null : Math.abs(n.remaining)}
            base={40}
            className={n.over ? 'text-danger' : 'text-ink'}
          />
        </span>
        <span className="mt-2.5 flex h-4 items-center gap-3">
          <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--kb-bar-track)]">
            {!failed && (
              <span
                className="absolute inset-y-0 left-0 rounded-full shadow-[inset_-1px_0_0_rgba(255,255,255,0.6)] transition-[width] duration-500"
                style={{ width: `${n.barPct}%`, background: n.over ? 'var(--kb-danger-grad)' : 'var(--kb-bar-grad)' }}
              />
            )}
          </span>
          <span className={cx('text-right text-kb-pct tabular-nums', n.over ? 'text-danger' : 'text-ink-2', failed && 'invisible')}>
            {failed ? '0%' : `${n.pct}%`}
          </span>
        </span>
        <span className="mt-1 block text-kb-sub tabular-nums text-ink-3">
          {yen(n.spent)}
          <span className="mx-[0.6em]">/</span>
          {failed ? '—' : yen(n.budget)}
        </span>
      </button>
      {failed && onRetry && (
        <IconButton
          label={T.aria.retry}
          icon={RotateCw}
          size={36}
          iconSize={16}
          onClick={onRetry}
          className="absolute right-4 top-[26px]"
        />
      )}
    </div>
  );
}
