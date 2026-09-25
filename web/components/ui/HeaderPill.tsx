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
        'kb-glass inline-flex h-12 shrink-0 items-center gap-2 rounded-full pl-[18px] pr-[14px] text-kb-pill text-ink transition-transform duration-150 active:scale-[0.97] disabled:opacity-40',
        className
      )}
      {...rest}
    >
      <Icon size={22} strokeWidth={2} />
      <span className="whitespace-nowrap">{label}</span>
      <ChevronDown size={18} strokeWidth={2} />
    </button>
  );
}
