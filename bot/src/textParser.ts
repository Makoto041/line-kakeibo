import dayjs from 'dayjs';

// 戻り値の型
export interface ParsedTextExpense {
  amount: number;
  date: string;        // YYYY-MM-DD
  description: string;
}

/**
 * 「500 ランチ」「6/29 4800 家賃」などを解析
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

  // 残りは説明
  const description = tokens
    .filter((_, i) => i !== amountIdx && i !== dateIdx)
    .join(' ')
    || '支出';

  return { amount, date, description };
}