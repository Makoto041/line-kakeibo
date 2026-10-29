'use client';

import {
  signInWithCustomToken,
  signInAnonymously,
  type User,
} from 'firebase/auth';
import { auth, ensureFirebaseInitialized } from './firebase';
import { shouldStartLineLogin } from './guestRedirect';
import { isLineInApp, isStandalone } from './installApp';

// initLineAuth() はアプリ起動時に1度だけ実行する。
// 二重実行や再マウントでも初回の Promise を使い回す。
let initPromise: Promise<void> | null = null;

// liff.login() でログイン画面へ移る間、ページが離れるのを待つ上限。
// 遷移が起きなかった場合に、完了を待つ呼び出し元（waitForLineAuth）を待たせ続けないため。
const LOGIN_REDIRECT_WAIT_MS = 10_000;

// waitForLineAuth() で待つ上限。LIFF の初期化・bot の /auth/line（コールドスタートを含む）・
// Firebase へのサインインはどれもタイムアウトを持たないため、通信が止まると読み込み中のまま
// 終わらなくなる。上限を過ぎたら呼び出し元にエラーを返し、再読み込みできるようにする。
export const LINE_AUTH_WAIT_MS = 20_000;

// LINE ログイン画面へ送った時刻（localStorage）。ログインから戻ってきたのに（URL に
// LIFF の戻りパラメータがある）ログインできていない（トークン交換の失敗など）ときに、
// すぐまたログイン画面へ送ると往復が止まらず読み込み中のように見えるため、この間は
// 送り直さず匿名にフォールバックする。カードのボタンから開き直したとき（戻りパラメータなし）は
// 止めない。
const LOGIN_ATTEMPT_KEY = 'lineLoginAttemptAt';
const LOGIN_RETRY_COOLDOWN_MS = 30_000;

function recentlyTriedLogin(): boolean {
  try {
    const elapsed = Date.now() - Number(localStorage.getItem(LOGIN_ATTEMPT_KEY));
    // 端末の時計が戻された（未来の時刻が残っている）場合は期限切れとして扱う
    return elapsed >= 0 && elapsed < LOGIN_RETRY_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function setLoginAttempt(at: number | null): void {
  try {
    if (at === null) localStorage.removeItem(LOGIN_ATTEMPT_KEY);
    else localStorage.setItem(LOGIN_ATTEMPT_KEY, String(at));
  } catch {
    // 保存できない環境では往復の抑止をあきらめる（ログイン自体は続ける）
  }
}

/**
 * サインイン処理の結果。デモへ送るのは 'guest'（LINE ログインをしていないと確かめられた）だけ。
 * - pending: 処理中（LIFF の初期化・LINE ログイン画面への移動・トークン交換）
 * - signed-in: LINE でサインインした
 * - guest: LINE ログインを本人がやめて戻ってきた（error=access_denied）・LIFF 未設定（匿名）。本当にログインしていない
 * - failed: 通信や認証の失敗で匿名になった・上限切れ・クローラー。本人かもしれないので、デモへは送らない
 */
export type LineAuthOutcome = 'pending' | 'signed-in' | 'guest' | 'failed';
let outcome: LineAuthOutcome = 'pending';

export function getLineAuthOutcome(): LineAuthOutcome {
  return outcome;
}

/** waitForLineAuth() が上限までに終わらなかったときのエラーコード */
export const LINE_AUTH_TIMEOUT = 'line-auth/timeout';

// LINE ログインから戻ったときに付くパラメータ（これと liff で始まるもの: liffClientId /
// liffRedirectUri / liff.state など）。LIFF はこれを URL から消さないため、次のログインの
// 戻り先にそのまま渡すと二重に付き、トークン交換が失敗してログインできなくなる。
// アプリのパラメータ（expenseId / edit / filter / token / lineId）とは重ならない。
const LIFF_RETURN_PARAMS = ['code', 'state', 'error', 'error_description'];

function isLiffReturnParam(key: string): boolean {
  return LIFF_RETURN_PARAMS.includes(key) || key.startsWith('liff');
}

function hasLiffReturnParams(): boolean {
  return Array.from(new URLSearchParams(window.location.search).keys()).some(isLiffReturnParam);
}

/**
 * 今のページから LIFF の戻りパラメータを除いた URL。ログイン後の戻り先と、再読み込みに使う
 * （残ったまま読み込み直すと、使用済みのコードや error で同じ失敗を繰り返す）。
 */
export function urlWithoutLiffReturnParams(): string {
  const url = new URL(window.location.href);
  for (const key of Array.from(url.searchParams.keys())) {
    if (isLiffReturnParam(key)) url.searchParams.delete(key);
  }

  return url.toString();
}

// 検索エンジンのクローラー。LINE ログインへ送られるとトップの内容（プレビュー）を読めないため、ログインを始めない。
// UA は偽装できるため、これは表示を決めるだけの判定で、アクセス権の判断には使わない（データは Firestore ルールが lineId クレームで守る）
const CRAWLER_UA = /Googlebot|Google-InspectionTool|bingbot|Yahoo! Slurp|DuckDuckBot|Baiduspider|facebookexternalhit|Twitterbot|Slackbot|LinkedInBot/i;

function isCrawler(): boolean {
  return CRAWLER_UA.test(navigator.userAgent);
}

/**
 * サインイン状態を確立する。
 * - NEXT_PUBLIC_LIFF_ID あり: LIFF で LINE ログイン → ID トークンを
 *   認証エンドポイント(POST)へ送り、返ってきたカスタムトークンで
 *   Firebase にサインインする（uid=appUid, claim lineId=検証済み LINE userId）。
 * - NEXT_PUBLIC_LIFF_ID なし（ローカル/プレビュー）: 匿名サインインへフォールバック。
 *   匿名ユーザーは lineId クレームを持たないため、ロックされた Firestore ルール下では
 *   一切のデータにアクセスできない（フェイルセーフ）。URL の lineId は決して信用しない。
 */
export function initLineAuth(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (initPromise) return initPromise;

  initPromise = (async () => {
    ensureFirebaseInitialized();
    if (!auth) {
      console.error('Firebase Auth is not initialized; cannot start LINE auth');
      outcome = 'failed';
      return;
    }

    // クローラーにはログインを求めず、サインインしないまま（＝プレビューモードの）トップを見せる
    if (isCrawler()) {
      outcome = 'failed';
      return;
    }

    // 永続化されたセッションの復元完了を待ってから判定する
    // （復元前は currentUser が null のため、待たないと二重サインインし得る）
    await auth.authStateReady();

    // LINE 認証済み（非匿名）セッションが復元されたなら何もしない。
    // 匿名セッションは一時フォールバックの名残なのでスキップ対象にしない。
    // （匿名で早期 return すると、一度の失敗で以後 LIFF を再試行できず
    //   永久にゲスト化してしまう）
    if (auth.currentUser && !auth.currentUser.isAnonymous) {
      outcome = 'signed-in';
      return;
    }

    const liffId = process.env.NEXT_PUBLIC_LIFF_ID;

    // LIFF 未設定: 匿名フォールバック（lineId クレームなし＝データは見えない）
    if (!liffId) {
      if (!auth.currentUser) {
        try {
          await signInAnonymously(auth);
        } catch (e) {
          console.error('Anonymous sign-in failed:', e);
        }
      }
      outcome = 'guest';
      return;
    }

    try {
      const liff = (await import('@line/liff')).default;
      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        if (recentlyTriedLogin() && hasLiffReturnParams()) {
          console.warn('LINE login did not complete after the redirect; falling back to anonymous');
          await signInAnonymously(auth);
          // 本人がログインをやめた（LINE が error=access_denied で戻す）ときだけ、ログインしていないと確かめられたことにする。
          // ほかの戻り（トークン交換の失敗、別のカードを開き直したときの liff.state など）は本人かもしれないので送らない
          outcome = new URLSearchParams(window.location.search).get('error') === 'access_denied' ? 'guest' : 'failed';
          return;
        }
        // 外部ブラウザの初めての人は、入口（トップ・規約）ではログイン画面へ送らずデモを見せる（shouldStartLineLogin の条件のときだけ進める）
        if (!shouldStartLineLogin({ pathname: window.location.pathname, search: window.location.search, inLine: liff.isInClient() || isLineInApp(navigator.userAgent), standalone: isStandalone() })) {
          await signInAnonymously(auth);
          outcome = 'guest';
          return;
        }
        setLoginAttempt(Date.now());
        // LINE ログイン画面へリダイレクト（この後の処理は戻ってきてから再実行される）。
        // 戻り先の既定はエンドポイント URL（トップ）で、/attach?expenseId=… や
        // /expenses?edit=… の行き先が失われるため、今のページへ戻す。
        // すぐに解決すると、完了を待つ呼び出し元が未ログインのまま読み取りに進み、
        // 遷移までの間に権限エラーを表示してしまうため、ページが離れるまで待つ。
        liff.login({ redirectUri: urlWithoutLiffReturnParams() });
        await new Promise((resolve) => setTimeout(resolve, LOGIN_REDIRECT_WAIT_MS));
        outcome = 'failed';
        return;
      }

      const idToken = liff.getIDToken();
      if (!idToken) {
        console.error('LIFF ID token is missing; falling back to anonymous');
        // 次の読み込みで LINE ログインからやり直せるよう、LIFF のログイン状態を消す
        liff.logout();
        outcome = 'failed';
        await signInAnonymously(auth);
        return;
      }

      const endpoint = process.env.NEXT_PUBLIC_AUTH_ENDPOINT;
      if (!endpoint) {
        console.error(
          'NEXT_PUBLIC_AUTH_ENDPOINT is not set; falling back to anonymous'
        );
        outcome = 'failed';
        await signInAnonymously(auth);
        return;
      }

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });

      if (!resp.ok) {
        console.error('Auth endpoint returned HTTP', resp.status);
        // 401 は ID トークンの期限切れ・無効。LIFF はトークンの期限を見ずに isLoggedIn() を
        // 返し続けるため、ログイン状態を消さないと再読み込みしても同じトークンで失敗し続ける。
        // 消しておけば次の読み込みで LINE ログインからやり直す（この読み込み内では再試行しない）
        if (resp.status === 401) liff.logout();
        outcome = 'failed';
        await signInAnonymously(auth);
        return;
      }

      const data = (await resp.json()) as { customToken?: string };
      if (!data.customToken) {
        console.error('No customToken in auth response; falling back to anonymous');
        outcome = 'failed';
        await signInAnonymously(auth);
        return;
      }

      await signInWithCustomToken(auth, data.customToken);
      setLoginAttempt(null);
      outcome = 'signed-in';
    } catch (e) {
      outcome = 'failed';
      console.error('LINE auth flow failed; falling back to anonymous:', e);
      try {
        await signInAnonymously(auth);
      } catch (anonError) {
        console.error('Anonymous fallback sign-in failed:', anonError);
      }
    }
  })();

  // 呼び出し側は結果を待たないので、ここで拒否を受け止めて unhandledrejection にしない
  initPromise.catch((e) => console.error('LINE auth init failed:', e));
  return initPromise;
}

/**
 * 起動時サインインの完了を待ち、検証済み LINE userId を返す（LINE で認証できなければ null）。
 *
 * Firestore / Storage のルールは lineId クレームを要求するため、サインインの完了前に
 * 読み書きすると権限エラーになる。LINE のボタンから直接開くページ（/attach）のように、
 * useLineAuth を通さずに読み取るページは、読み取りの前にこれを待つこと。
 */
export async function waitForLineAuth(): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('LINE auth timed out'), { code: LINE_AUTH_TIMEOUT })),
      LINE_AUTH_WAIT_MS
    );
  });
  try {
    return await Promise.race([
      initLineAuth().then(() => getLineIdClaim(auth?.currentUser ?? null)),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 検証済み LINE userId を Firebase ID トークンのカスタムクレームから取り出す。
 * 匿名ユーザーやクレーム未設定の場合は null。
 */
export async function getLineIdClaim(user: User | null): Promise<string | null> {
  if (!user || user.isAnonymous) return null;
  try {
    const result = await user.getIdTokenResult();
    const lineId = result.claims.lineId;
    return typeof lineId === 'string' && lineId ? lineId : null;
  } catch (e) {
    console.error('Failed to read lineId claim:', e);
    return null;
  }
}
