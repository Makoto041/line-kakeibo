/**
 * Gmail OAuth2認証
 *
 * Google OAuth2を使用してGmail APIにアクセスするための認証を管理
 * トークンはFirestoreに保存・管理
 */

import { google, Auth } from 'googleapis';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { GmailToken } from './types';

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
 * OAuth2認証URLを生成
 * 初回セットアップ時にこのURLにアクセスして認証を行う
 */
export function getAuthUrl(): string {
  const client = getOAuth2Client();

  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.metadata',
  ];

  return client.generateAuthUrl({
    access_type: 'offline', // refresh_tokenを取得するために必要
    scope: scopes,
    prompt: 'consent', // 常に同意画面を表示（refresh_tokenを確実に取得）
  });
}

/**
 * 認証コードからトークンを取得してFirestoreに保存
 * OAuth2コールバックで呼び出される
 */
export async function handleOAuthCallback(code: string): Promise<GmailToken> {
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
