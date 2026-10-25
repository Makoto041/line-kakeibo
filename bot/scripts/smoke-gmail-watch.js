/**
 * Gmail watch の登録・更新で保存する historyId の決め方（resolveWatchHistoryId）のスモークテスト
 * Firestore を使う確認は emulator-gmail-import.js
 *
 *   node bot/scripts/smoke-gmail-watch.js
 */
const { resolveWatchHistoryId } = require('../dist/gmail/watch');

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

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
