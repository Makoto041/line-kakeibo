/**
 * LINE関連モジュール
 *
 * Gmail自動取得用のFlex MessageとPostback処理
 */

// Flex Message
export {
  buildCardUsageFlexMessage,
  sendCardUsageNotification,
  sendTextMessage,
  sendStatusUpdateConfirmation,
  CardUsageInfo,
} from './flexMessage';

// Postback処理
export {
  handlePostback,
  isPostbackEvent,
  isGmailPostback,
} from './postback';
