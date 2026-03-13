import dayjs from 'dayjs';

// 支払い方法
export type PaymentMethod = 'cash' | 'paypay' | 'card' | 'unknown';

// 戻り値の型
export interface ParsedTextExpense {
  amount: number;
  date: string;        // YYYY-MM-DD
  description: string;
  paymentMethod: PaymentMethod;
  category?: string;   // ユーザー指定カテゴリ（あれば）
}

// 有効なカテゴリー一覧
const VALID_CATEGORIES = [
  '食費', '日用品', '交通費', '医療費', '娯楽費',
  '衣服費', '教育費', '通信費', '光熱費', '住居費',
  '保険', '税金', '貯蓄', '投資', '美容',
  'ペット', '趣味', '交際費', 'その他',
];

// 支払い方法キーワード
const PAYMENT_KEYWORDS: { [key: string]: PaymentMethod } = {
  '現金': 'cash',
  'げんきん': 'cash',
  'キャッシュ': 'cash',
  'paypay': 'paypay',
  'ペイペイ': 'paypay',
  'カード': 'card',
  'クレカ': 'card',
  'クレジット': 'card',
};

/**
 * 「500 ランチ」「6/29 4800 家賃」「1500 現金 ドラッグストア」などを解析
 *
 * 対応フォーマット:
 * - 基本: "500 ランチ"
 * - 日付付き: "6/29 4800 家賃"
 * - 支払い方法指定: "1500 現金 ドラッグストア"
 * - カテゴリ指定: "3000 スーパー 食費"
 */
export function parseTextExpense(input: string): ParsedTextExpense | null {
  const tokens = input.trim().split(/\s+/);

  // 金額 (= 数字) を抜き出す
  const amountIdx = tokens.findIndex(t => /^\d+円?$/.test(t.replace(/,/g, '')));
  if (amountIdx === -1) return null;
  const amount = Number(tokens[amountIdx].replace(/[,円]/g, ''));

  // 日付っぽいトークンを探す
  const dateIdx = tokens.findIndex(t => /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日?)$/.test(t));
  const dateStr = dateIdx !== -1 ? tokens[dateIdx] : undefined;

  let date: string;
  if (dateStr) {
    if (dateStr.includes('月')) {
      // MM月DD日 形式
      const match = dateStr.match(/(\d{1,2})月(\d{1,2})日?/);
      if (match) {
        const month = match[1].padStart(2, '0');
        const day = match[2].padStart(2, '0');
        date = dayjs(`${dayjs().year()}-${month}-${day}`).format('YYYY-MM-DD');
      } else {
        date = dayjs().format('YYYY-MM-DD');
      }
    } else {
      // YYYY-MM-DD や M/D 形式
      date = dayjs(dateStr, ['YYYY-MM-DD', 'M/D', 'MM/DD']).format('YYYY-MM-DD');
    }
  } else {
    date = dayjs().format('YYYY-MM-DD');
  }

  // 支払い方法を検出
  let paymentMethod: PaymentMethod = 'unknown';
  let paymentIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const lowerToken = tokens[i].toLowerCase();
    for (const [keyword, method] of Object.entries(PAYMENT_KEYWORDS)) {
      if (lowerToken === keyword.toLowerCase()) {
        paymentMethod = method;
        paymentIdx = i;
        break;
      }
    }
    if (paymentIdx !== -1) break;
  }

  // カテゴリを検出
  let category: string | undefined;
  let categoryIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (VALID_CATEGORIES.includes(tokens[i])) {
      category = tokens[i];
      categoryIdx = i;
      break;
    }
  }

  // 残りは説明（金額、日付、支払い方法、カテゴリを除く）
  const excludeIndices = new Set([amountIdx, dateIdx, paymentIdx, categoryIdx].filter(i => i !== -1));
  const description = tokens
    .filter((_, i) => !excludeIndices.has(i))
    .join(' ')
    || '支出';

  return { amount, date, description, paymentMethod, category };
}

/**
 * 支払い方法の表示名を取得
 */
export function getPaymentMethodLabel(method: PaymentMethod): string {
  switch (method) {
    case 'cash': return '現金';
    case 'paypay': return 'PayPay';
    case 'card': return 'カード';
    default: return '';
  }
}