// アプリのナビ（タブ・背景）を出さない単独画面（外部から開かれる 1 機能の画面）
export const BARE_ROUTES = ['/attach', '/link'] as const;

export function isBareRoute(pathname: string): boolean {
  return BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}
