'use client';

// シートの中の行（高さ 56〜64、行の間に細い区切り線）。
// - NavRow: 別のシート・ページへ進む行（[アイコン][短い語][›]）
// - InfoRow: 見出しと値の行（読み取りのみ）
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cx } from '@/lib/cx';
import type { AnyIcon } from './icons';

const ROW = 'flex min-h-12 w-full items-center gap-3 border-b border-divider px-1 last:border-b-0';

interface NavRowBase {
  icon?: AnyIcon;
  label: string;
  /** 右側に出す値（短い語やデータ） */
  value?: string;
  className?: string;
}

export function NavRow({
  icon: Icon,
  label,
  value,
  className,
  href,
  onClick,
  disabled,
}: NavRowBase & { href?: string; onClick?: () => void; disabled?: boolean }) {
  const inner = (
    <>
      {Icon && <Icon size={20} strokeWidth={1.9} className="shrink-0 text-ink" />}
      <span className="min-w-0 flex-1 truncate text-left text-kb-row text-ink-soft">{label}</span>
      {value && <span className="shrink-0 text-kb-caption text-ink-4">{value}</span>}
      <ChevronRight size={16} strokeWidth={2.25} className="shrink-0 text-ink-4" />
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cx(ROW, 'transition-opacity active:opacity-70', className)}>
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(ROW, 'transition-opacity active:opacity-70 disabled:opacity-40', className)}
    >
      {inner}
    </button>
  );
}

export function InfoRow({
  icon: Icon,
  label,
  children,
  className,
}: {
  icon?: AnyIcon;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(ROW, className)}>
      {Icon && <Icon size={18} strokeWidth={1.9} className="shrink-0 text-ink-3" />}
      <span className="shrink-0 text-kb-caption text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 text-right text-[15px] break-words text-ink">{children}</span>
    </div>
  );
}

/** シートの中の小見出し（13/600） */
export function SheetSection({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('mt-5 first:mt-1', className)}>
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <h3 className="text-[13px] font-semibold text-ink-3">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}
