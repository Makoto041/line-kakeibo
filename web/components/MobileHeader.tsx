'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ThemeToggle } from './ThemeToggle';

type NavItem = {
  href: string;
  label: string;
  icon?: string;
};

type MobileHeaderProps = {
  navItems: NavItem[];
  title?: string;
  currentPath?: string;
};

export default function MobileHeader({
  navItems,
  title = 'LINEレシート家計簿',
  currentPath,
}: MobileHeaderProps) {
  const pathname = usePathname();
  const activePath = currentPath || pathname;
  const [open, setOpen] = useState(false);

  const groupedNav = useMemo(
    () => navItems.map((item) => ({ ...item, isActive: activePath?.startsWith(item.href) })),
    [navItems, activePath],
  );

  return (
    <header className="md:hidden sticky top-0 z-40 backdrop-blur-xl bg-white/70 dark:bg-slate-900/70 border-b border-slate-200/60 dark:border-slate-800 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-bold grid place-items-center shadow-md">
            💸
          </div>
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">家計簿</p>
            <p className="text-base font-semibold text-slate-900 dark:text-white">{title}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle size="sm" />
          <button
            onClick={() => setOpen((prev) => !prev)}
            className="p-2 rounded-lg border border-slate-200/70 dark:border-slate-700 bg-white/80 dark:bg-slate-800/80 shadow-sm text-slate-700 dark:text-slate-100"
            aria-expanded={open}
            aria-label="メニューを開閉"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              {open ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /> : <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />}
            </svg>
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-200/70 dark:border-slate-800 bg-white/90 dark:bg-slate-900/95 backdrop-blur-lg shadow-lg">
          <nav className="max-w-7xl mx-auto px-4 py-3 space-y-2">
            {groupedNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition-colors ${
                  item.isActive
                    ? 'bg-gradient-to-r from-blue-50 to-indigo-50 text-blue-700 border border-blue-100 dark:from-slate-800 dark:to-slate-800 dark:text-blue-100 dark:border-slate-700'
                    : 'bg-white/70 dark:bg-slate-800/80 border border-slate-200/70 dark:border-slate-700 text-slate-700 dark:text-slate-100 hover:border-blue-200 dark:hover:border-blue-300/50'
                }`}
              >
                <span className="text-lg">{item.icon ?? '•'}</span>
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}
