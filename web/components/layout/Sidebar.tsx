'use client';

import Link from 'next/link';
import { Wallet } from 'lucide-react';
import { NAV_ITEMS, isActivePath } from './nav';
import { ThemeToggle } from '../ThemeToggle';

interface SidebarProps {
  pathname: string;
  hrefFor: (path: string) => string;
}

/** Desktop-only left rail (md+). */
export function Sidebar({ pathname, hrefFor }: SidebarProps) {
  return (
    <aside className="hidden md:fixed md:inset-y-0 md:left-0 md:z-30 md:flex md:w-60 md:flex-col glass-bar border-r border-line/60">
      <div className="flex items-center gap-2.5 px-5 h-16">
        <span className="grid h-9 w-9 place-items-center rounded-2xl bg-accent text-accent-fg shadow-sm">
          <Wallet className="h-5 w-5" strokeWidth={2.2} />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-fg">ぶちこむ家計簿</span>
      </div>

      <nav className="flex-1 px-3 py-2 space-y-1" aria-label="メインナビゲーション">
        {NAV_ITEMS.map(({ path, label, Icon }) => {
          const active = isActivePath(pathname, path);
          return (
            <Link
              key={path}
              href={hrefFor(path)}
              aria-current={active ? 'page' : undefined}
              className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? 'bg-accent/12 text-accent'
                  : 'text-muted hover:bg-fg/5 hover:text-fg'
              }`}
            >
              <Icon className="h-5 w-5 shrink-0" strokeWidth={active ? 2.4 : 2} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="px-4 py-4 border-t border-line/60">
        <ThemeToggle size="sm" />
      </div>
    </aside>
  );
}
