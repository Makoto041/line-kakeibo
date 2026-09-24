/**
 * カード利用通知メールのパースと日付整形のスモークテスト
 *
 *   node bot/scripts/smoke-gmail-parse.js
 */
const {
  parseSMBCCardEmail,
  isSMBCGoldVISANL,
  extractSenderAddress,
  getFromAddress,
} = require('../dist/gmail/parser');
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

// ------------------------------------------------------------
// 送信元（From ヘッダー）の判定
// 表示名や末尾の文字列に正規ドメインを書いただけの偽装を通さないこと。
// ------------------------------------------------------------
console.log('\nisSMBCGoldVISANL (sender check)');

const validBody = buildBody('2026/03/14 19:20', 'イオン〇〇店', '3,240');

const legitimateFroms = [
  'statement@vpass.ne.jp',
  '<statement@vpass.ne.jp>',
  '三井住友カード <statement@vpass.ne.jp>',
  '"三井住友カード" <statement@vpass.ne.jp>',
  '"=?UTF-8?B?5LiJ5LqV5L2P5Y+L44Kr44O844OJ?=" <statement@vpass.ne.jp>',
  'Statement@VPASS.NE.JP',
  'info@smbc-card.com',
  '三井住友カード <info@smbc-card.com>',
  'SMBC <noreply@mail.vpass.ne.jp>', // 正規ドメインのサブドメイン
  'statement@vpass.ne.jp (三井住友カード)',
];
for (const from of legitimateFroms) {
  check(`正規の送信元を通す: ${from}`, isSMBCGoldVISANL(from, validBody) === true);
}

const spoofedFroms = [
  'evil.com <x@evil.com> via smbc-card.com',
  '"vpass.ne.jp" <x@evil.example>',
  'vpass.ne.jp <x@evil.example>',
  '"三井住友カード <statement@vpass.ne.jp>" <x@evil.example>',
  '"a \\" <statement@vpass.ne.jp>" <x@evil.example>',
  'statement@vpass.ne.jp <x@evil.example>',
  'x@evil.example (statement@vpass.ne.jp)',
  'x@evil.example <statement@vpass.ne.jp>',
  '<statement@vpass.ne.jp> x@evil.example',
  '<statement@vpass.ne.jp> via evil.example',
  'statement@vpass.ne.jp.evil.example',
  '三井住友カード <statement@vpass.ne.jp.evil.example>',
  'statement@evilvpass.ne.jp',
  'statement@smbc-card.com.evil.example',
  'statement@vpass-ne.jp',
  'x@evil.example, statement@vpass.ne.jp',
  'a <x@evil.example>, b <statement@vpass.ne.jp>',
  'statement@vpass.ne.jp@evil.example',
  'statement@vpass.ne.jp>',
  '"unterminated <statement@vpass.ne.jp>',
  '',
];
for (const from of spoofedFroms) {
  check(`偽装した送信元を弾く: ${from || '(empty)'}`, isSMBCGoldVISANL(from, validBody) === false);
}

check('正規の送信元でも本文キーワードが無ければ弾く',
  isSMBCGoldVISANL('statement@vpass.ne.jp', 'ご利用金額：3,240円') === false);
check('アドレスは小文字で取り出す',
  extractSenderAddress('三井住友カード <Statement@VPASS.ne.jp>') === 'statement@vpass.ne.jp');
check('From ヘッダーが複数あるメールは送信元なし扱い',
  getFromAddress([
    { name: 'From', value: 'x@evil.example' },
    { name: 'From', value: 'statement@vpass.ne.jp' },
  ]) === '');
check('From ヘッダーが1つなら値を返す',
  getFromAddress([{ name: 'from', value: 'statement@vpass.ne.jp' }]) === 'statement@vpass.ne.jp');

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
