import type { Metadata } from 'next';
import DemoShell from '@/components/demo/DemoShell';

// デモ（ログイン不要・架空データだけ）。ルートグループ (app) の外に置き、AppShell（LINE ログイン・Firebase）を読み込まない。
// 第三者にも見せる常設の公開デモで、検索結果には出さない（noindex）。仕様は docs/SPECIFICATION.md §5.1 の /demo の行。
export const metadata: Metadata = {
  title: {
    default: 'デモ | ぶちこむ家計簿',
    template: '%s | デモ | ぶちこむ家計簿',
  },
  description: '架空のデータで動くデモです',
  robots: {
    index: false,
    follow: false,
  },
};

export default function DemoLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <DemoShell>{children}</DemoShell>;
}
