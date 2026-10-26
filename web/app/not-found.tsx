import type { Metadata } from "next";

// 一致する画面が無い URL の 404（ルート直下に置くと、すべての未一致の URL がここに来る）。
// AppShell は app/(app)/layout.tsx にあり、ここでは包まれない。AppShell を import すると
// 404 でも LINE ログインが始まるため、ナビの代わりにホームへのリンクだけを置く。
// next/link にすると、その chunk がすべての画面で先読みされるため、素の <a> で全体を読み直す。
export const metadata: Metadata = {
  title: "ページが見つかりません",
};

export default function NotFound() {
  return (
    <>
      <div className="app-bg-blob" aria-hidden />
      <div className="flex min-h-dvh items-center justify-center px-4">
        <div className="glass w-full max-w-md rounded-2xl p-8 text-center shadow-glass">
          <p className="text-sm text-muted">404</p>
          <h1 className="mt-1 text-lg font-semibold text-fg">ページが見つかりません</h1>
          <p className="mt-2 text-sm text-muted">URL が変わったか、削除された可能性があります。</p>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- 上のコメントのとおり、あえて next/link を使わない */}
          <a
            href="/"
            className="mt-5 inline-flex items-center rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:opacity-90"
          >
            ホームへ戻る
          </a>
        </div>
      </div>
    </>
  );
}
