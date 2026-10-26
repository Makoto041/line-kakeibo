/**
 * Gmail watch の状態（system/gmailState）まわりのスモークテスト（Firestore は使わない）
 *
 * - resolveWatchHistoryId: watch の登録・更新で保存する historyId の決め方
 * - watchStateFields: そのとき merge で書く項目（保存値を残すときは historyId を書かない）
 * - DELETE /gmail/revoke: gmailState を消せなかったら握り潰さず 500 で返す（Firestore の参照は偽物）
 * - DELETE /gmail/revoke: Google 側の失効（#284。Google の失効先は fetch の偽物）。refresh_token を先に本文（form）で送り、
 *   URL にトークンを載せない。Google が受け付けなければ googleRevoked: false・success: false（トークンは消す）。
 *   トークン・Google の応答の本文・例外の文言（目印 CANARY）を応答にもログにも出さない
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

  // adminRouter は ./index 経由（getter で再エクスポート）で参照を引くため、各モジュールの exports を差し替える
  // tokenData が undefined なら文書が無い（トークンが無ければ Google へは送らない）
  const fake = { tokenData: undefined, tokenDeletes: 0, stateDeletes: 0, failStateDelete: false };
  auth.gmailTokenRef = () => ({
    get: async () => ({ exists: fake.tokenData !== undefined, data: () => fake.tokenData }),
    delete: async () => {
      fake.tokenDeletes++;
      fake.tokenData = undefined;
    },
  });
  watch.gmailStateRef = () => ({
    delete: async () => {
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
    google.calls.push({
      url,
      method: init.method,
      contentType: new Headers(init.headers).get('content-type'),
      token: new URLSearchParams(body).get('token'),
    });
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

  const { gmailRouter } = require('../dist/gmail/adminRouter');
  const app = express();
  app.use('/gmail', gmailRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/gmail/revoke`;

  // 1 回の DELETE /gmail/revoke。その間の console.log / warn / error を util.format の形で集める
  const revoke = async () => {
    fake.tokenDeletes = 0;
    fake.stateDeletes = 0;
    google.calls = [];
    const logs = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const level of Object.keys(original)) {
      console[level] = (...args) => logs.push({ level, args, text: util.format(...args) });
    }
    try {
      const res = await httpFetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${SECRET}` } });
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

    fake.failStateDelete = true;
    const ng = await revoke();
    check('gmailState を消せなかったら 500・success: false・watchStateCleared: false',
      ng.status === 500 && ng.body.success === false && ng.body.watchStateCleared === false && typeof ng.body.error === 'string', ng);
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
  } finally {
    globalThis.fetch = httpFetch;
    server.close();
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
  for (const [name, fn] of [['revoke', revokeChecks], ['トークンの保存', tokenSaveChecks]]) {
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
