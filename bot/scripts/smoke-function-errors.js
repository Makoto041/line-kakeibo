/**
 * 関数の外（実行環境）へ投げる例外に、元の例外の文言が残らないことのスモークテスト（#285 の 3。Firestore・Gmail・LINE には接続しない）
 *
 * 関数の外へ投げた例外は、実行環境が文言ごとログに出す（functions-framework は `console.error(err.stack || err)`、
 * firebase-functions のスケジュール関数は `logger.error(err.message)`）。そのため、元の例外の種類を errorFields でログに出してから、
 * 固定文の Error を投げる（docs/SECURITY_OPERATIONS.md §9）。目印（CANARY）を元の例外の文言・ヘッダー・応答に入れて、次を確かめる。
 *
 * - gmail/handler.ts の handleGmailPubSub: 固定文 + エラーの種類のログを出してから、固定文の Error（GmailImportError）を投げる。
 *   投げる Error の name・message・stack・util.inspect に目印が無い。functions-framework が出す形（logger.js の sendCrashResponse）にも無い
 * - 再送の判定は変えない（#281）: 一時的な失敗（getGmailClient・history.list の 503、メールの処理の失敗で諦める前）は投げ、
 *   やり直しても直らないとき（Gmail のトークンが無い・watch の状態が無い・諦めた・history.list の 404）は投げない
 * - 失敗の記録（system/gmailFailures）に文言を保存しない（以前の lastError を消し、errorName・errorCode・errorCause・errorStatus だけを書く）
 * - 実行環境を通した呼び出し（別のプロセス。出力をすべて捕まえる）:
 *   functions-framework（CloudEvent）→ gmailPubSubHandler の失敗、firebase-functions の包みを通した renewGmailWatch・postRecurringExpenses の失敗で、
 *   出力に目印が無く、失敗の状態（500）で返す（再送・再試行が働く）こと
 *
 *   node bot/scripts/smoke-function-errors.js
 */
const path = require('path');
const util = require('util');
const { spawnSync } = require('child_process');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

const BOT_DIR = path.join(__dirname, '..');
const fromBot = (name) => require(require.resolve(name, { paths: [BOT_DIR] }));
/** functions-framework の内部のファイル（package.json の exports が深いパスを許さないので、本体の場所から引く） */
const ffFile = (name) => path.join(path.dirname(require.resolve('@google-cloud/functions-framework', { paths: [BOT_DIR] })), name);

// 目印。例外の文言・ヘッダー・応答の本文・失敗の記録の以前の文言に入れ、ログ・投げる例外・保存する値に出ないことを確かめる
const CANARY = '秘密CANARY';
const hasCanary = (text) => String(text).includes('CANARY');

/** Firestore の UNAVAILABLE（文言と details に文書のパスが入る） */
const firestoreError = () =>
  Object.assign(new Error(`14 UNAVAILABLE: projects/demo/databases/(default)/documents/groupMembers/G_${CANARY}`), {
    code: 14,
    details: `documents/groupMembers/G_${CANARY}`,
  });
/** gaxios の失敗（送ったリクエストの設定にアクセストークン、応答に本文が入る） */
const gaxiosError = (status) =>
  Object.assign(new Error(`Request failed ${CANARY}`), {
    name: 'GaxiosError',
    status,
    code: status,
    config: { headers: { Authorization: `Bearer ya29.${CANARY}` } },
    response: { data: { error: { message: CANARY } } },
  });

// --- ログの捕捉（画面には出さない。util.format で console が出す形にする） ---
let lines = [];
async function capture(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  lines = [];
  for (const level of Object.keys(original)) {
    console[level] = (...args) => lines.push({ level, args, text: util.format(...args) });
  }
  try {
    return await fn();
  } finally {
    Object.assign(console, original);
  }
}
const allText = () => lines.map((l) => `${l.level} ${l.text}`).join('\n');
const findLine = (message) => lines.find((l) => l.args[0] === message);

// --- Firestore の偽物（失敗の記録の読み書きだけ。recordMessageFailure はトランザクション、clearMessageFailure・failedMessageIds は文書を直接使う） ---
const adminFirestore = fromBot('firebase-admin/firestore');
const { FieldValue, Timestamp } = adminFirestore;
/** 失敗の記録の前回までの値（messageId → 記録） */
let priorFailures = {};
/** recordMessageFailure が書いた値（{ [messageId]: 記録 }） */
const failureWrites = [];
adminFirestore.getFirestore = () => ({
  collection: () => ({
    doc: () => ({
      get: async () => ({ exists: true, data: () => priorFailures }),
      set: async () => {},
    }),
  }),
  runTransaction: async (fn) =>
    fn({
      get: async () => ({ exists: true, data: () => priorFailures }),
      set: (_ref, data) => {
        failureWrites.push(data);
      },
    }),
});

const gmailAuth = require('../dist/gmail/auth');
const gmailWatch = require('../dist/gmail/watch');
const cardNotice = require('../dist/gmail/cardNotice');
const handler = require('../dist/gmail/handler');

// --- Gmail・watch の状態・送信待ちの印の偽物 ---
let gmailClientError = null; // getGmailClient が投げる例外
let historyError = null; // history.list が投げる例外
let messageError = null; // メールの処理（最初の deliverPendingCardNotice）が投げる例外
let watchState = { historyId: '100' }; // 連携中のアドレスは無い（照合しない）
const historyUpdates = [];
gmailAuth.getGmailClient = async () => {
  if (gmailClientError) throw gmailClientError;
  return {
    users: {
      history: {
        list: async () => {
          if (historyError) throw historyError;
          return { data: { history: [{ messagesAdded: [{ message: { id: 'msg-0001' } }] }] } };
        },
      },
    },
  };
};
gmailWatch.getWatchState = async () => watchState;
gmailWatch.updateHistoryId = async (historyId) => {
  historyUpdates.push(historyId);
};
cardNotice.deliverPendingCardNotice = async () => {
  if (messageError) throw messageError;
  return 'sent';
};
cardNotice.discardCardNotices = async () => {};

const notification = (historyId) => Buffer.from(JSON.stringify({ emailAddress: 'someone@example.com', historyId })).toString('base64');
/** handleGmailPubSub を呼び、投げたら例外を、投げなければ 'ok' を返す */
const handle = (historyId) =>
  capture(async () => {
    try {
      await handler.handleGmailPubSub(notification(historyId));
      return 'ok';
    } catch (error) {
      return error;
    }
  });

/** 投げた例外の、実行環境のログに出うる形（stack・message・name・util.inspect）に目印が無い */
function checkFixedError(label, thrown, original) {
  check(`${label}: 投げる（Pub/Sub が再送する）`, thrown instanceof Error, String(thrown));
  if (!(thrown instanceof Error)) return;
  check(`${label}: 元の例外ではなく、名前の付いた固定文の Error を投げる`, thrown !== original && thrown.name === 'GmailImportError', thrown.name);
  check(
    `${label}: 投げる Error の message・name・stack に元の文言が無い`,
    !hasCanary(thrown.message) && !hasCanary(thrown.name) && !hasCanary(thrown.stack),
    thrown.stack
  );
  check(
    `${label}: util.inspect（console.error(err) の形）にも無い（cause・元の例外の項目を持たない）`,
    !hasCanary(util.inspect(thrown, { depth: 10 })) && thrown.cause === undefined,
    util.inspect(thrown, { depth: 10 })
  );
}

/** recordMessageFailure が書いた msg-0001 の記録（無ければ undefined） */
const lastFailureWrite = (from) => failureWrites.slice(from).map((w) => w['msg-0001']).filter(Boolean).pop();
const isDelete = (value) => value instanceof Object && typeof value.isEqual === 'function' && value.isEqual(FieldValue.delete());

async function main() {
  console.log('\n[handleGmailPubSub: 一時的な失敗は、種類をログに出してから固定文の Error を投げる]');
  let original = gaxiosError(503);
  gmailClientError = original;
  let r = await handle('200');
  gmailClientError = null;
  checkFixedError('getGmailClient の 503', r, original);
  const handleLine = findLine('Failed to handle Gmail Pub/Sub');
  check(
    'getGmailClient の 503: 投げる前に「Failed to handle Gmail Pub/Sub」を error に固定文 + { errorName, errorCode, errorStatus } で出す',
    !!handleLine &&
      handleLine.level === 'error' &&
      handleLine.args.length === 2 &&
      JSON.stringify(handleLine.args[1]) === JSON.stringify({ errorName: 'GaxiosError', errorCode: 503, errorStatus: 503 }),
    allText()
  );
  check('getGmailClient の 503: ログに元の文言・ヘッダー・応答が無い', lines.length > 0 && !hasCanary(allText()), allText());

  // functions-framework が関数の失敗をログに出す形（logger.js の sendCrashResponse: console.error(err.stack || err)）
  const { sendCrashResponse } = require(ffFile('logger.js'));
  const runtimeOutput = (err) => {
    const out = [];
    const originalError = console.error;
    console.error = (...args) => out.push(util.format(...args));
    try {
      sendCrashResponse({ err, res: null });
    } finally {
      console.error = originalError;
    }
    return out.join('\n');
  };
  check('前提: 元の例外をそのまま渡すと、functions-framework のログに文言が出る', hasCanary(runtimeOutput(original)), runtimeOutput(original));
  const fixedOutput = runtimeOutput(r);
  check(
    'functions-framework のログ（err.stack）は固定文の名前・文言だけで、元の文言が無い',
    !hasCanary(fixedOutput) && fixedOutput.startsWith('GmailImportError: Gmail import failed; Pub/Sub retries the notification'),
    fixedOutput
  );

  original = gaxiosError(503);
  historyError = original;
  r = await handle('201');
  historyError = null;
  checkFixedError('history.list の 503', r, original);
  check('history.list の 503: historyId を進めない', historyUpdates.length === 0, historyUpdates);

  original = Object.assign(new Error(`Firestore read failed ${CANARY}`), { code: 14 });
  gmailWatch.getWatchState = async () => {
    throw original;
  };
  r = await handle('202');
  gmailWatch.getWatchState = async () => watchState;
  checkFixedError('watch の状態の読み取りの失敗', r, original);

  console.log('\n[メールの処理の失敗: 失敗の記録に文言を保存しない]');
  // 以前の記録（この変更の前の形。lastError に文言が入っている）
  priorFailures = { 'msg-0001': { attempts: 1, lastError: `14 UNAVAILABLE: documents/groupMembers/G_${CANARY}`, firstFailedAt: Timestamp.now() } };
  original = firestoreError();
  messageError = original;
  let writesBefore = failureWrites.length;
  r = await handle('300');
  messageError = null;
  checkFixedError('メールの処理の失敗（試行 2・諦める前）', r, original);
  check('メールの処理の失敗（諦める前）: historyId を進めない', historyUpdates.length === 0, historyUpdates);
  let write = lastFailureWrite(writesBefore);
  check(
    '失敗の記録: 試行回数と、最後の失敗の種類（errorName・errorCode）を書く',
    !!write && write.attempts === 2 && write.errorName === 'Error' && write.errorCode === 14,
    util.inspect(write)
  );
  check(
    '失敗の記録: 以前の記録の文言（lastError）を消し、今回の例外に無い項目（errorCause・errorStatus）も消す',
    !!write && isDelete(write.lastError) && isDelete(write.errorCause) && isDelete(write.errorStatus),
    util.inspect(write)
  );
  check('失敗の記録: 書く値に元の文言が無い', !!write && !hasCanary(util.inspect(write, { depth: 10 })), util.inspect(write, { depth: 10 }));
  check('メールの処理の失敗: ログに元の文言が無い', !hasCanary(allText()), allText());

  // HTTP の状態を持つ失敗（LINE の 5xx など）は errorStatus を書き、コードが無ければ errorCode を消す
  original = Object.assign(new Error(`500 - Internal Server Error ${CANARY}`), { name: 'HTTPFetchError', status: 500, body: CANARY });
  messageError = original;
  writesBefore = failureWrites.length;
  r = await handle('301');
  messageError = null;
  write = lastFailureWrite(writesBefore);
  checkFixedError('LINE の 500', r, original);
  check(
    '失敗の記録: errorName・errorStatus を書き、無い errorCode は消す',
    !!write && write.errorName === 'HTTPFetchError' && write.errorStatus === 500 && isDelete(write.errorCode) && !hasCanary(util.inspect(write, { depth: 10 })),
    util.inspect(write)
  );

  console.log('\n[やり直しても直らないときは、従来どおり投げない（#281）]');
  // 試行 3 回目・最初の失敗から 7 時間で諦める → historyId を進め、投げない
  priorFailures = {
    'msg-0001': { attempts: 2, lastError: `old ${CANARY}`, firstFailedAt: Timestamp.fromMillis(Date.now() - 7 * 60 * 60 * 1000) },
  };
  messageError = firestoreError();
  writesBefore = failureWrites.length;
  let historyBefore = historyUpdates.length;
  r = await handle('400');
  messageError = null;
  priorFailures = {};
  write = lastFailureWrite(writesBefore);
  check('諦めた（試行 3・7 時間）: 投げずに historyId を進める', r === 'ok' && historyUpdates.length === historyBefore + 1, String(r));
  check('諦めた: 失敗の記録の以前の文言を消す', !!write && write.attempts === 3 && isDelete(write.lastError), util.inspect(write));
  check('諦めた: ログに元の文言が無い', !hasCanary(allText()), allText());

  gmailClientError = new gmailAuth.GmailTokenMissingError();
  r = await handle('401');
  gmailClientError = null;
  check('Gmail のトークンが無い: 投げない', r === 'ok', String(r));

  watchState = null;
  r = await handle('402');
  watchState = { historyId: '100' };
  check('watch の状態が無い: 投げない', r === 'ok', String(r));

  historyError = Object.assign(new Error(`Requested entity was not found. ${CANARY}`), { code: 404 });
  historyBefore = historyUpdates.length;
  r = await handle('403');
  historyError = null;
  check('history.list の 404（historyId が古すぎる）: 投げずに先へ飛ばす', r === 'ok' && historyUpdates.length === historyBefore + 1, String(r));

  r = await capture(async () => {
    try {
      await handler.handleGmailPubSub(Buffer.from('not json').toString('base64'));
      return 'ok';
    } catch (error) {
      return error;
    }
  });
  check('historyId の読めない通知: 投げない', r === 'ok', String(r));

  r = await handle('404');
  check('成功: 投げずに historyId を進める', r === 'ok' && historyUpdates[historyUpdates.length - 1] === '404', String(r));

  console.log('\n[実行環境を通した呼び出し（別のプロセス。出力をすべて捕まえる）]');
  runRuntimeProbe();

  console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * dist/index.js を読み込み、実行環境（functions-framework のサーバー・firebase-functions の包み）を通して関数を失敗させる。
 * index.js は読み込むと dotenv と Firebase Admin の初期化が走るので、.env の無いディレクトリで別のプロセスにする
 * （接続はしない。取込・固定費・精算サマリー・watch の本体は偽物にする）。
 */
function runRuntimeProbe() {
  const dist = (name) => JSON.stringify(path.join(BOT_DIR, 'dist', name));
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `const CANARY = ${JSON.stringify(CANARY)};
       const m = require(${dist('index.js')});
       const gmailAuth = require(${dist('gmail/auth.js')});
       const watch = require(${dist('gmail/watch.js')});
       const recurring = require(${dist('recurringExpenses.js')});
       const settlement = require(${dist('settlementSummary.js')});
       const { getServer } = require(${JSON.stringify(ffFile('server.js'))});
       const secretError = () => Object.assign(new Error('failed ' + CANARY), {
         name: 'GaxiosError', status: 503, code: 503, config: { headers: { Authorization: 'Bearer ' + CANARY } },
       });
       // 出力（stdout・stderr）をすべて捕まえる。firebase-functions の logger は読み込み時の console を使うので、書き込みの口で捕まえる
       const out = [];
       const realOut = process.stdout.write.bind(process.stdout);
       const realErr = process.stderr.write.bind(process.stderr);
       const startCapture = () => {
         out.length = 0;
         process.stdout.write = (d) => { out.push(String(d)); return true; };
         process.stderr.write = (d) => { out.push(String(d)); return true; };
       };
       const stopCapture = () => { process.stdout.write = realOut; process.stderr.write = realErr; return out.join(''); };
       // Cloud Scheduler からの HTTP の要求と応答の偽物（onSchedule の包みは 200 / 500 を返す）
       const runScheduled = async (fn) => {
         const res = { statusCode: null, status(c) { res.statusCode = c; return res; }, send() { return res; } };
         let output;
         startCapture();
         try {
           await fn({ headers: {}, header: () => undefined }, res);
         } finally {
           output = stopCapture();
         }
         return { status: res.statusCode, output };
       };
       (async () => {
         const results = {};
         // functions-framework（CloudEvent）→ gmailPubSubHandler → handleGmailPubSub の失敗
         gmailAuth.getGmailClient = async () => { throw secretError(); };
         const server = getServer(m.gmailPubSubHandler, { signatureType: 'cloudevent', timeoutMilliseconds: 0, ignoredRoutes: null });
         await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
         startCapture();
         let status;
         let pubsubOutput;
         try {
           const res = await fetch('http://127.0.0.1:' + server.address().port + '/', {
             method: 'POST',
             headers: {
               'content-type': 'application/json',
               'ce-id': 'event-0001',
               'ce-specversion': '1.0',
               'ce-type': 'google.cloud.pubsub.topic.v1.messagePublished',
               'ce-source': '//pubsub.googleapis.com/projects/demo/topics/gmail-notifications',
             },
             body: JSON.stringify({
               message: {
                 data: Buffer.from(JSON.stringify({ emailAddress: 'someone@example.com', historyId: '500' })).toString('base64'),
                 messageId: 'm-0001',
                 publishTime: new Date().toISOString(),
               },
             }),
           });
           status = res.status;
           await res.text();
           await new Promise((resolve) => setTimeout(resolve, 50));
         } finally {
           pubsubOutput = stopCapture();
         }
         await new Promise((resolve) => server.close(resolve));
         results.pubsub = { status, output: pubsubOutput };

         watch.renewWatch = async () => { throw secretError(); };
         results.renewFail = await runScheduled(m.renewGmailWatch);
         watch.renewWatch = async () => ({});
         results.renewOk = await runScheduled(m.renewGmailWatch);

         let settlementCalls = 0;
         const ok = { checked: 1, posted: 0, skipped: 1, failed: 0 };
         const sent = { checked: 1, sent: 0, skipped: 1, failed: 0 };
         recurring.postDueRecurringExpenses = async () => { throw secretError(); };
         settlement.sendDueSettlementSummaries = async () => { settlementCalls++; return sent; };
         results.recurringThrows = await runScheduled(m.postRecurringExpenses);
         results.recurringThrows.settlementCalls = settlementCalls;

         recurring.postDueRecurringExpenses = async () => ok;
         settlement.sendDueSettlementSummaries = async () => { throw secretError(); };
         results.settlementThrows = await runScheduled(m.postRecurringExpenses);

         recurring.postDueRecurringExpenses = async () => ({ ...ok, failed: 2 });
         settlement.sendDueSettlementSummaries = async () => ({ ...sent, failed: 1 });
         results.someFailed = await runScheduled(m.postRecurringExpenses);

         recurring.postDueRecurringExpenses = async () => ok;
         settlement.sendDueSettlementSummaries = async () => sent;
         results.batchOk = await runScheduled(m.postRecurringExpenses);

         realOut('\\nRESULTS ' + JSON.stringify(results) + '\\n');
         process.exit(0);
       })().catch((e) => { realErr(String(e && e.stack)); process.exit(1); });`,
    ],
    { cwd: __dirname, encoding: 'utf-8', timeout: 60000 }
  );
  const line = (probe.stdout || '').split('\n').find((l) => l.startsWith('RESULTS '));
  const results = line ? JSON.parse(line.slice('RESULTS '.length)) : null;
  check('dist/index.js を読み込み、実行環境を通して呼べる', results !== null, { status: probe.status, stderr: (probe.stderr || '').slice(0, 500) });
  if (!results) return;

  const { pubsub, renewFail, renewOk, recurringThrows, settlementThrows, someFailed, batchOk } = results;
  check('gmailPubSubHandler（functions-framework）: 失敗の状態（500）で返す（Pub/Sub が再送する）', pubsub.status === 500, pubsub.status);
  check('gmailPubSubHandler（functions-framework）: 出力に元の文言・ヘッダーが無い', !hasCanary(pubsub.output), pubsub.output);
  check(
    'gmailPubSubHandler（functions-framework）: 出力は固定文のログと、固定文の Error の stack',
    pubsub.output.includes('Failed to handle Gmail Pub/Sub') &&
      pubsub.output.includes("errorName: 'GaxiosError'") &&
      pubsub.output.includes('GmailImportError: Gmail import failed; Pub/Sub retries the notification'),
    pubsub.output
  );

  check('renewGmailWatch: 失敗は 500（Cloud Scheduler がやり直す）', renewFail.status === 500, renewFail.status);
  check('renewGmailWatch: 出力に元の文言・ヘッダーが無い', !hasCanary(renewFail.output), renewFail.output);
  check(
    'renewGmailWatch: 固定文 + エラーの種類のログと、firebase-functions が出す固定文（Gmail Watch renewal failed）',
    renewFail.output.includes("Failed to renew Gmail Watch { errorName: 'GaxiosError'") &&
      renewFail.output.includes('"message":"Error: Gmail Watch renewal failed\\n'),
    renewFail.output
  );
  check('renewGmailWatch: 成功は 200', renewOk.status === 200, renewOk);

  check('postRecurringExpenses（固定費の一覧の読み取りの失敗）: 500', recurringThrows.status === 500, recurringThrows.status);
  check(
    'postRecurringExpenses（固定費の一覧の読み取りの失敗）: 精算サマリーは判定しない（以前と同じ）',
    recurringThrows.settlementCalls === 0,
    recurringThrows.settlementCalls
  );
  check('postRecurringExpenses（固定費の一覧の読み取りの失敗）: 出力に元の文言が無い', !hasCanary(recurringThrows.output), recurringThrows.output);
  check(
    'postRecurringExpenses（固定費の一覧の読み取りの失敗）: 固定文 + エラーの種類のログと、固定文（Daily batch failed）',
    recurringThrows.output.includes("Daily batch failed { errorName: 'GaxiosError'") && recurringThrows.output.includes('"message":"Error: Daily batch failed\\n'),
    recurringThrows.output
  );
  check('postRecurringExpenses（精算サマリーの対象の読み取りの失敗）: 500', settlementThrows.status === 500, settlementThrows.status);
  check('postRecurringExpenses（精算サマリーの対象の読み取りの失敗）: 出力に元の文言が無い', !hasCanary(settlementThrows.output), settlementThrows.output);
  check('postRecurringExpenses（失敗した件数がある）: 500', someFailed.status === 500, someFailed.status);
  check(
    'postRecurringExpenses（失敗した件数がある）: 件数はオブジェクトでログに出し、投げる文言は固定',
    someFailed.output.includes('Daily batch: some items failed { recurring: 2, settlementSummary: 1 }') &&
      someFailed.output.includes('"message":"Error: Daily batch: some items failed\\n'),
    someFailed.output
  );
  check('postRecurringExpenses: 失敗が無ければ 200', batchOk.status === 200, batchOk);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
