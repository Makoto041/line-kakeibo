/**
 * 固定費（recurringExpenses.ts）の純関数のテスト。ビルド済みの dist を読む（npm run smoke から実行）。
 */
const assert = require('node:assert/strict');
const {
  dueDateFor,
  shouldPost,
  parseRecurringInput,
  buildRecurringExpense,
  recurringExpenseId,
  toRecurringItem,
  RECURRING_SYSTEM_LINE_ID,
} = require('../dist/recurringExpenses');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n${error.stack}`);
    process.exitCode = 1;
  }
}

const baseItem = {
  id: 'r1',
  groupId: 'g1',
  name: '家賃',
  amount: 120000,
  category: '住居費',
  dayOfMonth: 27,
  payment: 'advance',
  payerLineId: 'Uaaa',
  active: true,
  lastPostedMonth: null,
  startDate: '2026-09-01',
};

console.log('recurring: dueDateFor');
test('月の日数以内はその日', () => assert.equal(dueDateFor('2026-09', 27), '2026-09-27'));
test('31 日指定は 30 日の月で末日', () => assert.equal(dueDateFor('2026-09', 31), '2026-09-30'));
test('2 月は 28 日（平年）', () => assert.equal(dueDateFor('2026-02', 30), '2026-02-28'));
test('2 月は 29 日（閏年）', () => assert.equal(dueDateFor('2028-02', 31), '2028-02-29'));

console.log('recurring: shouldPost');
test('引き落とし日の前は計上しない', () => assert.equal(shouldPost(baseItem, '2026-09-26'), null));
test('引き落とし日に計上する', () =>
  assert.deepEqual(shouldPost(baseItem, '2026-09-27'), { month: '2026-09', date: '2026-09-27' }));
test('実行が遅れても同じ月のうちなら計上する（日付は引き落とし日）', () =>
  assert.deepEqual(shouldPost(baseItem, '2026-09-30'), { month: '2026-09', date: '2026-09-27' }));
test('計上済みの月は計上しない', () =>
  assert.equal(shouldPost({ ...baseItem, lastPostedMonth: '2026-09' }, '2026-09-28'), null));
test('前月まで計上済みなら今月は計上する', () =>
  assert.deepEqual(shouldPost({ ...baseItem, lastPostedMonth: '2026-09' }, '2026-10-27'), {
    month: '2026-10',
    date: '2026-10-27',
  }));
test('無効の項目は計上しない', () => assert.equal(shouldPost({ ...baseItem, active: false }, '2026-09-27'), null));
test('作成日より前の引き落とし日は遡らない', () =>
  assert.equal(shouldPost({ ...baseItem, startDate: '2026-09-28' }, '2026-09-30'), null));
test('作成日当日が引き落とし日なら計上する', () =>
  assert.deepEqual(shouldPost({ ...baseItem, startDate: '2026-09-27' }, '2026-09-27'), {
    month: '2026-09',
    date: '2026-09-27',
  }));

console.log('recurring: parseRecurringInput');
const valid = { name: '家賃', amount: 120000, category: '住居費', dayOfMonth: 27, payment: 'advance', payerLineId: 'Uaaa' };
test('正しい入力（active は既定で true）', () => assert.deepEqual(parseRecurringInput(valid, false), { ...valid, active: true }));
test('名前の前後の空白と制御文字を落とす', () =>
  assert.equal(parseRecurringInput({ ...valid, name: '  電気\u0007代 ' }, false).name, '電気代'));
test('空の名前・41 字の名前は不可', () => {
  assert.equal(parseRecurringInput({ ...valid, name: '  ' }, false), null);
  assert.equal(parseRecurringInput({ ...valid, name: 'あ'.repeat(41) }, false), null);
});
test('金額は 1〜1000 万の整数', () => {
  assert.equal(parseRecurringInput({ ...valid, amount: 0 }, false), null);
  assert.equal(parseRecurringInput({ ...valid, amount: 1.5 }, false), null);
  assert.equal(parseRecurringInput({ ...valid, amount: '1000' }, false), null);
  assert.equal(parseRecurringInput({ ...valid, amount: 10_000_001 }, false), null);
});
test('カテゴリは正準カテゴリだけ', () => assert.equal(parseRecurringInput({ ...valid, category: 'なにか' }, false), null));
test('日は 1〜31 の整数', () => {
  assert.equal(parseRecurringInput({ ...valid, dayOfMonth: 0 }, false), null);
  assert.equal(parseRecurringInput({ ...valid, dayOfMonth: 32 }, false), null);
});
test('advance は立替者が必須、shared は立替者なし', () => {
  assert.equal(parseRecurringInput({ ...valid, payerLineId: null }, false), null);
  assert.equal(parseRecurringInput({ ...valid, payment: 'shared' }, false), null);
  assert.deepEqual(parseRecurringInput({ ...valid, payment: 'shared', payerLineId: null }, false).payment, 'shared');
});
test('知らないキーは不可', () => assert.equal(parseRecurringInput({ ...valid, groupId: 'x' }, false), null));
test('部分更新は渡したキーだけ', () =>
  assert.deepEqual(parseRecurringInput({ amount: 9800 }, true), { amount: 9800 }));
test('部分更新でも不正な値は不可', () => assert.equal(parseRecurringInput({ amount: -1 }, true), null));

console.log('recurring: buildRecurringExpense');
const now = new Date('2026-09-26T21:10:00Z');
const group = { lineGroupId: 'Cgroup', names: new Map([['Uaaa', 'まこと']]) };
test('立替（個人口座）は立替者の未精算の立替になる', () => {
  const e = buildRecurringExpense(baseItem, '2026-09-27', group, now);
  assert.equal(e.status, 'advance_pending');
  assert.equal(e.advanceBy, 'Uaaa');
  assert.equal(e.lineId, 'Uaaa');
  assert.equal(e.payerId, 'Uaaa');
  assert.equal(e.payerDisplayName, 'まこと');
  assert.equal(e.groupId, 'g1');
  assert.equal(e.lineGroupId, 'Cgroup');
  assert.equal(e.includeInTotal, true);
  assert.equal(e.confirmed, true);
  assert.equal(e.inputSource, 'recurring');
  assert.equal(e.recurringId, 'r1');
  assert.equal(e.date, '2026-09-27');
  assert.equal(e.description, '家賃');
});
test('共通のカード・口座は共同費になる（立替ではない）', () => {
  const e = buildRecurringExpense({ ...baseItem, payment: 'shared', payerLineId: null }, '2026-09-27', group, now);
  assert.equal(e.status, 'shared');
  assert.equal(e.lineId, RECURRING_SYSTEM_LINE_ID);
  assert.equal(e.advanceBy, undefined);
  assert.equal(e.userDisplayName, undefined);
  assert.equal(e.payerDisplayName, undefined);
});
test('立替者の表示名が分からないときは代わりの名前', () => {
  const e = buildRecurringExpense(baseItem, '2026-09-27', { lineGroupId: null, names: new Map([['Uaaa', '']]) }, now);
  assert.equal(e.payerDisplayName, 'User_Uaaa');
});
test('LINE グループに紐づかない世帯は lineGroupId を持たない', () => {
  const e = buildRecurringExpense(baseItem, '2026-09-27', { lineGroupId: null, names: new Map() }, now);
  assert.equal('lineGroupId' in e, false);
});
test('明細の ID は月ごとに固定', () => assert.equal(recurringExpenseId('r1', '2026-09'), 'recurring_r1_202609'));

console.log('recurring: toRecurringItem');
test('壊れた文書は null', () => {
  assert.equal(toRecurringItem('x', { ...baseItem, amount: 'a' }), null);
  assert.equal(toRecurringItem('x', { ...baseItem, payerLineId: null }), null);
  assert.equal(toRecurringItem('x', undefined), null);
});
test('active が無い古い文書は有効扱い', () => {
  const { active: _a, ...rest } = baseItem;
  assert.equal(toRecurringItem('x', rest).active, true);
});

console.log(`recurring: ${passed} passed`);
