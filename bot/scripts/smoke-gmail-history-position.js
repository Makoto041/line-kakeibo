/**
 * 取込（handleGmailPubSub）が保存する historyId のスモークテスト（#298。Firestore・Gmail には接続しない）
 *
 * watch.ts の getWatchState・updateHistoryId は本物を使い、Firestore（system/gmailState）だけをメモリ上の偽物にする。
 * Gmail（history.list・getProfile）と送信待ちの印（cardNotice.ts）は偽物。
 *
 * - 保存するのは常にメールボックスの現在位置（history.list の応答の historyId。正規の形の文字列）。通知の historyId は使わない:
 *   偽の通知（極端に大きい・現在位置より大きい・保存値と現在位置の間・保存値と同じ・保存値より小さい・ゼロ）のどれでも、
 *   保存値は現在位置になる。先頭ゼロの通知は読めない通知として捨てる（Gmail を呼ばず、保存値も変えない）
 * - 現在位置が保存値以下なら進めない（巻き戻さない。updateHistoryId は前進のみ）。そのログは固定文と桁数だけ
 * - 数値で保存されている値（#278）も使い、現在位置を文字列で保存する
 * - 保存してある historyId が使えない形（先頭ゼロ・21 桁・uint64 超・数字以外・負の数・小数）なら、投げず、Gmail API
 *   （history.list・getProfile）を呼ばず、保存値も変えずに終える。警告は固定文 1 行で、値を出さない
 * - history.list が 404 のときは getProfile の現在位置を保存する。先へ飛ばしたログは固定文と桁数だけ
 *
 *   node bot/scripts/smoke-gmail-history-position.js
 */
const path = require('path');
const util = require('util');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

const adminFirestore = require(require.resolve('firebase-admin/firestore', { paths: [path.join(__dirname, '..')] }));
const { FieldValue } = adminFirestore;

// --- Firestore の偽物（メモリ上の文書。トランザクションは順に実行する） ---
/** 文書のパス（collection/id）→ 中身 */
const docs = new Map();
const isDelete = (value) => value instanceof Object && typeof value.isEqual === 'function' && value.isEqual(FieldValue.delete());
function write(docPath, data, options) {
  const next = { ...(options && options.merge && docs.has(docPath) ? docs.get(docPath) : {}) };
  for (const [key, value] of Object.entries(data)) {
    if (isDelete(value)) delete next[key];
    else next[key] = value;
  }
  docs.set(docPath, next);
}
function docRef(collection, id) {
  const docPath = `${collection}/${id}`;
  return {
    id,
    path: docPath,
    get: async () => ({ exists: docs.has(docPath), data: () => (docs.has(docPath) ? { ...docs.get(docPath) } : undefined) }),
    set: async (data, options) => write(docPath, data, options),
    update: async (data) => {
      if (!docs.has(docPath)) throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 });
      write(docPath, data, { merge: true });
    },
    delete: async () => {
      docs.delete(docPath);
    },
  };
}
adminFirestore.getFirestore = () => ({
  collection: (name) => ({ doc: (id) => docRef(name, id) }),
  runTransaction: async (fn) =>
    fn({
      get: (ref) => ref.get(),
      set: (ref, data, options) => write(ref.path, data, options),
    }),
});

const gmailAuth = require('../dist/gmail/auth');
const cardNotice = require('../dist/gmail/cardNotice');
const { handleGmailPubSub } = require('../dist/gmail/handler');

// --- Gmail の偽物 ---
/** history.list の応答の historyId（メールボックスの現在位置）。応答にはメッセージを 1 通入れる */
let mailbox = '600';
/** getProfile の historyId（history.list が 404 のときの現在位置） */
let profileHistoryId = '5000';
/** 次の history.list で投げる例外 */
let historyError = null;
/** history.list に渡した引数・getProfile と messages.get を呼んだ回数 */
const historyListCalls = [];
let profileCalls = 0;
let messageGetCalls = 0;
gmailAuth.getGmailClient = async () => ({
  users: {
    history: {
      list: async (params) => {
        historyListCalls.push(params);
        if (historyError) {
          const error = historyError;
          historyError = null;
          throw error;
        }
        return { data: { history: [{ messagesAdded: [{ message: { id: 'msg-hp-0001' } }] }], historyId: mailbox } };
      },
    },
    getProfile: async () => {
      profileCalls++;
      return { data: { historyId: profileHistoryId } };
    },
    messages: {
      get: async () => {
        messageGetCalls++;
        throw new Error('not expected');
      },
    },
  },
});
// メールの処理は送信待ちの印で終える（保存済みで、カードを送り直した扱い。messages.get まで行かない）
let processedMessages = 0;
cardNotice.deliverPendingCardNotice = async () => {
  processedMessages++;
  return 'sent';
};
cardNotice.discardCardNotices = async () => {};

// --- 呼び出しとログ ---
let lines = [];
/** handleGmailPubSub を 1 回呼ぶ（本文は Gmail の形 { emailAddress, historyId } の base64）。投げたら例外を、投げなければ 'ok' を返す */
async function handle(historyId) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  lines = [];
  for (const level of Object.keys(original)) {
    console[level] = (...args) => lines.push({ level, args, text: util.format(...args) });
  }
  try {
    await handleGmailPubSub(Buffer.from(JSON.stringify({ emailAddress: 'someone@example.com', historyId })).toString('base64'));
    return 'ok';
  } catch (error) {
    return error;
  } finally {
    Object.assign(console, original);
  }
}
const logText = () => lines.map((l) => `${l.level} ${l.text}`).join('\n');
const findLine = (message) => lines.find((l) => l.args[0] === message);
const warns = () => lines.filter((l) => l.level === 'warn');

/** system/gmailState の historyId（無ければ undefined） */
const storedHistoryId = () => (docs.get('system/gmailState') || {}).historyId;
/** 保存値を置き直し、呼び出しの記録を消す */
function reset(historyId, { mailboxPosition = '600' } = {}) {
  docs.clear();
  docs.set('system/gmailState', { historyId, watchExpiration: Date.now() + 86400000 });
  mailbox = mailboxPosition;
  profileHistoryId = '5000';
  historyError = null;
  historyListCalls.length = 0;
  profileCalls = 0;
  messageGetCalls = 0;
  processedMessages = 0;
}

const FORGED = '18446744073709551615';
const ROLLBACK_LOG = 'Skipping historyId rollback';
const PROCESSED_LOG = 'Processed Gmail messages; updated historyId';
const UNUSABLE_LOG = 'Stored Gmail historyId is not usable; skipping without calling Gmail';
const SKIP_AHEAD_LOG = 'Gmail historyId is too old (Gmail keeps ~1 week); skipping ahead, and mail in between is NOT imported';

async function main() {
  console.log('\n[通知の historyId がどの値でも、保存するのは現在位置（保存値 100 < 現在位置 600）]');
  for (const [label, historyId] of [
    ['正当な通知（現在位置と同じ値の数値。Gmail の形）', 600],
    ['偽の通知: 極端に大きい（uint64 の最大）', FORGED],
    ['偽の通知: 現在位置より大きい', '601'],
    ['偽の通知: 保存値と現在位置の間', '300'],
    ['偽の通知: 保存値と同じ', '100'],
    ['偽の通知: 保存値より小さい', '1'],
    ['偽の通知: ゼロ（文字列）', '0'],
    ['偽の通知: ゼロ（数値）', 0],
  ]) {
    reset('100');
    const r = await handle(historyId);
    check(
      `${label}: 保存値から処理し、保存値を現在位置（"600"。文字列）にする`,
      r === 'ok' && historyListCalls.length === 1 && historyListCalls[0].startHistoryId === '100' && processedMessages === 1 && storedHistoryId() === '600',
      { r: String(r), startHistoryId: historyListCalls[0] && historyListCalls[0].startHistoryId, stored: storedHistoryId() }
    );
    const processed = findLine(PROCESSED_LOG);
    check(`${label}: 警告を出さず、更新のログは保存した値（現在位置）`, warns().length === 0 && processed && processed.args[1].historyId === '600', logText());
  }

  console.log('\n[先頭ゼロの通知は読めない通知として捨てる（保存値は変えない）]');
  for (const [label, historyId] of [
    ['先頭ゼロ（"0000600"）', '0000600'],
    ['長いゼロ埋め（"0"×100000 + "600"）', '0'.repeat(100000) + '600'],
  ]) {
    reset('100');
    const r = await handle(historyId);
    check(
      `${label}: 投げずに捨て、history.list を呼ばず、保存値（100）を変えない`,
      r === 'ok' && historyListCalls.length === 0 && storedHistoryId() === '100',
      { r: String(r), calls: historyListCalls.length, stored: storedHistoryId() }
    );
  }

  console.log('\n[現在位置が保存値以下なら進めない（巻き戻さない）。そのログは固定文と桁数だけ]');
  reset('600', { mailboxPosition: '600' });
  let r = await handle('700');
  check('現在位置 = 保存値（600）: 保存値を変えない（通知の 700 へも進めない）', r === 'ok' && storedHistoryId() === '600', { r: String(r), stored: storedHistoryId() });
  reset('900', { mailboxPosition: '600' });
  r = await handle(FORGED);
  check('現在位置（600）< 保存値（900）: 巻き戻さない（偽の大きい通知でも進めない）', r === 'ok' && storedHistoryId() === '900', { r: String(r), stored: storedHistoryId() });
  const rollback = findLine(ROLLBACK_LOG);
  check(
    '巻き戻しを飛ばしたログは固定文 + 桁数（currentDigits・incomingDigits）だけで、値を出さない',
    rollback && rollback.args.length === 2 && JSON.stringify(rollback.args[1]) === JSON.stringify({ currentDigits: 3, incomingDigits: 3 }) && !/900|600/.test(rollback.text),
    logText()
  );

  console.log('\n[数値で保存されている値（#278）も使い、現在位置を文字列で保存する]');
  reset(100);
  r = await handle(200);
  check(
    '保存値が数値 100: history.list に "100" を渡し、現在位置を文字列（"600"）で保存する',
    r === 'ok' && historyListCalls.length === 1 && historyListCalls[0].startHistoryId === '100' && storedHistoryId() === '600',
    { r: String(r), startHistoryId: historyListCalls[0] && historyListCalls[0].startHistoryId, stored: storedHistoryId() }
  );

  console.log('\n[保存してある historyId が使えない形: Gmail API を呼ばずに終える（投げない・値を出さない）]');
  for (const [label, historyId] of [
    ['先頭ゼロ', '0000000000000000000000077777'],
    ['21 桁', '177777777777777777777'],
    ['uint64 を超える 20 桁', '18446744073709577777'],
    ['数字以外を含む', 'abc77777'],
    ['負の数', -77777],
    ['小数', 77777.5],
    ['uint64 を超える数値', 7.7777e24],
  ]) {
    reset(historyId);
    r = await handle('600');
    check(
      `保存値が${label}: 投げず、history.list・getProfile・messages.get を呼ばず、保存値を変えない`,
      r === 'ok' && historyListCalls.length === 0 && profileCalls === 0 && messageGetCalls === 0 && processedMessages === 0 && storedHistoryId() === historyId,
      { r: String(r), list: historyListCalls.length, profile: profileCalls, stored: String(storedHistoryId()).slice(0, 30) }
    );
    check(
      `保存値が${label}: 警告は固定文 1 行だけで、保存値を出さない`,
      warns().length === 1 && warns()[0].args.length === 1 && warns()[0].args[0] === UNUSABLE_LOG && !logText().includes('7777'),
      logText()
    );
  }

  console.log('\n[history.list が 404: getProfile の現在位置を保存する。先へ飛ばしたログは固定文と桁数だけ]');
  reset('100');
  historyError = Object.assign(new Error('Requested entity was not found.'), { code: 404 });
  profileHistoryId = '5000';
  r = await handle('300');
  check('404: getProfile の現在位置（"5000"）を保存する（通知の 300 ではない）', r === 'ok' && profileCalls === 1 && storedHistoryId() === '5000', { r: String(r), stored: storedHistoryId() });
  const skip = findLine(SKIP_AHEAD_LOG);
  check(
    '404: 先へ飛ばしたログは固定文 + 桁数（fromDigits・toDigits）だけで、保存値・現在位置・通知の値を出さない',
    skip && skip.level === 'error' && JSON.stringify(skip.args[1]) === JSON.stringify({ fromDigits: 3, toDigits: 4 }) && !/5000|100|300/.test(skip.text),
    skip && skip.text
  );
  reset('9000');
  historyError = Object.assign(new Error('Requested entity was not found.'), { code: 404 });
  profileHistoryId = '5000';
  r = await handle(FORGED);
  check('404・getProfile の現在位置（5000）< 保存値（9000）: 巻き戻さない', r === 'ok' && storedHistoryId() === '9000', { r: String(r), stored: storedHistoryId() });
  check('そのログにも値を出さない', !/9000|5000/.test(logText()), logText());

  console.log(failed === 0 ? '\nすべて通過' : `\n${failed} 件失敗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.log('  FAIL チェックが例外で止まった', error && error.stack);
  process.exit(1);
});
