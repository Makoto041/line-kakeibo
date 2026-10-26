'use client';

// デモの場面（ホーム・支出一覧・精算）をマウントしてから描く（BodyPortal と同じ方式）。
// グラフ（Recharts）はサーバーで寸法を測れず、金額の書式（yen の toLocaleString）もサーバーとブラウザでずれうるため。
// 枠（DemoShell）と目次はこれで包まずサーバーで描く（枠で中身ごと止めると、存在しない URL の notFound() が 200 の応答になった）。
// 404 の本文はブラウザ側で描かれる（404 のステータスと noindex などのヘッダーはサーバーが付ける）。
import { useSyncExternalStore, type ReactNode } from 'react';

const subscribe = () => () => {};

export default function DemoClientOnly({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
  if (mounted) return children;
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    </div>
  );
}
