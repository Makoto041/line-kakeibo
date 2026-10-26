/**
 * Gmail watch の状態（system/gmailState）まわりのスモークテスト（Firestore は使わない）
 *
 * - resolveWatchHistoryId: watch の登録・更新で保存する historyId の決め方
 * - watchStateFields: そのとき merge で書く項目（保存値を残すときは historyId を書かない）
 * - DELETE /gmail/revoke: gmailState を消せなかったら握り潰さず 500 で返す（Firestore の参照は偽物）
 * - DELETE /gmail/revoke: Google 側の失効（#284。Google の失効先は fetch の偽物）。refresh_token を先に本文（form）で送り、
 *   URL にトークンを載せない。Google が受け付けなければ googleRevoked: false・success: false（トークンは消す）。
 *   トークン・Google の応答の本文・例外の文言（目印 CANARY）を応答にもログにも出さない
 * - DELETE /gmail/revoke: 失効の前に users.stop で古い watch を止める（#280。Gmail API は googleapis の google.gmail を差し替えた
 *   偽物）。順序は stop → 失効 → トークンの削除 → gmailState の削除。stop に失敗・時間切れでも続ける（watchStopped: false）。
 *   トークンが無ければ呼ばない（null）
 * - 管理 API のレート制限: 接続元の IP（X-Forwarded-For の末尾）で数え、認証の前後で枠を分ける。認証の無い連打で、
 *   認証に成功する管理者の要求が 429 にならない。/callback 以外の全ルートに同じ上限が付く（ルーターのスタックを走査）
 * - トークンの保存（auth.ts）: OAuth のコールバックの初回保存は文書を作り、アクセストークンの更新の保存は文書があるときだけ書く
 *   （更新の途中で revoke に消された文書を作り直さない。Firestore と Google の OAuth は偽物）
 *
 * Firestore を使う確認（トランザクション・merge・renewWatch が stop を呼ばないこと）は
 * emulator-gmail-import.js（npm -w bot run test:emulator）。
 *
 *   node bot/scripts/smoke-gmail-watch.js
 */
const util = require('util');
const express = require('express');
const watch = require('../dist/gmail/watch');
const auth = require('../dist/gmail/auth');

const { resolveWatchHistoryId, watchStateFields } = watch;

let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

function same(actual, historyId, source) {
  return actual.historyId === historyId && actual.source === source;
}

console.log('resolveWatchHistoryId');

let r = resolveWatchHistoryId('100', '500');
check('保存値 < 応答: 保存値を残す（未処理の範囲を飛ばさない）', same(r, '100', 'kept'), r);
r = resolveWatchHistoryId('900', '500');
check('保存値 > 応答: 保存値を残す（巻き戻さない）', same(r, '900', 'kept'), r);
r = resolveWatchHistoryId('500', '500');
check('同じ値: 保存値を残す', same(r, '500', 'kept'), r);
r = resolveWatchHistoryId('18446744073709551615', '500');
check('uint64 の最大値も読める値として残す', same(r, '18446744073709551615', 'kept'), r);
r = resolveWatchHistoryId(100, '500');
check('数値のまま保存された値も残す（文字列にして返す）', same(r, '100', 'kept'), r);

r = resolveWatchHistoryId(undefined, '500');
check('保存値なし: 応答の値を入れる', same(r, '500', 'initialized'), r);
r = resolveWatchHistoryId(null, '500');
check('null: 応答の値を入れる', same(r, '500', 'initialized'), r);
r = resolveWatchHistoryId('', '500');
check('空文字: 無し扱いで応答の値を入れる', same(r, '500', 'initialized'), r);

r = resolveWatchHistoryId('abc', '500');
check('数値として読めない文字列: 応答の値に置き換える', same(r, '500', 'replaced'), r);
r = resolveWatchHistoryId('-1', '500');
check('負の値: 応答の値に置き換える', same(r, '500', 'replaced'), r);
r = resolveWatchHistoryId(1.5, '500');
check('整数でない数値: 応答の値に置き換える', same(r, '500', 'replaced'), r);
r = resolveWatchHistoryId({ value: '100' }, '500');
check('オブジェクト: 応答の値に置き換える', same(r, '500', 'replaced'), r);

console.log('\nwatchStateFields');

const NOW = { marker: 'now' };
const EXP = 1793577600000;
let f = watchStateFields(resolveWatchHistoryId('100', '500'), EXP, NOW);
check('残すとき（kept）: historyId の項目を書かない', !('historyId' in f), f);
check('残すとき（kept）: watchExpiration と updatedAt だけを書く',
  Object.keys(f).sort().join(',') === 'updatedAt,watchExpiration' && f.watchExpiration === EXP && f.updatedAt === NOW, f);
f = watchStateFields(resolveWatchHistoryId(100, '500'), EXP, NOW);
check('数値の保存値を残すとき: historyId を書かない（型を変えない）', !('historyId' in f), f);
f = watchStateFields(resolveWatchHistoryId(undefined, '500'), EXP, NOW);
check('保存値なし（initialized）: 応答の historyId を書く',
  f.historyId === '500' && f.watchExpiration === EXP && f.updatedAt === NOW, f);
f = watchStateFields(resolveWatchHistoryId('abc', '500'), EXP, NOW);
check('使えない保存値（replaced）: 応答の historyId を書く', f.historyId === '500', f);

async function revokeChecks() {
  console.log('\nDELETE /gmail/revoke（Firestore の参照・Google の失効先は偽物）');

  // テスト用のダミー値（本物の秘密値ではない）
  const SECRET = 'dummy-admin-secret-for-smoke';
  process.env.ADMIN_SECRET = SECRET;
  // stop のクライアントを作るのに使う（OAuth の設定。ダミー値。最後に戻す）
  const savedEnv = { id: process.env.GMAIL_CLIENT_ID, secret: process.env.GMAIL_CLIENT_SECRET, redirect: process.env.GMAIL_REDIRECT_URI };
  process.env.GMAIL_CLIENT_ID = 'dummy-client-id-for-smoke';
  process.env.GMAIL_CLIENT_SECRET = 'dummy-client-secret-for-smoke';
  process.env.GMAIL_REDIRECT_URI = 'http://127.0.0.1/dummy-callback';

  // stop・失効・削除の順に積む（順序の確認）
  const events = [];

  // adminRouter は ./index 経由（getter で再エクスポート）で参照を引くため、各モジュールの exports を差し替える
  // tokenData が undefined なら文書が無い（トークンが無ければ Google へは送らない）
  const fake = { tokenData: undefined, tokenDeletes: 0, stateDeletes: 0, failStateDelete: false, failTokenDelete: false };
  auth.gmailTokenRef = () => ({
    get: async () => ({ exists: fake.tokenData !== undefined, data: () => fake.tokenData }),
    delete: async () => {
      events.push('token:delete');
      if (fake.failTokenDelete) {
        throw Object.assign(new Error('fake token delete failure'), { name: 'FakeFirestoreError' });
      }
      fake.tokenDeletes++;
      fake.tokenData = undefined;
    },
  });
  watch.gmailStateRef = () => ({
    delete: async () => {
      events.push('state:delete');
      fake.stateDeletes++;
      if (fake.failStateDelete) {
        const error = new Error('detail that must not be logged');
        error.name = 'FakeFirestoreError';
        throw error;
      }
    },
  });

  // Google の失効先の偽物（globalThis.fetch を差し替える）。このテスト自身が express へ送る要求は元の fetch を使う
  const httpFetch = globalThis.fetch;
  const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
  // 目印。トークン・例外の文言・Google の応答の本文に入れ、応答とログに出ないことを確かめる（本物のトークンではない）
  const CANARY = 'CANARY-revoke-7f3a';
  const REFRESH = `1//refresh-${CANARY}+/=`;
  const ACCESS = `ya29.access-${CANARY}`;
  const google = { calls: [], respond: null };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? init.body : String(init.body);
    const token = new URLSearchParams(body).get('token');
    google.calls.push({
      url,
      method: init.method,
      contentType: new Headers(init.headers).get('content-type'),
      token,
    });
    events.push(token === REFRESH ? 'revoke:refresh' : token === ACCESS ? 'revoke:access' : 'revoke:other');
    if (!url.startsWith('https://oauth2.googleapis.com/')) {
      throw new Error('unexpected fetch in smoke test');
    }
    return google.respond(new URLSearchParams(body).get('token'), init);
  };
  const ok200 = () => new Response('{}', { status: 200 });
  const rejected400 = () =>
    new Response(JSON.stringify({ error: 'invalid_token', error_description: `Token expired or revoked ${CANARY}` }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  // タイムアウトの代わり（router は 5 秒待つので、中断されたときと同じ AbortError をすぐ返す。本当の時間切れは下で直接確かめる）
  const aborted = () => Promise.reject(new DOMException(`The operation was aborted ${CANARY}`, 'AbortError'));
  const networkError = () =>
    Promise.reject(
      Object.assign(new TypeError(`fetch failed ${CANARY}`), {
        cause: Object.assign(new Error(`connect ECONNRESET ${CANARY}`), { code: 'ECONNRESET' }),
      })
    );
  const byToken = (map) => (token, init) => map[token === REFRESH ? 'refresh' : 'access'](token, init);

  // Gmail API（users.stop）の偽物。auth.ts は呼ぶたびに googleapis の google.gmail を引くので、差し替えが効く
  // （googleapis の通信は globalThis.fetch を使わない〔gaxios は Node では node-fetch〕ので、fetch の偽物では受けられない）
  const { google: googleapis } = require('googleapis');
  const realGmail = googleapis.gmail;
  const okStop = async () => ({ data: '' });
  const gmailStop = { calls: [], respond: okStop };
  googleapis.gmail = (options) => ({
    users: {
      stop: async (params, callOptions) => {
        const credentials = options.auth.credentials;
        gmailStop.calls.push({
          version: options.version,
          userId: params.userId,
          refresh: credentials.refresh_token,
          access: credentials.access_token,
          callOptions,
        });
        events.push('stop');
        return gmailStop.respond(params, callOptions);
      },
    },
  });
  // gaxios の HTTP の失敗の形（送った要求のヘッダー〔アクセストークン〕と応答の本文を持つ）。どちらにも目印を入れる
  const gaxiosError = (status) =>
    Object.assign(new Error(`Request failed with status code ${status} ${CANARY}`), {
      name: 'GaxiosError',
      status,
      code: String(status),
      config: { headers: { Authorization: `Bearer ${ACCESS}` } },
      response: { status, data: { error: { message: `Invalid Credentials ${CANARY}` } } },
    });

  const { gmailRouter } = require('../dist/gmail/adminRouter');
  const app = express();
  app.use('/gmail', gmailRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/gmail/revoke`;

  // 1 回の DELETE /gmail/revoke。その間の console.log / warn / error を util.format の形で集める
  // 接続元はレート制限のテスト（rateLimitChecks）と分ける（X-Forwarded-For の末尾がキー）
  const revoke = async () => {
    fake.tokenDeletes = 0;
    fake.stateDeletes = 0;
    google.calls = [];
    gmailStop.calls = [];
    events.length = 0;
    const logs = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const level of Object.keys(original)) {
      console[level] = (...args) => logs.push({ level, args, text: util.format(...args) });
    }
    try {
      const res = await httpFetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${SECRET}`, 'X-Forwarded-For': '192.0.2.10' },
      });
      const text = await res.text();
      return { status: res.status, body: JSON.parse(text), text, logs };
    } finally {
      Object.assign(console, original);
    }
  };
  const noCanary = (r) => !r.text.includes(CANARY) && r.logs.every((l) => !l.text.includes(CANARY));
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const MANUAL = 'myaccount.google.com/connections';

  try {
    // --- トークンが無い（従来どおり。Google へは送らない） ---
    const ok = await revoke();
    check('消せたら 200・success: true・watchStateCleared: true',
      ok.status === 200 && ok.body.success === true && ok.body.watchStateCleared === true && typeof ok.body.message === 'string', ok);
    check('トークンと gmailState の両方を消す', fake.tokenDeletes === 1 && fake.stateDeletes === 1, fake);
    check('トークンが無ければ Google へ送らず googleRevoked: null', google.calls.length === 0 && ok.body.googleRevoked === null, ok.body);
    check('トークンが無ければ users.stop を呼ばず watchStopped: null',
      gmailStop.calls.length === 0 && ok.body.watchStopped === null, { calls: gmailStop.calls.length, watchStopped: ok.body.watchStopped });

    fake.failStateDelete = true;
    const ng = await revoke();
    check('gmailState を消せなかったら 500・success: false・watchStateCleared: false',
      ng.status === 500 && ng.body.success === false && ng.body.watchStateCleared === false && typeof ng.body.error === 'string', ng);
    check('gmailState を消せなかった 500 にも watchStopped を付ける（トークンが無いので null）', ng.body.watchStopped === null, ng.body);
    check('失敗の応答に例外の中身を出さない', !JSON.stringify(ng.body).includes('must not be logged'), ng.body);
    const warned = ng.logs.find((l) => l.level === 'warn' && l.args[0] === 'Failed to delete Gmail watch state on revoke');
    check('固定文と errorName だけで warn する',
      !!warned && warned.args.length === 2 && JSON.stringify(warned.args[1]) === JSON.stringify({ errorName: 'FakeFirestoreError' }), ng.logs);

    fake.failStateDelete = false;
    const retry = await revoke();
    check('やり直せば消せる（トークンが無くても進む）', retry.status === 200 && retry.body.watchStateCleared === true, retry);

    // --- Google が refresh_token の失効を受け付けた（access_token は既に無効で 400） ---
    fake.tokenData = { refresh_token: REFRESH, access_token: ACCESS, expiry_date: 0 };
    google.respond = byToken({ refresh: ok200, access: rejected400 });
    const revoked = await revoke();
    check('失効できたら 200・success: true・googleRevoked: true',
      revoked.status === 200 && revoked.body.success === true && revoked.body.googleRevoked === true &&
        revoked.body.watchStateCleared === true, revoked.body);
    check('応答に Google の結果（トークンごとの結果と HTTP の状態）を載せる',
      sameJson(revoked.body.googleRevoke, {
        refreshToken: { result: 'revoked', status: 200 },
        accessToken: { result: 'rejected', status: 400 },
      }), revoked.body.googleRevoke);
    check('refresh_token を先に送り、続けて access_token を送る',
      google.calls.length === 2 && google.calls[0].token === REFRESH && google.calls[1].token === ACCESS,
      google.calls.map((c) => c.token === REFRESH ? 'refresh' : c.token === ACCESS ? 'access' : 'other'));
    check('失効先は POST https://oauth2.googleapis.com/revoke（URL にクエリもトークンも無い）',
      google.calls.every((c) => c.url === GOOGLE_REVOKE_URL && c.method === 'POST' && !c.url.includes('?') && !c.url.includes(CANARY)),
      google.calls.map((c) => ({ method: c.method, hasQuery: c.url.includes('?'), hasToken: c.url.includes(CANARY) })));
    check('トークンは application/x-www-form-urlencoded の本文で送る',
      google.calls.every((c) => c.contentType === 'application/x-www-form-urlencoded'),
      google.calls.map((c) => c.contentType));
    check('失効できても Firestore のトークンと gmailState を消す', fake.tokenDeletes === 1 && fake.stateDeletes === 1, fake);
    check('失効できたら固定文で log する',
      revoked.logs.some((l) => l.level === 'log' && l.args[0] === 'Gmail token revoked on Google side'), revoked.logs.map((l) => l.args[0]));
    check('トークンを応答にもログにも出さない（失効できたとき）', noCanary(revoked));
    // users.stop（古い watch を止める）
    const stopCall = gmailStop.calls[0];
    check('トークンがあれば users.stop を 1 回呼び、止められたら watchStopped: true',
      gmailStop.calls.length === 1 && revoked.body.watchStopped === true, { calls: gmailStop.calls.length, watchStopped: revoked.body.watchStopped });
    check('stop は gmail v1 の userId: me に、保存してあるトークン（revoke が失効させるもの）で送る',
      !!stopCall && stopCall.version === 'v1' && stopCall.userId === 'me' && stopCall.refresh === REFRESH && stopCall.access === ACCESS,
      stopCall && { version: stopCall.version, userId: stopCall.userId });
    check('stop には待ち時間（5 秒）を付け、再試行しない',
      !!stopCall && !!stopCall.callOptions && stopCall.callOptions.timeout === 5000 && stopCall.callOptions.retry === false,
      stopCall && stopCall.callOptions);
    check('順序は stop → 失効（refresh_token → access_token）→ トークンの削除 → gmailState の削除（失効の後は stop できない）',
      sameJson(events, ['stop', 'revoke:refresh', 'revoke:access', 'token:delete', 'state:delete']), events);
    check('stop できたら固定文で log する',
      revoked.logs.some((l) => l.level === 'log' && l.args[0] === 'Gmail watch stopped before revoking the token' && l.args.length === 1),
      revoked.logs.map((l) => l.args[0]));

    // --- stop に失敗した（トークンが無効など。gaxios の失敗の形。要求のヘッダーと応答の本文に目印） ---
    fake.tokenData = { refresh_token: REFRESH, access_token: ACCESS, expiry_date: 0 };
    google.respond = ok200;
    gmailStop.respond = () => Promise.reject(gaxiosError(400));
    const stopFailed = await revoke();
    check('stop に失敗しても revoke は続ける（watchStopped: false。success は失効の結果のまま true）',
      stopFailed.status === 200 && stopFailed.body.success === true && stopFailed.body.watchStopped === false &&
        stopFailed.body.googleRevoked === true && stopFailed.body.watchStateCleared === true, stopFailed.body);
    check('stop に失敗しても、失効・トークンの削除・gmailState の削除をその順に行う',
      sameJson(events, ['stop', 'revoke:refresh', 'revoke:access', 'token:delete', 'state:delete']) &&
        fake.tokenDeletes === 1 && fake.stateDeletes === 1, events);
    const stopWarn = stopFailed.logs.find((l) => l.level === 'warn' && l.args[0] === 'Failed to stop Gmail watch before revoking the token');
    check('stop の失敗は固定文と errorFields（名前・コード・HTTP の状態）で warn する',
      !!stopWarn && stopWarn.args.length === 2 &&
        sameJson(stopWarn.args[1], { errorName: 'GaxiosError', errorCode: '400', errorStatus: 400 }),
      stopFailed.logs.map((l) => l.args));
    check('トークン・Gmail の応答の本文・例外の文言を応答にもログにも出さない（stop の失敗）', noCanary(stopFailed));

    // --- stop が時間切れ（gaxios の打ち切りの形。本当の時間切れは下で直接確かめる） ---
    fake.tokenData = { refresh_token: REFRESH, access_token: ACCESS, expiry_date: 0 };
    gmailStop.respond = () =>
      Promise.reject(Object.assign(new Error(`The operation was aborted due to timeout ${CANARY}`), { name: 'GaxiosError', code: 'TimeoutError' }));
    const stopTimedOut = await revoke();
    check('stop が時間切れでも revoke は続け、watchStopped: false・トークンを消す',
      stopTimedOut.status === 200 && stopTimedOut.body.watchStopped === false && stopTimedOut.body.success === true &&
        fake.tokenDeletes === 1 && fake.stateDeletes === 1 && google.calls.length === 2, stopTimedOut.body);
    check('トークン・例外の文言を応答にもログにも出さない（stop の時間切れ）', noCanary(stopTimedOut));

    // --- OAuth の設定（GMAIL_CLIENT_ID）が無い: stop のクライアントを作れない ---
    fake.tokenData = { refresh_token: REFRESH, access_token: ACCESS, expiry_date: 0 };
    gmailStop.respond = okStop;
    delete process.env.GMAIL_CLIENT_ID;
    const noConfig = await revoke();
    process.env.GMAIL_CLIENT_ID = 'dummy-client-id-for-smoke';
    const noConfigWarn = noConfig.logs.find((l) => l.level === 'warn' && l.args[0] === 'Failed to stop Gmail watch before revoking the token');
    check('OAuth の設定が無ければ stop を送らず watchStopped: false で、失効と削除は続ける',
      gmailStop.calls.length === 0 && noConfig.body.watchStopped === false && noConfig.body.googleRevoked === true &&
        fake.tokenDeletes === 1 && fake.stateDeletes === 1 && !!noConfigWarn && noConfigWarn.args[1].errorName === 'GmailCredentialsMissingError',
      noConfig.body);

    // --- トークンの削除に失敗した（500。stop・失効の結果も返す） ---
    fake.tokenData = { refresh_token: REFRESH, access_token: ACCESS, expiry_date: 0 };
    fake.failTokenDelete = true;
    const tokenDeleteFailed = await revoke();
    fake.failTokenDelete = false;
    check('トークンを消せなかった 500 にも watchStopped と googleRevoked を付ける',
      tokenDeleteFailed.status === 500 && tokenDeleteFailed.body.watchStopped === true && tokenDeleteFailed.body.googleRevoked === true &&
        typeof tokenDeleteFailed.body.error === 'string', tokenDeleteFailed.body);
    check('トークンを応答にもログにも出さない（トークンの削除の失敗）', noCanary(tokenDeleteFailed));

    // --- Google が失効を受け付けない（2xx 以外。応答の本文に目印） ---
    fake.tokenData = { refresh_token: REFRESH, access_token: ACCESS, expiry_date: 0 };
    google.respond = rejected400;
    const rejected = await revoke();
    check('Google が 400 なら 200・success: false・googleRevoked: false',
      rejected.status === 200 && rejected.body.success === false && rejected.body.googleRevoked === false, rejected.body);
    check('400 の HTTP の状態を応答に載せる',
      sameJson(rejected.body.googleRevoke, {
        refreshToken: { result: 'rejected', status: 400 },
        accessToken: { result: 'rejected', status: 400 },
      }), rejected.body.googleRevoke);
    check('Google が受け付けなくても Firestore のトークンと gmailState を消す',
      fake.tokenDeletes === 1 && fake.stateDeletes === 1 && rejected.body.watchStateCleared === true, fake);
    check('手動で外す案内を返す', typeof rejected.body.message === 'string' && rejected.body.message.includes(MANUAL), rejected.body.message);
    check('失効できなかったら固定文で warn する',
      rejected.logs.some((l) => l.level === 'warn' && l.args[0] === 'Gmail token was not revoked on Google side'),
      rejected.logs.map((l) => l.args[0]));
    check('トークン・Google の応答の本文を応答にもログにも出さない（400）', noCanary(rejected));

    // --- タイムアウト（中断） ---
    fake.tokenData = { refresh_token: REFRESH, access_token: ACCESS, expiry_date: 0 };
    google.respond = aborted;
    const timedOut = await revoke();
    check('タイムアウトなら success: false・googleRevoked: false（HTTP の状態は無し）',
      timedOut.status === 200 && timedOut.body.success === false && timedOut.body.googleRevoked === false &&
        sameJson(timedOut.body.googleRevoke, { refreshToken: { result: 'timeout' }, accessToken: { result: 'timeout' } }),
      timedOut.body);
    check('タイムアウトでも Firestore のトークンを消し、手動で外す案内を返す',
      fake.tokenDeletes === 1 && fake.stateDeletes === 1 && String(timedOut.body.message).includes(MANUAL), fake);
    check('トークン・例外の文言を応答にもログにも出さない（タイムアウト）', noCanary(timedOut));

    // --- 通信の失敗 ---
    fake.tokenData = { refresh_token: REFRESH, access_token: ACCESS, expiry_date: 0 };
    google.respond = networkError;
    const network = await revoke();
    check('通信に失敗したら success: false・googleRevoked: false',
      network.status === 200 && network.body.success === false && network.body.googleRevoked === false &&
        sameJson(network.body.googleRevoke, { refreshToken: { result: 'network_error' }, accessToken: { result: 'network_error' } }),
      network.body);
    check('通信の失敗でも Firestore のトークンを消し、手動で外す案内を返す',
      fake.tokenDeletes === 1 && fake.stateDeletes === 1 && String(network.body.message).includes(MANUAL), fake);
    const reach = network.logs.find((l) => l.level === 'warn' && l.args[0] === 'Failed to reach Google to revoke a Gmail token');
    check('通信の失敗は固定文と種類（errorName・errorCause）で warn する',
      !!reach && reach.args.length === 2 && reach.args[1].errorName === 'TypeError' && reach.args[1].errorCause === 'ECONNRESET',
      network.logs.map((l) => l.args));
    check('トークン・例外の文言を応答にもログにも出さない（通信の失敗）', noCanary(network));

    // --- refresh_token はタイムアウト、access_token は受け付けた（access_token の失効で refresh_token も失効する） ---
    fake.tokenData = { refresh_token: REFRESH, access_token: ACCESS, expiry_date: 0 };
    google.respond = byToken({ refresh: aborted, access: ok200 });
    const either = await revoke();
    check('どちらかが受け付けられれば googleRevoked: true・success: true',
      either.status === 200 && either.body.success === true && either.body.googleRevoked === true, either.body);

    // --- access_token だけが保存されている ---
    fake.tokenData = { access_token: ACCESS };
    google.respond = ok200;
    const accessOnly = await revoke();
    check('access_token だけなら access_token を送り、refresh_token は skipped',
      accessOnly.body.googleRevoked === true && google.calls.length === 1 && google.calls[0].token === ACCESS &&
        sameJson(accessOnly.body.googleRevoke.refreshToken, { result: 'skipped' }), accessOnly.body);

    // --- Google が受け付けず、gmailState も消せない ---
    fake.tokenData = { refresh_token: REFRESH, access_token: ACCESS, expiry_date: 0 };
    google.respond = rejected400;
    fake.failStateDelete = true;
    const both = await revoke();
    check('gmailState を消せなければ 500 を優先し、googleRevoked: false と手動で外す案内も返す',
      both.status === 500 && both.body.success === false && both.body.watchStateCleared === false &&
        both.body.googleRevoked === false && String(both.body.error).includes(MANUAL), both.body);
    check('gmailState を消せなかった 500 にも stop の結果（watchStopped: true）を付ける', both.body.watchStopped === true, both.body);
    check('トークンを応答にもログにも出さない（gmailState も失敗）', noCanary(both));
    fake.failStateDelete = false;

    // --- 本当の時間切れ（AbortController の時間を短くして直接呼ぶ） ---
    google.calls = [];
    google.respond = (_token, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    const started = Date.now();
    const originalWarn = console.warn;
    console.warn = () => {};
    let direct;
    try {
      direct = await auth.revokeGmailTokenOnGoogle({ refresh_token: REFRESH, access_token: ACCESS }, 30);
    } finally {
      console.warn = originalWarn;
    }
    check('待ち時間を過ぎたら中断して timeout にする',
      direct && direct.revoked === false && direct.refreshToken.result === 'timeout' && direct.accessToken.result === 'timeout' &&
        Date.now() - started < 2000, direct);

    // --- stop の本当の時間切れ（応答の返らない stop。全体の上限を短くして直接呼ぶ） ---
    gmailStop.calls = [];
    gmailStop.respond = () => new Promise(() => {});
    const stopStarted = Date.now();
    const stopWarns = [];
    console.warn = (...args) => stopWarns.push(args);
    let stopDirect;
    try {
      stopDirect = await auth.stopGmailWatchOnGoogle({ refresh_token: REFRESH, access_token: ACCESS }, 30);
    } finally {
      console.warn = originalWarn;
    }
    check('stop が待ち時間を過ぎたら打ち切って false（応答が返らなくても待たない）',
      stopDirect === false && gmailStop.calls.length === 1 && Date.now() - stopStarted < 2000, stopDirect);
    check('stop の時間切れは固定文と TimeoutError で warn する',
      stopWarns.length === 1 && stopWarns[0][0] === 'Failed to stop Gmail watch before revoking the token' &&
        sameJson(stopWarns[0][1], { errorName: 'TimeoutError' }), stopWarns);
    const noTokenStop = [await auth.stopGmailWatchOnGoogle(undefined, 30), await auth.stopGmailWatchOnGoogle({ refresh_token: '', access_token: null }, 30)];
    check('トークンが無ければ stop は何も送らず null', sameJson(noTokenStop, [null, null]) && gmailStop.calls.length === 1, noTokenStop);
  } finally {
    globalThis.fetch = httpFetch;
    googleapis.gmail = realGmail;
    for (const [key, value] of [['GMAIL_CLIENT_ID', savedEnv.id], ['GMAIL_CLIENT_SECRET', savedEnv.secret], ['GMAIL_REDIRECT_URI', savedEnv.redirect]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.close();
  }
}

/**
 * 管理 API（/gmail/*）のレート制限
 *
 * - 接続元の IP（X-Forwarded-For の末尾。Google のフロントエンドが足す値）で数える（req.ip は Cloud Run では前段のアドレスにまとまる）
 * - 認証の前の枠は、認証に失敗する要求だけを数える。認証に成功する要求は数えも止めもしない
 * - 認証の後の枠（認証に成功した要求の上限）は別
 * - /callback 以外の全ルートに同じ並び（認証前の上限 → Admin 認証 → 認証後の上限）が付く。/callback は専用の上限
 *
 * limiter の数はプロセス内で共有されるので、ここの接続元（TEST-NET のアドレス）は revoke のテストと分けてある。
 */
async function rateLimitChecks() {
  console.log('\n管理 API のレート制限（接続元の IP = X-Forwarded-For の末尾。認証の前後で枠を分ける）');

  // テスト用のダミー値（本物の秘密値ではない）
  const SECRET = 'dummy-admin-secret-for-smoke';
  process.env.ADMIN_SECRET = SECRET;
  const LIMIT = 30;
  const CALLBACK_LIMIT = 20;

  const { gmailRouter, adminGuards, gmailCallbackLimiter } = require('../dist/gmail/adminRouter');

  // --- ルーターのスタックを走査する ---
  const routes = gmailRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({ path: layer.route.path, handles: layer.route.stack.map((s) => s.handle) }));
  const paths = routes.map((r) => r.path);
  const adminRoutes = routes.filter((r) => r.path !== '/callback');
  check('ルートを走査できる（/test-process・/revoke・/force-process を含む 9 本）',
    routes.length === 9 && ['/auth', '/callback', '/register-watch', '/status', '/refresh-token', '/revoke', '/process-latest',
      '/test-process', '/force-process/:messageId'].every((p) => paths.includes(p)), paths);
  check('adminGuards は 3 つ（認証前の上限 → Admin 認証 → 認証後の上限）',
    Array.isArray(adminGuards) && adminGuards.length === 3 && adminGuards[1].name === 'requireAdminAuth',
    adminGuards && adminGuards.map((g) => g.name));
  const unguarded = adminRoutes.filter(
    (r) => r.handles.length !== adminGuards.length + 1 || !adminGuards.every((guard, i) => r.handles[i] === guard)
  );
  check('/callback 以外の全ルートが adminGuards で始まり、その後はハンドラだけ', adminRoutes.length === 8 && unguarded.length === 0,
    unguarded.map((r) => r.path));
  const callback = routes.find((r) => r.path === '/callback');
  check('/callback は専用の上限で始まり、Admin 認証は付けない',
    !!callback && callback.handles[0] === gmailCallbackLimiter && callback.handles.every((h) => !adminGuards.includes(h)),
    callback && callback.handles.length);
  check('ルーター全体に掛かるミドルウェア（use）は無い（上限はルートごとに付ける）',
    gmailRouter.stack.every((layer) => layer.route), gmailRouter.stack.length);

  // --- 振る舞い（Firestore の参照は偽物。トークンは無い） ---
  auth.gmailTokenRef = () => ({ get: async () => ({ exists: false, data: () => undefined }), delete: async () => {} });
  watch.gmailStateRef = () => ({ delete: async () => {} });

  const app = express();
  app.use('/gmail', gmailRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base =`http://127.0.0.1:${server.address().port}/gmail`;
  // 1 回の要求の HTTP の状態（認証の失敗の warn は黙らせる）
  const send = async (path, { method = 'GET', xff, authorized = false } = {}) => {
    const headers = {};
    if (xff !== undefined) headers['X-Forwarded-For'] = xff;
    if (authorized) headers.Authorization = `Bearer ${SECRET}`;
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try {
      const res = await fetch(`${base}${path}`, { method, headers });
      await res.text();
      return res.status;
    } finally {
      Object.assign(console, saved);
    }
  };
  const revokeAs = (xff, authorized) => send('/revoke', { method: 'DELETE', xff, authorized });
  const times = async (n, fn) => {
    const statuses = [];
    for (let i = 0; i < n; i++) statuses.push(await fn(i));
    return statuses;
  };
  const all = (statuses, status) => statuses.every((s) => s === status);

  try {
    // 認証の無い連打。前に並ぶ値（クライアントが送れる部分）は毎回変える。末尾が接続元
    const A = '203.0.113.7';
    const flood = await times(LIMIT, (i) => revokeAs(`10.0.0.${i}, ${A}`, false));
    check('認証の無い要求は、接続元ごとに 30 回/分までは 401', all(flood, 401), flood);
    const over = await revokeAs(`10.9.9.9, 198.51.100.200, ${A}`, false);
    check('31 回目は 429（X-Forwarded-For の前の値を変えても、末尾が同じなら同じ枠）', over === 429, over);
    const otherClient = await revokeAs('198.51.100.7', false);
    check('末尾の違う接続元は別の枠（401。429 にならない）', otherClient === 401, otherClient);
    const adminOnExhausted = await revokeAs(`10.0.0.1, ${A}`, true);
    check('認証前の枠を使い切った接続元からでも、認証に成功する管理者の要求は 429 にならない（200）', adminOnExhausted === 200, adminOnExhausted);

    // 認証に成功した要求は、認証前の枠を使わない
    const B = '198.51.100.8';
    const failsBefore = await times(LIMIT - 1, () => revokeAs(B, false));
    const admins = await times(5, () => revokeAs(B, true));
    const lastFail = await revokeAs(B, false);
    const overFail = await revokeAs(B, false);
    check('認証に成功した要求は認証前の枠を数えない（29 回の失敗と 5 回の成功の後も、30 回目の失敗は 401）',
      all(failsBefore, 401) && all(admins, 200) && lastFail === 401, { failsBefore: failsBefore.length, admins, lastFail });
    check('その次の失敗は 429', overFail === 429, overFail);

    // 認証の後の枠（認証に成功した要求の上限。接続元ごと）
    const C = '192.0.2.77';
    const authed = await times(LIMIT, () => revokeAs(C, true));
    const authedOver = await revokeAs(C, true);
    const authedOther = await revokeAs('192.0.2.78', true);
    check('認証に成功した要求は、接続元ごとに 30 回/分までは通る', all(authed, 200), authed);
    check('認証後の上限を超えたら 429', authedOver === 429, authedOver);
    check('認証後の上限も接続元ごとに分かれる', authedOther === 200, authedOther);

    // /callback（Admin 認証なし。接続元ごとに 5 分で 20 回）
    const D = '203.0.113.20';
    const callbacks = await times(CALLBACK_LIMIT, () => send('/callback', { xff: D }));
    const callbackOver = await send('/callback', { xff: D });
    const callbackOther = await send('/callback', { xff: '203.0.113.21' });
    check('/callback は接続元ごとに 20 回まで（code が無いので 400）', all(callbacks, 400), callbacks);
    check('/callback の 21 回目は 429・別の接続元は 400（接続元ごとの枠）', callbackOver === 429 && callbackOther === 400,
      { callbackOver, callbackOther });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * トークンの保存（auth.ts）。OAuth のコールバックの初回保存は文書を作り、アクセストークンの更新の保存は
 * 文書があるときだけ書く（更新の途中で revoke に消された文書を作り直さない）
 *
 * Firestore は偽物（firebase-admin/firestore の getFirestore を差し替える。update は文書が無ければ NOT_FOUND〔code 5〕で
 * 失敗する、実物と同じ振る舞い）。Google の OAuth（getToken・refreshAccessToken）も偽物で、通信はしない。
 */
async function tokenSaveChecks() {
  console.log('\nトークンの保存（Firestore と Google の OAuth は偽物）');

  const TOKEN_PATH = 'system/gmailToken';
  // 目印。NOT_FOUND の文言（文書のパスが入る）に入れ、ログに出ないことを確かめる
  const CANARY = 'CANARY-token-save-5c1e';
  const store = new Map();
  const docRef = (path) => ({
    get: async () => ({ exists: store.has(path), data: () => (store.has(path) ? { ...store.get(path) } : undefined) }),
    set: async (data) => {
      store.set(path, { ...data });
    },
    update: async (data) => {
      if (!store.has(path)) {
        throw Object.assign(new Error(`5 NOT_FOUND: No document to update: projects/demo/databases/(default)/documents/${path} ${CANARY}`), {
          code: 5,
        });
      }
      store.set(path, { ...store.get(path), ...data });
    },
    delete: async () => {
      store.delete(path);
    },
  });
  const fakeDb = { collection: (c) => ({ doc: (d) => docRef(`${c}/${d}`) }) };

  const firestoreModule = require('firebase-admin/firestore');
  const { google } = require('googleapis');
  const proto = google.auth.OAuth2.prototype;
  const original = {
    getFirestore: firestoreModule.getFirestore,
    getToken: proto.getToken,
    refreshAccessToken: proto.refreshAccessToken,
    env: { id: process.env.GMAIL_CLIENT_ID, secret: process.env.GMAIL_CLIENT_SECRET, redirect: process.env.GMAIL_REDIRECT_URI },
  };
  // テスト用のダミー値（本物の秘密値ではない）
  process.env.GMAIL_CLIENT_ID = 'dummy-client-id-for-smoke';
  process.env.GMAIL_CLIENT_SECRET = 'dummy-client-secret-for-smoke';
  process.env.GMAIL_REDIRECT_URI = 'http://127.0.0.1/dummy-callback';

  const oauth = { refreshCalls: 0, onRefresh: null };
  firestoreModule.getFirestore = () => fakeDb;
  proto.getToken = async () => ({
    tokens: {
      access_token: 'ya29.initial',
      refresh_token: '1//initial',
      expiry_date: Date.now() + 3600 * 1000,
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    },
  });
  proto.refreshAccessToken = async () => {
    oauth.refreshCalls++;
    if (oauth.onRefresh) await oauth.onRefresh();
    return {
      credentials: {
        access_token: 'ya29.refreshed',
        expiry_date: Date.now() + 3600 * 1000,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      },
    };
  };

  // console.log / warn / error を util.format の形で集める
  const withLogs = async (fn) => {
    const logs = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    for (const level of Object.keys(saved)) {
      console[level] = (...args) => logs.push({ level, args, text: util.format(...args) });
    }
    try {
      return { value: await fn(), logs };
    } catch (error) {
      return { error, logs };
    } finally {
      Object.assign(console, saved);
    }
  };
  const expiredToken = () => ({
    access_token: 'ya29.old',
    refresh_token: '1//initial',
    expiry_date: 0, // 期限切れ（getGmailClient が更新する）
    token_type: 'Bearer',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
  });

  try {
    // --- 初回の保存（OAuth のコールバック。トークンの文書はまだ無い） ---
    store.clear();
    store.set('system/oauthState', { state: 'smoke-state', adminVerified: true, expiresAt: { toMillis: () => Date.now() + 60_000 } });
    const initial = await withLogs(() => auth.handleOAuthCallback('smoke-code', 'smoke-state'));
    const saved = store.get(TOKEN_PATH);
    check('初回の保存（OAuth のコールバック）は、文書が無くても作る',
      !initial.error && !!saved && saved.access_token === 'ya29.initial' && saved.refresh_token === '1//initial' && !!saved.updatedAt,
      { error: initial.error && initial.error.name, saved });

    // --- 既存の文書の更新（従来どおり） ---
    store.set(TOKEN_PATH, { ...expiredToken(), updatedAt: 'before' });
    oauth.refreshCalls = 0;
    oauth.onRefresh = null;
    const refreshed = await withLogs(() => auth.getGmailClient());
    const updated = store.get(TOKEN_PATH);
    check('期限切れなら更新し、既存の文書に新しいアクセストークンを書く（refresh_token は変えない）',
      !refreshed.error && oauth.refreshCalls === 1 && !!updated && updated.access_token === 'ya29.refreshed' &&
        updated.refresh_token === '1//initial' && updated.expiry_date > Date.now() && updated.updatedAt !== 'before',
      { error: refreshed.error && refreshed.error.name, updated });

    // --- 更新の途中で revoke がトークンの文書を消した ---
    store.set(TOKEN_PATH, expiredToken());
    oauth.refreshCalls = 0;
    oauth.onRefresh = async () => {
      store.delete(TOKEN_PATH);
    };
    const raced = await withLogs(() => auth.getGmailClient());
    check('更新の保存は、文書が消えていたら作り直さない', !store.has(TOKEN_PATH), store.get(TOKEN_PATH));
    check('そのときは GmailTokenDeletedError を投げる（取込を失敗させ、再送でトークンが無いと分かって終える）',
      oauth.refreshCalls === 1 && !!raced.error && raced.error.name === 'GmailTokenDeletedError',
      raced.error ? raced.error.name : 'resolved');
    const deletedLog = raced.logs.find((l) => l.level === 'warn' && l.args[0] === 'Gmail token was deleted while refreshing it; not recreating it (revoked)');
    check('固定文だけで warn し、NOT_FOUND の文言（文書のパス）を出さない',
      !!deletedLog && deletedLog.args.length === 1 && raced.logs.every((l) => !l.text.includes(CANARY)),
      raced.logs.map((l) => l.text));
  } finally {
    firestoreModule.getFirestore = original.getFirestore;
    proto.getToken = original.getToken;
    proto.refreshAccessToken = original.refreshAccessToken;
    for (const [key, value] of [['GMAIL_CLIENT_ID', original.env.id], ['GMAIL_CLIENT_SECRET', original.env.secret], ['GMAIL_REDIRECT_URI', original.env.redirect]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

(async () => {
  for (const [name, fn] of [['revoke', revokeChecks], ['レート制限', rateLimitChecks], ['トークンの保存', tokenSaveChecks]]) {
    try {
      await fn();
    } catch (error) {
      failed++;
      console.log(`  FAIL ${name} のチェックが例外で止まった`, error && error.name);
    }
  }
})()
  .then(() => {
    if (failed > 0) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log('\nAll checks passed');
    process.exit(0);
  });
