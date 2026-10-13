'use client';

import {
  signInWithCustomToken,
  signInAnonymously,
  type User,
} from 'firebase/auth';
import { auth, ensureFirebaseInitialized } from './firebase';

// initLineAuth() はアプリ起動時に1度だけ実行する。
// 二重実行や再マウントでも初回の Promise を使い回す。
let initPromise: Promise<void> | null = null;

// liff.login() でログイン画面へ移る間、ページが離れるのを待つ上限。
// 遷移が起きなかった場合に、完了を待つ呼び出し元（waitForLineAuth）を待たせ続けないため。
const LOGIN_REDIRECT_WAIT_MS = 10_000;

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
      return;
    }

    // 永続化されたセッションの復元完了を待ってから判定する
    // （復元前は currentUser が null のため、待たないと二重サインインし得る）
    await auth.authStateReady();

    // LINE 認証済み（非匿名）セッションが復元されたなら何もしない。
    // 匿名セッションは一時フォールバックの名残なのでスキップ対象にしない。
    // （匿名で早期 return すると、一度の失敗で以後 LIFF を再試行できず
    //   永久にゲスト化してしまう）
    if (auth.currentUser && !auth.currentUser.isAnonymous) return;

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
      return;
    }

    try {
      const liff = (await import('@line/liff')).default;
      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        // LINE ログイン画面へリダイレクト（この後の処理は戻ってきてから再実行される）。
        // 戻り先の既定はエンドポイント URL（トップ）で、/attach?expenseId=… や
        // /expenses?edit=… の行き先が失われるため、今のページへ戻す。
        // すぐに解決すると、完了を待つ呼び出し元が未ログインのまま読み取りに進み、
        // 遷移までの間に権限エラーを表示してしまうため、ページが離れるまで待つ。
        liff.login({ redirectUri: window.location.href });
        await new Promise((resolve) => setTimeout(resolve, LOGIN_REDIRECT_WAIT_MS));
        return;
      }

      const idToken = liff.getIDToken();
      if (!idToken) {
        console.error('LIFF ID token is missing; falling back to anonymous');
        await signInAnonymously(auth);
        return;
      }

      const endpoint = process.env.NEXT_PUBLIC_AUTH_ENDPOINT;
      if (!endpoint) {
        console.error(
          'NEXT_PUBLIC_AUTH_ENDPOINT is not set; falling back to anonymous'
        );
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
        await signInAnonymously(auth);
        return;
      }

      const data = (await resp.json()) as { customToken?: string };
      if (!data.customToken) {
        console.error('No customToken in auth response; falling back to anonymous');
        await signInAnonymously(auth);
        return;
      }

      await signInWithCustomToken(auth, data.customToken);
    } catch (e) {
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
  await initLineAuth();
  return getLineIdClaim(auth?.currentUser ?? null);
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
