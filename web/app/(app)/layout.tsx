import { AppShell } from "@/components/layout/AppShell";

// アプリの画面（ルートグループ (app)。URL には出ない）だけを AppShell で包む。
// AppShell はマウント時に LINE ログイン（lib/lineAuth）と PWA の登録を始めるため、
// このグループの外に置いたページでは、それらを読み込まず・起動もしない。
export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <AppShell>{children}</AppShell>;
}
