// ログインしていない人（LINE でサインインしていない）をデモへ送る画面の判定。
// アプリの本体の画面だけが対象で、規約・プライバシー、LINE から開く /attach・/link には触れない。
export const GUEST_DEMO_HREF = '/demo/';

/**
 * 未ログインのとき、LINE ログイン画面へ自動で進めてよいか。
 * 外部ブラウザの初めての人をいきなりログイン画面へ送らず、デモを見せるため、次のときだけ進める:
 * - LINE の中（アプリ内ブラウザ・LIFF）: ログインが自動で済む
 * - ホーム画面から開いたアプリ（PWA）: 保存領域が別で、ログインが要る
 * - `?login=1`: デモの「LINE でログイン」から来た（本人がログインしたい）
 */
export function shouldStartLineLogin(env: { search: string; inLine: boolean; standalone: boolean }): boolean {
  return env.inLine || env.standalone || new URLSearchParams(env.search).has('login');
}

const GUEST_DEMO_ROUTES = ['/expenses', '/settlement', '/settings', '/dashboard'];

export function isGuestDemoRoute(pathname: string): boolean {
  if (pathname === '/') return true;
  return GUEST_DEMO_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}
