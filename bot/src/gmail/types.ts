/**
 * Gmail連携自動化 - 型定義
 *
 * @see /docs/GMAIL_AUTO_SPEC.md
 */

// ============================================
// Gmail OAuth2 関連
// ============================================

/**
 * Gmail OAuth2トークン
 * Firestore: system/gmailToken
 */
export interface GmailToken {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type?: string;
  scope?: string;
}

/**
 * Gmail Watch状態
 * Firestore: system/gmailState
 */
export interface GmailWatchState {
  historyId: string;
  watchExpiration: number; // Unix timestamp (ms)
}

// ============================================
// メールパース関連
// ============================================

/**
 * パースされたカード利用通知
 */
export interface ParsedCardNotification {
  /** 店舗名 */
  merchant: string;
  /** 利用金額（円） */
  amount: number;
  /** 利用日時 */
  usedAt: Date;
  /** カード種別（常に "三井住友ゴールドVISA（NL）"） */
  cardType: string;
  /** メールの一意ID */
  messageId: string;
  /** 生のメール本文（デバッグ用） */
  rawBody?: string;
}

/**
 * Pub/Subメッセージペイロード
 */
export interface GmailPubSubPayload {
  emailAddress: string;
  historyId: string;
}

// ============================================
// LINE Postback関連
// ============================================

/**
 * LINE Postbackアクションデータ
 */
export interface PostbackActionData {
  /**
   * アクション種別
   *
   * - set_split / set_advance / show_list … 現行UI（現在値表示＋[変更]ボタン）が送る操作
   * - shared / personal / advance … 旧UIのボタン。配信済みメッセージは編集できないため、
   *   過去に送ったカードから押される可能性がある。互換のため残す。
   */
  action:
    | 'set_split'
    | 'set_advance'
    | 'show_list'
    | 'confirm'
    | 'edit'
    | 'show_category_select'
    | 'set_category'
    | 'shared'
    | 'personal'
    | 'advance';
  /** 対象の支出ID */
  expenseId: string;
}

// ============================================
// 三井住友カードフィルタ
// ============================================

/**
 * 三井住友カードメールの判定条件
 */
export const SMBC_CARD_FILTER = {
  /** 送信元ドメイン */
  fromDomains: ['vpass.ne.jp', 'smbc-card.com'],
  /** 本文に含まれるべきキーワード（全角） */
  bodyKeyword: '三井住友ゴールドＶＩＳＡ（ＮＬ）',
} as const;

// ============================================
// カテゴリ
// ============================================

/**
 * カテゴリ名から絵文字を取得
 */
export function getCategoryEmoji(categoryName: string): string {
  // 絵文字は使用しない方針のため空文字を返す（呼び出し側の互換性のため関数は残す）。
  void categoryName;
  return '';
}
