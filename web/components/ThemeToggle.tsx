'use client';

// テーマの切り替え（ライト / ダーク / 自動）。設定の「表示」の中で使う。
// 選んだ時点で反映し、端末に保存する（ThemeProvider）。
import { useRef, type KeyboardEvent } from 'react';
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
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(0, OPTIONS.findIndex((o) => o.key === themeSetting));

  // ラジオグループの操作: 左右（上下）の矢印で選択を移し、Tab で止まるのは選ばれている 1 つだけ
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    const edge = e.key === 'Home' ? 0 : e.key === 'End' ? OPTIONS.length - 1 : -1;
    if (!step && edge < 0) return;
    e.preventDefault();
    if (!isReady) return;
    const next = edge >= 0 ? edge : (selected + step + OPTIONS.length) % OPTIONS.length;
    setTheme(OPTIONS[next].key);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={T.settings.theme}
      onKeyDown={onKeyDown}
      className={cx('kb-seg grid h-[52px] grid-cols-3 rounded-full p-[2px]', className)}
    >
      {OPTIONS.map(({ key, label, Icon }, index) => {
        const active = themeSetting === key;
        return (
          <button
            key={key}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={index === selected ? 0 : -1}
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
