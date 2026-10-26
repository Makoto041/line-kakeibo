'use client';

// デモの場面（ホーム・支出一覧・精算）をマウントしてから描く（BodyPortal と同じ方式）。
// グラフ（Recharts）はサーバーで寸法を測れず、金額の書式（yen の toLocaleString）もサーバーとブラウザでずれうるため。
// 枠（DemoShell）・目次・404 はサーバーで描く（存在しない URL で notFound() が 404 の応答になるように）。
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
