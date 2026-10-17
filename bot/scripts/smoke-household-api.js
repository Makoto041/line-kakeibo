/**
 * /household API と、LINE の postback と共有する判定のスモークテスト（Firestore には接続しない）
 *
 *   node bot/scripts/smoke-household-api.js
 *
 * ルーター・認証・Firestore を通した確認はエミュレータの統合テスト
 * （bot/scripts/emulator-household-api.js）で行う。
 */
const assert = require('assert');
const {
  decideClearAdvance,
  decideConfirm,
  decideSetPayer,
  isPendingStatus,
  SETTLED_REJECTION,
} = require('../dist/expenseActions');
const { sortActiveMembers, readActiveMember } = require('../dist/householdMembers');
const {
  isValidDocId,
  isPlainObject,
  parseExpectedExpenseIds,
  sameIdSet,
  parseSummaryPeriod,
  authorizeExpenseWrite,
  householdErrorHandler,
  clientIpKey,
  parseCollectFromLineId,
  MAX_CLEAR_IDS,
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
console.log('\ndecideSetPayer（LINE の［自分が払った］）');
{
  const payer = { lineId: 'U1', displayName: 'まこと' };
  const isFieldDelete = (v) => v && typeof v === 'object' && v.constructor && v.constructor.name.includes('Transform');
  const pending = decideSetPayer(payer)({});
  check(
    '未確認 → 支払った人を変え、共同費・計上・確認済み',
    pending.update.payerId === 'U1' && pending.update.payerDisplayName === 'まこと' &&
      pending.update.status === 'shared' && pending.update.includeInTotal === true && pending.update.confirmed === true,
    JSON.stringify(pending.update)
  );
  const advance = decideSetPayer(payer)({ status: 'advance_pending', advanceBy: 'U2' });
  check('立替の印が残っていれば外す（共同費・advanceBy を消す）', advance.update.status === 'shared' && isFieldDelete(advance.update.advanceBy) && advance.cardPatch.advanceBy === undefined, JSON.stringify(advance.update));
  const personal = decideSetPayer(payer)({ status: 'personal', includeInTotal: false });
  check('除外は除外のまま（支払った人だけ変える）', personal.update.status === undefined && personal.update.includeInTotal === undefined && personal.update.payerId === 'U1');
  const shared = decideSetPayer(payer)({ status: 'shared' });
  check('共同費は status を変えない・advanceBy に触れない', shared.update.status === undefined && !('advanceBy' in shared.update));
  check('立替で精算済みは拒否', deepEqual(decideSetPayer(payer)({ status: 'advance_settled' }), { reject: SETTLED_REJECTION }));
  check('カードの組み直し用に名前を返す', pending.cardPatch.payerId === 'U1' && pending.cardPatch.payerDisplayName === 'まこと');
}

// ------------------------------------------------------------
console.log('\ndecideClearAdvance（立替の印を外す）');
{
  const d = decideClearAdvance()({ status: 'advance_pending', advanceBy: 'U2', payerId: 'U3' });
  check('advance_pending → 共同費（支払った人・金額は変えない）', d.update.status === 'shared' && !('payerId' in d.update) && !('amount' in d.update) && d.update.confirmed === true);
  check('立替で精算済みは拒否', deepEqual(decideClearAdvance()({ status: 'advance_settled' }), { reject: SETTLED_REJECTION }));
  const noop = decideClearAdvance()({ status: 'shared' });
  check('印が無ければ何も変えない（更新時刻だけ）', deepEqual(Object.keys(noop.update), ['updatedAt']) && deepEqual(noop.cardPatch, {}));
}

const ts = (ms) => ({ toMillis: () => ms });

// ------------------------------------------------------------
console.log('\nsortActiveMembers');
{
  const sorted = sortActiveMembers([
    { groupId: 'g', lineId: 'b', displayName: 'B', joinedAt: ts(2000), isActive: true },
    { groupId: 'g', lineId: 'a', displayName: '', joinedAt: ts(1000), isActive: true },
    { groupId: 'g', lineId: 'a', displayName: 'A', joinedAt: ts(3000), isActive: true },
    { groupId: 'g', lineId: 'c', displayName: 'C', joinedAt: ts(500), isActive: false },
    { groupId: 'g', lineId: 'd', displayName: 'D', isActive: true },
  ]);
  check('joinedAt 昇順・重複除去・脱退者除外・joinedAt 無しは末尾', deepEqual(sorted.map((m) => m.lineId), ['a', 'b', 'd']), JSON.stringify(sorted));
  check('重複した文書の表示名で空を補う', sorted[0].displayName === 'A');
  const placeholder = sortActiveMembers([
    { groupId: 'g', lineId: 'a', displayName: '作成者', joinedAt: ts(1000), isActive: true },
    { groupId: 'g', lineId: 'a', displayName: 'あきら', joinedAt: ts(2000), isActive: true },
    { groupId: 'g', lineId: 'b', displayName: '作成者', joinedAt: ts(3000), isActive: true },
  ]);
  check('作成者が分からなければ全員の仮名「作成者」を空として扱い、他の文書の名前で補う', placeholder[0].displayName === 'あきら' && placeholder[1].displayName === '', JSON.stringify(placeholder));
  const scoped = sortActiveMembers(
    [
      { groupId: 'g', lineId: 'a', displayName: '作成者', joinedAt: ts(1000), isActive: true },
      { groupId: 'g', lineId: 'b', displayName: '作成者', joinedAt: ts(3000), isActive: true },
    ],
    'a'
  );
  check('作成者が分かれば仮名として扱うのは作成者の文書だけ', scoped[0].displayName === '' && scoped[1].displayName === '作成者', JSON.stringify(scoped));
  check('createdBy が空文字なら分からない扱い', sortActiveMembers([{ groupId: 'g', lineId: 'b', displayName: '作成者', isActive: true }], '')[0].displayName === '');
}

// ------------------------------------------------------------
console.log('\n入力検証');
check('通常の ID は可', isValidDocId('abcDEF123_-') && isValidDocId('a'.repeat(128)));
check('129 文字は不可', !isValidDocId('a'.repeat(129)));
check('空・文字列以外は不可', !isValidDocId('') && !isValidDocId(123) && !isValidDocId(['a']) && !isValidDocId(undefined));
check('/ を含むと不可', !isValidDocId('a/b') && !isValidDocId('/'));
check('. と .. は不可', !isValidDocId('.') && !isValidDocId('..'));
check('__…__ は不可', !isValidDocId('__name__') && !isValidDocId('____') && isValidDocId('__a') && isValidDocId('a__') && isValidDocId('___'));
check('改行を含む __…__ も不可（Firestore の予約 ID）', !isValidDocId('__a\nb__') && !isValidDocId('__\n__'));
check('isPlainObject: オブジェクトだけ', isPlainObject({ a: 1 }) && !isPlainObject([]) && !isPlainObject(null) && !isPlainObject('x'));
check('expectedExpenseIds: 重複を除く', deepEqual(parseExpectedExpenseIds(['a', 'b', 'a']), ['a', 'b']));
check('expectedExpenseIds: 空配列は可', deepEqual(parseExpectedExpenseIds([]), []));
check('expectedExpenseIds: 配列以外は不可', parseExpectedExpenseIds('a') === null && parseExpectedExpenseIds(undefined) === null);
check('expectedExpenseIds: 文字列以外の要素は不可', parseExpectedExpenseIds(['a', 1]) === null);
check('expectedExpenseIds: 不正な ID は不可', parseExpectedExpenseIds(['a/b']) === null && parseExpectedExpenseIds(['..']) === null);
check(`expectedExpenseIds: ${MAX_CLEAR_IDS} 件までは可`, parseExpectedExpenseIds(Array.from({ length: MAX_CLEAR_IDS }, (_, i) => `e${i}`)).length === MAX_CLEAR_IDS);
check(`expectedExpenseIds: ${MAX_CLEAR_IDS + 1} 件は too_many（400 にせず 409 で返す）`, parseExpectedExpenseIds(Array.from({ length: MAX_CLEAR_IDS + 1 }, (_, i) => `e${i}`)) === 'too_many');
check('expectedExpenseIds: 重複を除いて 500 件以下なら可', parseExpectedExpenseIds([...Array.from({ length: MAX_CLEAR_IDS }, (_, i) => `e${i}`), 'e0']).length === MAX_CLEAR_IDS);
check('expectedExpenseIds: 件数が多くても不正な要素があれば不可', parseExpectedExpenseIds([...Array.from({ length: MAX_CLEAR_IDS + 1 }, (_, i) => `e${i}`), 'a/b']) === null);
check('sameIdSet: 順序は無視', sameIdSet(['a', 'b'], ['b', 'a']));
check('sameIdSet: 過不足は不一致', !sameIdSet(['a', 'b'], ['a']) && !sameIdSet(['a'], ['a', 'c']) && !sameIdSet(['a', 'b'], ['a', 'c']));
check('送る期間: closed / current だけ可', parseSummaryPeriod('closed') === 'closed' && parseSummaryPeriod('current') === 'current');
check('送る期間: それ以外は不可', [undefined, null, '', 'CLOSED', 'all', 1].every((v) => parseSummaryPeriod(v) === null));

// ------------------------------------------------------------
console.log('\nclientIpKey（認証前のレート制限のキー）');
{
  const key = (xff, ip = '169.254.1.1') => clientIpKey({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, ip });
  check('X-Forwarded-For の末尾（前段が足した接続元）を使う', key('203.0.113.7') === '203.0.113.7' && key('198.51.100.1, 203.0.113.7') === '203.0.113.7');
  check('末尾が違えば別のキー（別々に数える）', key('203.0.113.7') !== key('203.0.113.8'));
  check('クライアントが前に足した値では変わらない（詐称できない）', key('10.0.0.1, 203.0.113.7') === key('203.0.113.7') && key('203.0.113.9, 203.0.113.7') === key('203.0.113.7'));
  check('ヘッダーが無ければ req.ip', key(undefined) === '169.254.1.1');
  check('末尾が IP でなければ req.ip', key('203.0.113.7, garbage') === '169.254.1.1' && key('') === '169.254.1.1' && key('203.0.113.7,') === '169.254.1.1');
  check('配列のヘッダーも末尾を使う', key(['198.51.100.1', '203.0.113.7']) === '203.0.113.7');
  check('IPv6 は /56 にまとめる', key('2001:db8:1:1::1') === key('2001:db8:1:1:ffff::2') && key('2001:db8:1:1::1') !== key('2001:db8:1:200::1'));
  check('req.ip も無ければ unknown', clientIpKey({ headers: {}, ip: undefined }) === 'unknown');
}

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
  console.log('\nreadActiveMember（［自分が払った］の表示名）');
  {
    const docs = {
      g1_me: { groupId: 'g1', lineId: 'me', isActive: true, displayName: 'まこと' },
      g1_maker: { groupId: 'g1', lineId: 'maker', isActive: true, displayName: '作成者' },
      g1_left: { groupId: 'g1', lineId: 'left', isActive: false, displayName: 'いない人' },
    };
    const tx = {
      get: async (ref) => {
        const d = docs[ref.id];
        return { exists: !!d, get: (f) => (d ? d[f] : undefined) };
      },
    };
    check('有効メンバーは表示名を返す', deepEqual(await readActiveMember(fakeDb, 'g1', 'me', tx), { displayName: 'まこと' }));
    check('仮名「作成者」は空文字（呼び出し側で補う）', deepEqual(await readActiveMember(fakeDb, 'g1', 'maker', tx), { displayName: '' }));
    check('脱退者・メンバー外は null', (await readActiveMember(fakeDb, 'g1', 'left', tx)) === null && (await readActiveMember(fakeDb, 'g1', 'nobody', tx)) === null);
  }

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
    check('X-Content-Type-Options: nosniff', res.headers['x-content-type-options'] === 'nosniff');
  }
  {
    const res = fakeRes();
    // 500 のときの console.error（household: unexpected error: boom）は期待どおりなので出さない
    const origError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    try {
      householdErrorHandler(new Error('boom'), { headers: { origin: 'https://evil.example.com' }, method: 'POST' }, res, () => {});
    } finally {
      console.error = origError;
    }
    check('500 は原因をログに出す', errors.length === 1 && errors[0].includes('boom'));
    check('その他の例外は 500 internal', res.statusCode === 500 && deepEqual(res.body, { error: 'internal' }));
    check('許可外のオリジンには ACAO を付けない', res.headers['access-control-allow-origin'] === undefined);
  }

  // 折半精算で集金するメンバーの指定
  check('集金するメンバー: lineId はそのまま', parseCollectFromLineId('Uaaa') === 'Uaaa');
  check('集金するメンバー: null は解除', parseCollectFromLineId(null) === null);
  check(
    '集金するメンバー: 空・数値・undefined・パス区切りは不正',
    [undefined, '', 42, 'a/b', '__x__'].every((v) => parseCollectFromLineId(v) === undefined)
  );

  // postback が共有関数を読み込めること（require 時に落ちない）
  check('line/postback.js が読み込める', typeof require('../dist/line/postback').handlePostback === 'function');

  console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
