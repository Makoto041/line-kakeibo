'use client';

import { useEffect } from 'react';

// `/dashboard` はメインダッシュボード `/` に統合済み。
// クエリ（lineId 等）を保持したままリダイレクトする。
export default function DashboardRedirect() {
  useEffect(() => {
    window.location.replace(`/${window.location.search}`);
  }, []);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    </div>
  );
}
