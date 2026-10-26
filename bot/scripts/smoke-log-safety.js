/**
 * エラーログに、例外の文言（Firestore の文書パス・入力の断片）・生の例外（通信先のヘッダーや応答の本文）・伏せていない ID が
 * 残らないことのスモークテスト（#277。Firestore・LINE・Gmail・Firebase Auth には接続しない）
 *
 * 代表的な箇所で例外を起こし、console.log / warn / error に渡された引数を util.format（console が実際に出す形）で
 * 文字列にして、目印（CANARY）と伏せていない LINE の ID が含まれないことを確かめる。あわせて、固定文のログが
 * エラーの種類（errorName・errorCode・errorStatus。logSafe.ts の errorFields）を持つことも確かめる（診断できること）。
 *
 * - logSafe.ts の errorFields（コード・HTTP の状態の形の検査）
 * - firestore.ts（Firestore の失敗）・linkUserResolver.ts（Firestore・Firebase Auth の失敗）
 * - gmail/parser.ts（解析の例外）・gmail/cardNotice.ts（文字列のコードの検査）・gmail/handler.ts（force-process・process-latest）
 * - gmail/adminRouter.ts（OAuth のコールバックの失敗。gaxios のエラーはアクセストークン入りのヘッダーを持つ）
 * - line/webhookApp.ts と line/postback.ts（postback の例外のログが 1 回だけ。LINE の HTTPFetchError は応答の本文とヘッダーを持つ）
 * - line/client.ts（返信の失敗）・line/groupEvents.ts（退出の処理の失敗）
 *
 * household API の例外ハンドラは smoke-household-api.js、要望のコマンドは smoke-feedback-command.js、
 * 家計簿のコマンドは smoke-kakeibo-command.js で確かめる。
 *
 *   node bot/scripts/smoke-log-safety.js
 */
const path = require('path');
const util = require('util');
const { createHmac } = require('crypto');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

const fromBot = (name) => require(require.resolve(name, { paths: [path.join(__dirname, '..')] }));

// 目印。例外の文言・文書のパス・ヘッダー・応答の本文に入れ、ログに出ないことを確かめる
const CANARY = '秘密CANARY';
// 偽の LINE の ID（本物ではない）。ログには末尾 4 文字（…cd99）だけが出てよい
const LINE_ID = 'U0123456789abcdef0123456789abcd99';

/** Firestore の NOT_FOUND（文言と details に文書のパスが入る。文書 ID に LINE の ID を使う groupMembers の形） */
function firestoreError() {
  const docPath = `projects/demo/databases/(default)/documents/groupMembers/G_house_${LINE_ID}_${CANARY}`;
  return Object.assign(new Error(`5 NOT_FOUND: No document to update: ${docPath}`), {
    code: 5,
    details: `No document to update: ${docPath}`,
    note: `Exception occurred in retry method that was not classified as transient (${CANARY})`,
  });
}

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
const leaks = () => {
  const text = allText();
  return text.includes('CANARY') || text.includes(LINE_ID);
};
/** ログに目印も伏せていない ID も無い */
function checkNoLeak(label) {
  check(`${label}: ログに例外の文言・伏せていない ID を出さない`, lines.length > 0 && !leaks(), allText());
}
/** 固定文 + オブジェクト（エラーの種類）で出している */
function checkLine(label, message, level, expected) {
  const line = findLine(message);
  const fields = line?.args[1];
  const ok =
    !!line &&
    line.level === level &&
    line.args.length === 2 &&
    typeof fields === 'object' &&
    fields !== null &&
    Object.entries(expected).every(([key, value]) => fields[key] === value);
  check(`${label}: 「${message}」を ${level} に固定文 + ${JSON.stringify(expected)} で出す`, ok, allText());
}

// --- Firestore の偽物（firestore.ts は最初の呼び出しで getFirestore の戻り値を持ち続けるので、最初に差し替える） ---
let dbFailure = null; // 設定すると、読み書きがこの例外を投げる
const docOverrides = new Map(); // `${collection}/${id}` → 文書の参照の偽物
const throwIfFailing = () => {
  if (dbFailure) throw dbFailure;
};
function fakeQuery() {
  return {
    where: () => fakeQuery(),
    limit: () => fakeQuery(),
    orderBy: () => fakeQuery(),
    get: async () => {
      throwIfFailing();
      return { empty: true, docs: [], size: 0 };
    },
  };
}
function fakeDoc(collection, id) {
  const override = docOverrides.get(`${collection}/${id}`);
  if (override) return override;
  return {
    id,
    get: async () => {
      throwIfFailing();
      return { exists: false, data: () => undefined, get: () => undefined };
    },
    set: async () => throwIfFailing(),
    update: async () => throwIfFailing(),
    delete: async () => throwIfFailing(),
  };
}
const fakeDb = {
  collection: (name) => ({
    ...fakeQuery(),
    doc: (id) => fakeDoc(name, id),
    add: async () => {
      throwIfFailing();
      return { id: 'new-doc' };
    },
  }),
  runTransaction: async () => {
    throwIfFailing();
    throw new Error('runTransaction is not faked');
  },
};
fromBot('firebase-admin/firestore').getFirestore = () => fakeDb;

// --- Firebase Auth の偽物（linkUserResolver は呼ぶたびに getAuth を引く） ---
let createUserFailure = null;
fromBot('firebase-admin/auth').getAuth = () => ({
  createUser: async () => {
    if (createUserFailure) throw createUserFailure;
    return { uid: 'app-uid-0001' };
  },
});

// --- LINE の偽物（通信しない。クライアントは本物を作り、メソッドを差し替える） ---
process.env.LINE_CHANNEL_TOKEN = 'dummy-channel-token-for-smoke';
process.env.LINE_CHANNEL_SECRET = 'dummy-channel-secret-for-smoke';
const lineSdk = fromBot('@line/bot-sdk');
/** LINE の API の失敗（HTTPFetchError は応答の本文とヘッダーを持つ） */
const lineHttpError = (status) =>
  new lineSdk.HTTPFetchError(`${status} - Bad Request`, {
    status,
    statusText: 'Bad Request',
    headers: new Headers({ 'x-line-request-id': 'req-CANARY-0001' }), // ヘッダーの値は ASCII だけ
    body: JSON.stringify({ message: `The property 'to' is invalid: ${LINE_ID} ${CANARY}` }),
  });
const lineCalls = { reply: 0, push: 0 };
let replyFailure = null;
const proto = lineSdk.messagingApi.MessagingApiClient.prototype;
proto.replyMessage = async () => {
  lineCalls.reply++;
  if (replyFailure) throw replyFailure;
  return {};
};
proto.pushMessage = async () => {
  lineCalls.push++;
  return {};
};
proto.getGroupMemberProfile = async () => {
  throw lineHttpError(404);
};
proto.getProfile = async () => {
  throw lineHttpError(404);
};

const { errorFields } = require('../dist/logSafe');
const firestore = require('../dist/firestore');
const linkUserResolver = require('../dist/linkUserResolver');
const parser = require('../dist/gmail/parser');
const cardNotice = require('../dist/gmail/cardNotice');
const gmailAuth = require('../dist/gmail/auth');
const handler = require('../dist/gmail/handler');
const { replyWithPushFallback } = require('../dist/line/client');
const { handleMemberLeft } = require('../dist/line/groupEvents');

async function main() {
  console.log('\n[errorFields]');
  check('Firestore のエラー: 名前と数のコード（文言・details は出さない）',
    JSON.stringify(errorFields(firestoreError())) === JSON.stringify({ errorName: 'Error', errorCode: 5 }), errorFields(firestoreError()));
  check('Firebase の形のコード（auth/...）は出す', errorFields(Object.assign(new Error('x'), { code: 'auth/id-token-expired' })).errorCode === 'auth/id-token-expired');
  check(
    '形の違う文字列のコードは出さない（空白・パス・大文字小文字の混在・長すぎる）',
    ['bad code', `groups/${LINE_ID}`, 'auth/Bad', 'auth/a b', `auth/${'a'.repeat(65)}`, 'Auth/x', `${CANARY}`].every(
      (code) => errorFields(Object.assign(new Error('x'), { code })).errorCode === undefined
    )
  );
  check(
    'gaxios の打ち切り・中断のコード（TimeoutError・AbortError）は許可リストとして出す',
    ['TimeoutError', 'AbortError'].every((code) => errorFields(Object.assign(new Error('x'), { name: 'GaxiosError', code })).errorCode === code)
  );
  check(
    '許可リスト以外の、大文字小文字の混ざった文字列のコードは出さない',
    ['SyntaxError', 'timeoutError', 'TimeoutErrorX', 'Timeout Error', `${CANARY}Error`].every(
      (code) => errorFields(Object.assign(new Error('x'), { code })).errorCode === undefined
    )
  );
  check('HTTP の状態（100〜599 の整数）は errorStatus に出す', errorFields(lineHttpError(429)).errorStatus === 429 && errorFields(lineHttpError(429)).errorName === 'HTTPFetchError');
  check('範囲外・数でない status は出さない', [0, 99, 600, 429.5, '429', NaN].every((status) => errorFields(Object.assign(new Error('x'), { status })).errorStatus === undefined));
  check('Error でないもの（文字列・null・undefined）でも投げない', errorFields('boom').errorName === 'string' && errorFields(null).errorName === 'object' && errorFields(undefined).errorName === 'undefined');
  check('HTTPFetchError の本文・ヘッダーは出さない', !util.format(errorFields(lineHttpError(400))).includes('CANARY'));

  console.log('\n[firestore.ts: Firestore の失敗]');
  dbFailure = firestoreError();
  let threw = null;
  await capture(async () => {
    try {
      await firestore.saveExpense({ lineId: LINE_ID, amount: 100, description: 'x', date: '2026-10-26', category: 'その他', confirmed: false, includeInTotal: false, payerId: LINE_ID });
    } catch (error) {
      threw = error;
    }
  });
  check('saveExpense: 例外は投げ直す（挙動は変えない）', threw === dbFailure);
  checkLine('saveExpense', 'Error saving expense', 'error', { errorName: 'Error', errorCode: 5 });
  checkNoLeak('saveExpense');

  let settings;
  await capture(async () => {
    try {
      settings = await firestore.getUserSettings(LINE_ID);
    } catch (error) {
      settings = error;
    }
  });
  check('getUserSettings: 例外は投げ直す', settings === dbFailure);
  checkLine('getUserSettings', 'Error getting user settings', 'error', { errorName: 'Error', errorCode: 5 });
  checkNoLeak('getUserSettings');

  let budget;
  await capture(async () => {
    budget = await firestore.getMonthlyBudget(LINE_ID, 'C_line_group_0002');
  });
  check('getMonthlyBudget: 読めなければ undefined', budget === undefined);
  check(
    'getMonthlyBudget: ID ごとに固定文 + { 伏せた id, errorName, errorCode } で warn に出す',
    lines.filter((l) => l.level === 'warn' && l.args[0] === 'Failed to read budgetSettings').map((l) => l.args[1].id).join(',') === '…0002,…cd99' &&
      lines.every((l) => l.args[1]?.errorCode === 5),
    allText()
  );
  checkNoLeak('getMonthlyBudget');

  console.log('\n[linkUserResolver.ts: Firestore・Firebase Auth の失敗]');
  let appUid;
  await capture(async () => {
    appUid = await linkUserResolver.getAppUidByLineId(LINE_ID);
  });
  check('getAppUidByLineId: 失敗したら null（挙動は変えない）', appUid === null);
  checkLine('getAppUidByLineId', 'Error finding appUid by lineId', 'error', { errorName: 'Error', errorCode: 5 });
  checkLine('getAppUidByLineId', 'Error resolving appUid from lineId', 'error', { errorName: 'Error', errorCode: 5 });
  checkLine('getAppUidByLineId', 'Resolving appUid for the LINE user', 'log', { user: '…cd99' });
  checkNoLeak('getAppUidByLineId');

  dbFailure = null;
  createUserFailure = Object.assign(new Error(`Error while making request: ${CANARY} uid=${LINE_ID}`), { code: 'auth/internal-error' });
  await capture(async () => {
    appUid = await linkUserResolver.getOrCreateAppUidForLineId(LINE_ID);
  });
  createUserFailure = null;
  check('getOrCreateAppUidForLineId: 失敗したら null', appUid === null);
  checkLine('getOrCreateAppUidForLineId', 'Error getting or creating appUid for lineId', 'error', { errorName: 'Error', errorCode: 'auth/internal-error' });
  checkNoLeak('getOrCreateAppUidForLineId');

  console.log('\n[gmail/parser.ts: 解析の例外]');
  let parsed;
  await capture(async () => {
    // 本文の読み取りで例外になる入力（例外の文言にメール本文の断片が入る想定）
    parsed = parser.parseSMBCCardEmail('msg-0001', {
      match() {
        throw new TypeError(`Cannot parse ご利用店名：${CANARY}`);
      },
    });
  });
  check('parseSMBCCardEmail: 例外なら null（挙動は変えない）', parsed === null);
  checkLine('parseSMBCCardEmail', 'Failed to parse SMBC card email', 'error', { errorName: 'TypeError' });
  checkNoLeak('parseSMBCCardEmail');

  console.log('\n[gmail/cardNotice.ts: 印を消せない]');
  const noticeId = `msg-${CANARY}-n001`;
  const noticePath = `system/${cardNotice.CARD_NOTICE_PREFIX}${noticeId}`;
  let deleteFailure = null;
  docOverrides.set(noticePath, {
    get: async () => ({
      exists: true,
      data: () => ({ expenseId: `exp-${CANARY}-e001`, lineGroupId: 'C_line_group_0002', card: {}, createdAt: { toMillis: () => 0 } }),
    }),
    delete: async () => {
      throw deleteFailure;
    },
  });
  // 文字列のコードに入力の断片が入りうる（以前は形を確かめずに出していた）
  deleteFailure = Object.assign(new Error(`Document ${noticePath} is locked`), { code: `bad code ${CANARY}` });
  let delivery;
  await capture(async () => {
    delivery = await cardNotice.deliverPendingCardNotice(noticeId, new Date());
  });
  check('古い印は送らずに消そうとする（expired）', delivery === 'expired', delivery);
  const removeLine = findLine('Gmail card notice: failed to remove the marker');
  check('形の違う文字列のコードは出さない（errorCode が無い）', !!removeLine && !('errorCode' in removeLine.args[1]) && removeLine.args[1].errorName === 'Error', allText());
  check('ID は伏せる（message・expense）', !!removeLine && removeLine.args[1].message === '…n001' && removeLine.args[1].expense === '…e001', allText());
  checkNoLeak('deliverPendingCardNotice');
  deleteFailure = Object.assign(new Error(`14 UNAVAILABLE: ${noticePath}`), { code: 14 });
  await capture(async () => {
    await cardNotice.discardCardNotices([noticeId], 'abandoned');
  });
  checkLine('discardCardNotices', 'Gmail card notice: failed to discard the marker', 'warn', { errorName: 'Error', errorCode: 14, reason: 'abandoned' });
  checkNoLeak('discardCardNotices');
  docOverrides.delete(noticePath);

  console.log('\n[gmail/handler.ts: force-process・process-latest]');
  const realGetExpenseId = parser.getExpenseIdByGmailMessageId;
  const realDeliver = cardNotice.deliverPendingCardNotice;
  const realGetGmailClient = gmailAuth.getGmailClient;
  try {
    // messageId は管理 API のパスの値（入力）
    const forcedId = `msg-${CANARY}-f001`;
    parser.getExpenseIdByGmailMessageId = async () => `exp-${CANARY}-e002`;
    cardNotice.deliverPendingCardNotice = async () => 'none';
    let result;
    await capture(async () => {
      result = await handler.forceProcessMessage(forcedId);
    });
    check('既存の支出: alreadyExists で返す（挙動は変えない）', result?.success === true && result.alreadyExists === true);
    checkLine('forceProcessMessage', 'Expense already exists for the Gmail message', 'log', { message: '…f001', expense: '…e002' });
    checkNoLeak('forceProcessMessage（既存の支出）');

    parser.getExpenseIdByGmailMessageId = async () => {
      throw firestoreError();
    };
    await capture(async () => {
      result = await handler.forceProcessMessage(forcedId);
    });
    check('失敗: success: false で返す', result?.success === false);
    checkLine('forceProcessMessage', 'forceProcessMessage error', 'error', { errorName: 'Error', errorCode: 5 });
    checkNoLeak('forceProcessMessage（失敗）');

    // gaxios のエラーは、送ったリクエストの設定（Authorization ヘッダー = アクセストークン）を持つ
    gmailAuth.getGmailClient = async () => {
      throw Object.assign(new Error(`invalid_grant ${CANARY}`), {
        name: 'GaxiosError',
        status: 400,
        config: { headers: { Authorization: `Bearer ya29.${CANARY}` } },
        response: { data: { error_description: CANARY } },
      });
    };
    await capture(async () => {
      result = await handler.processLatestEmail();
    });
    check('process-latest の失敗: success: false で返す', result?.success === false);
    checkLine('processLatestEmail', 'processLatestEmail error', 'error', { errorName: 'GaxiosError', errorStatus: 400 });
    checkNoLeak('processLatestEmail');
  } finally {
    parser.getExpenseIdByGmailMessageId = realGetExpenseId;
    cardNotice.deliverPendingCardNotice = realDeliver;
    gmailAuth.getGmailClient = realGetGmailClient;
  }

  console.log('\n[gmail/adminRouter.ts: OAuth のコールバックの失敗]');
  const express = fromBot('express');
  {
    const realCallback = gmailAuth.handleOAuthCallback;
    gmailAuth.handleOAuthCallback = async () => {
      throw Object.assign(new Error(`invalid_grant: code=${CANARY}`), {
        name: 'GaxiosError',
        status: 400,
        code: '400',
        config: { data: `client_secret=${CANARY}&code=${CANARY}`, headers: { Authorization: `Bearer ${CANARY}` } },
      });
    };
    const { gmailRouter } = require('../dist/gmail/adminRouter');
    const app = express();
    app.use('/gmail', gmailRouter);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      let status;
      await capture(async () => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/gmail/callback?code=c&state=s`);
        status = res.status;
        await res.text();
      });
      check('失敗は 500（挙動は変えない）', status === 500, status);
      checkLine('OAuth callback', 'OAuth callback failed', 'error', { errorName: 'GaxiosError', errorStatus: 400, errorCode: '400' });
      checkNoLeak('OAuth callback');
    } finally {
      gmailAuth.handleOAuthCallback = realCallback;
      await new Promise((resolve) => server.close(resolve));
    }
  }

  console.log('\n[line/webhookApp.ts + line/postback.ts: postback の例外]');
  {
    const { webhookApp } = require('../dist/line/webhookApp');
    const server = await new Promise((resolve) => {
      const s = webhookApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const body = JSON.stringify({
        destination: 'U_bot',
        events: [
          {
            type: 'postback',
            replyToken: 'reply-token',
            source: { type: 'group', groupId: 'C_line_group_0002', userId: LINE_ID },
            postback: { data: JSON.stringify({ action: 'confirm', expenseId: 'exp_0003' }) },
          },
        ],
      });
      const signature = createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(body).digest('base64');
      dbFailure = firestoreError();
      let status;
      await capture(async () => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-line-signature': signature },
          body,
        });
        status = res.status;
        await res.text();
      });
      dbFailure = null;
      check('webhook は 200 で返す（挙動は変えない）', status === 200, status);
      const errorLines = lines.filter((l) => l.level === 'error');
      check(
        '例外のログは 1 回だけ（webhookApp の「Postback processing error」。postback.ts では出さない）',
        errorLines.length === 1 && errorLines[0].args[0] === 'Postback processing error',
        allText()
      );
      checkLine('postback', 'Postback processing error', 'error', { errorName: 'Error', errorCode: 5 });
      checkLine('postback', 'Failed to load LINE profile for payer', 'warn', { user: '…cd99', errorName: 'HTTPFetchError', errorStatus: 404 });
      checkNoLeak('postback');
    } finally {
      dbFailure = null;
      await new Promise((resolve) => server.close(resolve));
    }
  }

  console.log('\n[line/client.ts: 返信の失敗 → push]');
  replyFailure = lineHttpError(400);
  let via;
  await capture(async () => {
    via = await replyWithPushFallback('reply-token', 'C_line_group_0002', [{ type: 'text', text: 'x' }]);
  });
  replyFailure = null;
  check('push に切り替える（挙動は変えない）', via === 'push' && lineCalls.push >= 1, via);
  checkLine('replyWithPushFallback', 'replyMessage failed (token expired or already used), falling back to pushMessage', 'warn', {
    errorName: 'HTTPFetchError',
    errorStatus: 400,
  });
  checkNoLeak('replyWithPushFallback');

  console.log('\n[line/groupEvents.ts: 退出の処理の失敗]');
  dbFailure = firestoreError();
  await capture(async () => {
    await handleMemberLeft({ source: { type: 'group', groupId: 'C_line_group_0002' }, left: { members: [{ type: 'user', userId: LINE_ID }] } });
  });
  dbFailure = null;
  checkLine('handleMemberLeft', 'Member left event handling error', 'error', { errorName: 'Error', errorCode: 5 });
  checkNoLeak('handleMemberLeft');

  console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
