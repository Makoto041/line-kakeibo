/**
 * Gmail連携自動化モジュール
 *
 * 関数の定義（index.ts）と管理 API から使うものだけを公開する。
 *
 * @see /docs/GMAIL_AUTO_SPEC.md
 */

// OAuth2認証
export {
  getAuthUrl,
  handleOAuthCallback,
  getGmailClient,
  isGmailAuthConfigured,
} from './auth';

// Gmail Watch管理
export {
  registerWatch,
  renewWatch,
  getWatchStatus,
} from './watch';

// Pub/Subハンドラー
export {
  handleGmailPubSub,
  processLatestEmail,
  forceProcessMessage,
} from './handler';
