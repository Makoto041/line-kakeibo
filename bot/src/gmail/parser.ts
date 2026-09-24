/**
 * 三井住友カード利用通知メールのパーサー
 *
 * 三井住友ゴールドVISA（NL）の利用通知メールから
 * 店舗名・金額・利用日時を抽出
 */

import { ParsedCardNotification, SMBC_CARD_FILTER } from './types';
import { getFirestore } from 'firebase-admin/firestore';
import { parseJSTWallClock, toJSTDateString } from '../time';

/**
 * ヘッダー値から quoted-string（"..."）とコメント（(...)）を取り除く。
 * 表示名の中に書かれた `<x@vpass.ne.jp>` などでアドレス抽出を騙されないようにするため。
 * 引用符や括弧の対応が取れていない場合は null。
 */
function stripQuotedStringsAndComments(value: string): string | null {
  let out = '';
  let inQuote = false;
  let commentDepth = 0;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuote) {
      if (ch === '\\') {
        i++; // エスケープされた次の1文字も読み飛ばす
      } else if (ch === '"') {
        inQuote = false;
        out += ' ';
      }
      continue;
    }
    if (commentDepth > 0) {
      if (ch === '\\') {
        i++;
      } else if (ch === '(') {
        commentDepth++;
      } else if (ch === ')') {
        commentDepth--;
        if (commentDepth === 0) out += ' ';
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
    } else if (ch === '(') {
      commentDepth = 1;
    } else {
      out += ch;
    }
  }

  if (inQuote || commentDepth > 0) return null;
  return out;
}

/** 単純な addr-spec（local@domain）。quoted local-part や IP リテラルは受け付けない */
const ADDR_SPEC_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * From ヘッダーの値から送信元アドレスを1つだけ取り出す（RFC 5322 の mailbox を簡易パース）。
 *
 * - `表示名 <local@domain>` / `<local@domain>` / `local@domain` を受け付ける
 * - 表示名・コメント内の文字列は判定に使わない（表示名に "vpass.ne.jp" と書く偽装を防ぐ）
 * - アドレスが複数ある、`<...>` の後ろに文字列が続く（"... via smbc-card.com" 等）、
 *   表示名に裸のアドレスが混ざっている、といった曖昧な形は null（= 不一致扱い）
 */
export function extractSenderAddress(fromHeader: string): string | null {
  if (typeof fromHeader !== 'string' || !fromHeader.trim()) return null;

  const cleaned = stripQuotedStringsAndComments(fromHeader);
  if (cleaned === null) return null;

  const open = cleaned.indexOf('<');
  let address: string;

  if (open === -1) {
    if (cleaned.includes('>')) return null;
    address = cleaned.trim();
  } else {
    const close = cleaned.indexOf('>', open);
    if (close === -1) return null;
    // angle-addr は1つだけ
    if (cleaned.indexOf('<', open + 1) !== -1 || cleaned.indexOf('>', close + 1) !== -1) {
      return null;
    }
    const displayName = cleaned.slice(0, open);
    const trailing = cleaned.slice(close + 1);
    // 表示名に裸のアドレスや '>' がある / '>' の後ろに何か続く場合は曖昧なので拒否
    if (displayName.includes('@') || displayName.includes('>') || trailing.trim() !== '') {
      return null;
    }
    address = cleaned.slice(open + 1, close).trim();
  }

  if (!ADDR_SPEC_PATTERN.test(address)) return null;
  return address.toLowerCase();
}

/**
 * 送信元アドレスのドメインが許可リスト（SMBC_CARD_FILTER.fromDomains）に一致するか。
 *
 * ドメインは完全一致、または許可ドメインのサブドメイン（ラベル境界で一致。
 * 例: `mail.vpass.ne.jp`）だけを通す。`vpass.ne.jp.evil.example` や
 * `evilvpass.ne.jp` のような文字列上の一致は通さない。
 * サブドメインを通すのは、正規の通知が配信用サブドメインから届いても取り込みを
 * 止めないため（サブドメインは親ドメインの管理者しか作れない）。
 */
export function isAllowedSenderAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = address.slice(at + 1).toLowerCase();
  return SMBC_CARD_FILTER.fromDomains.some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`)
  );
}

/**
 * メールが三井住友ゴールドVISA（NL）の利用通知かどうか判定
 */
export function isSMBCGoldVISANL(from: string, body: string): boolean {
  // 送信元チェック: From ヘッダーをパースしてアドレスのドメインで判定する。
  // 以前は From ヘッダー全体の部分一致だったため、表示名に "vpass.ne.jp" と
  // 書いただけの偽装メールでも通ってしまっていた。
  const sender = extractSenderAddress(from);
  if (!sender || !isAllowedSenderAddress(sender)) {
    return false;
  }

  // 本文に対象カードのキーワードが含まれるかチェック
  // 全角・半角両方に対応
  const keywords = [
    SMBC_CARD_FILTER.bodyKeyword, // 三井住友ゴールドＶＩＳＡ（ＮＬ）
    '三井住友ゴールドVISA（NL）', // 半角
    '三井住友ゴールドVISA(NL)', // 括弧が半角
  ];

  return keywords.some(keyword => body.includes(keyword));
}

/**
 * 三井住友カード利用通知メールをパース
 *
 * メール本文の例:
 * ```
 * 【ご利用のお知らせ】
 * ご利用日時：2024/03/07 12:34
 * ご利用店名：イオン〇〇店
 * ご利用金額：3,240円
 * カード番号（下4桁）：1234
 * 三井住友ゴールドＶＩＳＡ（ＮＬ）
 * ```
 */
export function parseSMBCCardEmail(
  messageId: string,
  body: string
): ParsedCardNotification | null {
  try {
    // 金額を抽出
    // パターン1: 「ご利用金額：3,240円」形式
    // パターン2: 「◇利用金額：901円」形式
    const amountMatch = body.match(
      /(?:ご利用金額|◇利用金額)[：:]\s*([\d,]+)\s*円/
    );
    if (!amountMatch) {
      console.warn('Amount not found in email body');
      return null;
    }
    const amount = parseInt(amountMatch[1].replace(/,/g, ''), 10);

    // 店舗名を抽出
    // パターン1: 「ご利用店名：イオン〇〇店」形式
    // パターン2: 「◇利用先：NIKUNOHANAMASAPURASU NE」形式
    const merchantMatch = body.match(
      /(?:ご利用店名|◇利用先)[：:]\s*(.+?)(?:\n|\r|$)/
    );
    const merchant = merchantMatch
      ? merchantMatch[1].trim()
      : '不明な店舗';

    // 利用日時を抽出
    // パターン1: 「ご利用日時：2024/03/07 12:34」形式
    // パターン2: 「◇利用日：2026/03/14 19:20」形式
    const dateMatch = body.match(
      /(?:ご利用日時|◇利用日)[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2})\s*(\d{1,2}:\d{2})?/
    );
    let usedAt: Date;
    if (dateMatch) {
      const dateStr = dateMatch[1];
      const timeStr = dateMatch[2] || '00:00';
      // メール本文の日時は JST の壁時計表記。コンテナのTZ（本番は UTC）で
      // 解釈すると9時間ずれた瞬間になるため、JST として読む。
      usedAt = parseJSTWallClock(dateStr.replace(/\//g, '-'), timeStr);
    } else {
      // 日時が見つからない場合は現在時刻を使用
      usedAt = new Date();
    }

    return {
      merchant,
      amount,
      usedAt,
      cardType: '三井住友ゴールドVISA（NL）',
      messageId,
    };
  } catch (error) {
    console.error('Failed to parse SMBC card email:', error);
    return null;
  }
}

/**
 * メールの生データからBase64デコードして本文を取得
 */
export function decodeEmailBody(payload: any): string {
  // シンプルなテキストメールの場合
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // マルチパートメールの場合
  if (payload.parts) {
    for (const part of payload.parts) {
      // text/plain または text/html を優先
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      // 再帰的にネストされたパートをチェック
      if (part.parts) {
        const nested = decodeEmailBody(part);
        if (nested) return nested;
      }
    }
    // text/plainが見つからない場合はtext/htmlを使用
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
        // HTMLタグを除去してテキストのみ取得
        return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  }

  return '';
}

/**
 * メールヘッダーから送信元アドレスを取得
 */
export function getFromAddress(headers: Array<{ name: string; value: string }>): string {
  const fromHeaders = headers.filter(
    h => h.name.toLowerCase() === 'from'
  );
  // From ヘッダーが複数ある不正なメールは、どれを信じるか曖昧なので送信元なし扱い
  if (fromHeaders.length !== 1) return '';
  return fromHeaders[0].value || '';
}

/**
 * 重複チェック: 同じgmailMessageIdの支出が既に存在するか
 */
export async function isDuplicateExpense(gmailMessageId: string): Promise<boolean> {
  const db = getFirestore();
  const snapshot = await db
    .collection('expenses')
    .where('gmailMessageId', '==', gmailMessageId)
    .limit(1)
    .get();

  return !snapshot.empty;
}

/**
 * gmailMessageIdから既存の支出IDを取得
 * 存在しない場合はnullを返す
 */
export async function getExpenseIdByGmailMessageId(gmailMessageId: string): Promise<string | null> {
  const db = getFirestore();
  const snapshot = await db
    .collection('expenses')
    .where('gmailMessageId', '==', gmailMessageId)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  return snapshot.docs[0].id;
}

/**
 * 追加の重複チェック: 同日・同店舗・同金額
 * gmailMessageIdがない場合のフォールバック
 */
export async function isDuplicateByContent(
  date: string,
  merchant: string,
  amount: number
): Promise<boolean> {
  const db = getFirestore();

  // 同じ日付で同じ金額の支出を検索
  const snapshot = await db
    .collection('expenses')
    .where('date', '==', date)
    .where('amount', '==', amount)
    .get();

  // 店舗名が類似しているかチェック
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const existingMerchant = data.description || '';

    // 完全一致または部分一致でチェック
    if (
      existingMerchant === merchant ||
      existingMerchant.includes(merchant) ||
      merchant.includes(existingMerchant)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * 利用日時ベースの重複チェック: 同日時・同店舗・同金額
 * 返信メールからの二重登録を防止しつつ、同日の複数決済を許可
 *
 * 注意: Gmail自動取得（inputSource='gmail_auto'）の支出のみを対象にチェック
 * 手動入力（現金・PayPay等）との重複は許可する
 *
 * @param usedAt - カード利用日時（フルタイムスタンプ）
 * @param merchant - 店舗名
 * @param amount - 金額
 * @returns 重複している場合はtrue
 */
export async function isDuplicateByTimestamp(
  usedAt: Date,
  merchant: string,
  amount: number
): Promise<boolean> {
  const db = getFirestore();
  // 保存時（handler.ts）と同じ整形にそろえる。片方だけ変えると重複判定が壊れる
  const date = toJSTDateString(usedAt);

  // 同じ日付で同じ金額のGmail自動取得の支出のみを検索
  const snapshot = await db
    .collection('expenses')
    .where('date', '==', date)
    .where('amount', '==', amount)
    .where('inputSource', '==', 'gmail_auto')
    .get();

  // 店舗名と利用日時をチェック
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const existingMerchant = data.description || '';

    // 店舗名が類似しているかチェック
    const isSameMerchant =
      existingMerchant === merchant ||
      existingMerchant.includes(merchant) ||
      merchant.includes(existingMerchant);

    if (!isSameMerchant) continue;

    // usedAt（カード利用日時）を比較
    if (data.usedAt) {
      const existingUsedAt = data.usedAt.toDate ? data.usedAt.toDate() : new Date(data.usedAt);
      // 同じ利用日時（1分以内）なら重複とみなす
      const timeDiff = Math.abs(usedAt.getTime() - existingUsedAt.getTime());
      const oneMinute = 60 * 1000;

      if (timeDiff < oneMinute) {
        return true;
      }
    } else {
      // usedAtがない古いデータの場合、同日・同店舗・同金額で重複とみなす（保守的）
      return true;
    }
  }

  return false;
}
