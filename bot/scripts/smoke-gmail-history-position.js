/**
 * 取込（handleGmailPubSub）が保存する historyId のスモークテスト（#298・#300。Firestore・Gmail には接続しない）
 *
 * watch.ts の getWatchState・updateHistoryId・replaceUnusableHistoryId は本物を使い、Firestore（system/gmailState）だけを
 * メモリ上の偽物にする。Gmail（history.list・getProfile）と送信待ちの印（cardNotice.ts）は偽物。
 *
 * - 保存するのは常にメールボックスの現在位置（history.list の応答の historyId。正規の形の文字列）。通知の historyId は使わない:
 *   偽の通知（極端に大きい・現在位置より大きい・保存値と現在位置の間・保存値と同じ・保存値より小さい・ゼロ）のどれでも、
 *   保存値は現在位置になる。先頭ゼロの通知は読めない通知として捨てる（Gmail を呼ばず、保存値も変えない）
 * - 複数ページのときは、最初のページの historyId を保存する（#300。後のページの値は使わない。最初のページに無ければ進めない）
 * - 現在位置が保存値と同じ（新着なし）なら進めない（警告なし）。同時に走った実行が先に進めていたら巻き戻さない
 *   （updateHistoryId は前進のみ。そのログは固定文と桁数だけ）
 * - 現在位置が実行の開始位置（保存値）より前なら、固定文の警告（桁数だけ）を出して書かない（#300。history.list・404 の両方）。
 *   uint64 の最大値の近く（Number では区別できない値）でも BigInt で比べる
 * - 保存値が '0'・uint64 の最大値でも、そのまま history.list に渡して取込を続ける
 * - 数値で保存されている値（#278）も使い、現在位置を文字列で保存する
 * - 保存してある historyId が使えない形（先頭ゼロ・21 桁・uint64 超・数字以外・負の数・小数）なら、投げず、history.list を
 *   呼ばず、getProfile の現在位置に置き換えて終える（#300）。置き換えるのはトランザクションの中で保存値がまだ使えない形のときだけ
 *   （先に直っていた・消えていたら書かない）。getProfile の失敗・historyId が無いときは投げずに警告で終える。ログに値を出さない
 * - history.list が 404 のときは getProfile の現在位置を保存する。先へ飛ばしたログは固定文と桁数だけ
 * - 置き換え・404 で印を消す対象（失敗の記録）は、historyId の書き込みを確定させる前に読む（確定の後に、新しい位置から始めた
 *   ほかの実行が記録した失敗の印は消さない）
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
/** 次のトランザクションを確定させた直後に 1 回だけ呼ぶ（確定の後に、ほかの実行が書き込むのを再現する） */
let afterNextTransaction = null;
adminFirestore.getFirestore = () => ({
  collection: (name) => ({ doc: (id) => docRef(name, id) }),
  runTransaction: async (fn) => {
    const result = await fn({
      get: (ref) => ref.get(),
      set: (ref, data, options) => write(ref.path, data, options),
    });
    if (afterNextTransaction) {
      const hook = afterNextTransaction;
      afterNextTransaction = null;
      await hook();
    }
    return result;
  },
});

const gmailAuth = require('../dist/gmail/auth');
const cardNotice = require('../dist/gmail/cardNotice');
const { handleGmailPubSub } = require('../dist/gmail/handler');
const { updateHistoryId } = require('../dist/gmail/watch');

// --- Gmail の偽物 ---
/** history.list の応答の historyId（メールボックスの現在位置）。応答にはメッセージを 1 通入れる */
let mailbox = '600';
/** 複数ページの history.list（[{ historyId?, ids }]。null なら mailbox の 1 ページ）。pageToken はページの番号 */
let pages = null;
/** getProfile の historyId（history.list が 404 のときと、保存値が使えない形のときの現在位置）。undefined なら応答に入れない */
let profileHistoryId = '5000';
/** 次の history.list・getProfile で投げる例外 */
let historyError = null;
let profileError = null;
/** history.list・getProfile の応答を返す直前に呼ぶ（同時に走った実行・watch の更新・revoke の書き込みを再現する） */
let beforeHistoryReply = null;
let beforeProfileReply = null;
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
        if (beforeHistoryReply) beforeHistoryReply();
        if (pages) {
          const index = params.pageToken ? Number(params.pageToken) : 0;
          const page = pages[index];
          return {
            data: {
              history: [{ messagesAdded: page.ids.map((id) => ({ message: { id } })) }],
              ...(page.historyId === undefined ? {} : { historyId: page.historyId }),
              ...(index + 1 < pages.length ? { nextPageToken: String(index + 1) } : {}),
            },
          };
        }
        return { data: { history: [{ messagesAdded: [{ message: { id: 'msg-hp-0001' } }] }], historyId: mailbox } };
      },
    },
    getProfile: async () => {
      profileCalls++;
      if (profileError) throw profileError;
      if (beforeProfileReply) beforeProfileReply();
      return { data: profileHistoryId === undefined ? {} : { historyId: profileHistoryId } };
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
/** discardCardNotices を呼んだ理由（先へ飛ばした・置き換えたときだけ呼ぶ）と、渡した messageId（呼んだ順） */
const discardCalls = [];
const discardIds = [];
cardNotice.discardCardNotices = async (ids, reason) => {
  discardCalls.push(reason);
  discardIds.push([...ids]);
};

// --- 呼び出しとログ ---
let lines = [];
/** fn を呼び、ログを lines に集める。投げたら例外を、投げなければ 'ok' を返す */
async function capture(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  lines = [];
  for (const level of Object.keys(original)) {
    console[level] = (...args) => lines.push({ level, args, text: util.format(...args) });
  }
  try {
    await fn();
    return 'ok';
  } catch (error) {
    return error;
  } finally {
    Object.assign(console, original);
  }
}
/** handleGmailPubSub を 1 回呼ぶ（本文は Gmail の形 { emailAddress, historyId } の base64） */
const handle = (historyId) =>
  capture(() => handleGmailPubSub(Buffer.from(JSON.stringify({ emailAddress: 'someone@example.com', historyId })).toString('base64')));
const logText = () => lines.map((l) => `${l.level} ${l.text}`).join('\n');
const findLine = (message) => lines.find((l) => l.args[0] === message);
const warns = () => lines.filter((l) => l.level === 'warn');
const errors = () => lines.filter((l) => l.level === 'error');

/** system/gmailState の中身・historyId（無ければ undefined） */
const gmailState = () => docs.get('system/gmailState');
const storedHistoryId = () => (gmailState() || {}).historyId;
const WATCH_EXPIRATION = Date.now() + 86400000;
/** 保存値を置き直し、呼び出しの記録を消す */
function reset(historyId, { mailboxPosition = '600' } = {}) {
  docs.clear();
  docs.set('system/gmailState', { historyId, watchExpiration: WATCH_EXPIRATION, emailAddress: 'someone@example.com' });
  mailbox = mailboxPosition;
  pages = null;
  profileHistoryId = '5000';
  historyError = null;
  profileError = null;
  beforeHistoryReply = null;
  beforeProfileReply = null;
  historyListCalls.length = 0;
  profileCalls = 0;
  messageGetCalls = 0;
  processedMessages = 0;
  discardCalls.length = 0;
  discardIds.length = 0;
  afterNextTransaction = null;
}

const FORGED = '18446744073709551615';
const UINT64_MAX = FORGED;
const UINT64_MAX_MINUS_1 = '18446744073709551614';
const UINT64_MAX_MINUS_2 = '18446744073709551613';
const ROLLBACK_LOG = 'Skipping historyId rollback';
const PROCESSED_LOG = 'Processed Gmail messages; updated historyId';
const AHEAD_LOG =
  'Stored Gmail historyId is ahead of the mailbox; nothing is imported until it is reset (reset it only if this repeats on later notifications; see GMAIL_AUTO_SPEC 11.2)';
const MISSING_LOG = 'Gmail did not return the mailbox historyId; keeping the saved historyId (the range is processed again on the next notification)';
const REPLACED_LOG = 'Stored Gmail historyId was not usable; replaced it with the mailbox position, and mail before it is NOT imported';
const PROFILE_FAILED_LOG = 'Stored Gmail historyId is not usable and getProfile failed; keeping it (retried on the next notification)';
const PROFILE_MISSING_LOG = 'Stored Gmail historyId is not usable and getProfile returned no historyId; keeping it (retried on the next notification)';
const ALREADY_REPLACED_LOG = 'Stored Gmail historyId was already replaced or removed; skipping';
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

  console.log('\n[複数ページ: 最初のページの historyId を保存する（#300）]');
  reset('100');
  pages = [{ historyId: '700', ids: ['msg-hp-0001'] }, { historyId: '800', ids: ['msg-hp-0002'] }];
  let r = await handle('900');
  check(
    '2 ページ（700・800）: 両方のページのメールを処理し、最初のページの historyId（"700"）を保存する（最後のページの 800 ではない）',
    r === 'ok' && historyListCalls.length === 2 && processedMessages === 2 && storedHistoryId() === '700',
    { r: String(r), calls: historyListCalls.length, processed: processedMessages, stored: storedHistoryId() }
  );
  check('2 ページ: どちらのページの要求も保存値（100）から', historyListCalls.every((c) => c.startHistoryId === '100'), historyListCalls);
  reset('100');
  pages = [{ ids: ['msg-hp-0001'] }, { historyId: '800', ids: [] }];
  r = await handle('900');
  check(
    '最初のページに historyId が無い: 後のページの値（800）は使わず、保存値（100）を変えない',
    r === 'ok' && storedHistoryId() === '100' && JSON.stringify(warns().map((l) => l.args)) === JSON.stringify([[MISSING_LOG, { source: 'history.list' }]]),
    { r: String(r), stored: storedHistoryId(), log: logText() }
  );
  reset('750');
  pages = [{ historyId: '700', ids: [] }, { historyId: '800', ids: [] }];
  r = await handle('900');
  check(
    '最初のページ（700）< 保存値（750）< 最後のページ（800）: 現在位置より先の保存値として警告し、800 へも進めない',
    r === 'ok' && storedHistoryId() === '750' && warns().length === 1 && warns()[0].args[0] === AHEAD_LOG,
    { r: String(r), stored: storedHistoryId(), log: logText() }
  );

  console.log('\n[現在位置 = 保存値（新着なし）は正常。同時に走った実行が先に進めていたら巻き戻さない]');
  reset('600', { mailboxPosition: '600' });
  r = await handle('700');
  check(
    '現在位置 = 保存値（600）: 保存値を変えず（通知の 700 へも進めない）、警告を出さない',
    r === 'ok' && storedHistoryId() === '600' && warns().length === 0 && !findLine(AHEAD_LOG),
    { r: String(r), stored: storedHistoryId(), log: logText() }
  );
  reset(UINT64_MAX, { mailboxPosition: UINT64_MAX });
  r = await handle('700');
  check(
    '保存値 = 現在位置 = uint64 の最大値: history.list にそのまま渡し、保存値を変えず、警告を出さない',
    r === 'ok' && historyListCalls.length === 1 && historyListCalls[0].startHistoryId === UINT64_MAX && storedHistoryId() === UINT64_MAX && warns().length === 0,
    { r: String(r), stored: storedHistoryId(), log: logText() }
  );
  // 同時に走った実行: この実行が history.list を待つ間に、ほかの実行が保存値を 900 へ進めた。この実行の現在位置（600）は
  // 開始位置（100）より後なので先の保存値の警告は出さず、updateHistoryId が巻き戻しを飛ばす
  reset('100', { mailboxPosition: '600' });
  beforeHistoryReply = () => write('system/gmailState', { historyId: '900' }, { merge: true });
  r = await handle('600');
  check(
    '同時に走った実行が先に 900 へ進めた（この実行の現在位置 600）: 巻き戻さず、先の保存値の警告は出さない',
    r === 'ok' && storedHistoryId() === '900' && warns().length === 0 && !findLine(AHEAD_LOG),
    { r: String(r), stored: storedHistoryId(), log: logText() }
  );
  const rollback = findLine(ROLLBACK_LOG);
  check(
    '巻き戻しを飛ばしたログは固定文 + 桁数（currentDigits・incomingDigits）だけで、値を出さない',
    rollback && rollback.args.length === 2 && JSON.stringify(rollback.args[1]) === JSON.stringify({ currentDigits: 3, incomingDigits: 3 }) && !/900|600/.test(rollback.text),
    logText()
  );

  console.log('\n[現在位置が開始位置（保存値）より前: 固定文の警告を出して書かない（#300）]');
  reset('900', { mailboxPosition: '600' });
  r = await handle(FORGED);
  check('現在位置（600）< 保存値（900）: 投げず、巻き戻さない', r === 'ok' && storedHistoryId() === '900', { r: String(r), stored: storedHistoryId() });
  let ahead = findLine(AHEAD_LOG);
  check(
    '現在位置 < 保存値: 警告は固定文 + source・桁数だけ（1 行）で、値を出さない',
    ahead &&
      ahead.level === 'warn' &&
      warns().length === 1 &&
      JSON.stringify(ahead.args[1]) === JSON.stringify({ source: 'history.list', storedDigits: 3, mailboxDigits: 3 }) &&
      !/900|600/.test(ahead.text),
    logText()
  );
  check(
    '現在位置 < 保存値: 巻き戻しのログ・更新のログを出さない（同時実行による正当なスキップと見分けられる）',
    !findLine(ROLLBACK_LOG) && !findLine(PROCESSED_LOG),
    logText()
  );
  // uint64 の最大値の近く: Number では同じ値になるので、BigInt で比べないと見逃す
  reset(UINT64_MAX, { mailboxPosition: UINT64_MAX_MINUS_1 });
  r = await handle('700');
  ahead = findLine(AHEAD_LOG);
  check(
    '保存値 uint64 の最大値・現在位置がその 1 つ前: 先の保存値として警告し（桁数だけ）、保存値を変えない',
    r === 'ok' &&
      storedHistoryId() === UINT64_MAX &&
      ahead &&
      JSON.stringify(ahead.args[1]) === JSON.stringify({ source: 'history.list', storedDigits: 20, mailboxDigits: 20 }) &&
      !logText().includes('1844674407370955161'),
    { r: String(r), stored: storedHistoryId(), log: logText() }
  );

  console.log('\n[保存値が "0"・uint64 の最大値の近くでも、そのまま取込を続ける]');
  reset('0', { mailboxPosition: '600' });
  r = await handle('600');
  check(
    '保存値 "0": history.list に "0" を渡し、現在位置（"600"）を保存する（警告なし）',
    r === 'ok' && historyListCalls.length === 1 && historyListCalls[0].startHistoryId === '0' && storedHistoryId() === '600' && warns().length === 0,
    { r: String(r), startHistoryId: historyListCalls[0] && historyListCalls[0].startHistoryId, stored: storedHistoryId(), log: logText() }
  );
  // Number では uint64 の最大値とその 1 つ前が同じ値になる（前進を見逃す）ので、BigInt で比べていることを確かめる
  reset(UINT64_MAX_MINUS_1, { mailboxPosition: UINT64_MAX });
  r = await handle('600');
  check(
    '保存値が uint64 の最大値の 1 つ前・現在位置が最大値: 最大値（"18446744073709551615"）へ進める',
    r === 'ok' && historyListCalls[0].startHistoryId === UINT64_MAX_MINUS_1 && storedHistoryId() === UINT64_MAX && warns().length === 0,
    { r: String(r), stored: storedHistoryId(), log: logText() }
  );

  console.log('\n[updateHistoryId（本物）: uint64 の最大値の近くでも前進のみ]');
  reset(UINT64_MAX);
  await capture(() => updateHistoryId(UINT64_MAX_MINUS_1));
  check('保存値 uint64 の最大値に 1 つ前を書こうとしても巻き戻さない', storedHistoryId() === UINT64_MAX, storedHistoryId());
  check('そのログは固定文 + 桁数だけ', JSON.stringify(findLine(ROLLBACK_LOG) && findLine(ROLLBACK_LOG).args) === JSON.stringify([ROLLBACK_LOG, { currentDigits: 20, incomingDigits: 20 }]), logText());
  reset(UINT64_MAX_MINUS_2);
  await capture(() => updateHistoryId(UINT64_MAX_MINUS_1));
  check('保存値 最大値の 2 つ前 → 1 つ前へは進める（Number では同じ値）', storedHistoryId() === UINT64_MAX_MINUS_1, storedHistoryId());
  await capture(() => updateHistoryId(UINT64_MAX));
  check('1 つ前 → 最大値へも進める', storedHistoryId() === UINT64_MAX, storedHistoryId());

  console.log('\n[数値で保存されている値（#278）も使い、現在位置を文字列で保存する]');
  reset(100);
  r = await handle(200);
  check(
    '保存値が数値 100: history.list に "100" を渡し、現在位置を文字列（"600"）で保存する',
    r === 'ok' && historyListCalls.length === 1 && historyListCalls[0].startHistoryId === '100' && storedHistoryId() === '600',
    { r: String(r), startHistoryId: historyListCalls[0] && historyListCalls[0].startHistoryId, stored: storedHistoryId() }
  );

  console.log('\n[保存してある historyId が使えない形: history.list を呼ばず、getProfile の現在位置に置き換える（#300）]');
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
    profileHistoryId = '5000';
    r = await handle('600');
    check(
      `保存値が${label}: 投げず、getProfile を 1 回呼び、history.list・messages.get を呼ばず、保存値を getProfile の現在位置（"5000"）にする`,
      r === 'ok' && profileCalls === 1 && historyListCalls.length === 0 && messageGetCalls === 0 && processedMessages === 0 && storedHistoryId() === '5000',
      { r: String(r), list: historyListCalls.length, profile: profileCalls, stored: String(storedHistoryId()).slice(0, 30) }
    );
    check(
      `保存値が${label}: historyId と updatedAt のほかは変えない（watchExpiration・emailAddress は残す）`,
      gmailState().watchExpiration === WATCH_EXPIRATION && gmailState().emailAddress === 'someone@example.com' && gmailState().updatedAt !== undefined,
      Object.keys(gmailState())
    );
    check(
      `保存値が${label}: 置き換えたことを固定文 1 行（error）で出し、警告は出さず、保存値・現在位置を出さない`,
      errors().length === 1 && errors()[0].args.length === 1 && errors()[0].args[0] === REPLACED_LOG && warns().length === 0 && !logText().includes('7777') && !logText().includes('5000'),
      logText()
    );
    check(`保存値が${label}: 飛ばした範囲のメールの印を消す（404 と同じ）`, JSON.stringify(discardCalls) === JSON.stringify(['history_skipped']), discardCalls);
  }

  reset('0001000');
  profileHistoryId = 5000;
  r = await handle('600');
  check('getProfile の historyId が数値: 10 進の文字列（"5000"）で置き換える', r === 'ok' && storedHistoryId() === '5000', { r: String(r), stored: storedHistoryId() });

  // 置き換えた後は、その位置から取込を続ける
  mailbox = '6000';
  historyListCalls.length = 0;
  r = await handle('6000');
  check(
    '置き換えた後の通知: 置き換えた位置（"5000"）から history.list を引き、現在位置（"6000"）まで進む',
    r === 'ok' && historyListCalls.length === 1 && historyListCalls[0].startHistoryId === '5000' && storedHistoryId() === '6000',
    { r: String(r), calls: historyListCalls, stored: storedHistoryId() }
  );

  console.log('\n[使えない形の保存値で getProfile が失敗する・historyId を返さない: 投げずに警告で終える（保存値は変えない）]');
  reset('0001000');
  profileError = Object.assign(new Error('Backend Error'), { code: 503, status: 503 });
  r = await handle('600');
  check(
    'getProfile が失敗: 投げず（再送させない）、history.list を呼ばず、保存値を変えない',
    r === 'ok' && profileCalls === 1 && historyListCalls.length === 0 && storedHistoryId() === '0001000' && discardCalls.length === 0,
    { r: String(r), stored: storedHistoryId() }
  );
  check(
    'getProfile が失敗: 警告は固定文 + 例外の種類（文言なし）の 1 行',
    warns().length === 1 &&
      JSON.stringify(warns()[0].args) === JSON.stringify([PROFILE_FAILED_LOG, { errorName: 'Error', errorCode: 503, errorStatus: 503 }]) &&
      !logText().includes('Backend Error') &&
      errors().length === 0,
    logText()
  );
  for (const [label, value] of [
    ['返さない', undefined],
    ['使えない形（先頭ゼロ）', '0005000'],
  ]) {
    reset('0001000');
    profileHistoryId = value;
    r = await handle('600');
    check(
      `getProfile の historyId を${label}: 投げず、保存値を変えず、固定文の警告 1 行だけ`,
      r === 'ok' &&
        storedHistoryId() === '0001000' &&
        historyListCalls.length === 0 &&
        JSON.stringify(warns().map((l) => l.args)) === JSON.stringify([[PROFILE_MISSING_LOG]]) &&
        errors().length === 0 &&
        discardCalls.length === 0,
      { r: String(r), stored: storedHistoryId(), log: logText() }
    );
  }

  console.log('\n[置き換えはトランザクションの中で保存値がまだ使えない形のときだけ（先に直っていた・消えていたら書かない）]');
  // getProfile を待つ間に、watch の更新が保存値を watch の応答（700）に置き換えた
  reset('0001000');
  beforeProfileReply = () => write('system/gmailState', { historyId: '700' }, { merge: true });
  r = await handle('600');
  check(
    'getProfile の間に watch の更新が 700 に置き換えた: 5000 で上書きせず、印も消さない',
    r === 'ok' && storedHistoryId() === '700' && discardCalls.length === 0 && errors().length === 0 && JSON.stringify(findLine(ALREADY_REPLACED_LOG) && findLine(ALREADY_REPLACED_LOG).args) === JSON.stringify([ALREADY_REPLACED_LOG]),
    { r: String(r), stored: storedHistoryId(), log: logText() }
  );
  // getProfile を待つ間に、/gmail/revoke が文書を消した
  reset('0001000');
  beforeProfileReply = () => docs.delete('system/gmailState');
  r = await handle('600');
  check('getProfile の間に revoke が文書を消した: 作り直さない', r === 'ok' && !docs.has('system/gmailState') && discardCalls.length === 0, { r: String(r), docs: [...docs.keys()] });
  // getProfile を待つ間に、§11.2 の手順で historyId が消された（次の watch の登録が入れる）
  reset('0001000');
  beforeProfileReply = () => write('system/gmailState', { historyId: FieldValue.delete() }, { merge: true });
  r = await handle('600');
  check('getProfile の間に historyId が消された: 書かない', r === 'ok' && storedHistoryId() === undefined && discardCalls.length === 0, { r: String(r), state: gmailState() });

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
  check('404: 飛ばした範囲のメールの印を消す', JSON.stringify(discardCalls) === JSON.stringify(['history_skipped']), discardCalls);

  reset('9000');
  historyError = Object.assign(new Error('Requested entity was not found.'), { code: 404 });
  profileHistoryId = '5000';
  r = await handle(FORGED);
  check('404・getProfile の現在位置（5000）< 保存値（9000）: 巻き戻さない', r === 'ok' && storedHistoryId() === '9000', { r: String(r), stored: storedHistoryId() });
  ahead = findLine(AHEAD_LOG);
  check(
    '404・現在位置 < 保存値: 古すぎるのではなく先の保存値として警告し（source: getProfile・桁数だけ）、先へ飛ばしたログを出さない',
    ahead && JSON.stringify(ahead.args[1]) === JSON.stringify({ source: 'getProfile', storedDigits: 4, mailboxDigits: 4 }) && !findLine(SKIP_AHEAD_LOG) && errors().length === 0,
    logText()
  );
  check('404・現在位置 < 保存値: 印を消さない', discardCalls.length === 0, discardCalls);
  check('そのログにも値を出さない', !/9000|5000/.test(logText()), logText());

  reset('5000');
  historyError = Object.assign(new Error('Requested entity was not found.'), { code: 404 });
  profileHistoryId = '5000';
  r = await handle('5000');
  check(
    '404・getProfile の現在位置 = 保存値: 先の保存値の警告は出さない（同じ位置は正常）',
    r === 'ok' && storedHistoryId() === '5000' && !findLine(AHEAD_LOG),
    { r: String(r), stored: storedHistoryId(), log: logText() }
  );

  console.log('\n[印を消す対象（失敗の記録）は、historyId の書き込みを確定させる前に読む]');
  // 確定の直後に、新しい位置から始めたほかの実行がメールの失敗を記録した（そのメールは新しい位置より後で、再処理される）
  const recordFailureAfterCommit = () => write('system/gmailFailures', { 'msg-new-0002': { attempts: 1 } }, { merge: true });
  reset('0001000');
  docs.set('system/gmailFailures', { 'msg-old-0001': { attempts: 1 } });
  afterNextTransaction = recordFailureAfterCommit;
  r = await handle('600');
  check(
    '保存値が使えない形で置き換えた: 確定の前の失敗の記録（msg-old-0001）の印だけを消し、確定の後に記録された失敗（msg-new-0002）の印は消さない',
    r === 'ok' && storedHistoryId() === '5000' && JSON.stringify(discardIds) === JSON.stringify([['msg-old-0001']]),
    { r: String(r), stored: storedHistoryId(), discardIds }
  );
  reset('100');
  docs.set('system/gmailFailures', { 'msg-old-0001': { attempts: 1 } });
  historyError = Object.assign(new Error('Requested entity was not found.'), { code: 404 });
  profileHistoryId = '5000';
  afterNextTransaction = recordFailureAfterCommit;
  r = await handle('300');
  check(
    '404 で先へ飛ばした: 確定の前の失敗の記録（msg-old-0001）の印だけを消し、確定の後に記録された失敗（msg-new-0002）の印は消さない',
    r === 'ok' && storedHistoryId() === '5000' && JSON.stringify(discardIds) === JSON.stringify([['msg-old-0001']]),
    { r: String(r), stored: storedHistoryId(), discardIds }
  );

  console.log(failed === 0 ? '\nすべて通過' : `\n${failed} 件失敗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.log('  FAIL チェックが例外で止まった', error && error.stack);
  process.exit(1);
});
