// ログインしていない人（LINE でサインインしていない）をデモへ送る画面の判定。
// アプリの本体の画面だけが対象で、規約・プライバシー、LINE から開く /attach・/link には触れない。
export const GUEST_DEMO_HREF = '/demo/';

const GUEST_DEMO_ROUTES = ['/expenses', '/settlement', '/settings', '/dashboard'];

export function isGuestDemoRoute(pathname: string): boolean {
  if (pathname === '/') return true;
  return GUEST_DEMO_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}
