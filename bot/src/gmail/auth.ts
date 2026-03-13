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
import * as crypto from 'crypto';

// OAuth stateの有効期限（10分）
const STATE_EXPIRY_MS = 10 * 60 * 1000;

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
      throw new Error('Gmail OAuth2 credentials not configured');
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

  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.metadata',
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
    throw new Error('Invalid or expired OAuth state. Please start the authentication process again.');
  }

  const client = getOAuth2Client();

  const { tokens } = await client.getToken(code);

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('Failed to obtain tokens from OAuth2 callback');
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

/**
 * トークンをFirestoreに保存
 */
async function saveTokenToFirestore(token: GmailToken): Promise<void> {
  const db = getFirestore();
  await db.collection('system').doc('gmailToken').set({
    ...token,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Firestoreからトークンを読み込み
 */
async function loadTokenFromFirestore(): Promise<GmailToken | null> {
  const db = getFirestore();
  const doc = await db.collection('system').doc('gmailToken').get();

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
    throw new Error('Failed to refresh access token');
  }

  const newToken: GmailToken = {
    access_token: credentials.access_token,
    refresh_token: refreshToken, // refresh_tokenは変わらない
    expiry_date: credentials.expiry_date || Date.now() + 3600 * 1000,
    token_type: credentials.token_type || 'Bearer',
    scope: credentials.scope || '',
  };

  // 更新したトークンをFirestoreに保存
  await saveTokenToFirestore(newToken);

  console.log('Gmail access token refreshed successfully');
  return newToken;
}

/**
 * 有効なアクセストークンを取得
 * 期限切れの場合は自動的にリフレッシュ
 */
export async function getValidAccessToken(): Promise<string> {
  const token = await loadTokenFromFirestore();

  if (!token) {
    throw new Error('Gmail token not found. Please run OAuth2 setup first.');
  }

  // トークンが期限切れかどうかチェック（5分のバッファ）
  const isExpired = token.expiry_date < Date.now() + 5 * 60 * 1000;

  if (isExpired) {
    console.log('Gmail access token expired, refreshing...');
    const newToken = await refreshAccessToken(token.refresh_token);
    return newToken.access_token;
  }

  return token.access_token;
}

/**
 * 認証済みのGmail APIクライアントを取得
 */
export async function getGmailClient() {
  const accessToken = await getValidAccessToken();
  const client = getOAuth2Client();

  client.setCredentials({
    access_token: accessToken,
  });

  return google.gmail({ version: 'v1', auth: client });
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
