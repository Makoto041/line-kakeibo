import type { Metadata } from 'next';
import Link from 'next/link';
import { DEMO_INDEX_HREF } from '@/lib/demo/demoScenes';

// /demo 以下の 404（app/demo/[...slug]/page.tsx の notFound() から）。デモの枠（DemoShell）の中に出る。
// 本番の画面へのリンクは置かず、デモの目次へ戻るリンクだけにする
export const metadata: Metadata = {
  title: 'ページが見つかりません',
};

export default function DemoNotFound() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="glass w-full max-w-md rounded-2xl p-8 text-center shadow-glass">
        <p className="text-sm text-muted">404</p>
        <h1 className="mt-1 text-lg font-semibold text-fg">デモのページが見つかりません</h1>
        <p className="mt-2 text-sm text-muted">URL が間違っているか、まだ用意していない場面です。</p>
        <Link
          href={DEMO_INDEX_HREF}
          className="mt-5 inline-flex items-center rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:opacity-90"
        >
          デモの目次へ戻る
        </Link>
      </div>
    </div>
  );
}
