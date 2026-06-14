'use client';

import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from './theme/ThemeProvider';

type ThemeToggleProps = {
  size?: 'sm' | 'md';
};

const OPTIONS = [
  { key: 'light', label: 'ライト', Icon: Sun },
  { key: 'dark', label: 'ダーク', Icon: Moon },
  { key: 'system', label: '自動', Icon: Monitor },
] as const;

export function ThemeToggle({ size = 'md' }: ThemeToggleProps) {
  const { themeSetting, isReady, setTheme } = useTheme();
  const pad = size === 'sm' ? 'p-1.5' : 'p-2';

  return (
    <div
      role="radiogroup"
      aria-label="テーマ"
      className="inline-flex items-center gap-0.5 rounded-full border border-line/70 bg-card/60 p-0.5 shadow-sm"
    >
      {OPTIONS.map(({ key, label, Icon }) => {
        const active = themeSetting === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            disabled={!isReady}
            onClick={() => setTheme(key)}
            className={`${pad} inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-50 ${
              active
                ? 'bg-accent text-accent-fg shadow-sm'
                : 'text-muted hover:bg-fg/5 hover:text-fg'
            }`}
          >
            <Icon className={size === 'sm' ? 'h-4 w-4' : 'h-[18px] w-[18px]'} strokeWidth={2} />
          </button>
        );
      })}
    </div>
  );
}
