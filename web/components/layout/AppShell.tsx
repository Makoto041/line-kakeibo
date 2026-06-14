'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Sidebar } from './Sidebar';
import { BottomTabBar } from './BottomTabBar';
import { TopBar } from './TopBar';

// Routes that should render without the app navigation chrome
// (single-purpose / standalone screens opened from outside the app).
const BARE_ROUTES = ['/attach', '/link', '/debug'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  const reduceMotion = useReducedMotion();
  const [lineId, setLineId] = useState<string | null>(null);

  // Read lineId after mount to keep SSR/first-render markup stable (no hydration mismatch).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setLineId(params.get('lineId'));
  }, [pathname]);

  const hrefFor = (path: string) =>
    lineId ? `${path}?lineId=${encodeURIComponent(lineId)}` : path;

  const bare = BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));

  if (bare) {
    return (
      <>
        <div className="app-bg-blob" aria-hidden />
        {children}
      </>
    );
  }

  return (
    <div className="min-h-dvh">
      <div className="app-bg-blob" aria-hidden />
      <Sidebar pathname={pathname} hrefFor={hrefFor} />

      <div className="md:pl-60">
        <TopBar hrefFor={hrefFor} />
        {/* Pages own their inner container/padding; shell adds offset for the
            fixed bottom tab on mobile so content never hides behind it.
            SPA らしい遷移のため、ルート切替を軽いフェード＋スライドで繋ぐ。 */}
        <main className="pb-24 md:pb-0">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={pathname}
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <BottomTabBar pathname={pathname} hrefFor={hrefFor} />
    </div>
  );
}
