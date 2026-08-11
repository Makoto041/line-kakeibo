/**
 * LINE関連モジュール
 *
 * Gmail自動取得用のFlex MessageとPostback処理
 */

// Flex Message
export {
  buildCardUsageFlexMessage,
  sendCardUsageNotification,
  buildExpenseCardFromRecord,
  buildExpenseListUrl,
  CardUsageInfo,
  // テキスト入力用
  buildTextExpenseFlexMessage,
  sendTextExpenseNotification,
  TextExpenseInfo,
} from './flexMessage';

// Postback処理
export {
  handlePostback,
  isPostbackEvent,
} from './postback';
