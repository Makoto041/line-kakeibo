'use client';

// テーマの切り替え（ライト / ダーク / 自動）。設定の「表示」の中で使う。
// 選んだ時点で反映し、端末に保存する（ThemeProvider）。
import { Sun, Moon, Monitor } from 'lucide-react';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import { useTheme } from './theme/ThemeProvider';

const OPTIONS = [
  { key: 'light', label: T.settings.themeLight, Icon: Sun },
  { key: 'dark', label: T.settings.themeDark, Icon: Moon },
  { key: 'system', label: T.settings.themeSystem, Icon: Monitor },
] as const;

export function ThemeToggle({ className }: { className?: string }) {
  const { themeSetting, isReady, setTheme } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label={T.settings.theme}
      className={cx('kb-seg grid h-[52px] grid-cols-3 rounded-full p-[2px]', className)}
    >
      {OPTIONS.map(({ key, label, Icon }) => {
        const active = themeSetting === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={!isReady}
            onClick={() => setTheme(key)}
            className={cx(
              'inline-flex h-full min-w-0 items-center justify-center gap-2 rounded-full text-kb-seg transition-colors duration-150 disabled:opacity-50',
              active ? 'kb-seg-on font-semibold' : 'text-ink'
            )}
          >
            <Icon size={18} strokeWidth={2} />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
