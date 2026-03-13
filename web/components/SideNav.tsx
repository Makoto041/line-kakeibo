'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './ThemeToggle';

type NavItem = {
  href: string;
  label: string;
  icon?: string;
};

type SideNavProps = {
  navItems: NavItem[];
  currentPath?: string;
  className?: string;
};

export default function SideNav({ navItems, currentPath, className = '' }: SideNavProps) {
  const pathname = usePathname();
  const activePath = currentPath || pathname;

  return (
    <aside
      className={`hidden md:flex w-64 flex-col gap-6 rounded-2xl bg-white/80 dark:bg-slate-900/70 border border-slate-200/70 dark:border-slate-800 shadow-xl p-5 ${className}`}
    >
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-bold grid place-items-center shadow-lg">
          📊
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400">LINE 家計簿</p>
          <p className="text-lg font-semibold text-slate-900 dark:text-white">Dashboard</p>
        </div>
      </div>

      <nav className="space-y-2">
        {navItems.map((item) => {
          const isActive = activePath?.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition-all border ${
                isActive
                  ? 'bg-gradient-to-r from-blue-50 to-indigo-50 text-blue-700 border-blue-100 shadow-sm dark:from-slate-800 dark:to-slate-800 dark:text-blue-100 dark:border-slate-700'
                  : 'bg-white/60 dark:bg-slate-800/70 text-slate-700 dark:text-slate-100 border-slate-200/70 dark:border-slate-700 hover:border-blue-200 dark:hover:border-blue-300/50'
              }`}
            >
              <span className="text-lg">{item.icon ?? '•'}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto pt-4 border-t border-slate-200/60 dark:border-slate-800">
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">表示テーマ</p>
        <ThemeToggle size="sm" />
      </div>
    </aside>
  );
}
