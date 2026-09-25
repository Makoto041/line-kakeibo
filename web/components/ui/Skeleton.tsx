// 読み込み中の形（文字は出さない）。まとまりの外側に aria-busy を付ける。
import { cx } from '@/lib/cx';

/** 1 つの形（角丸の面） */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx('block animate-pulse rounded-xl bg-skeleton', className)} />;
}

/** 読み込み中のまとまり（支援技術に読み込み中であることを伝える） */
export function SkeletonGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div aria-busy="true" className={className}>
      {children}
    </div>
  );
}
