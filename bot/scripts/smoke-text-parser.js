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

/**
 * 実行環境のTZに依存せずJSTの今日を求める
 *
 * 日付をまたいだ瞬間に落ちないよう、比較のたびに取り直す。
 */
function todayJST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const yearJST = () => todayJST().slice(0, 4);

console.log('parseTextExpense');

// カテゴリ名＋金額だけの入力（本文が空になるケース）
const category = parseTextExpense('光熱費　28727');
check('カテゴリ名を指定として拾う', category && category.category === '光熱費', JSON.stringify(category));
check('金額を拾う', category && category.amount === 28727, JSON.stringify(category));
check('説明はカテゴリ名で埋める（「支出」にしない）', category && category.description === '光熱費', JSON.stringify(category));
check('日付はJSTの今日', category && category.date === todayJST(), `${category && category.date} !== ${todayJST()}`);

// 日付付き。書式指定が効かないと 2001年 になっていた
const dated = parseTextExpense('6/29 4800 家賃');
check('M/D は年を補って解釈する', dated && /^\d{4}-06-29$/.test(dated.date), JSON.stringify(dated));
check('日付トークンは説明から除く', dated && dated.description === '家賃', JSON.stringify(dated));
check('日付付きでも金額を拾う', dated && dated.amount === 4800, JSON.stringify(dated));

const kanjiDate = parseTextExpense('6月29日 4800 家賃');
check('M月D日 も同じ日付になる', kanjiDate && dated && kanjiDate.date === dated.date, JSON.stringify(kanjiDate));

const iso = parseTextExpense('2026-06-29 4800 家賃');
check('YYYY-MM-DD はそのまま使う', iso && iso.date === '2026-06-29', JSON.stringify(iso));

// 年の無い日付は「半年以上先」にならない＝年またぎでも実感に合う日付になる
const MS_PER_DAY = 24 * 60 * 60 * 1000;
let farFuture = null;
for (let month = 1; month <= 12; month++) {
  const parsed = parseTextExpense(`${month}/15 1000 テスト`);
  if (!parsed) {
    farFuture = `${month}/15 を解釈できない`;
    break;
  }
  const days = (Date.parse(`${parsed.date}T00:00:00+09:00`) - Date.parse(`${todayJST()}T00:00:00+09:00`)) / MS_PER_DAY;
  if (days > 183) farFuture = `${month}/15 -> ${parsed.date}（${days}日先）`;
}
check('年の無い日付が半年以上先にならない', farFuture === null, farFuture);

// 実在しない日付
const invalidDate = parseTextExpense('2/30 500 テスト');
check('実在しない日付は今日に倒す', invalidDate && invalidDate.date === todayJST(), JSON.stringify(invalidDate));
check('読めなかった日付トークンは説明に残す', invalidDate && invalidDate.description.includes('2/30'), JSON.stringify(invalidDate));

// 既存フォーマットの回帰確認
const basic = parseTextExpense('500 ランチ');
check('基本形', basic && basic.amount === 500 && basic.description === 'ランチ' && !basic.category, JSON.stringify(basic));

const yen = parseTextExpense('500円 コンビニ');
check('「円」付きの金額', yen && yen.amount === 500 && yen.description === 'コンビニ', JSON.stringify(yen));

const payment = parseTextExpense('1500 現金 ドラッグストア');
check('支払い方法を拾う', payment && payment.paymentMethod === 'cash' && payment.description === 'ドラッグストア', JSON.stringify(payment));

const paymentAndCategory = parseTextExpense('1500 現金 食費');
check('支払い方法＋カテゴリだけなら説明はカテゴリ名',
  paymentAndCategory && paymentAndCategory.paymentMethod === 'cash'
    && paymentAndCategory.category === '食費' && paymentAndCategory.description === '食費',
  JSON.stringify(paymentAndCategory));

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
