// 予算カードのカテゴリ別の実支出（lib/budgetAnalytics.ts の sumCategoryTotals・buildCategoryBudgetRows）のテスト（#243）。
// useMonthlyStats（lib/hooks.ts）と同じく、正規化に normalizeCategoryName を渡す。node --test で実行する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildCategoryBudgetRows, getActualSpending, sumCategoryTotals } from '../lib/budgetAnalytics.ts';
import { normalizeCategoryName } from '../lib/categoryNormalization.ts';

// 旧名（#255 より前の LINE の名前）・正準名・知らない名前・空。合計に含む支出だけを渡す（useMonthlyStats と同じ）
const EXPENSES = [
  { category: '娯楽', amount: 2000 },
  { category: '娯楽費', amount: 1500 },
  { category: '交際費', amount: 1000 },
  { category: '投資', amount: 6000 },
  { category: '貯金', amount: 4000 },
  { category: '医療費', amount: 700 },
  { category: '推し活', amount: 800 },
  { category: '', amount: 300 },
];
const normalize = (category) => normalizeCategoryName(category);

test('カテゴリ別の合計: 旧名は正準名の行にまとめ、知らない名前・空は「その他」にまとめる（ホームの内訳と同じ）', () => {
  assert.deepEqual(sumCategoryTotals(EXPENSES, normalize), {
    娯楽: 4500,
    貯金: 10000,
    '医療・健康': 700,
    その他: 1100,
  });
  // 合計は変わらない
  const totals = sumCategoryTotals(EXPENSES, normalize);
  assert.equal(
    Object.values(totals).reduce((a, b) => a + b, 0),
    EXPENSES.reduce((a, e) => a + e.amount, 0)
  );
  assert.deepEqual(sumCategoryTotals([], normalize), {});
});

test('予算カード: 交際費・投資は娯楽・貯金の予算に数え、別の行にしない', () => {
  const totals = sumCategoryTotals(EXPENSES, normalize);
  const rows = buildCategoryBudgetRows(totals, { 娯楽: 5000, 貯金: 20000 });
  assert.deepEqual(
    rows.map((r) => [r.category, r.budget, r.actual]),
    [
      ['娯楽', 5000, 4500],
      ['貯金', 20000, 10000],
      ['その他', 0, 1100],
      ['医療・健康', 0, 700],
    ]
  );
  for (const old of ['娯楽費', '交際費', '投資', '医療費', '推し活']) {
    assert.ok(!rows.some((r) => r.category === old), `「${old}」が別の行になっている`);
  }
});

test('useMonthlyStats は、カテゴリ別の合計を normalizeCategoryName を通した sumCategoryTotals で出す', () => {
  // hooks.ts は firebase を import するので node --test から動かせない。ソースを文字列として読み、配線の行を確かめる
  // （前例: demoCard.test.mjs が bot のソースを読む）。CI は web/ を作業ディレクトリにして実行するので、このファイルからの相対で読む
  const hooks = readFileSync(new URL('../lib/hooks.ts', import.meta.url), 'utf8');
  const start = hooks.search(/\bexport function useMonthlyStats\s*\(/);
  assert.notEqual(start, -1, 'useMonthlyStats が無い');
  const end = hooks.indexOf('\nexport ', start + 1);
  const body = hooks.slice(start, end === -1 ? undefined : end);
  assert.ok(
    body.includes('const categoryTotals = sumCategoryTotals(includedExpenses, (category) => normalizeCategoryName(category));'),
    'useMonthlyStats のカテゴリ別の合計が、normalizeCategoryName を通した sumCategoryTotals になっていない'
  );
  assert.ok(hooks.includes("import { normalizeCategoryName } from './categoryNormalization';"), 'normalizeCategoryName の import が無い');
  assert.ok(hooks.includes("import { sumCategoryTotals } from './budgetAnalytics';"), 'sumCategoryTotals の import が無い');
});

test('予算カード: 旧名の予算キー（娯楽費）は、まとめた実支出を逆引きで数える', () => {
  const totals = sumCategoryTotals(EXPENSES, normalize);
  assert.equal(getActualSpending('娯楽費', totals), 4500);
  assert.equal(getActualSpending('医療費', totals), 700);
  const rows = buildCategoryBudgetRows(totals, { 娯楽費: 3000 });
  assert.deepEqual(
    rows.find((r) => r.category === '娯楽費'),
    { category: '娯楽費', budget: 3000, actual: 4500 }
  );
});
