'use client';

import Link from 'next/link';
import { NAV_ITEMS, isActivePath } from './nav';

interface BottomTabBarProps {
  pathname: string;
  hrefFor: (path: string) => string;
}

/** Mobile-only bottom tab bar (hidden on md+). */
export function BottomTabBar({ pathname, hrefFor }: BottomTabBarProps) {
  return (
    <nav
      aria-label="メインナビゲーション"
      className="md:hidden fixed inset-x-0 bottom-0 z-40 glass-bar border-t border-line/60 pb-safe"
    >
      <ul className="grid grid-cols-3">
        {NAV_ITEMS.map(({ path, label, Icon }) => {
          const active = isActivePath(pathname, path);
          return (
            <li key={path}>
              <Link
                href={hrefFor(path)}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-medium transition-colors ${
                  active ? 'text-accent' : 'text-muted'
                }`}
              >
                <span
                  className={`grid h-8 w-12 place-items-center rounded-full transition-colors ${
                    active ? 'bg-accent/12' : ''
                  }`}
                >
                  <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.4 : 2} />
                </span>
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
