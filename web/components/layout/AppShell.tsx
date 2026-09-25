'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BottomTabBar } from './BottomTabBar';
import { initLineAuth } from '@/lib/lineAuth';
import { isBareRoute } from '@/lib/routes';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  const reduceMotion = useReducedMotion();

  // アプリ起動時に1度だけサインイン（LIFF または匿名フォールバック）を開始する。
  // 認証は Firebase に永続化されるため、遷移ごとに URL へ lineId を引き回す必要はない。
  useEffect(() => {
    initLineAuth();
  }, []);

  // Routes that should render without the app navigation chrome
  // (single-purpose / standalone screens opened from outside the app).
  const bare = isBareRoute(pathname);

  if (bare) {
    return (
      <>
        <div className="kb-page-bg" aria-hidden="true" />
        <div data-kb-behind-sheet="">{children}</div>
      </>
    );
  }

  return (
    <div className="min-h-dvh">
      <div className="kb-page-bg" aria-hidden="true" />
      {/* スマホ幅の 1 カラムを中央に置く（PC でも同じ）。下は浮いているナビの分だけ空ける。
          ルート切替は軽いフェードでつなぐ（transform を使わないので、中の fixed 要素の位置は変わらない）。 */}
      <main data-kb-behind-sheet="" className="mx-auto w-full max-w-[440px]" style={{ paddingBottom: 'var(--kb-content-bottom)' }}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={pathname}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </main>

      <BottomTabBar pathname={pathname} />
    </div>
  );
}
