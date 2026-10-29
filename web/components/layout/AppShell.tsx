'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Sidebar } from './Sidebar';
import { BottomTabBar } from './BottomTabBar';
import { TopBar } from './TopBar';
import { initLineAuth } from '@/lib/lineAuth';
import { useLineAuth } from '@/lib/hooks';
import { GUEST_DEMO_HREF, isGuestDemoRoute } from '@/lib/guestRedirect';
import { startPwa } from '@/lib/installApp';

// Routes that should render without the app navigation chrome
// (single-purpose / standalone screens opened from outside the app).
const BARE_ROUTES = ['/attach', '/link'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const { lineId, loading: authLoading, outcome } = useLineAuth();

  // LINE ログインをしていないと確かめられた人（ログインを済ませずに戻ってきた・LIFF 未設定）だけをデモへ送る。
  // 通信や認証の失敗・処理が長引いただけの本人は送らない（行き先の URL が消え、デモから戻れないため）。
  // 検索エンジンのクローラーは outcome が 'failed' なので送らず、トップのプレビューをそのまま見せる
  const toDemo = !authLoading && !lineId && outcome === 'guest' && isGuestDemoRoute(pathname);

  useEffect(() => {
    if (toDemo) router.replace(GUEST_DEMO_HREF);
  }, [toDemo, router]);

  // アプリ起動時に1度だけサインイン（LIFF または匿名フォールバック）を開始する。
  // 認証は Firebase に永続化されるため、遷移ごとに URL へ lineId を引き回す必要はない。
  useEffect(() => {
    initLineAuth();
    // PWA: Service Worker（オフライン画面）の登録と、インストールの合図の受け取り
    startPwa();
  }, []);

  const hrefFor = (path: string) => path;

  // デモへ移る間は、ゲストのプレビュー画面を出さない
  if (toDemo) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-label="読み込み中" />
      </div>
    );
  }

  const bare = BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));

  if (bare) {
    return (
      <>
        <div className="app-bg-blob" aria-hidden />
        <div className="pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">{children}</div>
      </>
    );
  }

  return (
    // viewport-fit=cover（app/layout.tsx）のため、横向きのノッチ・角丸は左右の safe-area で避ける
    <div className="min-h-dvh pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <div className="app-bg-blob" aria-hidden />
      <Sidebar pathname={pathname} hrefFor={hrefFor} />

      <div className="md:pl-60">
        <TopBar hrefFor={hrefFor} />
        {/* Pages own their inner container/padding; shell adds offset for the
            fixed bottom tab on mobile so content never hides behind it.
            SPA らしい遷移のため、ルート切替を軽いフェード＋スライドで繋ぐ。 */}
        <main className="pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-0">
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
