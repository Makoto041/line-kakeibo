/**
 * Gmail 取込の再送まわりのスモークテスト（Firestore・Gmail には接続しない）
 *
 * - shouldAbandon: 同じメールを諦める条件（試行 3 回以上 かつ 最初の失敗から 6 時間以上）
 * - firstFailedAtOf: 失敗の記録に入れる最初の失敗の時刻（firstFailedAt を引き継ぐ。無い記録は lastFailedAt で代用）
 * - isStaleGmailEvent: 12 時間より古い Pub/Sub の通知を捨てるか
 * - historyIdOfPubSubData: 通知の本文から historyId を取り出す（読めなければ null で、再送させない）
 * - errorFields: ログに出すエラーの種類（文字列のコードは形を確かめてから出す）
 * - 関数の設定: gmailPubSubHandler の retry: true・timeoutSeconds: 300、renewGmailWatch の retryCount: 2
 * - gmailPubSubHandler が publishTime（無ければ CloudEvent の time）から 12 時間より古い通知を取込に渡さず成功で返すこと（取込は偽物）
 *
 * 取込の流れの中での確かめ（404 の読み飛ばし・firstFailedAt の保存・諦め・やり直しても直らない失敗で投げないこと・
 * 名前の無いヘッダー・ログに ID を出さないこと）は smoke-expense-card.js（偽物）と emulator-gmail-card-notice.js（Firestore エミュレータ）。
 *
 *   node bot/scripts/smoke-gmail-retry.js
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { Timestamp } = require(require.resolve('firebase-admin/firestore', { paths: [path.join(__dirname, '..')] }));
const {
  shouldAbandon,
  firstFailedAtOf,
  isStaleGmailEvent,
  historyIdOfPubSubData,
  errorFields,
  MESSAGE_ABANDON_AFTER_MS,
  STALE_GMAIL_EVENT_MS,
} = require('../dist/gmail/handler');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const now = new Date('2026-10-26T12:00:00.000Z');
const ago = (ms) => new Date(now.getTime() - ms);

console.log('\n[shouldAbandon]');
check('定数: 6 時間', MESSAGE_ABANDON_AFTER_MS === 6 * HOUR, MESSAGE_ABANDON_AFTER_MS);
check('試行 3 回・最初の失敗から 5 時間 → まだ諦めない', shouldAbandon(3, ago(5 * HOUR), now) === false);
check('試行 3 回・5 時間 59 分 → まだ諦めない', shouldAbandon(3, ago(6 * HOUR - MINUTE), now) === false);
check('試行 3 回・ちょうど 6 時間 → 諦める', shouldAbandon(3, ago(6 * HOUR), now) === true);
check('試行 3 回・7 時間 → 諦める', shouldAbandon(3, ago(7 * HOUR), now) === true);
check('試行 2 回・7 時間 → 諦めない（回数が足りない）', shouldAbandon(2, ago(7 * HOUR), now) === false);
check('試行 1 回・24 時間 → 諦めない', shouldAbandon(1, ago(24 * HOUR), now) === false);
check('試行 10 回・数分（再送で回数だけ増えた） → 諦めない', shouldAbandon(10, ago(3 * MINUTE), now) === false);
check('試行 10 回・6 時間 → 諦める', shouldAbandon(10, ago(6 * HOUR), now) === true);
check('最初の失敗の時刻が読めない（不正な Date）: 試行 3 回なら回数だけで諦める', shouldAbandon(3, new Date(NaN), now) === true);
check('最初の失敗の時刻が読めない: 試行 2 回なら諦めない', shouldAbandon(2, new Date(NaN), now) === false);
check('試行回数が数でない → 諦めない', shouldAbandon(undefined, ago(7 * HOUR), now) === false);

console.log('\n[firstFailedAtOf]');
const ts = (ms) => Timestamp.fromMillis(now.getTime() - ms);
const iso = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : String(d));
let r = firstFailedAtOf(undefined, now);
check('記録が無い（初回の失敗）→ now', iso(r) === iso(now), iso(r));
r = firstFailedAtOf({ attempts: 2, firstFailedAt: ts(5 * HOUR), lastFailedAt: ts(1 * MINUTE) }, now);
check('firstFailedAt がある → 引き継ぐ（lastFailedAt ではない）', iso(r) === iso(ago(5 * HOUR)), iso(r));
r = firstFailedAtOf({ attempts: 2, lastFailedAt: ts(7 * HOUR) }, now);
check('firstFailedAt が無い記録（項目を足す前）→ lastFailedAt で代用', iso(r) === iso(ago(7 * HOUR)), iso(r));
r = firstFailedAtOf({ attempts: 2, firstFailedAt: 'broken', lastFailedAt: ts(2 * HOUR) }, now);
check('firstFailedAt が読めない → lastFailedAt で代用', iso(r) === iso(ago(2 * HOUR)), iso(r));
r = firstFailedAtOf({ attempts: 2 }, now);
check('どちらも無い → now', iso(r) === iso(now), iso(r));
r = firstFailedAtOf({ attempts: 2, firstFailedAt: Timestamp.fromMillis(now.getTime() + HOUR) }, now);
check('now より後（時計のずれ・壊れた値）→ now', iso(r) === iso(now), iso(r));
check(
  '代用した lastFailedAt（7 時間前）と試行 3 回なら諦める',
  shouldAbandon(3, firstFailedAtOf({ attempts: 2, lastFailedAt: ts(7 * HOUR) }, now), now) === true
);

console.log('\n[isStaleGmailEvent]');
const eventAt = (ms) => ago(ms).toISOString();
check('定数: 12 時間', STALE_GMAIL_EVENT_MS === 12 * HOUR, STALE_GMAIL_EVENT_MS);
check('11 時間 59 分前 → 捨てない', isStaleGmailEvent(eventAt(12 * HOUR - MINUTE), now) === false);
check('ちょうど 12 時間前 → 捨てない（超えたら捨てる）', isStaleGmailEvent(eventAt(12 * HOUR), now) === false);
check('12 時間 1 分前 → 捨てる', isStaleGmailEvent(eventAt(12 * HOUR + MINUTE), now) === true);
check('数秒前 → 捨てない', isStaleGmailEvent(eventAt(5000), now) === false);
check('時刻が不正な文字列 → 捨てない（処理する）', isStaleGmailEvent('not-a-time', now) === false);
check('時刻が無い（undefined）→ 捨てない', isStaleGmailEvent(undefined, now) === false);
check('時刻が文字列でない → 捨てない', isStaleGmailEvent(12345, now) === false);
check('ナノ秒の小数の付いた RFC 3339（Pub/Sub の publishTime の形）も読む', isStaleGmailEvent('2026-10-25T23:59:00.123456789Z', now) === true);

console.log('\n[historyIdOfPubSubData（通知の本文から historyId を取り出す。読めなければ null で、再送させない）]');
const b64 = (text) => Buffer.from(text, 'utf-8').toString('base64');
const data = (payload) => b64(JSON.stringify(payload));
check('数値の historyId（Gmail の形）→ 型を変えずに返す', historyIdOfPubSubData(data({ emailAddress: 'a@example.com', historyId: 12345 })) === 12345);
check('数字の文字列 → そのまま返す', historyIdOfPubSubData(data({ historyId: '67890' })) === '67890');
check('historyId が無い → null', historyIdOfPubSubData(data({ emailAddress: 'a@example.com' })) === null);
check('数値として読めない文字列 → null', historyIdOfPubSubData(data({ historyId: '12a' })) === null);
check('負の数・小数 → null', historyIdOfPubSubData(data({ historyId: -1 })) === null && historyIdOfPubSubData(data({ historyId: 1.5 })) === null);
check('空文字 → null', historyIdOfPubSubData(data({ historyId: '' })) === null);
check('JSON でない → null', historyIdOfPubSubData(b64('{not json')) === null);
check('JSON の null・配列・数 → null', [b64('null'), b64('[1]'), b64('42')].every((d) => historyIdOfPubSubData(d) === null));
check('本文が文字列でない → null', historyIdOfPubSubData(undefined) === null && historyIdOfPubSubData(123) === null);

console.log('\n[errorFields（ログに出すエラーの種類）]');
check('名前と数のコード', JSON.stringify(errorFields(Object.assign(new Error('x'), { code: 503 }))) === JSON.stringify({ errorName: 'Error', errorCode: 503 }));
check('英大文字・数字・_ のコードは出す', errorFields(Object.assign(new Error('x'), { code: 'ECONNRESET' })).errorCode === 'ECONNRESET');
check(
  '形の違う文字列のコード（入力の断片でありうる）は出さない',
  ['abc', 'ERR bad', 'a@example.com', 'X'.repeat(65), ''].every((code) => errorFields(Object.assign(new Error('x'), { code })).errorCode === undefined)
);
check('NaN・Infinity のコードは出さない', [NaN, Infinity].every((code) => errorFields(Object.assign(new Error('x'), { code })).errorCode === undefined));
check(
  '原因のコード（fetch の通信の失敗）は errorCause に出す',
  errorFields(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).errorCause === 'UND_ERR_CONNECT_TIMEOUT'
);
check('エラーの文言は出さない', !JSON.stringify(errorFields(new Error('secret-ish message a@example.com'))).includes('a@example.com'));

console.log('\n[関数の設定と古い通知の扱い（dist/index.js）]');
// index.js は読み込むと dotenv と Firebase Admin の初期化が走るので、.env の無いディレクトリで別のプロセスにする
// （接続はしない。Admin SDK は最初に使うときに接続する）
const probe = spawnSync(
  process.execPath,
  [
    '-e',
    `const m = require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'index.js'))});
     // 取込の本体は偽物にする（index.js は呼ぶときに exports から引く）
     const handler = require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'gmail', 'handler.js'))});
     const handled = [];
     handler.handleGmailPubSub = async (data) => { handled.push(data); };
     const g = m.gmailPubSubHandler.__endpoint;
     const w = m.renewGmailWatch.__endpoint;
     const at = (ageMs) => (ageMs === null ? undefined : new Date(Date.now() - ageMs).toISOString());
     // publishAgeMs: メッセージの publishTime（null なら無し）、timeAgeMs: CloudEvent の time
     const event = (publishAgeMs, timeAgeMs, data) => ({ time: at(timeAgeMs), data: { message: { data, publishTime: at(publishAgeMs) } } });
     const H = 3600 * 1000;
     (async () => {
       const warns = [];
       const warn = console.warn;
       console.warn = (...args) => warns.push(args);
       let staleError = null;
       try {
         // 再送で time が新しくても、publishTime が 13 時間前なら捨てる
         await m.gmailPubSubHandler.run(event(13 * H, 0, 'stale'));
         // publishTime が無ければ time で測る（防御だけ。firebase-functions の Message は publishTime を必ず埋めるので、本番でこの経路は通らない。
         // ここは onMessagePublished の包みを通さない run を直接呼ぶので、publishTime の無いメッセージを渡せる）
         await m.gmailPubSubHandler.run(event(null, 13 * H, 'stale-time-only'));
       } catch (e) {
         staleError = String(e);
       }
       await m.gmailPubSubHandler.run(event(60 * 1000, 60 * 1000, 'fresh'));
       // publishTime が新しければ、time が古くても処理する
       await m.gmailPubSubHandler.run(event(60 * 1000, 13 * H, 'fresh-publish'));
       console.warn = warn;
       process.stdout.write('\\nENDPOINTS ' + JSON.stringify({
         retry: g.eventTrigger.retry,
         timeoutSeconds: g.timeoutSeconds,
         topic: g.eventTrigger.eventFilters.topic,
         region: g.region,
         renewRetry: w.scheduleTrigger.retryConfig,
         handled,
         staleError,
         warns,
       }) + '\\n');
       process.exit(0);
     })().catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });`,
  ],
  { cwd: __dirname, encoding: 'utf-8', timeout: 60000 }
);
const line = (probe.stdout || '').split('\n').find((l) => l.startsWith('ENDPOINTS '));
const endpoints = line ? JSON.parse(line.slice('ENDPOINTS '.length)) : null;
check('dist/index.js を読み込める', endpoints !== null, { status: probe.status, stderr: (probe.stderr || '').slice(0, 300) });
if (endpoints) {
  check('gmailPubSubHandler: retry: true（失敗したら Pub/Sub が再送する）', endpoints.retry === true, endpoints);
  check('gmailPubSubHandler: timeoutSeconds: 300', endpoints.timeoutSeconds === 300, endpoints);
  check(
    'gmailPubSubHandler: トピックとリージョンは変えない（変えると関数が作り直しになる）',
    JSON.stringify(endpoints.region) === JSON.stringify(['asia-northeast1']) && /gmail-notifications$/.test(String(endpoints.topic)),
    endpoints
  );
  check('renewGmailWatch: retryCount: 2', endpoints.renewRetry && endpoints.renewRetry.retryCount === 2, endpoints);
  check(
    'gmailPubSubHandler: publishTime が 13 時間前の通知は、time が今でも取込を呼ばずに成功で返す（投げない＝再送を止める）',
    endpoints.staleError === null && !endpoints.handled.includes('stale'),
    endpoints
  );
  check(
    'gmailPubSubHandler: publishTime が無ければ time（13 時間前）で測って捨てる',
    endpoints.staleError === null && !endpoints.handled.includes('stale-time-only'),
    endpoints
  );
  check(
    'gmailPubSubHandler: 古い通知を捨てたら固定文の警告を出す（2 回）',
    endpoints.warns.length === 2 && endpoints.warns.every((w) => w.length === 1 && /older than 12 hours/.test(w[0])),
    endpoints.warns
  );
  check(
    'gmailPubSubHandler: publishTime が 1 分前なら（time が古くても）取込に渡す',
    JSON.stringify(endpoints.handled) === JSON.stringify(['fresh', 'fresh-publish']),
    endpoints.handled
  );
}

console.log(failed === 0 ? '\nすべて通過' : `\n${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
