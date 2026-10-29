import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ぶちこむ家計簿アプリ",
  description: "LINEで入力した支出を家計簿に保存するアプリ",
  applicationName: "ぶちこむ家計簿",
  // 検索結果に出すのはトップ（/）だけ。ほかのページは next.config.ts の X-Robots-Tag（noindex）と
  // robots.txt で止める。ロゴは検索エンジンが読める PNG（48px の倍数）も明示する
  icons: {
    icon: [
      { url: "/pwa/favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/pwa/favicon-96.png", sizes: "96x96", type: "image/png" },
      { url: "/pwa/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // iPhone でホーム画面に追加したときの名前と表示（manifest は app/manifest.ts）
  appleWebApp: {
    capable: true,
    title: "ぶちこむ",
    statusBarStyle: "default",
  },
  // Next は標準の mobile-web-app-capable だけを出すため、古い iOS 向けに Apple 独自の名前も出す
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // ノッチ・ホームバーの下まで描き、env(safe-area-inset-*) で避ける（下のタブ・シートの余白）
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* アプリのナビと LINE ログインの起動（AppShell）は app/(app)/layout.tsx で包む */}
        <Providers>{children}</Providers>
        {/* 検索結果のサイト名（vercel.app のドメイン名ではなく、アプリの名前を出す） */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "ぶちこむ家計簿",
              alternateName: ["ぶちこむ家計簿アプリ"],
              url: "https://line-kakeibo.vercel.app/",
            }),
          }}
        />
      </body>
    </html>
  );
}
