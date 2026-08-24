import { dayjs, JST, nowJST, todayJST } from './time';

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

/** 日付トークンとして認識する形（YYYY-MM-DD / M/D / M月D日） */
const DATE_TOKEN = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日?)$/;

/** 「半年以上先」を前年の日付とみなす境界（日） */
const FUTURE_DATE_LIMIT_DAYS = 183;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 年月日から YYYY-MM-DD を作る。実在しない日付なら null
 *
 * 厳密パースにするのは 2/31 のような入力を silently ずらさないため。
 */
function buildYMD(year: number, month: number, day: number): string | null {
  const parsed = dayjs(`${year}-${pad(month)}-${pad(day)}`, 'YYYY-MM-DD', true);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : null;
}

/**
 * 年の無い「6/29」「6月29日」を解決する
 *
 * 基本は JST の今年。ただし年をまたいだ直後に前年の支出を入力すると（1/1 に 12/31 など）
 * 今年で組むと約1年先になってしまうため、半年以上先になる場合は前年とみなす。
 */
function resolveMonthDay(month: number, day: number): string | null {
  const now = nowJST();
  const thisYear = buildYMD(now.year(), month, day);
  if (!thisYear) return null;

  const isFarFuture =
    dayjs.tz(thisYear, JST).diff(now.startOf('day'), 'day') > FUTURE_DATE_LIMIT_DAYS;
  return isFarFuture ? buildYMD(now.year() - 1, month, day) ?? thisYear : thisYear;
}

/**
 * 日付トークンを YYYY-MM-DD へ解決する。解釈できなければ null
 *
 * 以前は `dayjs('6/29', ['M/D'])` としていたが、customParseFormat プラグインを
 * 読み込んでいないため書式指定が無視され、`new Date('6/29')` 相当の解釈で
 * **2001年** になっていた（保存はされるがアプリのどの月にも出てこない）。
 */
function resolveDate(dateStr: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateStr);
  if (iso) return buildYMD(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const monthDay =
    /^(\d{1,2})\/(\d{1,2})$/.exec(dateStr) || /^(\d{1,2})月(\d{1,2})日?$/.exec(dateStr);
  if (monthDay) return resolveMonthDay(Number(monthDay[1]), Number(monthDay[2]));

  return null;
}

/**
 * 「500 ランチ」「6/29 4800 家賃」「1500 現金 ドラッグストア」などを解析
 *
 * 対応フォーマット:
 * - 基本: "500 ランチ"
 * - 日付付き: "6/29 4800 家賃"
 * - 支払い方法指定: "1500 現金 ドラッグストア"
 * - カテゴリ指定: "3000 スーパー 食費" / "光熱費 28727"
 */
export function parseTextExpense(input: string): ParsedTextExpense | null {
  const tokens = input.trim().split(/\s+/);

  // 金額 (= 数字) を抜き出す
  const amountIdx = tokens.findIndex(t => /^\d+円?$/.test(t.replace(/,/g, '')));
  if (amountIdx === -1) return null;
  const amount = Number(tokens[amountIdx].replace(/[,円]/g, ''));

  // 日付っぽいトークンを探す。
  // 「13/45」のように日付の形はしていても実在しない場合は今日として扱い、
  // トークンは説明に残す（黙って消すと入力の取りこぼしに気づけない）。
  const dateIdx = tokens.findIndex(t => DATE_TOKEN.test(t));
  const resolvedDate = dateIdx !== -1 ? resolveDate(tokens[dateIdx]) : null;
  const date = resolvedDate ?? todayJST();
  const usedDateIdx = resolvedDate ? dateIdx : -1;

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
  // 「光熱費 28727」のようにカテゴリと金額だけの入力では残りが空になる。
  // 一覧に「支出」が並ぶと見分けが付かないため、その場合はカテゴリ名を説明にする。
  const excludeIndices = new Set([amountIdx, usedDateIdx, paymentIdx, categoryIdx].filter(i => i !== -1));
  const description = tokens
    .filter((_, i) => !excludeIndices.has(i))
    .join(' ')
    || category
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
