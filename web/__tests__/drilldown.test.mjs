// 内訳（lib/drilldown.ts）の純関数のテスト。node --test で実行する（型除去で .ts を直接読む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
  subCategoriesOf,
  subCategoryKey,
  CARD_PAYER_NAME,
  SHARED_PAYER_NAME,
  NO_SUB_CATEGORY,
  SUB_CATEGORIES,
} from '../lib/drilldown.ts';
import { isPending } from '../lib/expenseState.ts';
import { yen } from '../lib/money.ts';

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
  assert.deepEqual(availableDims(included, {}), { category: true, subCategory: false, payer: true });
  const food = included.filter((i) => matchesDrill(i, { category: '食費' }));
  // カードだけ・中項目なしだけ
  assert.deepEqual(availableDims(food, { category: '食費' }), { category: false, subCategory: false, payer: false });
  assert.equal(resolveDim(food, { category: '食費' }), null);
  const mitsu = included.filter((i) => matchesDrill(i, { payers: ['Ua'] }));
  assert.deepEqual(availableDims(mitsu, { payers: ['Ua'] }), { category: false, subCategory: false, payer: false });
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

// ---- 中項目（#235） ----

test('中項目の一覧: bot/src/categoryTaxonomy.ts の SUB_CATEGORIES と同じ（大項目・中項目・並び）', () => {
  // bot は CommonJS で拡張子なしの import を使うため直接は読めない。ソースから一覧の部分だけを取り出して比べる
  const src = readFileSync(new URL('../../bot/src/categoryTaxonomy.ts', import.meta.url), 'utf8');
  const start = src.indexOf('export const SUB_CATEGORIES:');
  assert.ok(start >= 0, 'bot の SUB_CATEGORIES が見つからない');
  const block = src.slice(start, src.indexOf('\n};', start));
  const bot = {};
  let major = null;
  for (const line of block.split('\n')) {
    const head = line.match(/^ {2}'?([^'\s:]+)'?: \[/);
    if (head) {
      major = head[1];
      bot[major] = [];
      continue;
    }
    const name = line.match(/^ {4}'([^']+)',?$/);
    if (name && major) bot[major].push(name[1]);
  }
  assert.deepEqual(bot, { ...SUB_CATEGORIES });
  // 一覧にない値を寄せる先（各一覧の最後）は「その他の<大項目>」
  for (const [m, list] of Object.entries(SUB_CATEGORIES)) assert.equal(list[list.length - 1], `その他の${m}`);
});

test('subCategoryKey: 一覧の値はそのまま、一覧にない値は「その他の…」、空は「中項目なし」、一覧の無い大項目は無し', () => {
  assert.equal(subCategoryKey('食費', '昼ご飯'), '昼ご飯');
  assert.equal(subCategoryKey('食費', ' 昼ご飯 '), '昼ご飯');
  assert.equal(subCategoryKey('娯楽', 'スポーツ・アウトドア'), 'スポーツ・アウトドア');
  // 一覧にない値（Web で入れた値・別の大項目の中項目・「中項目なし」という文字列）
  assert.equal(subCategoryKey('食費', 'おやつ'), 'その他の食費');
  assert.equal(subCategoryKey('食費', '映画'), 'その他の食費');
  assert.equal(subCategoryKey('食費', NO_SUB_CATEGORY), 'その他の食費');
  assert.equal(subCategoryKey('娯楽', 'ボルダリング'), 'その他の娯楽');
  assert.equal(subCategoryKey('食費', 'あ'.repeat(10000)), 'その他の食費');
  // 空・文字列でない
  for (const v of [undefined, null, '', '   ', 123, {}, ['昼ご飯']]) assert.equal(subCategoryKey('食費', v), NO_SUB_CATEGORY);
  // 一覧の無い大項目（値があっても使わない）・正準名でない名前
  assert.equal(subCategoryKey('日用品', '洗剤'), undefined);
  assert.equal(subCategoryKey('日用品', undefined), undefined);
  assert.equal(subCategoryKey('外食', '昼ご飯'), undefined);
  assert.equal(subCategoryKey('__proto__', '昼ご飯'), undefined);
  assert.deepEqual(subCategoriesOf('constructor'), []);
});

const SUB_RANGE = { startDate: '2026-09-15', endDate: '2026-10-31' };
const subExpenses = [
  e('s1', 3800, { subCategory: '食料品（スーパー）', date: '2026-10-02' }),
  e('s2', 4250, { subCategory: '食料品（スーパー）', lineId: 'Ub', payerId: 'Ub', date: '2026-10-09' }),
  e('l1', 800, { subCategory: '昼ご飯', date: '2026-10-03' }),
  e('l2', 1200, { subCategory: '昼ご飯', lineId: 'Ub', payerId: 'Ub', date: '2026-10-20' }),
  e('o1', 1500, { subCategory: 'おやつ', date: '2026-10-10' }),
  // 中項目なし（金額はいちばん多い）
  e('n1', 9000, { date: '2026-10-11' }),
  e('n2', 480, { subCategory: '', date: '2026-10-12' }),
  e('c1', 600, { subCategory: 'カフェ', lineId: 'gmail-auto-system', payerId: 'gmail-auto-system', inputSource: 'gmail_auto', date: '2026-10-23' }),
  // 合計に含まない
  e('x1', 5000, { subCategory: '外食', includeInTotal: false, status: undefined, confirmed: false }),
  e('p1', 900, { category: '日用品', subCategory: '洗剤' }),
  e('m1', 1900, { category: '娯楽', subCategory: '映画' }),
  e('m2', 1000, { category: '娯楽' }),
  e('t1', 3000, { category: '交通費' }),
];
const subItems = toDrillItems(subExpenses, { range: SUB_RANGE, included: (x) => x.includeInTotal, payer, pending: isPending });
const subIncluded = subItems.filter((i) => i.included);
const FOOD = { category: '食費' };
const foodItems = subIncluded.filter((i) => matchesDrill(i, FOOD));

test('toDrillItems: 中項目を subCategoryKey で付ける（一覧の無い大項目は無し）', () => {
  const sub = Object.fromEntries(subItems.map((i) => [i.id, i.subCategory]));
  assert.equal(sub.s1, '食料品（スーパー）');
  assert.equal(sub.o1, 'その他の食費');
  assert.equal(sub.n1, NO_SUB_CATEGORY);
  assert.equal(sub.n2, NO_SUB_CATEGORY);
  assert.equal(sub.m1, '映画');
  assert.equal(sub.m2, NO_SUB_CATEGORY);
  assert.equal(sub.p1, undefined);
  assert.equal(sub.t1, undefined);
});

test('groupDrill(subCategory): 金額の多い順、「中項目なし」は金額にかかわらず最後、一覧にない値は「その他の食費」', () => {
  const total = sumAmount(foodItems);
  assert.equal(total, 21630);
  const groups = groupDrill(foodItems, 'subCategory');
  assert.deepEqual(
    groups.map((g) => [g.label, g.total, g.count]),
    [
      ['食料品（スーパー）', 8050, 2],
      ['昼ご飯', 2000, 2],
      ['その他の食費', 1500, 1],
      ['カフェ', 600, 1],
      [NO_SUB_CATEGORY, 9480, 2],
    ]
  );
  // 割合（小数 1 桁）と金額の表記（¥ と 3 桁区切り）
  assert.deepEqual(
    groups.map((g) => sharePct(g.total, total)),
    [37.2, 9.2, 6.9, 2.8, 43.8]
  );
  assert.deepEqual(
    groups.map((g) => yen(g.total, 'ja-JP')),
    ['¥8,050', '¥2,000', '¥1,500', '¥600', '¥9,480']
  );
  // 娯楽も同じ。日用品は中項目が無いので全部「中項目なし」にまとまる（段は出さない。下の availableDims）
  const fun = subIncluded.filter((i) => matchesDrill(i, { category: '娯楽' }));
  assert.deepEqual(groupDrill(fun, 'subCategory').map((g) => [g.label, g.total]), [['映画', 1900], [NO_SUB_CATEGORY, 1000]]);
});

test('matchesDrill: 中項目で絞る（「中項目なし」も絞れる）', () => {
  const lunch = subIncluded.filter((i) => matchesDrill(i, { ...FOOD, subCategory: '昼ご飯' }));
  assert.deepEqual(lunch.map((i) => i.id), ['l1', 'l2']);
  const none = subIncluded.filter((i) => matchesDrill(i, { ...FOOD, subCategory: NO_SUB_CATEGORY }));
  assert.deepEqual(none.map((i) => i.id), ['n1', 'n2']);
  const other = subIncluded.filter((i) => matchesDrill(i, { ...FOOD, subCategory: 'その他の食費' }));
  assert.deepEqual(other.map((i) => i.id), ['o1']);
  assert.equal(matchesDrill({ category: '食費', subCategory: '昼ご飯', payerKey: 'Ua' }, { category: '食費', subCategory: '昼ご飯', payers: ['Ub'] }), false);
  // 中項目の小計の割合: 食費の / 合計の
  assert.equal(sharePct(sumAmount(lunch), sumAmount(foodItems)), 9.2);
  assert.equal(sharePct(sumAmount(lunch), sumAmount(subIncluded)), 7);
});

test('availableDims / resolveDim: 中項目の段は食費・娯楽だけで、既定は中項目（支払い者にも切り替えられる）', () => {
  assert.deepEqual(availableDims(foodItems, FOOD), { category: false, subCategory: true, payer: true });
  assert.equal(resolveDim(foodItems, FOOD), 'subCategory');
  assert.equal(resolveDim(foodItems, FOOD, 'payer'), 'payer');
  // 合計の階層では出さない（カテゴリの軸）
  assert.equal(availableDims(subIncluded, {}).subCategory, false);
  assert.equal(resolveDim(subIncluded, {}), 'category');
  // 日用品（一覧の無い大項目）は、値が入っていても出さない
  const daily = subIncluded.filter((i) => matchesDrill(i, { category: '日用品' }));
  assert.equal(availableDims(daily, { category: '日用品' }).subCategory, false);
  assert.equal(resolveDim(daily, { category: '日用品' }), null);
  // 全部が「中項目なし」なら出さない
  const noneOnly = foodItems.filter((i) => i.subCategory === NO_SUB_CATEGORY);
  assert.equal(availableDims(noneOnly, FOOD).subCategory, false);
  // 中項目が 1 つだけでも、「中項目なし」でなければ出す（どの中項目かが分かるように）
  const lunchOnly = foodItems.filter((i) => i.subCategory === '昼ご飯');
  assert.equal(availableDims(lunchOnly, FOOD).subCategory, true);
  // 中項目で絞った階層では出さない（支払い者だけ）
  const lunchFilter = { ...FOOD, subCategory: '昼ご飯' };
  assert.deepEqual(availableDims(lunchOnly, lunchFilter), { category: false, subCategory: false, payer: true });
  assert.equal(resolveDim(lunchOnly, lunchFilter, 'subCategory'), 'payer');
  // 支払い者で絞った食費でも出す
  const mitsuFood = foodItems.filter((i) => matchesDrill(i, { ...FOOD, payers: ['Ua'] }));
  assert.equal(resolveDim(mitsuFood, { ...FOOD, payers: ['Ua'] }), 'subCategory');
});
