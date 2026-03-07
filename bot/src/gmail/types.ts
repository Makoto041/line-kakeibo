/**
 * Gmail連携自動化 - 型定義
 *
 * 既存のExpenseインターフェース（firestore.ts）を拡張する形で定義
 * @see /.github/docs/GMAIL_AUTO_SPEC_V2.md
 */

import { Expense } from '../firestore';

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
// 支出データ拡張
// ============================================

/**
 * 入力ソース
 */
export type InputSource = 'line_text' | 'line_ocr' | 'gmail_auto';

/**
 * 支出ステータス（Gmail自動取得用）
 */
export type ExpenseStatus = 'pending' | 'shared' | 'personal' | 'advance_pending';

/**
 * Gmail自動取得で追加するフィールド
 * 既存のExpenseインターフェースを拡張
 */
export interface GmailExpenseExtension {
  /** 入力元 */
  inputSource: InputSource;
  /** GmailメッセージID（重複チェック用） */
  gmailMessageId: string;
  /** ステータス */
  status: ExpenseStatus;
  /** 立替者（立替の場合のみ） */
  advanceBy?: string;
}

/**
 * Gmail自動取得で作成する支出データ
 * 既存のExpense + 拡張フィールド
 */
export type GmailExpense = Expense & GmailExpenseExtension;

// ============================================
// LINE Postback関連
// ============================================

/**
 * LINE Postbackアクションデータ
 */
export interface PostbackActionData {
  /** アクション種別 */
  action: 'shared' | 'personal' | 'advance';
  /** 対象の支出ID */
  expenseId: string;
}

// ============================================
// 予算設定
// ============================================

/**
 * 予算設定
 * Firestore: system/budget
 */
export interface BudgetSettings {
  /** 月次予算（円） */
  monthly: number;
  /** アラート閾値（残り円） */
  alertThreshold: number;
}

/**
 * デフォルト予算設定
 */
export const DEFAULT_BUDGET: BudgetSettings = {
  monthly: 136000, // 13.6万円
  alertThreshold: 20000, // 残り2万円でアラート
};

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
// カテゴリ定義（既存と一致）
// ============================================

/**
 * カテゴリ絵文字マップ
 * geminiCategoryClassifier.ts の getAllUserCategories と一致させる
 */
export const CATEGORY_EMOJI_MAP: Record<string, string> = {
  '食費': '🍱',
  '交通費': '🚃',
  '日用品': '🧻',
  '娯楽': '🎮',
  '衣服': '👕',
  '医療・健康': '💊',
  '教育': '📚',
  '光熱費': '💡',
  '住居費': '🏠',
  '保険': '🛡️',
  '税金': '📋',
  '美容': '💄',
  '通信費': '📱',
  'サブスク': '📺',
  'プレゼント': '🎁',
  '旅行': '✈️',
  'ペット': '🐕',
  '貯金': '💰',
  'その他': '📝',
};

/**
 * カテゴリ名から絵文字を取得
 */
export function getCategoryEmoji(categoryName: string): string {
  return CATEGORY_EMOJI_MAP[categoryName] || '📝';
}
