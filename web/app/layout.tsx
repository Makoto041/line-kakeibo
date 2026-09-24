import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_JP } from "next/font/google";
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

// 和文・数字の字形をヒラギノに近づけるための自前配信フォント。
// iOS / macOS ではヒラギノが先に当たるため読み込まれない（unicode-range 分割）。
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${notoSansJp.variable} antialiased`}
      >
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
