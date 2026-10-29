// ログインしていない人（LINE でサインインしていない）をデモへ送る画面の判定。
// アプリの本体の画面だけが対象で、規約・プライバシー、LINE から開く /attach・/link には触れない。
export const GUEST_DEMO_HREF = '/demo/';

/** 未ログインでもログイン画面へ送らず、デモ（または規約）を見せる入口の画面 */
const FRONT_DOOR_ROUTES = ['/', '/dashboard', '/dashboard/', '/terms', '/terms/', '/privacy', '/privacy/'];

/**
 * 未ログインのとき、LINE ログイン画面へ自動で進めてよいか。
 * 外部ブラウザの初めての人を、入口（トップ・規約）でいきなりログイン画面へ送らず、デモを見せる。次のときは進める:
 * - LINE の中（アプリ内ブラウザ・LIFF）: ログインが自動で済む
 * - ホーム画面から開いたアプリ（PWA）: 保存領域が別で、ログインが要る
 * - `?login=1`: デモの「LINE でログイン」から来た（本人がログインしたい）
 * - `?openExternalBrowser=1`: LINE の中から外部ブラウザへ開き直した（設定の「ホーム画面に追加」。ログインして続ける）
 * - 入口以外の画面（支出一覧・設定・`/attach` など。LINE のカードのリンクやブックマークで、行き先とデータが目的）
 */
export function shouldStartLineLogin(env: { pathname: string; search: string; inLine: boolean; standalone: boolean }): boolean {
  if (env.inLine || env.standalone) return true;
  const params = new URLSearchParams(env.search);
  if (params.get('login') === '1' || params.has('openExternalBrowser')) return true;
  return !FRONT_DOOR_ROUTES.includes(env.pathname);
}

const GUEST_DEMO_ROUTES = ['/expenses', '/settlement', '/settings', '/dashboard'];

export function isGuestDemoRoute(pathname: string): boolean {
  if (pathname === '/') return true;
  return GUEST_DEMO_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}
