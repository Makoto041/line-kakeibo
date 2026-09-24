/**
 * /household API と精算額の共有関数のスモークテスト（Firestore には接続しない）
 *
 *   node bot/scripts/smoke-household-api.js
 *
 * ルーター・認証・Firestore を通した確認はエミュレータの統合テスト
 * （bot/scripts/emulator-household-api.js）で行う。
 */
const assert = require('assert');
const { decideConfirm, isPendingStatus, SETTLED_REJECTION } = require('../dist/expenseActions');
const {
  computeHouseholdSettlement,
  sortActiveMembers,
  isSettlementComputable,
} = require('../dist/householdSettlement');
const { calculateSettlement } = require('../dist/firestore');
const {
  isValidDocId,
  isPlainObject,
  parseExpectedExpenseIds,
  sameIdSet,
  parseExpectedSettlement,
  sameSettlement,
  authorizeExpenseWrite,
  householdErrorHandler,
  MAX_SETTLE_IDS,
} = require('../dist/householdApi');
const { isAllowedWebOrigin } = require('../dist/webOrigins');

let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function deepEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
console.log('decideConfirm（LINE の OK と同じ判定）');

/** リファクタ前の postback.ts handleConfirm のクロージャ（比較用の写し） */
function legacyConfirm(data) {
  const status = data.status;
  const isPending = !status || status === 'pending';
  return isPending
    ? {
        update: { confirmed: true, status: 'shared', includeInTotal: true, updatedAt: new Date() },
        cardPatch: { status: 'shared', includeInTotal: true },
      }
    : {
        update: { confirmed: true, updatedAt: new Date() },
        cardPatch: {},
      };
}

/** updatedAt（生成時刻）は Date であることだけ確かめて比較から外す */
function comparable(decision) {
  const { updatedAt, ...rest } = decision.update;
  return { update: rest, cardPatch: decision.cardPatch, updatedAtIsDate: updatedAt instanceof Date };
}

const statuses = [undefined, null, '', 'pending', 'shared', 'personal', 'advance_pending', 'advance_settled'];
for (const status of statuses) {
  const data = { status, amount: 1000, includeInTotal: false };
  const actual = decideConfirm()(data);
  const expected = legacyConfirm(data);
  check(
    `status=${JSON.stringify(status)} は従来と同じ更新内容`,
    !('reject' in actual) && deepEqual(comparable(actual), comparable(expected)),
    JSON.stringify(actual)
  );
}
{
  const d = decideConfirm()({});
  check('status なし（LINE 手入力）→ shared・計上・確認済み', d.update.status === 'shared' && d.update.includeInTotal === true && d.update.confirmed === true);
  const s = decideConfirm()({ status: 'advance_settled' });
  check('精算済みは拒否せず確認済みにするだけ', !('reject' in s) && deepEqual(Object.keys(s.update).sort(), ['confirmed', 'updatedAt']));
  const p = decideConfirm()({ status: 'personal' });
  check('個人費は共同費へ巻き戻さない', p.update.status === undefined && deepEqual(p.cardPatch, {}));
}
check('isPendingStatus: 無し / pending は未確認', isPendingStatus(undefined) && isPendingStatus('pending') && isPendingStatus(''));
check('isPendingStatus: shared は確認済み', !isPendingStatus('shared') && !isPendingStatus('advance_settled'));
check('SETTLED_REJECTION の文言は従来どおり', SETTLED_REJECTION === '精算済みのため変更できません');

// ------------------------------------------------------------
console.log('\ncomputeHouseholdSettlement（精算額・Q15/Q17）');

const summary = (userId, total, name = userId.toUpperCase()) => ({
  userId,
  userDisplayName: name,
  totalAdvanced: total,
  expenses: [],
});
const member = (lineId, displayName = `${lineId}さん`) => ({ lineId, displayName });

{
  const r = computeHouseholdSettlement([], [member('a'), member('b')]);
  check('立替なし → none・金額なし', r.basis === 'none' && r.settlement === null && r.reason === null);
  check('立替なしでもメンバーは 0 円で並ぶ', deepEqual(r.participants.map((p) => [p.userId, p.totalAdvanced]), [['a', 0], ['b', 0]]));
}
{
  const r = computeHouseholdSettlement([summary('a', 12400), summary('b', 4000)], [member('a'), member('b')]);
  check('2人とも立替 → pair', r.basis === 'pair');
  check('少ない方 → 多い方へ差額の半分（b → a ¥4,200）', r.settlement && r.settlement.fromUserId === 'b' && r.settlement.toUserId === 'a' && r.settlement.amount === 4200, JSON.stringify(r.settlement));
  check('pair は既存の calculateSettlement と同じ結果', deepEqual(r.settlement, calculateSettlement([summary('a', 12400), summary('b', 4000)])));
  check('名前はメンバーの表示名を優先', r.participants[0].displayName === 'aさん');
}
{
  const r = computeHouseholdSettlement([summary('a', 5000), summary('b', 5000)], [member('a'), member('b')]);
  check('差額 0 → pair・settlement は null（精算不要）', r.basis === 'pair' && r.settlement === null);
}
{
  const r = computeHouseholdSettlement([summary('a', 1001), summary('b', 900)], [member('a'), member('b')]);
  check('奇数の差額は Math.round（101/2 → 51）', r.settlement && r.settlement.amount === 51, JSON.stringify(r.settlement));
}
{
  const r = computeHouseholdSettlement([summary('a', 10000)], [member('a'), member('b', 'ゆい')]);
  check('1人だけ立替・メンバー2人 → single_advancer（Q15）', r.basis === 'single_advancer' && r.reason === null);
  check('相手を 0 円で補う（b → a ¥5,000）', r.settlement && r.settlement.fromUserId === 'b' && r.settlement.toUserId === 'a' && r.settlement.amount === 5000, JSON.stringify(r.settlement));
  check('補った相手の名前はメンバーの表示名', r.settlement && r.settlement.fromUserName === 'ゆい');
  check('LINE でも金額を出す（isSettlementComputable）', isSettlementComputable(r.basis));
}
{
  const r = computeHouseholdSettlement([summary('a', 10000)], [member('a')]);
  check('1人だけ立替・メンバーは本人だけ → undeterminable / partner_unknown（Q17）', r.basis === 'undeterminable' && r.reason === 'partner_unknown' && r.settlement === null);
  check('計算できないときは金額を出さない', !isSettlementComputable(r.basis));
}
{
  const r = computeHouseholdSettlement([summary('a', 10000)], []);
  check('1人だけ立替・メンバー0人 → partner_unknown', r.basis === 'undeterminable' && r.reason === 'partner_unknown');
}
{
  const r = computeHouseholdSettlement([summary('x', 10000)], [member('a'), member('b')]);
  check('立替者がメンバー外（メンバー2人）→ more_than_two', r.basis === 'undeterminable' && r.reason === 'more_than_two' && r.settlement === null);
  check('メンバー外の立替者は isMember:false で末尾', deepEqual(r.participants.map((p) => [p.userId, p.isMember]), [['a', true], ['b', true], ['x', false]]));
}
{
  // 脱退した・登録していない相手だけが立て替えている（関係者は 2 人だが、有効メンバーは 1 人）
  const r = computeHouseholdSettlement([summary('left', 3000)], [member('a')]);
  check('メンバー1人・メンバー外の1人だけが立替 → partner_unknown（相手を補わない）', r.basis === 'undeterminable' && r.reason === 'partner_unknown' && r.settlement === null, JSON.stringify(r));
  const line = computeHouseholdSettlement([summary('left', 3000)], [member('a')], { legacyPair: true });
  check('同上（LINE）も金額なし（従来どおり）', line.basis === 'undeterminable' && line.settlement === null);
}
{
  const r = computeHouseholdSettlement([summary('a', 3000), summary('b', 1000)], [member('a'), member('b'), member('c')]);
  check('メンバー3人・2人が立替 → Web は more_than_two（金額なし。Q17）', r.basis === 'undeterminable' && r.reason === 'more_than_two');
  const line = computeHouseholdSettlement([summary('a', 3000), summary('b', 1000)], [member('a'), member('b'), member('c')], { legacyPair: true });
  check('同上（LINE）は pair（従来どおり b → a ¥1,000）', line.basis === 'pair' && line.settlement && line.settlement.fromUserId === 'b' && line.settlement.amount === 1000, JSON.stringify(line.settlement));
}
{
  const r = computeHouseholdSettlement([summary('a', 3000), summary('b', 1000), summary('c', 500)], []);
  check('立替者3人 → more_than_two', r.basis === 'undeterminable' && r.reason === 'more_than_two');
  const line = computeHouseholdSettlement([summary('a', 3000), summary('b', 1000), summary('c', 500)], [member('a'), member('b')], { legacyPair: true });
  check('立替者3人（LINE）も金額なし（従来どおり）', line.basis === 'undeterminable' && line.settlement === null);
}
{
  // LINE でパートナーがボタンだけ押していて groupMembers に居ない / 脱退済み / groups 文書が無い場合
  const r = computeHouseholdSettlement([summary('a', 3000), summary('b', 1000)], [member('a')]);
  check('2人とも立替・メンバー登録が1人 → Web は partner_unknown', r.basis === 'undeterminable' && r.reason === 'partner_unknown');
  const r0 = computeHouseholdSettlement([summary('a', 3000), summary('b', 1000)], []);
  check('2人とも立替・メンバー0人 → Web は partner_unknown', r0.basis === 'undeterminable' && r0.reason === 'partner_unknown');
  const line = computeHouseholdSettlement([summary('a', 3000), summary('b', 1000)], [member('a')], { legacyPair: true });
  check('2人とも立替・メンバー登録が1人（LINE）は pair（従来どおり）', line.basis === 'pair' && line.settlement && line.settlement.amount === 1000);
  const line0 = computeHouseholdSettlement([summary('a', 3000), summary('b', 1000)], [], { legacyPair: true });
  check('2人とも立替・メンバー0人（LINE。読み込み失敗・groups 無し）は pair', line0.basis === 'pair' && line0.settlement && line0.settlement.amount === 1000);
  check('LINE の pair は既存の calculateSettlement と同じ', deepEqual(line0.settlement, calculateSettlement([summary('a', 3000), summary('b', 1000)])));
}
{
  // LINE でも Q15 は Web と同じ条件
  const line = computeHouseholdSettlement([summary('a', 10000)], [member('a'), member('b', 'ゆい')], { legacyPair: true });
  check('1人だけ立替・メンバー2人（LINE）→ single_advancer（Q15）', line.basis === 'single_advancer' && line.settlement && line.settlement.amount === 5000 && line.settlement.fromUserName === 'ゆい');
  const lineOut = computeHouseholdSettlement([summary('x', 10000)], [member('a'), member('b')], { legacyPair: true });
  check('立替者がメンバー外（LINE）は金額なし', lineOut.basis === 'undeterminable' && lineOut.settlement === null);
  const line1 = computeHouseholdSettlement([summary('a', 10000)], [member('a')], { legacyPair: true });
  check('1人だけ立替・メンバー1人（LINE）は金額なし（従来どおり）', line1.basis === 'undeterminable' && line1.settlement === null);
}
{
  const r = computeHouseholdSettlement([summary('a', 100)], [member('a'), member('a', '重複'), member('b')]);
  check('メンバーの lineId 重複は 1 人として数える', r.basis === 'single_advancer' && r.participants.length === 2);
}

// ------------------------------------------------------------
console.log('\nsortActiveMembers');
{
  const ts = (ms) => ({ toMillis: () => ms });
  const sorted = sortActiveMembers([
    { groupId: 'g', lineId: 'b', displayName: 'B', joinedAt: ts(2000), isActive: true },
    { groupId: 'g', lineId: 'a', displayName: '', joinedAt: ts(1000), isActive: true },
    { groupId: 'g', lineId: 'a', displayName: 'A', joinedAt: ts(3000), isActive: true },
    { groupId: 'g', lineId: 'c', displayName: 'C', joinedAt: ts(500), isActive: false },
    { groupId: 'g', lineId: 'd', displayName: 'D', isActive: true },
  ]);
  check('joinedAt 昇順・重複除去・脱退者除外・joinedAt 無しは末尾', deepEqual(sorted.map((m) => m.lineId), ['a', 'b', 'd']), JSON.stringify(sorted));
  check('重複した文書の表示名で空を補う', sorted[0].displayName === 'A');
}

// ------------------------------------------------------------
console.log('\n入力検証');
check('通常の ID は可', isValidDocId('abcDEF123_-') && isValidDocId('a'.repeat(128)));
check('129 文字は不可', !isValidDocId('a'.repeat(129)));
check('空・文字列以外は不可', !isValidDocId('') && !isValidDocId(123) && !isValidDocId(['a']) && !isValidDocId(undefined));
check('/ を含むと不可', !isValidDocId('a/b') && !isValidDocId('/'));
check('. と .. は不可', !isValidDocId('.') && !isValidDocId('..'));
check('__…__ は不可', !isValidDocId('__name__') && !isValidDocId('____') && isValidDocId('__a') && isValidDocId('a__'));
check('isPlainObject: オブジェクトだけ', isPlainObject({ a: 1 }) && !isPlainObject([]) && !isPlainObject(null) && !isPlainObject('x'));
check('expectedExpenseIds: 重複を除く', deepEqual(parseExpectedExpenseIds(['a', 'b', 'a']), ['a', 'b']));
check('expectedExpenseIds: 空配列は可', deepEqual(parseExpectedExpenseIds([]), []));
check('expectedExpenseIds: 配列以外は不可', parseExpectedExpenseIds('a') === null && parseExpectedExpenseIds(undefined) === null);
check('expectedExpenseIds: 文字列以外の要素は不可', parseExpectedExpenseIds(['a', 1]) === null);
check('expectedExpenseIds: 不正な ID は不可', parseExpectedExpenseIds(['a/b']) === null && parseExpectedExpenseIds(['..']) === null);
check(`expectedExpenseIds: ${MAX_SETTLE_IDS} 件までは可`, parseExpectedExpenseIds(Array.from({ length: MAX_SETTLE_IDS }, (_, i) => `e${i}`)).length === MAX_SETTLE_IDS);
check(`expectedExpenseIds: ${MAX_SETTLE_IDS + 1} 件は不可`, parseExpectedExpenseIds(Array.from({ length: MAX_SETTLE_IDS + 1 }, (_, i) => `e${i}`)) === null);
check('sameIdSet: 順序は無視', sameIdSet(['a', 'b'], ['b', 'a']));
check('sameIdSet: 過不足は不一致', !sameIdSet(['a', 'b'], ['a']) && !sameIdSet(['a'], ['a', 'c']) && !sameIdSet(['a', 'b'], ['a', 'c']));
check('expectedSettlement: null は可（精算額なし）', parseExpectedSettlement(null) === null);
check('expectedSettlement: 正しい形は可', deepEqual(parseExpectedSettlement({ fromUserId: 'b', toUserId: 'a', amount: 4200, extra: 1 }), { fromUserId: 'b', toUserId: 'a', amount: 4200 }));
check('expectedSettlement: 金額が文字列・負・小数は不可', ['4200', -1, 1.5, NaN, Infinity].every((amount) => parseExpectedSettlement({ fromUserId: 'b', toUserId: 'a', amount }) === 'invalid'));
check('expectedSettlement: ID が不正・欠けていれば不可', parseExpectedSettlement({ fromUserId: 'a/b', toUserId: 'a', amount: 1 }) === 'invalid' && parseExpectedSettlement({ toUserId: 'a', amount: 1 }) === 'invalid');
check('expectedSettlement: 配列・文字列は不可', parseExpectedSettlement([]) === 'invalid' && parseExpectedSettlement('x') === 'invalid');
check('sameSettlement: null 同士は一致・片方だけ null は不一致', sameSettlement(null, null) && !sameSettlement(null, { fromUserId: 'b', toUserId: 'a', amount: 1 }));
check('sameSettlement: 向き・金額が違えば不一致', !sameSettlement({ fromUserId: 'b', toUserId: 'a', amount: 1 }, { fromUserId: 'a', toUserId: 'b', amount: 1 }) && !sameSettlement({ fromUserId: 'b', toUserId: 'a', amount: 1 }, { fromUserId: 'b', toUserId: 'a', amount: 2 }));

// ------------------------------------------------------------
console.log('\nauthorizeExpenseWrite（偽のトランザクション）');
(async () => {
  const members = {
    g1_me: { groupId: 'g1', lineId: 'me', isActive: true },
    g1_left: { groupId: 'g1', lineId: 'left', isActive: false },
    // 世帯 g1_x のメンバー mallory の文書。ID は lineId が x_mallory の人の g1 の文書 ID と同じになる
    g1_x_mallory: { groupId: 'g1_x', lineId: 'mallory', isActive: true },
    // groupId / lineId の無い文書（決定的 ID と中身が照合できない）
    g1_nofields: { isActive: true },
  };
  const reads = [];
  const fakeDb = {
    collection: (name) => ({
      doc: (id) => ({ path: `${name}/${id}`, id }),
    }),
  };
  const fakeTx = {
    get: async (ref) => {
      reads.push(ref.path);
      const d = members[ref.id];
      return { exists: !!d, get: (f) => (d ? d[f] : undefined) };
    },
  };

  check('有効メンバーは可', (await authorizeExpenseWrite(fakeTx, fakeDb, { groupId: 'g1', lineId: 'other' }, 'me')) === true);
  check('メンバー文書はトランザクションで読む', reads.includes('groupMembers/g1_me'));
  check('脱退者（isActive:false）は不可', (await authorizeExpenseWrite(fakeTx, fakeDb, { groupId: 'g1', lineId: 'left' }, 'left')) === false);
  check('メンバー外は不可（所有者でも）', (await authorizeExpenseWrite(fakeTx, fakeDb, { groupId: 'g1', lineId: 'stranger' }, 'stranger')) === false);
  check('個人支出の所有者は可', (await authorizeExpenseWrite(fakeTx, fakeDb, { lineId: 'me' }, 'me')) === true);
  check('個人支出の他人は不可', (await authorizeExpenseWrite(fakeTx, fakeDb, { lineId: 'me' }, 'other')) === false);
  check('lineGroupId だけの旧形式は不可（所有者でも）', (await authorizeExpenseWrite(fakeTx, fakeDb, { lineId: 'me', lineGroupId: 'C1' }, 'me')) === false);
  check('文書 ID が一致しても中身の groupId・lineId が違えば不可', (await authorizeExpenseWrite(fakeTx, fakeDb, { groupId: 'g1', lineId: 'x' }, 'x_mallory')) === false);
  check('groupId・lineId の無いメンバー文書は不可', (await authorizeExpenseWrite(fakeTx, fakeDb, { groupId: 'g1', lineId: 'x' }, 'nofields')) === false);
  check('不正な groupId は読まずに不可', (await authorizeExpenseWrite(fakeTx, fakeDb, { groupId: 'a/b', lineId: 'me' }, 'me')) === false && !reads.some((p) => p.includes('a/b')));

  // ------------------------------------------------------------
  console.log('\nisAllowedWebOrigin');
  delete process.env.WEB_ORIGINS;
  check('本番は可', isAllowedWebOrigin('https://line-kakeibo.vercel.app'));
  check('localhost:3000 は可', isAllowedWebOrigin('http://localhost:3000'));
  check('プレビューは可', isAllowedWebOrigin('https://line-kakeibo-git-feat-x.vercel.app'));
  check('他のオリジンは不可', !isAllowedWebOrigin('https://evil.example.com') && !isAllowedWebOrigin('https://line-kakeibo.vercel.app.evil.com'));
  check('オリジン無しは不可', !isAllowedWebOrigin(undefined) && !isAllowedWebOrigin(''));
  process.env.WEB_ORIGINS = 'https://example.test';
  check('WEB_ORIGINS で上書き', isAllowedWebOrigin('https://example.test') && !isAllowedWebOrigin('http://localhost:3000'));
  delete process.env.WEB_ORIGINS;

  // ------------------------------------------------------------
  console.log('\nhouseholdErrorHandler（JSON の解析エラーにも CORS を付ける）');
  function fakeRes() {
    return {
      headers: {},
      statusCode: 200,
      body: undefined,
      headersSent: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(code) { this.statusCode = code; return this; },
      json(b) { this.body = b; this.headersSent = true; return this; },
    };
  }
  {
    const res = fakeRes();
    const parseError = Object.assign(new SyntaxError('Unexpected token'), { status: 400, type: 'entity.parse.failed' });
    householdErrorHandler(parseError, { headers: { origin: 'https://line-kakeibo.vercel.app' }, method: 'POST' }, res, () => {});
    check('解析エラーは 400 invalid_request', res.statusCode === 400 && deepEqual(res.body, { error: 'invalid_request' }));
    check('許可オリジンなら ACAO が付く', res.headers['access-control-allow-origin'] === 'https://line-kakeibo.vercel.app');
    check('Authorization ヘッダーを許可', String(res.headers['access-control-allow-headers']).includes('Authorization'));
    check('Cache-Control: no-store', res.headers['cache-control'] === 'no-store');
  }
  {
    const res = fakeRes();
    householdErrorHandler(new Error('boom'), { headers: { origin: 'https://evil.example.com' }, method: 'POST' }, res, () => {});
    check('その他の例外は 500 internal', res.statusCode === 500 && deepEqual(res.body, { error: 'internal' }));
    check('許可外のオリジンには ACAO を付けない', res.headers['access-control-allow-origin'] === undefined);
  }

  // postback が共有関数を読み込めること（require 時に落ちない）
  check('line/postback.js が読み込める', typeof require('../dist/line/postback').handlePostback === 'function');

  console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
