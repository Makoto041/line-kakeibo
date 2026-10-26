/**
 * /household API と、LINE の postback と共有する判定のスモークテスト（Firestore には接続しない）
 *
 *   node bot/scripts/smoke-household-api.js
 *
 * ルーター・認証・Firestore を通した確認はエミュレータの統合テスト
 * （bot/scripts/emulator-household-api.js）で行う。
 */
const assert = require('assert');
const { Timestamp } = require('firebase-admin/firestore');
const {
  decideClearAdvance,
  decideConfirm,
  decideSetAdvance,
  decideSetCategory,
  decideSetPayer,
  decideSettleLegacyAdvance,
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
  MAX_LEGACY_SETTLE_IDS,
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

/** FieldValue.delete() の番兵か */
const isFieldDelete = (v) => !!v && typeof v === 'object' && !!v.constructor && v.constructor.name.includes('Transform');

/** Flex メッセージに含まれる postback ボタンの data（JSON を解析したもの）をすべて集める */
function postbacksIn(message) {
  const found = [];
  (function collect(node) {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'postback' && typeof node.data === 'string') found.push(JSON.parse(node.data));
    Object.values(node).forEach(collect);
  })(message);
  return found;
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

/** 比較用に、FieldValue.delete() の番兵を目印の文字列に置き換える（番兵どうしの同一性に頼らない） */
const DELETE = '<FieldValue.delete()>';
const withDeleteMarker = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, isFieldDelete(v) ? DELETE : v]));

/** updatedAt（生成時刻）は Date であることだけ確かめて比較から外す */
function comparable(decision) {
  const { updatedAt, ...rest } = decision.update;
  return { update: withDeleteMarker(rest), cardPatch: decision.cardPatch, updatedAtIsDate: updatedAt instanceof Date };
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
  const pending = decideSetPayer(payer)({});
  check(
    '未確認 → 支払った人を変え、共同費・計上・確認済み',
    pending.update.payerId === 'U1' && pending.update.payerDisplayName === 'まこと' &&
      pending.update.status === 'shared' && pending.update.includeInTotal === true && pending.update.confirmed === true,
    JSON.stringify(pending.update)
  );
  const advance = decideSetPayer(payer)({ status: 'advance_pending', advanceBy: 'U2', advanceFull: true });
  check('立替なら立て替えた人も押した人にする（立替のまま）', advance.update.status === undefined && advance.update.advanceBy === 'U1' && advance.cardPatch.advanceBy === 'U1', JSON.stringify(advance.update));
  const personal = decideSetPayer(payer)({ status: 'personal', includeInTotal: false });
  check('除外は除外のまま（支払った人だけ変える）', personal.update.status === undefined && personal.update.includeInTotal === undefined && personal.update.payerId === 'U1');
  const shared = decideSetPayer(payer)({ status: 'shared' });
  check('共同費は status を変えない・advanceBy に触れない', shared.update.status === undefined && !('advanceBy' in shared.update));
  check('立替で精算済みは拒否', deepEqual(decideSetPayer(payer)({ status: 'advance_settled' }), { reject: SETTLED_REJECTION }));
  check('カードの組み直し用に名前を返す', pending.cardPatch.payerId === 'U1' && pending.cardPatch.payerDisplayName === 'まこと');
}

// ------------------------------------------------------------
console.log('\ndecideSetAdvance（LINE の［自分が立替］）');
{
  const presser = { lineId: 'U1', displayName: 'まこと' };
  for (const status of [undefined, 'pending', 'shared', 'personal', 'advance_pending']) {
    const d = decideSetAdvance(presser)({ status, includeInTotal: status !== 'personal' });
    check(
      `status=${status ?? '無し'} → 全額の立替（押した人が立替・支払い、計上・確認済み）`,
      d.update.status === 'advance_pending' && d.update.advanceFull === true && d.update.advanceBy === 'U1' &&
        d.update.payerId === 'U1' && d.update.payerDisplayName === 'まこと' && d.update.includeInTotal === true && d.update.confirmed === true,
      JSON.stringify(d.update)
    );
  }
  check('立替で精算済みは拒否', deepEqual(decideSetAdvance(presser)({ status: 'advance_settled' }), { reject: SETTLED_REJECTION }));
}

// ------------------------------------------------------------
console.log('\ndecideClearAdvance（立替を取り消す）');
{
  const d = decideClearAdvance()({ status: 'advance_pending', advanceBy: 'U2', advanceFull: true, payerId: 'U3' });
  check('advance_pending → 共同費（支払った人・金額は変えない）', d.update.status === 'shared' && !('payerId' in d.update) && !('amount' in d.update) && d.update.confirmed === true);
  check('advanceBy・advanceFull を消す', isFieldDelete(d.update.advanceBy) && isFieldDelete(d.update.advanceFull) && d.cardPatch.advanceFull === undefined);
  check('立替で精算済みは拒否', deepEqual(decideClearAdvance()({ status: 'advance_settled' }), { reject: SETTLED_REJECTION }));
  check('立替でなければ変えない（理由を返す）', deepEqual(decideClearAdvance()({ status: 'shared' }), { reject: '立替ではないため、変更はありません' }));
}

// ------------------------------------------------------------
console.log('\ndecideSettleLegacyAdvance（全額にする前の立替を精算済みにする）');
{
  const now = new Date('2026-10-17T01:00:00Z');
  const d = decideSettleLegacyAdvance(now)({ status: 'advance_pending', advanceBy: 'U2' });
  check('advanceFull の無い立替 → advance_settled・精算日時', d.update.status === 'advance_settled' && d.update.advanceSettledAt === now);
  check('全額の立替は対象外（期間の精算で返す）', 'reject' in decideSettleLegacyAdvance(now)({ status: 'advance_pending', advanceFull: true }));
  check('立替でなければ対象外', 'reject' in decideSettleLegacyAdvance(now)({ status: 'shared' }) && 'reject' in decideSettleLegacyAdvance(now)({ status: 'advance_settled' }));
}

// ------------------------------------------------------------
console.log('\ndecideSetCategory（LINE のカテゴリ選択。postback の set_category）');
{
  /**
   * 切り出す前の postback.ts handleSetCategory のクロージャ（比較用の写し。カテゴリはそのまま保存していた）に、
   * 中項目の削除（#235。大項目が変わり、辞書で決まらないとき）を足したもの。
   * 下のデータは category・description を持たないので、どの大項目を選んでも「大項目が変わり、決まらない」になる。
   */
  function legacySetCategory(category, data) {
    const status = data.status;
    const isPending = !status || status === 'pending';
    return isPending
      ? {
          update: { category, subCategory: DELETE, confirmed: true, status: 'shared', includeInTotal: true, updatedAt: new Date() },
          cardPatch: { category, subCategory: undefined, status: 'shared', includeInTotal: true },
        }
      : {
          update: { category, subCategory: DELETE, confirmed: true, updatedAt: new Date() },
          cardPatch: { category, subCategory: undefined },
        };
  }

  // 正準名・揃えられない名前（カスタム名）は、切り出す前と同じ更新内容（＋中項目の削除）
  for (const category of ['食費', '通信費', 'その他', '医療・健康', '推し活']) {
    for (const status of statuses) {
      const data = { status, amount: 1000, includeInTotal: false };
      const actual = decideSetCategory(category)(data);
      check(
        `${category}・status=${JSON.stringify(status)} は従来と同じ更新内容（＋中項目の削除）`,
        !('reject' in actual) && deepEqual(comparable(actual), comparable(legacySetCategory(category, data))) &&
          'subCategory' in actual.cardPatch,
        JSON.stringify(actual)
      );
    }
  }

  // カルーセル・LINE の入力の旧名は正準名で保存する（それ以外は従来と同じ）
  const legacyNames = [
    ['医療費', '医療・健康'],
    ['娯楽費', '娯楽'],
    ['衣服費', '衣服'],
    ['教育費', '教育'],
    ['趣味', '娯楽'],
    ['貯蓄', '貯金'],
  ];
  for (const [label, canonical] of legacyNames) {
    for (const status of statuses) {
      const data = { status, amount: 1000, includeInTotal: false };
      const actual = decideSetCategory(label)(data);
      check(
        `${label}・status=${JSON.stringify(status)} → ${canonical} で保存（ほかは従来と同じ＋中項目の削除）`,
        !('reject' in actual) && deepEqual(comparable(actual), comparable(legacySetCategory(canonical, data))) &&
          actual.update.category === canonical && actual.cardPatch.category === canonical,
        JSON.stringify(actual)
      );
    }
  }
  check('精算済みでもカテゴリは変えられる（拒否しない）', !('reject' in decideSetCategory('医療費')({ status: 'advance_settled' })));
}

// ------------------------------------------------------------
console.log('\ndecideSetCategory の中項目（#235。大項目が変わるときだけ、辞書と時刻のルールで決め直す）');
{
  /** JST の壁時計の時刻の Firestore Timestamp（保存済みの usedAt は読むと Timestamp になる） */
  const jst = (s) => Timestamp.fromDate(new Date(`${s}+09:00`));
  const decide = (category, data) => decideSetCategory(category)(data);
  const hasSubKey = (d) => 'subCategory' in d.update || 'subCategory' in d.cardPatch;

  // 大項目が同じ
  for (const status of [undefined, 'shared', 'advance_settled']) {
    const d = decide('食費', { category: '食費', description: 'ランチ', subCategory: '夜ご飯', status });
    check(
      `大項目が同じなら中項目に触らない（update・cardPatch ともキーなし。status=${status ?? '無し'}）`,
      !('reject' in d) && !hasSubKey(d) && d.update.category === '食費',
      JSON.stringify(d)
    );
  }
  {
    const alias = decide('医療費', { category: '医療・健康', description: '病院', subCategory: 'x', status: 'shared' });
    check('旧名を選んでも、正準名どうしで同じなら触らない（医療・健康 → 医療費）', !hasSubKey(alias) && alias.update.category === '医療・健康', JSON.stringify(alias));
    const storedLegacy = decide('娯楽', { category: '娯楽費', description: 'ランチ', subCategory: '映画', status: 'shared' });
    check('保存済みが旧名（娯楽費）で同じ大項目（娯楽）を選んでも触らない', !hasSubKey(storedLegacy) && storedLegacy.update.category === '娯楽', JSON.stringify(storedLegacy));
    const padded = decide('食費', { category: ' 食費 ', description: 'ランチ', subCategory: 'カフェ', status: 'shared' });
    check('保存済みの大項目の前後に空白があっても（「 食費 」→ 食費）同じ大項目として触らない', !hasSubKey(padded) && padded.update.category === '食費', JSON.stringify(padded));
    const storedMedical = decide('医療・健康', { category: '医療費', description: '病院', subCategory: 'x', status: 'shared' });
    check('保存済みが旧名（医療費）で正準名（医療・健康）を選んでも触らない', !hasSubKey(storedMedical) && storedMedical.update.category === '医療・健康', JSON.stringify(storedMedical));
  }

  // 大項目が変わり、辞書で決まる
  {
    const lunch = decide('食費', { category: 'その他', description: 'ランチ', status: 'shared' });
    check('食費にして説明「ランチ」→ 昼ご飯（update・cardPatch とも）', lunch.update.subCategory === '昼ご飯' && lunch.cardPatch.subCategory === '昼ご飯', JSON.stringify(lunch));
    const movie = decide('娯楽費', { category: '食費', description: '映画館', subCategory: 'カフェ', status: 'shared' });
    check('娯楽費（旧名）にして説明「映画館」→ 映画（食費の中項目を残さない）', movie.update.category === '娯楽' && movie.update.subCategory === '映画' && movie.cardPatch.subCategory === '映画', JSON.stringify(movie));
    const pending = decide('食費', { description: 'ランチ' });
    check('未確認でも決める（共同費への昇格と一緒に）', pending.update.subCategory === '昼ご飯' && pending.update.status === 'shared' && pending.cardPatch.subCategory === '昼ご飯');
  }

  // 大項目が変わり、決まらなければ消す
  {
    const none = decide('日用品', { category: '食費', description: 'ランチ', subCategory: '昼ご飯', status: 'shared' });
    check('中項目の無い大項目にすると消す（update は FieldValue.delete() の番兵）', isFieldDelete(none.update.subCategory), JSON.stringify(none.update));
    check('cardPatch.subCategory は undefined で、キーはある', 'subCategory' in none.cardPatch && none.cardPatch.subCategory === undefined, JSON.stringify(Object.keys(none.cardPatch)));
    const record = { ...{ category: '食費', subCategory: '昼ご飯' }, ...none.cardPatch };
    check('返信カード用のレコード（{ ...data, ...cardPatch }）に古い中項目が残らない', record.subCategory === undefined && record.category === '日用品');
    const noMatch = decide('食費', { category: 'その他', description: '謎の支出', subCategory: 'カフェ', status: 'shared' });
    check('辞書に当たらなければ消す', isFieldDelete(noMatch.update.subCategory) && 'subCategory' in noMatch.cardPatch && noMatch.cardPatch.subCategory === undefined);
    const custom = decide('推し活', { category: '食費', description: 'ランチ', subCategory: '昼ご飯', status: 'shared' });
    check('利用者のカスタム名にすると消す', isFieldDelete(custom.update.subCategory) && custom.update.category === '推し活');
    const other = decide('食費', { category: 'その他', description: '食費', status: 'shared' });
    check('説明が大項目名だけなら決めない（消す）', isFieldDelete(other.update.subCategory));
  }

  // 時刻のルール（Gmail 取込の店名で、保存済みの usedAt に時刻があるときだけ）
  {
    const base = { category: 'その他', description: 'ラーメン', status: 'shared' };
    const gmail = (usedAt) => decide('食費', { ...base, inputSource: 'gmail_auto', usedAt }).update.subCategory;
    check('Gmail で 12:30（JST）の飲食店 → 昼ご飯', gmail(jst('2026-10-20T12:30:00')) === '昼ご飯');
    check('Gmail で 07:15 → 朝ご飯、19:00 → 夜ご飯', gmail(jst('2026-10-20T07:15:00')) === '朝ご飯' && gmail(jst('2026-10-20T19:00:00')) === '夜ご飯');
    check('Gmail で 00:00:00.000 ちょうど（時刻なし）→ 外食（夜ご飯にしない）', gmail(jst('2026-10-20T00:00:00')) === '外食', gmail(jst('2026-10-20T00:00:00')));
    check('Gmail で 00:01 は時刻あり → 夜ご飯', gmail(jst('2026-10-20T00:01:00')) === '夜ご飯');
    check('Gmail で usedAt が無ければ外食', gmail(undefined) === '外食' && gmail(null) === '外食');
    check('Timestamp でない usedAt（Date・数値・文字列）には時刻を当てない', [new Date('2026-10-20T12:30:00+09:00'), Date.parse('2026-10-20T12:30:00+09:00'), '2026-10-20T12:30:00+09:00'].every((v) => gmail(v) === '外食'));
    check('toDate が投げても、時刻なしとして辞書で決める', gmail({ toDate() { throw new Error('boom'); } }) === '外食');
    check('toDate が Date を返さなければ時刻なし', gmail({ toDate: () => '2026-10-20T12:30:00+09:00' }) === '外食');
    const cafe = decide('食費', { ...base, description: 'スターバックス', inputSource: 'gmail_auto', usedAt: jst('2026-10-20T12:30:00') });
    check('飲食店でないグループ（カフェ）には時刻を当てない', cafe.update.subCategory === 'カフェ');
    const text = (inputSource) => decide('食費', { ...base, inputSource, usedAt: jst('2026-10-20T12:30:00') }).update.subCategory;
    check('LINE（text）には時刻を当てない（line_text・入力元なし・固定費）', ['line_text', undefined, 'recurring', 'line_ocr'].every((s) => text(s) === '外食'));
  }

  // 精算済み
  {
    const settled = decide('食費', { category: 'その他', description: 'ランチ', status: 'advance_settled', advanceBy: 'U1' });
    check('精算済みでも大項目・中項目を変えられる（status は変えない）', !('reject' in settled) && settled.update.category === '食費' && settled.update.subCategory === '昼ご飯' && settled.update.status === undefined, JSON.stringify(settled));
  }

  // 判定で例外が起きても大項目の変更は続ける（中項目は消す）
  {
    const rules = require('../dist/subCategoryRules');
    const silenced = (fn) => {
      const origWarn = console.warn;
      const warns = [];
      console.warn = (...args) => warns.push(args);
      try {
        return { result: fn(), warns };
      } finally {
        console.warn = origWarn;
      }
    };

    const origResolve = rules.resolveSubCategory;
    rules.resolveSubCategory = () => {
      throw new Error('boom');
    };
    let thrown;
    try {
      thrown = silenced(() => decide('食費', { category: 'その他', description: 'ランチ', subCategory: '映画', status: 'shared' }));
    } finally {
      rules.resolveSubCategory = origResolve;
    }
    const d = thrown.result;
    check('resolveSubCategory が投げても大項目の変更は続く', !('reject' in d) && d.update.category === '食費' && d.update.confirmed === true, JSON.stringify(d));
    check('そのとき中項目は消す（update は番兵、cardPatch は undefined のキー）', isFieldDelete(d.update.subCategory) && 'subCategory' in d.cardPatch && d.cardPatch.subCategory === undefined);
    check('原因は種類だけをオブジェクトでログに出す（書式文字列に埋め込まない・文言を出さない）', thrown.warns.length === 1 && typeof thrown.warns[0][0] === 'string' && thrown.warns[0][1] && thrown.warns[0][1].errorName === 'Error' && !require('util').format(...thrown.warns[0]).includes('boom'), JSON.stringify(thrown.warns));

    const broken = { category: 'その他', status: 'shared', subCategory: '映画' };
    Object.defineProperty(broken, 'description', { enumerable: true, get() { throw new Error('getter'); } });
    const fromGetter = silenced(() => decide('食費', broken));
    check('説明の読み取りが投げても大項目の変更は続き、中項目は消す', fromGetter.result.update.category === '食費' && isFieldDelete(fromGetter.result.update.subCategory) && fromGetter.warns.length === 1);
  }
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
check(`expectedExpenseIds: ${MAX_LEGACY_SETTLE_IDS} 件までは可`, parseExpectedExpenseIds(Array.from({ length: MAX_LEGACY_SETTLE_IDS }, (_, i) => `e${i}`)).length === MAX_LEGACY_SETTLE_IDS);
check(`expectedExpenseIds: ${MAX_LEGACY_SETTLE_IDS + 1} 件は too_many（400 にせず 409 で返す）`, parseExpectedExpenseIds(Array.from({ length: MAX_LEGACY_SETTLE_IDS + 1 }, (_, i) => `e${i}`)) === 'too_many');
check('expectedExpenseIds: 重複を除いて 500 件以下なら可', parseExpectedExpenseIds([...Array.from({ length: MAX_LEGACY_SETTLE_IDS }, (_, i) => `e${i}`), 'e0']).length === MAX_LEGACY_SETTLE_IDS);
check('expectedExpenseIds: 件数が多くても不正な要素があれば不可', parseExpectedExpenseIds([...Array.from({ length: MAX_LEGACY_SETTLE_IDS + 1 }, (_, i) => `e${i}`), 'a/b']) === null);
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
    // 500 のときの console.error（household: unexpected error）は期待どおりなので出さない
    const origError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    // 本文の JSON の解析の失敗のように、文言に入力の断片が入りうる例外
    const err = Object.assign(new SyntaxError('Unexpected token 秘密CANARY in JSON'), { code: 'ERR_CANARY_7' });
    try {
      householdErrorHandler(err, { headers: { origin: 'https://evil.example.com' }, method: 'POST' }, res, () => {});
    } finally {
      console.error = origError;
    }
    const logged = errors.map((args) => require('util').format(...args)).join('\n');
    check(
      '500 は原因の種類だけを固定文 + オブジェクトでログに出す（文言を出さない）',
      errors.length === 1 && errors[0][0] === 'household: unexpected error' && errors[0][1]?.errorName === 'SyntaxError' &&
        errors[0][1]?.errorCode === 'ERR_CANARY_7' && !logged.includes('CANARY in') && !logged.includes('秘密'),
      logged
    );
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

  // ------------------------------------------------------------
  console.log('\ntoSelectableCategoryName（postback の set_category で受け付けるカテゴリ）');
  {
    const { toSelectableCategoryName, CANONICAL_CATEGORIES, MAX_SELECTABLE_CATEGORY_LENGTH } = require('../dist/categoryNormalization');
    check('正準名 19 種はそのまま受け付ける', CANONICAL_CATEGORIES.length === 19 && CANONICAL_CATEGORIES.every((c) => toSelectableCategoryName(c) === c));
    check(
      'カルーセルの旧名は正準名にして受け付ける（医療費 → 医療・健康 など）',
      toSelectableCategoryName('医療費') === '医療・健康' && toSelectableCategoryName('娯楽費') === '娯楽' &&
        toSelectableCategoryName('衣服費') === '衣服' && toSelectableCategoryName('教育費') === '教育'
    );
    check(
      'LINE の入力の旧名（趣味・貯蓄）も正準名にして受け付ける（#243）',
      toSelectableCategoryName('趣味') === '娯楽' && toSelectableCategoryName('貯蓄') === '貯金'
    );
    check('前後の空白は除いて照合する', toSelectableCategoryName(' 食費 ') === '食費');
    check(
      '文字列以外は受け付けない',
      [undefined, null, 0, 123, true, {}, [], ['食費'], { name: '食費' }].every((v) => toSelectableCategoryName(v) === null)
    );
    check('一覧に無い名前（空・カスタム名）は受け付けない', ['', ' ', '推し活', 'food', '食費費'].every((v) => toSelectableCategoryName(v) === null));
    check(`上限は ${MAX_SELECTABLE_CATEGORY_LENGTH} 文字`, MAX_SELECTABLE_CATEGORY_LENGTH === 32);
    check(
      '上限ちょうどの長さ（空白で埋めた食費）は受け付け、1 文字超えると受け付けない（揃えれば一覧にある名前でも）',
      toSelectableCategoryName('食費'.padStart(MAX_SELECTABLE_CATEGORY_LENGTH, ' ')) === '食費' &&
        toSelectableCategoryName('食費'.padStart(MAX_SELECTABLE_CATEGORY_LENGTH + 1, ' ')) === null
    );

    // トーク履歴に残っているカルーセルの選択肢は、どれも受け付ける
    const { buildCategorySelectCarousel } = require('../dist/line/flexMessage');
    const carousel = buildCategorySelectCarousel({ expenseId: 'exp_0001', currentCategory: '食費', source: 'gmail', merchant: '店', amount: 100 });
    const choices = postbacksIn(carousel).filter((p) => p.action === 'set_category');
    check(
      'カルーセルの「これにする」の値は、どれも受け付けて正準名にする',
      choices.length === 10 && choices.every((p) => CANONICAL_CATEGORIES.includes(toSelectableCategoryName(p.category))),
      JSON.stringify(choices.map((p) => [p.category, toSelectableCategoryName(p.category)]))
    );
  }

  // ------------------------------------------------------------
  console.log('\npostback（handlePostback を通す。偽の Firestore と偽の LINE クライアントで、外には繋がない）');
  {
    // dist の呼び出しはモジュールの exports を毎回引くので、getFirestore・LINE クライアントを差し替えられる。
    // applyExpenseChange・メンバー確認（readActiveMember）は本物を、偽の Firestore の上で動かす。
    const firestoreModule = require('firebase-admin/firestore');
    const actions = require('../dist/expenseActions');
    const client = require('../dist/line/client');
    const { handlePostback } = require('../dist/line/postback');
    const origGetFirestore = firestoreModule.getFirestore;
    const origApply = actions.applyExpenseChange;
    const origReply = client.replyWithPushFallback;
    const origGetLineClient = client.getLineClient;
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    /** パス（collection/id）→ 文書 */
    const docs = new Map();
    /** トランザクションで書いた [パス, 更新内容] */
    const writes = [];
    const snapshotOf = (data) => ({
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : { ...data }),
      get: (field) => (data ? data[field] : undefined),
    });
    /** Firestore の文書を読んだ回数 */
    let reads = 0;
    const refOf = (name, id) => ({
      id,
      path: `${name}/${id}`,
      get: async () => {
        reads++;
        return snapshotOf(docs.get(`${name}/${id}`));
      },
    });
    const fakeDb = {
      collection: (name) => ({ doc: (id) => refOf(name, id) }),
      runTransaction: async (fn) => {
        const pending = [];
        const result = await fn({ get: (ref) => ref.get(), update: (ref, update) => pending.push([ref.path, update]) });
        for (const [path, update] of pending) {
          writes.push([path, update]);
          const next = { ...docs.get(path) };
          for (const [k, v] of Object.entries(update)) {
            if (isFieldDelete(v)) delete next[k];
            else next[k] = v;
          }
          docs.set(path, next);
        }
        return result;
      },
    };

    const decisions = [];
    /** applyExpenseChange の呼び出し（押した action と、authorize を付けたか） */
    const applyCalls = [];
    let pressingAction;
    /** LINE のプロフィールを取得した回数 */
    let profileCalls = 0;
    const replies = [];
    const logs = [];
    const warns = [];

    firestoreModule.getFirestore = () => fakeDb;
    actions.applyExpenseChange = (expenseId, decide, opts) => {
      applyCalls.push({ action: pressingAction, authorized: !!opts && typeof opts.authorize === 'function' });
      return origApply(expenseId, (data) => {
        const decision = decide(data);
        decisions.push(decision);
        return decision;
      }, opts);
    };
    client.replyWithPushFallback = async (_replyToken, _to, messages) => {
      replies.push(messages);
      return 'reply';
    };
    client.getLineClient = () => ({
      getProfile: async () => {
        profileCalls++;
        return { displayName: 'プロフィール名' };
      },
      getGroupMemberProfile: async () => {
        profileCalls++;
        return { displayName: 'プロフィール名' };
      },
    });

    const MEMBERS_ONLY = '変更できるのは、世帯のメンバーだけです';
    const PRESSER_UNKNOWN = '押した人を特定できなかったため、変更できませんでした';
    const NOT_SELECTABLE = 'このカテゴリには変更できません';

    // 世帯 g1（LINE グループ C_line1）: Alice・Bob が有効、Left は脱退済み
    docs.set('groupMembers/g1_Ualice0001', { groupId: 'g1', lineId: 'Ualice0001', displayName: 'Alice', isActive: true });
    docs.set('groupMembers/g1_Ubob0001', { groupId: 'g1', lineId: 'Ubob0001', displayName: 'Bob', isActive: true });
    docs.set('groupMembers/g1_Uleft0001', { groupId: 'g1', lineId: 'Uleft0001', displayName: 'Left', isActive: false });
    const groupExpense = (extra) => ({ lineId: 'Ualice0001', groupId: 'g1', lineGroupId: 'C_line1', amount: 1000, description: 'ランチ', category: 'その他', ...extra });
    const legacyExpense = (extra) => ({ lineId: 'Ualice0001', lineGroupId: 'C_line1', amount: 900, description: 'ランチ', category: 'その他', ...extra });
    const personalExpense = (extra) => ({ lineId: 'Ualice0001', amount: 500, description: 'ランチ', category: 'その他', ...extra });
    const expense = (id) => docs.get(`expenses/${id}`);

    /** ボタンを押す。userId を null にすると、押した人が分からないイベントになる */
    const press = async (payload, userId = 'Ubob0001') => {
      const before = { decisions: decisions.length, replies: replies.length, writes: writes.length, warns: warns.length };
      pressingAction = payload && payload.action;
      console.log = (...args) => logs.push(args);
      console.warn = (...args) => warns.push(args);
      console.error = () => {};
      try {
        await handlePostback({
          type: 'postback',
          replyToken: 'reply-token',
          source: userId === null ? { type: 'group', groupId: 'C_line1' } : { type: 'group', groupId: 'C_line1', userId },
          postback: { data: JSON.stringify(payload) },
        });
      } finally {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
      }
      const newReplies = replies.slice(before.replies);
      return {
        decision: decisions.length > before.decisions ? decisions[decisions.length - 1] : undefined,
        decided: decisions.length > before.decisions,
        wrote: writes.length > before.writes,
        replies: newReplies,
        text: newReplies.length === 1 && newReplies[0].length === 1 && newReplies[0][0].type === 'text' ? newReplies[0][0].text : undefined,
        flex: newReplies.length === 1 && newReplies[0].length === 1 && newReplies[0][0].type === 'flex' ? newReplies[0][0] : undefined,
        warns: warns.slice(before.warns),
      };
    };
    /** 拒否された（決める処理を呼ばず・書かず、文言 text を 1 通だけ返した） */
    const refused = (r, text) => !r.decided && !r.wrote && r.text === text;

    try {
      // ---------------- set_category の中項目（#264） ----------------
      console.log('  [set_category の中項目は postback の値を使わず、サーバーで決める]');
      const forged = { action: 'set_category', expenseId: 'exp_0001', category: '食費', subCategory: '夜ご飯' };
      const pressForged = async (data) => {
        docs.set('expenses/exp_0001', groupExpense(data));
        return (await press(forged)).decision;
      };
      const logsBefore = logs.length;
      const a = await pressForged({ category: 'その他', description: 'ランチ', status: 'shared' });
      check('postback の subCategory（夜ご飯）ではなく、辞書で決めた値（昼ご飯）を保存する', a && a.update.subCategory === '昼ご飯' && a.cardPatch.subCategory === '昼ご飯' && expense('exp_0001').subCategory === '昼ご飯', JSON.stringify(a && a.update));
      const b = await pressForged({ category: 'その他', description: '謎の支出', status: 'shared', subCategory: '外食' });
      check('辞書で決まらなければ、postback に値があっても消す', b && isFieldDelete(b.update.subCategory) && 'subCategory' in b.cardPatch && b.cardPatch.subCategory === undefined && !('subCategory' in expense('exp_0001')), JSON.stringify(b && b.cardPatch));
      const c = await pressForged({ category: '食費', description: 'ランチ', subCategory: 'カフェ', status: 'shared' });
      check('大項目が同じなら、postback に値があっても中項目に触らない', c && !('subCategory' in c.update) && !('subCategory' in c.cardPatch) && expense('exp_0001').subCategory === 'カフェ', JSON.stringify(c));
      const d = await pressForged({ category: '食費', description: 'ランチ', subCategory: '手で書いた中項目', status: 'shared' });
      check('（大項目が同じ・一覧に無い中項目でも触らない）', d && !('subCategory' in d.update));
      const forgedReplies = replies.slice(-4);
      check('どの場合も最新の値のカードを返信する', replies.length === 4 && forgedReplies.every((m) => Array.isArray(m) && m.length === 1 && m[0].type === 'flex'), JSON.stringify(replies.map((m) => m.map((x) => x.type))));

      const logged = logs.slice(logsBefore).filter((l) => l[0] === 'Expense category updated').map((l) => l[1]);
      check(
        'ログに中項目を出す（決めた値・消したら null・触らなければ保存済みの値）',
        logged.length === 4 && logged[0].subCategory === '昼ご飯' && logged[1].subCategory === null && logged[2].subCategory === 'カフェ',
        JSON.stringify(logged)
      );
      check('一覧に無い中項目はログに出さない', logged.length === 4 && logged[3].subCategory === '(not in list)', JSON.stringify(logged[3]));
      check('ログの支出 ID は伏せる', logged.length === 4 && logged.every((l) => l.expense === '…0001'), JSON.stringify(logged.map((l) => l.expense)));

      // ---------------- set_category の認可（#266） ----------------
      console.log('  [set_category は世帯のメンバーだけ]');
      const setCategory = { action: 'set_category', expenseId: 'exp_cat', category: '食費' };
      for (const [who, userId] of [['メンバー外', 'Ustranger01'], ['脱退者', 'Uleft0001']]) {
        docs.set('expenses/exp_cat', groupExpense({}));
        const r = await press(setCategory, userId);
        check(`${who}は「${MEMBERS_ONLY}」で、書かない`, refused(r, MEMBERS_ONLY) && expense('exp_cat').category === 'その他' && expense('exp_cat').confirmed === undefined, JSON.stringify(r));
      }
      docs.set('expenses/exp_cat', groupExpense({}));
      const byMember = await press(setCategory, 'Ubob0001');
      check('メンバー（登録者でない Bob）は変えられる（確認済み・共同費にもなる）', byMember.wrote && byMember.flex && expense('exp_cat').category === '食費' && expense('exp_cat').status === 'shared' && expense('exp_cat').confirmed === true, JSON.stringify(expense('exp_cat')));
      docs.set('expenses/exp_cat', groupExpense({}));
      const unknown = await press(setCategory, null);
      check(`押した人が分からなければ「${PRESSER_UNKNOWN}」で、書かない`, refused(unknown, PRESSER_UNKNOWN) && expense('exp_cat').category === 'その他', JSON.stringify(unknown));

      docs.set('expenses/exp_cat_legacy', legacyExpense({}));
      const legacy = await press({ ...setCategory, expenseId: 'exp_cat_legacy' }, 'Ualice0001');
      check('lineGroupId だけを持つ旧形式は、登録した本人でも変えられない', refused(legacy, MEMBERS_ONLY) && expense('exp_cat_legacy').category === 'その他', JSON.stringify(legacy));

      docs.set('expenses/exp_cat_personal', personalExpense({}));
      const personalOther = await press({ ...setCategory, expenseId: 'exp_cat_personal' }, 'Ubob0001');
      check('世帯の無い個人の支出は、登録した本人でなければ変えられない', refused(personalOther, MEMBERS_ONLY) && expense('exp_cat_personal').category === 'その他');
      const personalOwner = await press({ ...setCategory, expenseId: 'exp_cat_personal' }, 'Ualice0001');
      check('世帯の無い個人の支出は、登録した本人なら変えられる', personalOwner.wrote && expense('exp_cat_personal').category === '食費');

      // ---------------- set_category の入力検証（#266） ----------------
      console.log('  [set_category は一覧にあるカテゴリだけ]');
      const invalid = [
        ['数値', 123],
        ['真偽値', true],
        ['null', null],
        ['オブジェクト', { name: '食費' }],
        ['配列', ['食費']],
        ['無し', undefined],
        ['空文字', ''],
        ['一覧に無い名前', '推し活'],
        ['長すぎる値', 'あ'.repeat(200)],
        ['揃えれば一覧にあるが上限を超える長さ', '食費'.padStart(40, ' ')],
      ];
      for (const [label, category] of invalid) {
        docs.set('expenses/exp_cat', groupExpense({}));
        const payload = { action: 'set_category', expenseId: 'exp_cat' };
        if (category !== undefined) payload.category = category;
        const r = await press(payload, 'Ubob0001');
        const loggedValue = r.warns.some((w) => JSON.stringify(w).includes(typeof category === 'string' && category.trim() ? category.trim() : '\u0000'));
        check(
          `${label}は「${NOT_SELECTABLE}」で、書かない（メンバーが押しても。ログに値を出さない）`,
          refused(r, NOT_SELECTABLE) && expense('exp_cat').category === 'その他' && expense('exp_cat').confirmed === undefined && !loggedValue,
          JSON.stringify({ text: r.text, wrote: r.wrote, warns: r.warns })
        );
      }
      {
        docs.set('expenses/exp_cat', groupExpense({}));
        const r = await press({ action: 'set_category', expenseId: 'exp_cat', category: '推し活' }, 'Ubob0001');
        const w = r.warns.find((x) => x[0] === 'Rejected set_category: the category is not in the list');
        check('拒否のログは型と長さだけ（支出 ID は伏せる）', w && w[1].type === 'string' && w[1].length === 3 && w[1].expense === '…_cat' && !JSON.stringify(w).includes('推し活'), JSON.stringify(r.warns));
      }
      docs.set('expenses/exp_cat', groupExpense({}));
      const alias = await press({ action: 'set_category', expenseId: 'exp_cat', category: '医療費' }, 'Ubob0001');
      check('カルーセルの旧名（医療費）は正準名（医療・健康）で保存する', alias.wrote && expense('exp_cat').category === '医療・健康');
      docs.set('expenses/exp_cat', groupExpense({}));
      const hobby = await press({ action: 'set_category', expenseId: 'exp_cat', category: '趣味' }, 'Ubob0001');
      check('LINE の入力の旧名（趣味）も正準名（娯楽）で保存する（#243）', hobby.wrote && expense('exp_cat').category === '娯楽');

      // ---------------- confirm の認可（#266） ----------------
      console.log('  [confirm（OK）は世帯のメンバーだけ]');
      const confirm = { action: 'confirm', expenseId: 'exp_ok' };
      for (const [who, userId] of [['メンバー外', 'Ustranger01'], ['脱退者', 'Uleft0001']]) {
        docs.set('expenses/exp_ok', groupExpense({ includeInTotal: false, confirmed: false }));
        const r = await press(confirm, userId);
        check(`${who}は「${MEMBERS_ONLY}」で、共同費にしない`, refused(r, MEMBERS_ONLY) && expense('exp_ok').status === undefined && expense('exp_ok').includeInTotal === false && expense('exp_ok').confirmed === false, JSON.stringify(r));
      }
      docs.set('expenses/exp_ok', groupExpense({ includeInTotal: false, confirmed: false }));
      const okUnknown = await press(confirm, null);
      check(`押した人が分からなければ「${PRESSER_UNKNOWN}」で、書かない`, refused(okUnknown, PRESSER_UNKNOWN) && expense('exp_ok').confirmed === false);
      docs.set('expenses/exp_ok_legacy', legacyExpense({ includeInTotal: false, confirmed: false }));
      const okLegacy = await press({ action: 'confirm', expenseId: 'exp_ok_legacy' }, 'Ualice0001');
      check('lineGroupId だけを持つ旧形式は、登録した本人でも確定できない', refused(okLegacy, MEMBERS_ONLY) && expense('exp_ok_legacy').confirmed === false);
      docs.set('expenses/exp_ok', groupExpense({ includeInTotal: false, confirmed: false }));
      const okMember = await press(confirm, 'Ubob0001');
      check('メンバーは確定できる（未確認 → 共同費・計上・確認済み）', okMember.wrote && okMember.flex && expense('exp_ok').status === 'shared' && expense('exp_ok').includeInTotal === true && expense('exp_ok').confirmed === true, JSON.stringify(expense('exp_ok')));
      const okLog = logs.filter((l) => l[0] === 'Expense confirmed').pop();
      check('確定のログは支出 ID を伏せ、書式文字列に埋め込まない', okLog && okLog[1].expense === '…p_ok' && okLog[1].status === 'shared', JSON.stringify(okLog));

      // ---------------- show_category_select の認可（#266） ----------------
      console.log('  [show_category_select（カテゴリ選択のカルーセル）は世帯のメンバーだけ]');
      const show = { action: 'show_category_select', expenseId: 'exp_show', source: 'gmail' };
      docs.set('expenses/exp_show', groupExpense({}));
      docs.set('expenses/exp_show_legacy', legacyExpense({}));
      for (const [who, userId, expenseId] of [
        ['メンバー外', 'Ustranger01', 'exp_show'],
        ['脱退者', 'Uleft0001', 'exp_show'],
        ['旧形式（lineGroupId だけ）の登録者', 'Ualice0001', 'exp_show_legacy'],
      ]) {
        const r = await press({ ...show, expenseId }, userId);
        check(`${who}にはカルーセルを返さず「${MEMBERS_ONLY}」`, refused(r, MEMBERS_ONLY) && !r.flex, JSON.stringify(r.replies));
      }
      const showUnknown = await press(show, null);
      check(`押した人が分からなければ「${PRESSER_UNKNOWN}」`, refused(showUnknown, PRESSER_UNKNOWN));
      const showMember = await press(show, 'Ubob0001');
      check('メンバーにはカルーセルを返す（書かない）', showMember.flex && showMember.flex.contents.type === 'carousel' && !showMember.wrote, JSON.stringify(showMember.replies));
      const showMissing = await press({ ...show, expenseId: 'no_such' }, 'Ubob0001');
      check('存在しない支出には返信しない', showMissing.replies.length === 0 && !showMissing.wrote);

      // ---------------- show_category_select の source（許可リスト） ----------------
      console.log('  [show_category_select の source は gmail / text だけ（それ以外は gmail）]');
      const sourcesInCarousel = async (source) => {
        const payload = { action: 'show_category_select', expenseId: 'exp_show' };
        if (source !== undefined) payload.source = source;
        const r = await press(payload, 'Ubob0001');
        return r.flex ? [...new Set(postbacksIn(r.flex).map((p) => p.source))] : null;
      };
      check('source が text なら、カルーセルのボタンにも text を埋め込む', deepEqual(await sourcesInCarousel('text'), ['text']));
      check('source が gmail・無しなら gmail', deepEqual(await sourcesInCarousel('gmail'), ['gmail']) && deepEqual(await sourcesInCarousel(undefined), ['gmail']));
      const unexpectedSources = [];
      for (const source of ['x'.repeat(300), 'TEXT', 123, { a: 1 }, ['text'], null]) {
        const s = await sourcesInCarousel(source);
        if (!deepEqual(s, ['gmail'])) unexpectedSources.push([source, s]);
      }
      check('許可リストに無い source（長い文字列・大文字・数値・オブジェクト・配列・null）は既定の gmail にする', unexpectedSources.length === 0, JSON.stringify(unexpectedSources));

      // ---------------- set_payer・set_split・set_advance（区分・［自分が払った］［自分が立替］［取り消す］） ----------------
      console.log('  [set_payer・set_split・set_advance も世帯のメンバーだけ]');
      for (const [label, payload] of [
        ['set_payer', { action: 'set_payer' }],
        ['set_split', { action: 'set_split', to: 'personal' }],
        ['set_advance', { action: 'set_advance', to: 'on' }],
        ['旧UIの personal', { action: 'personal' }],
      ]) {
        for (const [who, userId, make] of [
          ['メンバー外', 'Ustranger01', groupExpense],
          ['脱退者', 'Uleft0001', groupExpense],
          ['旧形式（lineGroupId だけ）の登録者', 'Ualice0001', legacyExpense],
        ]) {
          docs.set('expenses/exp_btn', make({ status: 'shared', includeInTotal: true, confirmed: true, payerId: 'Ualice0001' }));
          const r = await press({ ...payload, expenseId: 'exp_btn' }, userId);
          check(`${label}: ${who}は「${MEMBERS_ONLY}」で、書かない`, refused(r, MEMBERS_ONLY) && expense('exp_btn').status === 'shared' && expense('exp_btn').payerId === 'Ualice0001', JSON.stringify(r.replies));
        }
      }
      docs.set('expenses/exp_btn', groupExpense({ status: 'shared', includeInTotal: true, confirmed: true, payerId: 'Ualice0001', payerDisplayName: 'Alice' }));
      const payer = await press({ action: 'set_payer', expenseId: 'exp_btn' }, 'Ubob0001');
      check(
        'set_payer: メンバーが押すと支払った人がその人になる（名前はメンバー文書の Bob。LINE のプロフィール名ではない）',
        payer.wrote && payer.flex && expense('exp_btn').payerId === 'Ubob0001' && expense('exp_btn').payerDisplayName === 'Bob',
        JSON.stringify(expense('exp_btn'))
      );
      docs.set('groupMembers/g1_Uhana0001', { groupId: 'g1', lineId: 'Uhana0001', displayName: '作成者', isActive: true });
      const placeholder = await press({ action: 'set_payer', expenseId: 'exp_btn' }, 'Uhana0001');
      check('set_payer: メンバー文書の名前が仮名「作成者」なら LINE のプロフィール名を使う', placeholder.wrote && expense('exp_btn').payerDisplayName === 'プロフィール名', JSON.stringify(expense('exp_btn')));
      docs.delete('groupMembers/g1_Uhana0001');
      const split = await press({ action: 'set_split', expenseId: 'exp_btn', to: 'personal' }, 'Ubob0001');
      check('set_split: メンバーは除外にできる', split.wrote && expense('exp_btn').status === 'personal' && expense('exp_btn').includeInTotal === false);
      const advance = await press({ action: 'set_advance', expenseId: 'exp_btn', to: 'on' }, 'Ubob0001');
      check('set_advance: メンバーは立替にできる（押した人が立替・支払い。名前はメンバー文書）', advance.wrote && expense('exp_btn').status === 'advance_pending' && expense('exp_btn').advanceBy === 'Ubob0001' && expense('exp_btn').payerDisplayName === 'Bob', JSON.stringify(expense('exp_btn')));
      const clear = await press({ action: 'set_advance', expenseId: 'exp_btn', to: 'off' }, 'Ualice0001');
      check('set_advance off: メンバーは立替を取り消せる', clear.wrote && expense('exp_btn').status === 'shared' && !('advanceBy' in expense('exp_btn')));

      // ---------------- 支出 ID の形式（最初に確かめ、不正なら何もしない） ----------------
      console.log('  [支出 ID が文書 ID として不正なら、Firestore も LINE も呼ばずに何もしない]');
      const badIds = [
        ['a/b/c', 'a/b/c'],
        ['数値', 123],
        ['巨大な文字列', 'x'.repeat(100000)],
        ['129 文字', 'x'.repeat(129)],
        ['予約 ID（__x__）', '__x__'],
        ['..', '..'],
        ['空文字', ''],
        ['オブジェクト', { id: 'exp_btn' }],
      ];
      for (const [label, expenseId] of badIds) {
        const touched = [];
        for (const action of ['set_category', 'confirm', 'show_category_select', 'set_payer', 'set_split', 'set_advance', 'edit']) {
          const before = { reads, profileCalls, applyCalls: applyCalls.length };
          const r = await press({ action, expenseId, category: '食費', to: 'personal' }, 'Ubob0001');
          if (r.replies.length > 0 || r.wrote || r.decided || reads !== before.reads || profileCalls !== before.profileCalls || applyCalls.length !== before.applyCalls) {
            touched.push(action);
          }
        }
        check(`${label}: どの action でも返信・読み取り・書き込み・プロフィール取得をしない`, touched.length === 0, JSON.stringify(touched));
      }
      {
        const r = await press({ action: 'set_category', expenseId: 'exp_btn', category: '食費' }, 'Ubob0001');
        check('（比較: 正しい支出 ID なら同じ押し方で書き込む）', r.wrote);
      }
      {
        const before = { reads, replies: replies.length };
        console.log = () => {};
        console.error = () => {};
        try {
          await handlePostback({ type: 'postback', replyToken: 'reply-token', source: { type: 'group', groupId: 'C_line1', userId: 'Ubob0001' }, postback: { data: 'null' } });
          await handlePostback({ type: 'postback', replyToken: 'reply-token', source: { type: 'group', groupId: 'C_line1', userId: 'Ubob0001' }, postback: { data: '1' } });
        } finally {
          console.log = origLog;
          console.error = origError;
        }
        check('JSON がオブジェクトでない postback（null・数値）は投げずに何もしない', reads === before.reads && replies.length === before.replies);
      }

      // ---------------- ログ（利用者の入力を書式文字列に埋め込まない） ----------------
      console.log('  [ログに利用者の入力を書式文字列で埋め込まない]');
      {
        const r = await press({ action: 'evil\naction', expenseId: 'exp_btn' }, 'Ubob0001');
        const w = r.warns.find((x) => x[0] === 'Unknown postback action');
        check('不明な action は型だけをオブジェクトで出す（値を出さない）', w && w[1].type === 'string' && w[1].expense === '…_btn' && !JSON.stringify(r.warns).includes('evil'), JSON.stringify(r.warns));
        const m = await press({ action: 'set_category', expenseId: 'no_such_0042', category: '食費' }, 'Ubob0001');
        const nf = m.warns.find((x) => x[0] === 'Expense not found');
        check('存在しない支出のログ（applyExpenseChange）は支出 ID を伏せてオブジェクトで出す', nf && nf[1].expense === '…0042' && !JSON.stringify(m.warns).includes('no_such'), JSON.stringify(m.warns));
      }

      // ---------------- applyExpenseChange は authorize 付きでだけ呼ぶ ----------------
      const pressedActions = [...new Set(applyCalls.map((c) => c.action))].sort();
      const expectedActions = ['confirm', 'personal', 'set_advance', 'set_category', 'set_payer', 'set_split'];
      check(
        `押した ${expectedActions.join('・')} は、どれも authorize を付けて applyExpenseChange を呼ぶ`,
        deepEqual(pressedActions, expectedActions) && applyCalls.every((c) => c.authorized),
        JSON.stringify({ pressedActions, unauthorized: applyCalls.filter((c) => !c.authorized) })
      );
    } finally {
      firestoreModule.getFirestore = origGetFirestore;
      actions.applyExpenseChange = origApply;
      client.replyWithPushFallback = origReply;
      client.getLineClient = origGetLineClient;
    }
  }

  console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
