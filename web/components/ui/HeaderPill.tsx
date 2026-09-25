'use client';

// ヘッダー右のピル（世帯「ふたり」・ゲスト）。[アイコン][短いラベル][▼]。
// 表示している文字がそのままボタンの名前になる。押すとシートが開く。
import type { ButtonHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cx } from '@/lib/cx';
import type { AnyIcon } from './icons';

export interface PillProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
}

export function HeaderPill({ label, icon: Icon, className, type = 'button', ...rest }: PillProps & { icon: AnyIcon }) {
  return (
    <button
      type={type}
      aria-haspopup="dialog"
      className={cx(
        'kb-glass relative inline-flex h-10 shrink-0 before:absolute before:-inset-y-0.5 before:inset-x-0 before:rounded-full items-center gap-1.5 rounded-full px-3 text-kb-pill text-ink transition-transform duration-150 active:scale-[0.97] disabled:opacity-40',
        className
      )}
      {...rest}
    >
      <Icon size={18} strokeWidth={2} />
      <span className="whitespace-nowrap">{label}</span>
      <ChevronDown size={14} strokeWidth={2.25} />
    </button>
  );
}
