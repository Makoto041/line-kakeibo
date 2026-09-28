/**
 * Gmail連携自動化モジュール
 *
 * @see /docs/GMAIL_AUTO_SPEC.md
 */

// 型定義
export * from './types';

// OAuth2認証
export {
  getAuthUrl,
  handleOAuthCallback,
  getValidAccessToken,
  getGmailClient,
  isGmailAuthConfigured,
} from './auth';

// Gmail Watch管理
export {
  registerWatch,
  renewWatch,
  stopWatch,
  getWatchState,
  updateHistoryId,
  isWatchExpiringSoon,
  getWatchExpiration,
  getWatchStatus,
} from './watch';

// メールパース
export {
  isSMBCGoldVISANL,
  parseSMBCCardEmail,
  decodeEmailBody,
  getFromAddress,
  isDuplicateExpense,
  isDuplicateByContent,
  isDuplicateByTimestamp,
  getExpenseIdByGmailMessageId,
} from './parser';

// Pub/Subハンドラー
export {
  handleGmailPubSub,
  processLatestEmail,
  forceProcessMessage,
} from './handler';
