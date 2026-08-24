/**
 * テキスト入力パーサのスモークテスト
 *
 * LINEへ実送信せずに parseTextExpense の解釈を検証する。
 *   node bot/scripts/smoke-text-parser.js
 */
const { parseTextExpense } = require('../dist/textParser');

let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 実行環境のTZに依存せずJSTの今日を求める */
function todayJST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const today = todayJST();
const thisYear = today.slice(0, 4);

console.log('parseTextExpense');

// カテゴリ名＋金額だけの入力（本文が空になるケース）
const category = parseTextExpense('光熱費　28727');
check('カテゴリ名を指定として拾う', category && category.category === '光熱費', JSON.stringify(category));
check('金額を拾う', category && category.amount === 28727, JSON.stringify(category));
check('説明はカテゴリ名で埋める（「支出」にしない）', category && category.description === '光熱費', JSON.stringify(category));
check('日付はJSTの今日', category && category.date === today, `${category && category.date} !== ${today}`);

// 日付付き。書式指定が効かないと 2001年 になっていた
const dated = parseTextExpense('6/29 4800 家賃');
check('M/D は今年として解釈する', dated && dated.date === `${thisYear}-06-29`, JSON.stringify(dated));
check('日付トークンは説明から除く', dated && dated.description === '家賃', JSON.stringify(dated));
check('日付付きでも金額を拾う', dated && dated.amount === 4800, JSON.stringify(dated));

const kanjiDate = parseTextExpense('6月29日 4800 家賃');
check('M月D日 も今年として解釈する', kanjiDate && kanjiDate.date === `${thisYear}-06-29`, JSON.stringify(kanjiDate));

const iso = parseTextExpense('2026-06-29 4800 家賃');
check('YYYY-MM-DD はそのまま使う', iso && iso.date === '2026-06-29', JSON.stringify(iso));

const invalidDate = parseTextExpense('2/30 500 テスト');
check('実在しない日付は今日に倒す', invalidDate && invalidDate.date === today, JSON.stringify(invalidDate));

// 既存フォーマットの回帰確認
const basic = parseTextExpense('500 ランチ');
check('基本形', basic && basic.amount === 500 && basic.description === 'ランチ' && !basic.category, JSON.stringify(basic));

const payment = parseTextExpense('1500 現金 ドラッグストア');
check('支払い方法を拾う', payment && payment.paymentMethod === 'cash' && payment.description === 'ドラッグストア', JSON.stringify(payment));

const withCategory = parseTextExpense('3000 スーパー 食費');
check('説明とカテゴリを両立する', withCategory && withCategory.category === '食費' && withCategory.description === 'スーパー', JSON.stringify(withCategory));

const comma = parseTextExpense('1,200 コンビニ');
check('カンマ区切りの金額', comma && comma.amount === 1200, JSON.stringify(comma));

check('金額の無いテキストは無視する', parseTextExpense('こんにちは') === null);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
