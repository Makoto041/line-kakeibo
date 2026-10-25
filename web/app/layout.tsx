import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AppShell } from "@/components/layout/AppShell";

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
  // 個人の家計簿なので検索エンジンにインデックスさせない
  robots: {
    index: false,
    follow: false,
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
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
