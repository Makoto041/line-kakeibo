// 期間の折半精算（periodSplit.ts）のテスト。node --test で実行する（型除去で .ts を直接読む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computePeriodSplit, formatYenExact } from '../lib/periodSplit.ts';

const OWNER = { lineId: 'Uowner', displayName: '誠' };
const PARTNER = { lineId: 'Upartner', displayName: '光麦' };
const MEMBERS = [OWNER, PARTNER];
const G = 'g1';

const e = (amount, payerId, extra = {}) => ({ amount, lineId: payerId, payerId, groupId: G, includeInTotal: true, ...extra });

// 2026/8/15〜9/14 のスクショと同じ内訳: 誠 196,329 / クレジットカード 121,914 / 光麦 2,610 = 320,853
const screenshot = [
  e(196329, OWNER.lineId),
  e(121914, 'gmail-system', { lineId: 'gmail-system' }),
  e(2610, PARTNER.lineId),
  e(5000, OWNER.lineId, { includeInTotal: false }),
];

test('スクショの精算を再現: 320,853 ÷ 2 − 2,610 = 157,816.5 → 光麦から 157,817 円', () => {
  const r = computePeriodSplit({ expenses: screenshot, groupId: G, members: MEMBERS, targetLineId: PARTNER.lineId });
  assert.equal(r.total, 320853);
  assert.equal(r.count, 3);
  assert.equal(r.excludedCount, 1);
  assert.equal(r.half, 160426.5);
  assert.equal(r.targetPaid, 2610);
  assert.equal(r.reason, null);
  assert.deepEqual(r.transfer, { fromLineId: PARTNER.lineId, toLineId: OWNER.lineId, amount: 157817 });
  assert.equal(formatYenExact(r.half), '¥160,426.5');
});

test('集金するメンバーは名前で決め打ちしない（誠を指定すれば誠の支払いを引く）', () => {
  const r = computePeriodSplit({ expenses: screenshot, groupId: G, members: MEMBERS, targetLineId: OWNER.lineId });
  assert.equal(r.targetPaid, 196329);
  // 160,426.5 − 196,329 = −35,902.5 → 光麦が誠に 35,903 円
  assert.deepEqual(r.transfer, { fromLineId: PARTNER.lineId, toLineId: OWNER.lineId, amount: 35903 });
});

test('集金するメンバーが半分より多く払っていれば、相手が払う', () => {
  const r = computePeriodSplit({
    expenses: [e(1000, OWNER.lineId), e(9000, PARTNER.lineId)],
    groupId: G,
    members: MEMBERS,
    targetLineId: PARTNER.lineId,
  });
  assert.deepEqual(r.transfer, { fromLineId: OWNER.lineId, toLineId: PARTNER.lineId, amount: 4000 });
});

test('ちょうど半分なら精算なし', () => {
  const r = computePeriodSplit({
    expenses: [e(5000, OWNER.lineId), e(5000, PARTNER.lineId)],
    groupId: G,
    members: MEMBERS,
    targetLineId: PARTNER.lineId,
  });
  assert.equal(r.transfer, null);
  assert.equal(r.reason, null);
});

test('個人の支出・別の世帯の支出は折半しない', () => {
  const r = computePeriodSplit({
    expenses: [e(1000, OWNER.lineId), e(7777, OWNER.lineId, { groupId: undefined }), e(8888, PARTNER.lineId, { groupId: 'g2' })],
    groupId: G,
    members: MEMBERS,
    targetLineId: PARTNER.lineId,
  });
  assert.equal(r.total, 1000);
  assert.deepEqual(r.transfer, { fromLineId: PARTNER.lineId, toLineId: OWNER.lineId, amount: 500 });
});

test('payerId が無ければ登録者（lineId）の支払いとみなす', () => {
  const r = computePeriodSplit({
    expenses: [{ amount: 3000, lineId: PARTNER.lineId, groupId: G, includeInTotal: true }, e(1000, OWNER.lineId)],
    groupId: G,
    members: MEMBERS,
    targetLineId: PARTNER.lineId,
  });
  assert.equal(r.targetPaid, 3000);
  assert.deepEqual(r.transfer, { fromLineId: OWNER.lineId, toLineId: PARTNER.lineId, amount: 1000 });
});

test('集金するメンバーが未指定・メンバー外なら金額を出さない（合計は出す）', () => {
  for (const targetLineId of [null, 'Ustranger']) {
    const r = computePeriodSplit({ expenses: screenshot, groupId: G, members: MEMBERS, targetLineId });
    assert.equal(r.reason, 'no_target');
    assert.equal(r.transfer, null);
    assert.equal(r.total, 320853);
  }
});

test('有効メンバーが 2 人でなければ計算しない', () => {
  const r = computePeriodSplit({ expenses: screenshot, groupId: G, members: [OWNER], targetLineId: OWNER.lineId });
  assert.equal(r.reason, 'not_two_members');
  assert.equal(r.transfer, null);
});

test('立替精算済みの明細は折半しない（立替の精算と二重にしない）', () => {
  const r = computePeriodSplit({
    expenses: [e(4000, OWNER.lineId), e(6000, PARTNER.lineId, { status: 'advance_settled' })],
    groupId: G,
    members: MEMBERS,
    targetLineId: PARTNER.lineId,
  });
  assert.equal(r.total, 4000);
  assert.equal(r.settledCount, 1);
  assert.equal(r.excludedCount, 0);
  assert.deepEqual(r.transfer, { fromLineId: PARTNER.lineId, toLineId: OWNER.lineId, amount: 2000 });
});

test('期間を指定すると範囲外の日付は数えない（両端を含む）', () => {
  const r = computePeriodSplit({
    expenses: [
      e(100, OWNER.lineId, { date: '2026-08-14' }),
      e(200, OWNER.lineId, { date: '2026-08-15' }),
      e(300, OWNER.lineId, { date: '2026-09-14' }),
      e(400, OWNER.lineId, { date: '2026-09-15' }),
    ],
    groupId: G,
    members: MEMBERS,
    targetLineId: PARTNER.lineId,
    range: { startDate: '2026-08-15', endDate: '2026-09-14' },
  });
  assert.equal(r.total, 500);
});

test('formatYenExact: 整数は小数なし', () => {
  assert.equal(formatYenExact(320853), '¥320,853');
  assert.equal(formatYenExact(0.5), '¥0.5');
});

test('立替（全額）は折半せず、支出の日付の期間の精算に全額を加算する', () => {
  const range = { startDate: '2026-09-15', endDate: '2026-10-14' };
  const d = (date, amount, payerId, extra = {}) => e(amount, payerId, { date, ...extra });
  const base = [d('2026-09-20', 10000, PARTNER.lineId), d('2026-09-21', 30000, OWNER.lineId)];
  const full = (date, amount, by) => d(date, amount, by, { status: 'advance_pending', advanceBy: by, advanceFull: true });
  const split = (expenses) => computePeriodSplit({ expenses, groupId: G, members: MEMBERS, targetLineId: PARTNER.lineId, range });

  // 誠が光麦の分を立て替えた 2,610 → 光麦は 10,000 + 2,610 を誠へ
  const r = split([...base, full('2026-10-01', 2610, OWNER.lineId)]);
  assert.equal(r.total, 40000);
  assert.equal(r.count, 2);
  assert.equal(r.advanceCount, 1);
  assert.equal(r.counterpartAdvanced, 2610);
  assert.equal(r.targetAdvanced, 0);
  assert.deepEqual(r.transfer, { fromLineId: PARTNER.lineId, toLineId: OWNER.lineId, amount: 12610 });

  // 光麦の立替は差し引く
  const both = split([...base, full('2026-10-01', 2610, OWNER.lineId), full('2026-10-02', 788, PARTNER.lineId)]);
  assert.deepEqual(both.transfer, { fromLineId: PARTNER.lineId, toLineId: OWNER.lineId, amount: 11822 });

  // 期間外の立替はその期間の精算に入る（この期間には入らない）
  assert.equal(split([...base, full('2026-10-15', 2610, OWNER.lineId)]).advanceCount, 0);

  // 全額にする前の立替（advanceFull 無し）と精算済みは、これまでどおり
  const legacy = split([...base, d('2026-10-01', 2610, OWNER.lineId, { status: 'advance_pending', advanceBy: OWNER.lineId })]);
  assert.equal(legacy.total, 42610);
  assert.equal(legacy.advanceCount, 0);
  const settled = split([...base, d('2026-10-01', 2610, OWNER.lineId, { status: 'advance_settled', advanceFull: true })]);
  assert.equal(settled.settledCount, 1);
  assert.equal(settled.advanceCount, 0);

  // 送金する人が決まっていなければ立替の額も出さない
  const noTarget = computePeriodSplit({ expenses: [...base, full('2026-10-01', 2610, OWNER.lineId)], groupId: G, members: MEMBERS, targetLineId: null, range });
  assert.equal(noTarget.reason, 'no_target');
  assert.equal(noTarget.counterpartAdvanced, 0);
  assert.equal(noTarget.transfer, null);
});
