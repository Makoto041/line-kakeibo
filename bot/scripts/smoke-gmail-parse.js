/**
 * カード利用通知メールのパースと日付整形のスモークテスト
 *
 *   node bot/scripts/smoke-gmail-parse.js
 */
const { parseSMBCCardEmail } = require('../dist/gmail/parser');
const { toJSTDateString, formatJST } = require('../dist/time');

let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function buildBody(dateTime, merchant, amount) {
  return [
    '【ご利用のお知らせ】',
    `ご利用日時：${dateTime}`,
    `ご利用店名：${merchant}`,
    `ご利用金額：${amount}円`,
    'カード番号（下4桁）：1234',
    '三井住友ゴールドＶＩＳＡ（ＮＬ）',
  ].join('\n');
}

console.log('parseSMBCCardEmail');

const evening = parseSMBCCardEmail('msg-1', buildBody('2026/03/14 19:20', 'イオン〇〇店', '3,240'));
check('金額・店舗名を拾う', evening && evening.amount === 3240 && evening.merchant === 'イオン〇〇店', JSON.stringify(evening));
check('利用日時をJSTの実時刻として読む', evening && evening.usedAt.toISOString() === '2026-03-14T10:20:00.000Z',
  evening && evening.usedAt.toISOString());
check('保存する日付は利用日と一致する', evening && toJSTDateString(evening.usedAt) === '2026-03-14',
  evening && toJSTDateString(evening.usedAt));

// JST 深夜〜早朝。コンテナのTZに引きずられると前日になる区間
const midnight = parseSMBCCardEmail('msg-2', buildBody('2026/09/01 00:30', 'コンビニ', '901'));
check('JST 0時台でも当日の日付になる', midnight && toJSTDateString(midnight.usedAt) === '2026-09-01',
  midnight && toJSTDateString(midnight.usedAt));
check('通知の M/D 表示も当日', midnight && formatJST(midnight.usedAt, 'M/D') === '9/1',
  midnight && formatJST(midnight.usedAt, 'M/D'));

// 別書式（◇利用先 / ◇利用日）
const altFormat = parseSMBCCardEmail('msg-3', [
  '◇利用日：2026/03/14 19:20',
  '◇利用先：NIKUNOHANAMASA',
  '◇利用金額：901円',
].join('\n'));
check('◇ 書式も読める', altFormat && altFormat.amount === 901 && altFormat.merchant === 'NIKUNOHANAMASA', JSON.stringify(altFormat));

// 時刻の無い通知
const dateOnly = parseSMBCCardEmail('msg-4', buildBody('2026/03/14', 'スーパー', '500'));
check('時刻が無ければ 00:00 として当日になる', dateOnly && toJSTDateString(dateOnly.usedAt) === '2026-03-14',
  dateOnly && toJSTDateString(dateOnly.usedAt));

check('金額が無いメールは null', parseSMBCCardEmail('msg-5', 'ご利用日時：2026/03/14 19:20') === null);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
