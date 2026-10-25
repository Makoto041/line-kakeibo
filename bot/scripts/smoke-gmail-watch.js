/**
 * Gmail watch の状態（system/gmailState）まわりのスモークテスト（Firestore は使わない）
 *
 * - resolveWatchHistoryId: watch の登録・更新で保存する historyId の決め方
 * - watchStateFields: そのとき merge で書く項目（保存値を残すときは historyId を書かない）
 * - DELETE /gmail/revoke: gmailState を消せなかったら握り潰さず 500 で返す（Firestore の参照は偽物）
 *
 * Firestore を使う確認（トランザクション・merge・renewWatch が stop を呼ばないこと）は
 * emulator-gmail-import.js（npm -w bot run test:emulator）。
 *
 *   node bot/scripts/smoke-gmail-watch.js
 */
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
  console.log('\nDELETE /gmail/revoke（Firestore の参照は偽物）');

  // テスト用のダミー値（本物の秘密値ではない）
  const SECRET = 'dummy-admin-secret-for-smoke';
  process.env.ADMIN_SECRET = SECRET;

  // adminRouter は ./index 経由（getter で再エクスポート）で参照を引くため、各モジュールの exports を差し替える
  const fake = { tokenDeletes: 0, stateDeletes: 0, failStateDelete: false };
  auth.gmailTokenRef = () => ({
    get: async () => ({ exists: false, data: () => undefined }), // access_token が無ければ Google へは送らない
    delete: async () => {
      fake.tokenDeletes++;
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

  const { gmailRouter } = require('../dist/gmail/adminRouter');
  const app = express();
  app.use('/gmail', gmailRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/gmail/revoke`;
  const revoke = async () => {
    const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${SECRET}` } });
    return { status: res.status, body: await res.json() };
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    const ok = await revoke();
    check('消せたら 200・success: true・watchStateCleared: true',
      ok.status === 200 && ok.body.success === true && ok.body.watchStateCleared === true && typeof ok.body.message === 'string', ok);
    check('トークンと gmailState の両方を消す', fake.tokenDeletes === 1 && fake.stateDeletes === 1, fake);

    fake.failStateDelete = true;
    const ng = await revoke();
    check('gmailState を消せなかったら 500・success: false・watchStateCleared: false',
      ng.status === 500 && ng.body.success === false && ng.body.watchStateCleared === false && typeof ng.body.error === 'string', ng);
    check('失敗の応答に例外の中身を出さない', !JSON.stringify(ng.body).includes('must not be logged'), ng.body);
    const warned = warnings.find((args) => args[0] === 'Failed to delete Gmail watch state on revoke');
    check('固定文と errorName だけで warn する',
      !!warned && warned.length === 2 && JSON.stringify(warned[1]) === JSON.stringify({ errorName: 'FakeFirestoreError' }), warnings);

    fake.failStateDelete = false;
    const retry = await revoke();
    check('やり直せば消せる（トークンが無くても進む）', retry.status === 200 && retry.body.watchStateCleared === true, retry);
  } finally {
    console.warn = originalWarn;
    server.close();
  }
}

revokeChecks()
  .catch((error) => {
    failed++;
    console.log('  FAIL revoke のチェックが例外で止まった', error && error.name);
  })
  .then(() => {
    if (failed > 0) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log('\nAll checks passed');
    process.exit(0);
  });
