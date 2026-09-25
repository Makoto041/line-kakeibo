'use client';

import Link from 'next/link';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import { NAV_ITEMS, isActivePath } from './nav';

/**
 * 画面下に浮かぶガラスのナビ（ホーム / 明細 / ふたり）。スマホ・PC とも同じ形で、
 * 列の中央に置く（最大 360px）。選択中はピルの中に塗りのアイコンと太字のラベル。
 */
export function BottomTabBar({ pathname }: { pathname: string }) {
  return (
    <nav
      data-kb-behind-sheet=""
      aria-label={T.nav.label}
      className="kb-nav fixed left-1/2 z-40 -translate-x-1/2 rounded-full p-1"
      style={{
        bottom: 'calc(var(--kb-nav-bottom) + var(--kb-safe-bottom))',
        height: 'var(--kb-nav-h)',
        width: 'min(calc(100% - 32px), 360px)',
      }}
    >
      <ul className="grid h-full grid-cols-3">
        {NAV_ITEMS.map(({ path, label, Icon, ActiveIcon }) => {
          const active = isActivePath(pathname, path);
          return (
            <li key={path} className="h-full min-w-0">
              <Link
                href={path}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex h-full flex-col items-center justify-center gap-0.5 rounded-full text-kb-nav transition-colors duration-150',
                  active ? 'kb-nav-sel font-bold text-accent-strong' : 'border border-transparent text-nav-ink'
                )}
              >
                {active ? <ActiveIcon size={22} /> : <Icon size={22} strokeWidth={1.9} />}
                <span className="whitespace-nowrap">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
