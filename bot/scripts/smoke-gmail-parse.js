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
  decodeEmailBody,
  MERCHANT_MAX_CHARS,
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
// 店名の切り方（#244）
// text/html しか無いメールは改行が空白になり、店名が本文の残りまで伸びうる。
// 次のラベルの手前で切り、長さに上限を設ける。文面はすべて架空。
// ------------------------------------------------------------
console.log('\nparseSMBCCardEmail (merchant cut)');

// ◇ 書式の行（店名の後ろに ◇利用取引・◇利用金額 が続く）
function altLines(merchant) {
  return [
    'ご利用カード：三井住友ゴールドＶＩＳＡ（ＮＬ）',
    '◇利用日：2026/03/14 19:20',
    `◇利用先：${merchant}`,
    '◇利用取引：買物',
    '◇利用金額：1,200円',
    'ご利用内容の詳細は会員サイトでご確認ください。',
  ];
}

// text/html のパートだけを持つ multipart（decodeEmailBody がタグを除いて改行を空白にする経路）
function htmlOnlyPayload(html) {
  return {
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/html', body: { data: Buffer.from(html, 'utf-8').toString('base64') } }],
  };
}

function isAltJst(parsed) {
  return parsed && parsed.amount === 1200 && parsed.usedAt.toISOString() === '2026-03-14T10:20:00.000Z';
}

// (a) 改行のある通常のメールは今と同じ
const altNewline = parseSMBCCardEmail('msg-m1', altLines('SAMPLE MART EKIMAE').join('\n'));
check('改行あり（◇ 書式）: 店名は行末まで', altNewline && altNewline.merchant === 'SAMPLE MART EKIMAE', JSON.stringify(altNewline));
const altCrlf = parseSMBCCardEmail('msg-m2', altLines('SAMPLE MART EKIMAE').join('\r\n'));
check('改行あり（CRLF）: 店名は行末まで', altCrlf && altCrlf.merchant === 'SAMPLE MART EKIMAE', JSON.stringify(altCrlf));

// (b) 改行が空白になった 1 行の本文
const altOneLine = parseSMBCCardEmail('msg-m3', altLines('SAMPLE MART EKIMAE').join(' '));
check('1 行（◇ 書式）: ◇利用取引 の手前で切る', altOneLine && altOneLine.merchant === 'SAMPLE MART EKIMAE', JSON.stringify(altOneLine));
// (f) 金額・日時は変わらない
check('1 行（◇ 書式）: 金額・日時は今と同じ', isAltJst(altOneLine), JSON.stringify(altOneLine));

const goriyoOneLine = parseSMBCCardEmail('msg-m4',
  buildBody('2026/03/14 19:20', 'テスト食堂 駅前店', '3,240').replace(/\n/g, ' '));
check('1 行（ご利用 書式）: ご利用金額 の手前で切る',
  goriyoOneLine && goriyoOneLine.merchant === 'テスト食堂 駅前店', JSON.stringify(goriyoOneLine));
check('1 行（ご利用 書式）: 金額・日時は今と同じ',
  goriyoOneLine && goriyoOneLine.amount === 3240 && goriyoOneLine.usedAt.toISOString() === '2026-03-14T10:20:00.000Z',
  JSON.stringify(goriyoOneLine));

// 半角コロンのラベル、◇利用日 が店名の直後に来る並び
const halfColon = parseSMBCCardEmail('msg-m5', '◇利用先:SAMPLE MART ◇利用日:2026/03/14 19:20 ◇利用金額:1,200円');
check('1 行（半角コロン）: ◇利用日 の手前で切る', halfColon && halfColon.merchant === 'SAMPLE MART', JSON.stringify(halfColon));
check('1 行（半角コロン）: 金額・日時は今と同じ', isAltJst(halfColon), JSON.stringify(halfColon));

// ご利用カード・カード番号（下4桁）が店名の直後に来る並び
const cardLabel = parseSMBCCardEmail('msg-m6', 'ご利用店名：テスト食堂 ご利用カード：三井住友ゴールドＶＩＳＡ（ＮＬ） ご利用金額：500円');
check('1 行: ご利用カード の手前で切る', cardLabel && cardLabel.merchant === 'テスト食堂', JSON.stringify(cardLabel));
const cardNumber = parseSMBCCardEmail('msg-m7', 'ご利用店名：テスト食堂 カード番号（下4桁）：1234 ご利用金額：500円');
check('1 行: カード番号（下4桁） の手前で切る', cardNumber && cardNumber.merchant === 'テスト食堂', JSON.stringify(cardNumber));

// text/html だけのメールを decodeEmailBody に通してから読む
const htmlBody = decodeEmailBody(htmlOnlyPayload([
  '<html><body><table>',
  '<tr><td>ご利用カード：三井住友ゴールドＶＩＳＡ（ＮＬ）</td></tr>',
  '<tr><td>◇利用日：2026/03/14 19:20</td></tr>',
  '<tr><td>◇利用先：SAMPLE MART EKIMAE</td></tr>',
  '<tr><td>◇利用取引：買物</td></tr>',
  '<tr><td>◇利用金額：1,200円</td></tr>',
  '</table><p>ご利用内容の詳細は<br>会員サイトでご確認ください。</p>',
  '</body></html>',
].join('\n')));
check('HTML のみ: 本文は 1 行になる（前提の確認）', !/[\r\n]/.test(htmlBody), JSON.stringify(htmlBody));
const htmlParsed = parseSMBCCardEmail('msg-m8', htmlBody);
check('HTML のみ: ◇利用取引 の手前で切る', htmlParsed && htmlParsed.merchant === 'SAMPLE MART EKIMAE', JSON.stringify(htmlParsed));
check('HTML のみ: 金額・日時は今と同じ', isAltJst(htmlParsed), JSON.stringify(htmlParsed));

// (c) 店名が空になる場合は「不明な店舗」
const emptyOneLine = parseSMBCCardEmail('msg-m9', altLines('').join(' '));
check('1 行: 店名が空なら「不明な店舗」', emptyOneLine && emptyOneLine.merchant === '不明な店舗', JSON.stringify(emptyOneLine));
check('1 行: 店名が空でも金額・日時は読む', isAltJst(emptyOneLine), JSON.stringify(emptyOneLine));
// 改行ありで店名の行が空のとき、以前は次の行（「ご利用金額：…」）を店名にしていた
const emptyNewline = parseSMBCCardEmail('msg-m10', buildBody('2026/03/14 19:20', '', '3,240'));
check('改行あり: 店名の行が空なら次の行を店名にせず「不明な店舗」',
  emptyNewline && emptyNewline.merchant === '不明な店舗' && emptyNewline.amount === 3240, JSON.stringify(emptyNewline));
const blankAtEnd = parseSMBCCardEmail('msg-m11', 'ご利用金額：500円\nご利用店名：   ');
check('店名が空白だけなら「不明な店舗」', blankAtEnd && blankAtEnd.merchant === '不明な店舗', JSON.stringify(blankAtEnd));

// (d) 長さの上限
check('上限は 100 文字', MERCHANT_MAX_CHARS === 100, String(MERCHANT_MAX_CHARS));
const exact = 'A'.repeat(MERCHANT_MAX_CHARS);
const exactParsed = parseSMBCCardEmail('msg-m12', altLines(exact).join('\n'));
check('ちょうど上限の店名は変えない', exactParsed && exactParsed.merchant === exact, JSON.stringify(exactParsed));
const longParsed = parseSMBCCardEmail('msg-m13', altLines('B'.repeat(MERCHANT_MAX_CHARS + 50)).join('\n'));
check('上限を超える店名は先頭から上限まで',
  longParsed && longParsed.merchant === 'B'.repeat(MERCHANT_MAX_CHARS), longParsed && longParsed.merchant.length);
const wideParsed = parseSMBCCardEmail('msg-m14', altLines('店'.repeat(MERCHANT_MAX_CHARS + 1)).join('\n'));
check('全角も 1 文字として数える',
  wideParsed && wideParsed.merchant === '店'.repeat(MERCHANT_MAX_CHARS), wideParsed && wideParsed.merchant.length);
const astralParsed = parseSMBCCardEmail('msg-m15', altLines('𠮷'.repeat(MERCHANT_MAX_CHARS + 1)).join('\n'));
check('サロゲートペアを割らない',
  astralParsed && Array.from(astralParsed.merchant).length === MERCHANT_MAX_CHARS &&
    astralParsed.merchant === '𠮷'.repeat(MERCHANT_MAX_CHARS),
  astralParsed && astralParsed.merchant.length);
// ラベルで切れない続き（店名の後ろが案内文だけ）は上限で止まる
const trailing = parseSMBCCardEmail('msg-m16',
  `◇利用日：2026/03/14 19:20 ◇利用金額：1,200円 ◇利用先：SAMPLE MART ${'お問い合わせは会員サイトへ。'.repeat(20)}`);
check('ラベルが無い続きは上限で切る',
  trailing && Array.from(trailing.merchant).length === MERCHANT_MAX_CHARS && trailing.merchant.startsWith('SAMPLE MART '),
  trailing && trailing.merchant.length);
check('ラベルが無い続きでも金額・日時は今と同じ', isAltJst(trailing), JSON.stringify(trailing));

// (e) 店名の途中の「ご利用」（コロンが続かない）では切らない
const guideNewline = parseSMBCCardEmail('msg-m17', altLines('ご利用ガイド食堂').join('\n'));
check('改行あり: 「ご利用ガイド食堂」をそのまま読む', guideNewline && guideNewline.merchant === 'ご利用ガイド食堂', JSON.stringify(guideNewline));
const guideOneLine = parseSMBCCardEmail('msg-m18', altLines('ご利用ガイド食堂').join(' '));
check('1 行: 「ご利用ガイド食堂」で止め、店名の中では切らない',
  guideOneLine && guideOneLine.merchant === 'ご利用ガイド食堂', JSON.stringify(guideOneLine));
const guideGoriyo = parseSMBCCardEmail('msg-m19',
  buildBody('2026/03/14 19:20', 'ご利用ガイド食堂 ご利用者さま感謝店', '3,240').replace(/\n/g, ' '));
check('1 行（ご利用 書式）: 店名の中の「ご利用」では切らない',
  guideGoriyo && guideGoriyo.merchant === 'ご利用ガイド食堂 ご利用者さま感謝店', JSON.stringify(guideGoriyo));
const colonInName = parseSMBCCardEmail('msg-m20', altLines('SAMPLE:MART EKIMAE').join(' '));
check('1 行: ラベルでないコロンでは切らない', colonInName && colonInName.merchant === 'SAMPLE:MART EKIMAE', JSON.stringify(colonInName));

// ------------------------------------------------------------
// 時刻の有無（usedAtHasTime。#235）
// 中項目の時刻のルール（朝ご飯・昼ご飯・夜ご飯）は、メールに時刻が書かれていたときだけ当てる。
// 時刻なし（00:00 にする）・日付なし（処理した時刻にする）・時刻として読めない表記（dayjs の繰り上げと食い違う）は false。
// ------------------------------------------------------------
console.log('\nparseSMBCCardEmail (usedAtHasTime)');

check('日付と時刻あり → true', evening && evening.usedAtHasTime === true, JSON.stringify(evening));
check('JST 0 時台の時刻（00:30）も true', midnight && midnight.usedAtHasTime === true, JSON.stringify(midnight));
check('◇ 書式の日時も true', altFormat && altFormat.usedAtHasTime === true, JSON.stringify(altFormat));
check('1 行（HTML のみ）の日時も true', htmlParsed && htmlParsed.usedAtHasTime === true, JSON.stringify(htmlParsed));
check('日付だけ（時刻なし）→ false', dateOnly && dateOnly.usedAtHasTime === false, JSON.stringify(dateOnly));

const oneDigitHour = parseSMBCCardEmail('msg-t1', buildBody('2026/03/14 9:05', 'テスト食堂', '500'));
check('時が 1 桁（9:05）→ true', oneDigitHour && oneDigitHour.usedAtHasTime === true, JSON.stringify(oneDigitHour));
check('時が 1 桁でも JST の 9:05 として読む', oneDigitHour && formatJST(oneDigitHour.usedAt, 'YYYY-MM-DD HH:mm') === '2026-03-14 09:05',
  oneDigitHour && formatJST(oneDigitHour.usedAt, 'YYYY-MM-DD HH:mm'));
const lastMinute = parseSMBCCardEmail('msg-t2', buildBody('2026/03/14 23:59', 'テスト食堂', '500'));
check('23:59 → true', lastMinute && lastMinute.usedAtHasTime === true, JSON.stringify(lastMinute));

// dayjs は「25:00」を翌日 1:00、「12:60」を 13:00 に繰り上げて読む。日時（usedAt）は今と同じに読み、時刻なしとみなす
for (const [label, time] of [['25:00', '25:00'], ['24:00', '24:00'], ['12:60', '12:60'], ['99:99', '99:99']]) {
  const bad = parseSMBCCardEmail(`msg-t-${label}`, buildBody(`2026/03/14 ${time}`, 'テスト食堂', '500'));
  check(`時刻として読めない表記（${label}）→ false`, bad && bad.usedAtHasTime === false, JSON.stringify(bad));
}

const before = Date.now();
const noDate = parseSMBCCardEmail('msg-t3', ['ご利用店名：テスト食堂', 'ご利用金額：500円'].join('\n'));
const after = Date.now();
check('日付なし（処理した時刻にする）→ false', noDate && noDate.usedAtHasTime === false, JSON.stringify(noDate));
check('日付なしの usedAt は処理した時刻（前提の確認）',
  noDate && noDate.usedAt.getTime() >= before && noDate.usedAt.getTime() <= after, noDate && noDate.usedAt.toISOString());
const unknownDate = parseSMBCCardEmail('msg-t4', buildBody('不明', 'テスト食堂', '500'));
check('日時が読めない（「不明」）→ false', unknownDate && unknownDate.usedAtHasTime === false, JSON.stringify(unknownDate));
check('どの結果も boolean', [evening, midnight, altFormat, dateOnly, oneDigitHour, noDate, unknownDate].every((p) => typeof p.usedAtHasTime === 'boolean'));

// ------------------------------------------------------------
// 送信元（From ヘッダー）の判定
// 表示名や末尾の文字列に正規ドメインを書いただけの偽装を通さないこと。
// ------------------------------------------------------------
console.log('\nisSMBCGoldVISANL (sender check)');

// 厳密判定で弾いたときの console.warn を拾う（出力を汚さないよう差し替える）
const realWarn = console.warn;
let warnings = [];
console.warn = (...args) => { warnings.push(args.join(' ')); };
function judge(from, body) {
  warnings = [];
  return isSMBCGoldVISANL(from, body);
}

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
  // 表示名に angle-addr と同じアドレスを引用符なしで書く形（RFC 外だが実在する）
  'statement@vpass.ne.jp <statement@vpass.ne.jp>',
  'Statement@VPASS.ne.jp <statement@vpass.ne.jp>',
];
for (const from of legitimateFroms) {
  check(`正規の送信元を通す: ${from}`, judge(from, validBody) === true && warnings.length === 0);
}

const spoofedFroms = [
  'evil.com <x@evil.com> via smbc-card.com',
  '"vpass.ne.jp" <x@evil.example>',
  'vpass.ne.jp <x@evil.example>',
  '"三井住友カード <statement@vpass.ne.jp>" <x@evil.example>',
  '"a \\" <statement@vpass.ne.jp>" <x@evil.example>',
  'statement@vpass.ne.jp <x@evil.example>',
  'statement@vpass.ne.jp <statement@vpass.ne.jp.evil.example>',
  'x@evil.example <x@evil.example>',
  'statement@vpass.ne.jp statement@vpass.ne.jp <x@evil.example>',
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
  check(`偽装した送信元を弾く: ${from || '(empty)'}`, judge(from, validBody) === false);
}

check('正規の送信元でも本文キーワードが無ければ弾く',
  judge('statement@vpass.ne.jp', 'ご利用金額：3,240円') === false);
check('本文キーワードで弾いたときは送信元の警告を出さない', warnings.length === 0, JSON.stringify(warnings));

judge('"vpass.ne.jp" <x@evil.example>', validBody);
check('許可ドメインを騙る送信元は警告に実ドメインだけを出す',
  warnings.length === 1 &&
    warnings[0].includes('SMBC sender rejected by strict From check') &&
    warnings[0].includes('domain=evil.example') &&
    !warnings[0].includes('x@'),
  JSON.stringify(warnings));
judge('x@evil.example <statement@vpass.ne.jp>', validBody);
check('アドレスを取り出せない形は domain=none で警告する',
  warnings.length === 1 && warnings[0].includes('domain=none') && !warnings[0].includes('statement@'),
  JSON.stringify(warnings));
check('無関係なメールは弾くが警告は出さない',
  judge('friend@example.com', validBody) === false && warnings.length === 0, JSON.stringify(warnings));

console.warn = realWarn;
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
