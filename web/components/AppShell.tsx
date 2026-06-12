'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import BottomNav from './BottomNav';

interface AppShellProps {
  children: React.ReactNode;
  getUrlWithLineId: (path: string) => string;
  title?: string;
}

export default function AppShell({ children, getUrlWithLineId, title }: AppShellProps) {
  const pathname = usePathname();

  const navItems = [
    {
      href: getUrlWithLineId('/'),
      label: 'ホーム',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
        </svg>
      ),
      isActive: pathname === '/',
    },
    {
      href: getUrlWithLineId('/expenses'),
      label: '支出一覧',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
        </svg>
      ),
      isActive: pathname === '/expenses',
    },
    {
      href: getUrlWithLineId('/settings'),
      label: '設定',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
      isActive: pathname === '/settings',
    },
  ];

  return (
    <div className="min-h-screen">
      {/* Ambient liquid background */}
      <div className="liquid-bg" aria-hidden="true" />

      {/* Desktop floating glass sidebar */}
      <aside className="hidden md:flex md:flex-col fixed left-4 top-4 bottom-4 w-56 glass-strong rounded-3xl z-40 overflow-hidden">
        <div className="px-5 py-6">
          <h1 className="text-lg font-bold text-gray-900 tracking-tight">
            <span className="bg-gradient-to-r from-emerald-600 to-teal-500 bg-clip-text text-transparent">Kakeibo</span>
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">LINE家計簿</p>
        </div>
        <nav className="flex-1 px-3 space-y-1.5">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`pressable flex items-center gap-3 px-3.5 py-2.5 rounded-2xl text-sm font-medium transition-colors ${
                item.isActive
                  ? 'glass-accent text-emerald-700'
                  : 'text-gray-600 hover:bg-white/40'
              }`}
            >
              {item.icon}
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Mobile glass header */}
      <header className="md:hidden sticky top-0 z-40">
        <div className="glass-strong border-x-0 border-t-0 rounded-none">
          <div className="flex items-center h-12 px-4">
            <h1 className="text-base font-bold text-gray-900">
              {title || <span className="bg-gradient-to-r from-emerald-600 to-teal-500 bg-clip-text text-transparent">Kakeibo</span>}
            </h1>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="md:pl-64">
        <div className="pb-28 md:pb-8">
          {children}
        </div>
      </main>

      {/* Mobile floating bottom navigation */}
      <BottomNav getUrlWithLineId={getUrlWithLineId} />
    </div>
  );
}
