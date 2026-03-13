'use client';

import { useMemo } from 'react';
import { useTheme } from './theme/ThemeProvider';

type ThemeToggleProps = {
  size?: 'sm' | 'md';
};

const labelMap = {
  light: 'ライト',
  dark: 'ダーク',
  system: '自動',
} as const;

export function ThemeToggle({ size = 'md' }: ThemeToggleProps) {
  const { resolvedTheme, themeSetting, systemTheme, isReady, toggleTheme, setTheme } = useTheme();

  const icon = resolvedTheme === 'dark' ? '🌙' : '☀️';
  const autoHint = useMemo(() => {
    if (themeSetting !== 'system') return null;
    return systemTheme === 'dark' ? 'OSがダーク' : 'OSがライト';
  }, [themeSetting, systemTheme]);

  const basePadding = size === 'sm' ? 'px-2 py-1' : 'px-3 py-2';
  const baseText = size === 'sm' ? 'text-xs' : 'text-sm';

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={!isReady}
        onClick={toggleTheme}
        className={`inline-flex items-center gap-2 rounded-full border border-slate-200/70 dark:border-slate-700 bg-white/70 dark:bg-slate-800/80 shadow-sm hover:shadow-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${basePadding}`}
        aria-label="ダークモードを切り替える"
      >
        <span className="text-lg leading-none">{icon}</span>
        <span className={`${baseText} font-semibold text-slate-700 dark:text-slate-100`}>
          {labelMap[resolvedTheme]}
        </span>
      </button>

      <button
        type="button"
        disabled={!isReady}
        onClick={() => setTheme(themeSetting === 'system' ? (resolvedTheme === 'dark' ? 'dark' : 'light') : 'system')}
        className={`inline-flex items-center gap-1 rounded-full border border-transparent ${basePadding} ${baseText} font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
          themeSetting === 'system'
            ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
            : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600'
        }`}
        aria-pressed={themeSetting === 'system'}
        aria-label="システム設定に合わせる"
      >
        <span className="text-base">🧭</span>
        <span>自動</span>
        {autoHint && <span className="text-[10px] opacity-80">{autoHint}</span>}
      </button>
    </div>
  );
}
