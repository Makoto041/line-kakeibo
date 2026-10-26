/**
 * Gmail OAuth2認証
 *
 * Google OAuth2を使用してGmail APIにアクセスするための認証を管理
 * トークンはFirestoreに保存・管理
 *
 * セキュリティ:
 * - stateパラメータによるCSRF保護
 * - state有効期限（10分）
 */

import { google, Auth } from 'googleapis';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { GmailToken } from './types';
import { errorFields } from '../logSafe';
import * as crypto from 'crypto';

// OAuth stateの有効期限（10分）
const STATE_EXPIRY_MS = 10 * 60 * 1000;

/** Google の OAuth のトークンの失効先（https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke） */
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** Google への失効の要求 1 回あたりの待ち時間（refresh_token と access_token で最大 2 回） */
const GOOGLE_REVOKE_TIMEOUT_MS = 5000;

/**
 * Gmail のトークンが保存されていない（OAuth の設定前・/gmail/revoke の後）
 *
 * やり直しても直らないので、取込（handler.ts）はこの種類だけを投げずに終える（Pub/Sub に再送させない）。
 * Firestore の読み取りの失敗など一時的な失敗は、この種類にしない。
 */
export class GmailTokenMissingError extends Error {
  constructor() {
    super('Gmail token not found. Please run OAuth2 setup first.');
    this.name = 'GmailTokenMissingError';
  }
}

/**
 * 更新したアクセストークンを保存しようとしたら、トークンの文書が無かった（更新の途中で /gmail/revoke に消された）
 *
 * 文書は作り直さない（saveRefreshedTokenToFirestore）。取込（handler.ts）はこれを投げて失敗し、Pub/Sub の再送で
 * トークンが無い（GmailTokenMissingError）と分かって終える。
 */
export class GmailTokenDeletedError extends Error {
  constructor() {
    super('Gmail token was deleted while refreshing it');
    this.name = 'GmailTokenDeletedError';
  }
}

/** Firestore の gRPC のコード NOT_FOUND（update で文書が無いとき） */
const FIRESTORE_NOT_FOUND = 5;

// OAuth2クライアント
let oauth2Client: Auth.OAuth2Client | null = null;

/**
 * OAuth2クライアントを取得
 */
function getOAuth2Client() {
  if (!oauth2Client) {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const redirectUri = process.env.GMAIL_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      // 固定文の例外には名前を付ける（ログは文言を出さず errorName で見分けるため。logSafe.ts の errorFields）
      throw Object.assign(new Error('Gmail OAuth2 credentials not configured'), { name: 'GmailCredentialsMissingError' });
    }

    oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }
  return oauth2Client;
}

/**
 * OAuth stateを生成してFirestoreに保存
 * adminVerifiedフラグを含めて、Admin認証済みフローであることを記録
 */
async function generateAndSaveState(): Promise<string> {
  const state = crypto.randomBytes(32).toString('hex');
  const db = getFirestore();

  await db.collection('system').doc('oauthState').set({
    state,
    adminVerified: true, // Admin認証済みエンドポイントから生成されたことを証明
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + STATE_EXPIRY_MS),
  });

  return state;
}

/**
 * OAuth stateを検証
 * 一度使用したstateは削除して再利用を防ぐ
 * adminVerifiedフラグも検証してAdmin認証済みフローであることを確認
 */
async function validateAndConsumeState(state: string): Promise<boolean> {
  const db = getFirestore();
  const doc = await db.collection('system').doc('oauthState').get();

  if (!doc.exists) {
    console.error('OAuth state not found in Firestore');
    return false;
  }

  const data = doc.data();
  if (!data) {
    return false;
  }

  // stateが一致するか確認
  if (data.state !== state) {
    console.error('OAuth state mismatch');
    return false;
  }

  // Admin認証済みフローであることを確認
  if (!data.adminVerified) {
    console.error('OAuth state was not created through admin-authenticated endpoint');
    await db.collection('system').doc('oauthState').delete();
    return false;
  }

  // 有効期限を確認
  const expiresAt = data.expiresAt?.toMillis?.() || 0;
  if (Date.now() > expiresAt) {
    console.error('OAuth state expired');
    // 期限切れのstateを削除
    await db.collection('system').doc('oauthState').delete();
    return false;
  }

  // 使用済みのstateを削除（再利用防止）
  await db.collection('system').doc('oauthState').delete();

  return true;
}

/**
 * OAuth2認証URLを生成
 * 初回セットアップ時にこのURLにアクセスして認証を行う
 * stateパラメータでCSRF攻撃を防止
 */
export async function getAuthUrl(): Promise<string> {
  const client = getOAuth2Client();

  // gmail.readonlyのみ使用（gmail.metadataを含めるとq parameterやformat: fullが使えなくなる）
  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
  ];

  // CSRFトークンとして使用するstateを生成
  const state = await generateAndSaveState();

  return client.generateAuthUrl({
    access_type: 'offline', // refresh_tokenを取得するために必要
    scope: scopes,
    prompt: 'consent', // 常に同意画面を表示（refresh_tokenを確実に取得）
    state, // CSRF保護
  });
}

/**
 * 認証コードからトークンを取得してFirestoreに保存
 * OAuth2コールバックで呼び出される
 *
 * @param code - Google OAuth2から返された認証コード
 * @param state - CSRF保護用のstateパラメータ
 * @throws state検証失敗時にエラー
 */
export async function handleOAuthCallback(code: string, state: string): Promise<GmailToken> {
  // stateパラメータを検証（CSRF保護）
  const isValidState = await validateAndConsumeState(state);
  if (!isValidState) {
    throw Object.assign(new Error('Invalid or expired OAuth state. Please start the authentication process again.'), {
      name: 'GmailOAuthStateError',
    });
  }

  const client = getOAuth2Client();

  const { tokens } = await client.getToken(code);

  if (!tokens.access_token || !tokens.refresh_token) {
    throw Object.assign(new Error('Failed to obtain tokens from OAuth2 callback'), { name: 'GmailOAuthTokenError' });
  }

  const gmailToken: GmailToken = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date || Date.now() + 3600 * 1000,
    token_type: tokens.token_type || 'Bearer',
    scope: tokens.scope || '',
  };

  // Firestoreに保存
  await saveTokenToFirestore(gmailToken);

  console.log('Gmail OAuth2 tokens saved successfully');
  return gmailToken;
}

/** OAuth トークンの保存先（Firestore: system/gmailToken）。管理 API もここを使う */
export function gmailTokenRef() {
  return getFirestore().collection('system').doc('gmailToken');
}

/**
 * OAuth のコールバックで受け取ったトークンを Firestore に保存する（文書が無ければ作り、あれば置き換える）
 */
async function saveTokenToFirestore(token: GmailToken): Promise<void> {
  await gmailTokenRef().set({
    ...token,
    updatedAt: Timestamp.now(),
  });
}

/**
 * 更新したアクセストークンを Firestore に保存する（文書があるときだけ書く）
 *
 * set で書くと、更新の途中で /gmail/revoke がトークンを消したときに、消したトークンを作り直してしまう
 * （revoke の後も取込が古いトークンで動き続ける）。update は文書が無ければ NOT_FOUND で失敗するので、
 * そのときは作らずに GmailTokenDeletedError を投げる。
 */
async function saveRefreshedTokenToFirestore(token: GmailToken): Promise<void> {
  try {
    await gmailTokenRef().update({
      ...token,
      updatedAt: Timestamp.now(),
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === FIRESTORE_NOT_FOUND) {
      console.warn('Gmail token was deleted while refreshing it; not recreating it (revoked)');
      throw new GmailTokenDeletedError();
    }
    throw error;
  }
}

/**
 * Firestoreからトークンを読み込み
 */
async function loadTokenFromFirestore(): Promise<GmailToken | null> {
  const doc = await gmailTokenRef().get();

  if (!doc.exists) {
    return null;
  }

  const data = doc.data();
  if (!data?.access_token || !data?.refresh_token) {
    return null;
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: data.expiry_date,
    token_type: data.token_type,
    scope: data.scope,
  };
}

/**
 * アクセストークンをリフレッシュ
 */
async function refreshAccessToken(refreshToken: string): Promise<GmailToken> {
  const client = getOAuth2Client();

  client.setCredentials({
    refresh_token: refreshToken,
  });

  const { credentials } = await client.refreshAccessToken();

  if (!credentials.access_token) {
    throw Object.assign(new Error('Failed to refresh access token'), { name: 'GmailTokenRefreshError' });
  }

  const newToken: GmailToken = {
    access_token: credentials.access_token,
    refresh_token: refreshToken, // refresh_tokenは変わらない
    expiry_date: credentials.expiry_date || Date.now() + 3600 * 1000,
    token_type: credentials.token_type || 'Bearer',
    scope: credentials.scope || '',
  };

  // 更新したトークンをFirestoreに保存（文書が消えていたら作り直さずに投げる）
  await saveRefreshedTokenToFirestore(newToken);

  console.log('Gmail access token refreshed successfully');
  return newToken;
}

/**
 * 認証済みのGmail APIクライアントを取得
 */
export async function getGmailClient() {
  const token = await loadTokenFromFirestore();

  if (!token) {
    throw new GmailTokenMissingError();
  }

  const client = getOAuth2Client();

  // トークンが期限切れかどうかチェック（5分のバッファ）
  const isExpired = token.expiry_date < Date.now() + 5 * 60 * 1000;

  if (isExpired) {
    console.log('Gmail access token expired, refreshing...');
    const newToken = await refreshAccessToken(token.refresh_token);
    client.setCredentials({
      access_token: newToken.access_token,
      refresh_token: newToken.refresh_token,
      expiry_date: newToken.expiry_date,
      token_type: newToken.token_type,
      scope: newToken.scope,
    });
  } else {
    client.setCredentials({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expiry_date: token.expiry_date,
      token_type: token.token_type,
      scope: token.scope,
    });
  }

  return google.gmail({ version: 'v1', auth: client });
}

/**
 * Google の失効の要求 1 回分の結果。トークン・Google の応答の本文・例外の文言は持たない（管理 API の応答とログにそのまま出す）
 *
 * - revoked: Google が 2xx を返した（文書では成功は 200）
 * - rejected: Google が 2xx 以外を返した（文書では失敗は 400。期限切れ・取り消し済みのトークンもこれになる）
 * - timeout: 待ち時間（GOOGLE_REVOKE_TIMEOUT_MS）を過ぎた
 * - network_error: 通信に失敗した（応答が無い）
 * - skipped: そのトークンが保存されていないので送っていない
 */
export type GoogleRevokeAttempt =
  | { result: 'revoked'; status: number }
  | { result: 'rejected'; status: number }
  | { result: 'timeout' }
  | { result: 'network_error' }
  | { result: 'skipped' };

/** Google 側の失効の結果（revokeGmailTokenOnGoogle） */
export interface GoogleRevokeResult {
  /** どちらかのトークンで Google が失効を受け付けた（2xx） */
  revoked: boolean;
  refreshToken: GoogleRevokeAttempt;
  accessToken: GoogleRevokeAttempt;
}

/** トークンを 1 つ Google で失効させる */
async function revokeOneTokenOnGoogle(
  kind: 'refresh_token' | 'access_token',
  token: string,
  timeoutMs: number
): Promise<GoogleRevokeAttempt> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // トークンは本文（application/x-www-form-urlencoded）で送る。URL のクエリに載せると、通信の途中や通信先のログに残りうる
    const response = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: controller.signal,
    });
    // 応答の本文（エラーの説明）は使わないので、読まずに閉じる
    await response.body?.cancel().catch(() => undefined);
    return response.ok ? { result: 'revoked', status: response.status } : { result: 'rejected', status: response.status };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { result: 'timeout' };
    }
    console.warn('Failed to reach Google to revoke a Gmail token', { kind, ...errorFields(error) });
    return { result: 'network_error' };
  } finally {
    clearTimeout(timeoutId);
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 保存してあるトークンを Google で失効させる（DELETE /gmail/revoke）。トークンが 1 つも無ければ何も送らずに null を返す
 *
 * refresh_token を先に、access_token を後に送る。Google の文書（Token revocation）は「access_token を失効させると、
 * 対応する refresh_token も失効する」と明記している。逆向き（refresh_token → access_token）は明記が無い
 * （「失効はそのプロジェクトに与えた権限をすべて外し、発行済みのアクセス・リフレッシュトークンを無効にする」という
 * 一般的な記述だけ）ので、両方送る。どちらかが受け付けられれば、許可は外れている（revoked: true）。
 * refresh_token の失効が通った後の access_token は、既に無効なので 400 になりうるが、結果は変えない。
 */
export async function revokeGmailTokenOnGoogle(
  tokenData: { refresh_token?: unknown; access_token?: unknown } | undefined,
  timeoutMs: number = GOOGLE_REVOKE_TIMEOUT_MS
): Promise<GoogleRevokeResult | null> {
  const refresh = nonEmptyString(tokenData?.refresh_token);
  const access = nonEmptyString(tokenData?.access_token);
  if (!refresh && !access) {
    return null;
  }

  const skipped: GoogleRevokeAttempt = { result: 'skipped' };
  const refreshResult = refresh ? await revokeOneTokenOnGoogle('refresh_token', refresh, timeoutMs) : skipped;
  const accessResult = access ? await revokeOneTokenOnGoogle('access_token', access, timeoutMs) : skipped;
  const revoked = refreshResult.result === 'revoked' || accessResult.result === 'revoked';

  // ログには結果だけを出す（トークンは出さない）
  if (revoked) {
    console.log('Gmail token revoked on Google side', { refresh: refreshResult, access: accessResult });
  } else {
    console.warn('Gmail token was not revoked on Google side', { refresh: refreshResult, access: accessResult });
  }
  return { revoked, refreshToken: refreshResult, accessToken: accessResult };
}

/**
 * Gmail OAuth2が設定済みかチェック
 */
export async function isGmailAuthConfigured(): Promise<boolean> {
  try {
    const token = await loadTokenFromFirestore();
    return token !== null && !!token.refresh_token;
  } catch {
    return false;
  }
}
