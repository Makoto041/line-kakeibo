'use client';

// 主ボタン（高さ 64 の青いピル。[CircleCheck 28][短い語 20/700]）。
// 処理中はアイコンをスピナーに替えて押せなくする（文字は変えない）。
import type { ButtonHTMLAttributes } from 'react';
import { CircleCheck, LoaderCircle } from 'lucide-react';
import { cx } from '@/lib/cx';
import type { AnyIcon } from './icons';

interface PrimaryButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 先頭のアイコン。null で出さない */
  icon?: AnyIcon | null;
  loading?: boolean;
  /** primary: 青 / danger: 赤（削除の確定など） / soft: カード上の淡いボタン */
  variant?: 'primary' | 'danger' | 'soft';
  /** 高さ（既定 50） */
  height?: 44 | 48 | 50;
}

const HEIGHT_CLASS = { 44: 'h-11 text-[15px] font-semibold', 48: 'h-12 text-[16px] font-semibold', 50: 'h-[50px] text-kb-btn' };

export function PrimaryButton({
  icon = CircleCheck,
  loading = false,
  variant = 'primary',
  height = 50,
  disabled,
  className,
  children,
  type = 'button',
  onClick,
  ...rest
}: PrimaryButtonProps) {
  const Icon = icon;
  return (
    <button
      type={type}
      // 処理中は disabled にしない（押した直後にフォーカスがシートの外へ落ちないように）
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={cx(
        'inline-flex w-full items-center justify-center gap-2 rounded-full px-5 transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:pointer-events-none aria-disabled:pointer-events-none',
        HEIGHT_CLASS[height],
        variant === 'primary' && 'kb-btn-primary',
        variant === 'danger' && 'kb-btn-danger',
        variant === 'soft' && 'kb-glass-2 text-ink disabled:opacity-45 aria-disabled:opacity-45',
        className
      )}
      {...rest}
    >
      {loading ? (
        <LoaderCircle size={height === 44 ? 18 : 20} strokeWidth={2} className="animate-spin" />
      ) : (
        Icon && <Icon size={height === 44 ? 18 : 20} strokeWidth={2} />
      )}
      <span className="truncate">{children}</span>
    </button>
  );
}
