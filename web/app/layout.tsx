import type { Metadata, Viewport } from "next";
import { Noto_Sans_JP } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AppShell } from "@/components/layout/AppShell";

// 和文・数字の字形をヒラギノに近づけるための自前配信フォント。
// iOS / macOS ではヒラギノが先に当たるため読み込まれない（unicode-range 分割）。
// 変数は <html> に付ける（:root で定義するフォントスタック --kb-font から参照するため）。
const notoSansJp = Noto_Sans_JP({
  variable: "--font-noto-jp",
  weight: "variable",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "ぶちこむ家計簿アプリ",
  description: "LINEから入力されたレシートを自動的に家計簿に保存するアプリ",
  // 個人の家計簿なので検索エンジンにインデックスさせない
  robots: {
    index: false,
    follow: false,
  },
};

// 安全領域（env(safe-area-inset-*)）を効かせる
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const THEME_BOOT = `try{var s=localStorage.getItem("theme-preference");var d=s==="dark"||((s===null||s==="system")&&matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;if(d)r.classList.add("dark");r.style.colorScheme=d?"dark":"light"}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={notoSansJp.variable} suppressHydrationWarning>
      <head>
        {/* 保存済みのテーマを描画前に当て、ダーク設定での白い一瞬を防ぐ（ThemeProvider と同じキー） */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
