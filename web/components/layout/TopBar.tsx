'use client';

import Link from 'next/link';
import { Wallet } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS, isActivePath } from './nav';
import { ThemeToggle } from '../ThemeToggle';

interface TopBarProps {
  hrefFor: (path: string) => string;
}

/** Top app bar: brand on mobile, current section title on desktop. */
export function TopBar({ hrefFor }: TopBarProps) {
  const pathname = usePathname();
  const current = NAV_ITEMS.find((i) => isActivePath(pathname, i.path));

  return (
    <header className="sticky top-0 z-30 glass-bar border-b border-line/60">
      <div className="flex h-14 items-center justify-between gap-3 px-4 md:h-16 md:px-8">
        {/* Mobile: brand. Desktop: section title (brand lives in sidebar) */}
        <Link href={hrefFor('/')} className="md:hidden flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-accent text-accent-fg">
            <Wallet className="h-[18px] w-[18px]" strokeWidth={2.2} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-fg">ぶちこむ家計簿</span>
        </Link>
        <h1 className="hidden md:block text-lg font-semibold tracking-tight text-fg">
          {current?.label ?? 'ぶちこむ家計簿'}
        </h1>

        <div className="md:hidden">
          <ThemeToggle size="sm" />
        </div>
      </div>
    </header>
  );
}
