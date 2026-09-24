'use client';

// 月ピル（明細・ふたりのヘッダー右）。[月ラベル 18/500][▼]。表示の月ラベルがボタンの名前になる。
import { ChevronDown } from 'lucide-react';
import { cx } from '@/lib/cx';
import type { PillProps } from './HeaderPill';

export function MonthPill({ label, className, type = 'button', ...rest }: PillProps) {
  return (
    <button
      type={type}
      aria-haspopup="dialog"
      className={cx(
        'kb-glass inline-flex h-12 shrink-0 items-center gap-[14px] rounded-full pl-[26px] pr-[22px] text-kb-pill-month text-ink transition-transform duration-150 active:scale-[0.97] disabled:opacity-40',
        className
      )}
      {...rest}
    >
      <span className="whitespace-nowrap">{label}</span>
      <ChevronDown size={20} strokeWidth={2} />
    </button>
  );
}
