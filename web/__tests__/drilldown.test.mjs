// 内訳（lib/drilldown.ts）の純関数のテスト。node --test で実行する（型除去で .ts を直接読む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toDrillItems,
  matchesDrill,
  sumAmount,
  groupDrill,
  sharePct,
  deltaPct,
  availableDims,
  resolveDim,
  sortDrillItems,
  weeklyTotals,
  payerColor,
  inputSourceLabel,
  CARD_PAYER_NAME,
  SHARED_PAYER_NAME,
} from '../lib/drilldown.ts';
import { isPending } from '../lib/expenseState.ts';

const RANGE = { startDate: '2026-09-15', endDate: '2026-10-14' };
const e = (id, amount, extra = {}) => ({
  id,
  lineId: 'Ua',
  payerId: 'Ua',
  amount,
  description: `item ${id}`,
  date: '2026-09-20',
  category: '食費',
  includeInTotal: true,
  status: 'shared',
  confirmed: true,
  inputSource: 'line_text',
  ...extra,
});
const NAMES = { Ua: '光麦', Ub: '誠', 'gmail-auto-system': CARD_PAYER_NAME, 'recurring-system': SHARED_PAYER_NAME };
const payer = (x) => ({ key: x.payerId || x.lineId, name: NAMES[x.payerId || x.lineId] ?? '不明' });

const expenses = [
  e('a', 4900, { category: '日用品' }),
  e('b', 120000, { lineId: 'recurring-system', payerId: 'recurring-system', category: '住居費', inputSource: 'recurring', date: '2026-09-27' }),
  e('c', 3000, { lineId: 'gmail-auto-system', payerId: 'gmail-auto-system', inputSource: 'gmail_auto', date: '2026-10-01' }),
  e('d', 2000, { lineId: 'gmail-auto-system', payerId: 'gmail-auto-system', inputSource: 'gmail_auto', date: '2026-10-08' }),
  e('e', 8000, { lineId: 'Ub', payerId: 'Ub', category: '娯楽', date: '2026-10-14' }),
  // 合計に含まない（手入力の未確認）
  e('f', 2180, { includeInTotal: false, status: undefined, confirmed: false }),
  // 期間外
  e('g', 99999, { date: '2026-10-15' }),
];
const items = toDrillItems(expenses, { range: RANGE, included: (x) => x.includeInTotal, payer, pending: isPending });
const included = items.filter((i) => i.included);

test('toDrillItems: 期間外を除き、合計に含むか・支払い者・要確認を付ける', () => {
  assert.deepEqual(items.map((i) => i.id), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(items.find((i) => i.id === 'f').included, false);
  assert.equal(items.find((i) => i.id === 'f').pending, true);
  assert.equal(items.find((i) => i.id === 'c').pending, false); // カード取込は確認不要
  assert.equal(items.find((i) => i.id === 'b').payerName, SHARED_PAYER_NAME);
  assert.equal(items.find((i) => i.id === 'c').payerKey, 'gmail-auto-system');
});

test('matchesDrill: カテゴリと支払い者（どれか）で絞る', () => {
  assert.equal(matchesDrill({ category: '食費', payerKey: 'Ua' }, {}), true);
  assert.equal(matchesDrill({ category: '食費', payerKey: 'Ua' }, { category: '娯楽' }), false);
  assert.equal(matchesDrill({ category: '食費', payerKey: 'Ua' }, { payers: ['Ub', 'Ua'] }), true);
  assert.equal(matchesDrill({ category: '食費', payerKey: 'Ua' }, { payers: [] }), false);
  assert.equal(matchesDrill({ category: '食費', payerKey: 'Ua' }, { category: '食費', payers: ['Ub'] }), false);
});

test('groupDrill: カテゴリ別・支払い者別の小計を金額の多い順に', () => {
  assert.equal(sumAmount(included), 137900);
  assert.deepEqual(
    groupDrill(included, 'category').map((g) => [g.key, g.total, g.count]),
    [['住居費', 120000, 1], ['娯楽', 8000, 1], ['食費', 5000, 2], ['日用品', 4900, 1]]
  );
  assert.deepEqual(
    groupDrill(included, 'payer').map((g) => [g.label, g.total]),
    [[SHARED_PAYER_NAME, 120000], ['誠', 8000], [CARD_PAYER_NAME, 5000], ['光麦', 4900]]
  );
});

test('sharePct / deltaPct', () => {
  assert.equal(sharePct(120000, 137900), 87);
  assert.equal(sharePct(1, 3), 33.3);
  assert.equal(sharePct(5, 0), 0);
  assert.equal(deltaPct(110, 100), 10);
  assert.equal(deltaPct(90, 100), -10);
  assert.equal(deltaPct(100, 0), null);
  assert.equal(deltaPct(100, undefined), null);
});

test('availableDims / resolveDim: 絞り込み済みの軸・1 つしか無い軸は出さない', () => {
  assert.deepEqual(availableDims(included, {}), { category: true, payer: true });
  const food = included.filter((i) => matchesDrill(i, { category: '食費' }));
  assert.deepEqual(availableDims(food, { category: '食費' }), { category: false, payer: false }); // カードだけ
  assert.equal(resolveDim(food, { category: '食費' }), null);
  const mitsu = included.filter((i) => matchesDrill(i, { payers: ['Ua'] }));
  assert.deepEqual(availableDims(mitsu, { payers: ['Ua'] }), { category: false, payer: false });
  const others = included.filter((i) => matchesDrill(i, { payers: ['Ub', 'gmail-auto-system', 'recurring-system'] }));
  assert.equal(resolveDim(others, { payers: ['Ub', 'gmail-auto-system', 'recurring-system'] }, 'payer'), 'payer');
  assert.equal(resolveDim(included, {}), 'category');
  assert.equal(resolveDim(included, {}, 'payer'), 'payer');
});

test('sortDrillItems: 日付の新しい順 / 金額の多い順', () => {
  assert.deepEqual(sortDrillItems(included, 'date').map((i) => i.id), ['e', 'd', 'c', 'b', 'a']);
  assert.deepEqual(sortDrillItems(included, 'amount').map((i) => i.id), ['b', 'e', 'a', 'c', 'd']);
});

test('weeklyTotals: 開始日から 7 日ずつ、最後の週は期間末で切る', () => {
  const weeks = weeklyTotals(included, RANGE);
  assert.deepEqual(
    weeks.map((w) => [w.start, w.end, w.total]),
    [
      ['2026-09-15', '2026-09-21', 4900],
      ['2026-09-22', '2026-09-28', 120000],
      ['2026-09-29', '2026-10-05', 3000],
      ['2026-10-06', '2026-10-12', 2000],
      ['2026-10-13', '2026-10-14', 8000],
    ]
  );
  assert.deepEqual(weeklyTotals(included, { startDate: '', endDate: '' }), []);
});

test('payerColor / inputSourceLabel', () => {
  assert.equal(payerColor(CARD_PAYER_NAME, 0), '#0ea5e9');
  assert.equal(payerColor(SHARED_PAYER_NAME, 3), '#14b8a6');
  assert.notEqual(payerColor('光麦', 0), payerColor('誠', 1));
  assert.equal(inputSourceLabel('gmail_auto'), 'カード取込（メール）');
  assert.equal(inputSourceLabel(undefined), 'LINE で手入力');
});
