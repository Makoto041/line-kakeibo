'use client';

// アイコンだけの丸ボタン（ヘッダーの歯車・検索、月切替の ‹ ›、シートの閉じる・戻る、カードの鉛筆など）。
// 画面に文字を出さないので、aria-label（label）は必須。
import type { ButtonHTMLAttributes, Ref } from 'react';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import type { AnyIcon } from './icons';

type Size = 32 | 36 | 40 | 44 | 48 | 64;

const SIZE_CLASS: Record<Size, string> = {
  32: 'h-8 w-8',
  36: 'h-9 w-9',
  40: 'h-10 w-10',
  44: 'h-11 w-11',
  48: 'h-12 w-12',
  64: 'h-16 w-16',
};

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** アクセシブルネーム（画面には出さない） */
  label: string;
  icon: AnyIcon;
  size?: Size;
  iconSize?: number;
  strokeWidth?: number;
  /** glass: ヘッダー等の小さいガラス / soft: カードの上の丸 / plain: 面なし */
  variant?: 'glass' | 'soft' | 'plain';
  /** 絞り込み中の印（アイコンを青にして小さな点を付ける。文字は出さず、名前に「絞り込み中」を足す） */
  active?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  icon: Icon,
  size = 40,
  iconSize = 18,
  strokeWidth = 2,
  variant = 'glass',
  active = false,
  className,
  type = 'button',
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={active ? `${label} ${T.aria.filtering}` : label}
      className={cx(
        'relative inline-grid shrink-0 place-items-center rounded-full transition-[transform,opacity] duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40',
        SIZE_CLASS[size],
        variant === 'glass' && 'kb-glass',
        variant === 'soft' && 'kb-glass-2',
        active ? 'text-accent' : 'text-ink',
        className
      )}
      {...rest}
    >
      <Icon size={iconSize} strokeWidth={strokeWidth} />
      {active && (
        <span className="absolute right-[7px] top-[7px] h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
      )}
    </button>
  );
}
