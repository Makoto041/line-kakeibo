// Web のカテゴリ名の正規化（lib/categoryNormalization.ts の normalizeCategoryName）のテスト（#243）。
// LINE で指定できる旧名は、bot が保存時に正準名へ揃える（bot/src/categoryNormalization.ts の toCanonicalCategoryName）。
// 揃える前の旧名のまま保存された既存データも、Web の表示・集計で bot と同じ正準名に入ることを確かめる。
// bot と Web の表の突き合わせは bot/scripts/smoke-expense-card.js でも行う（bot の結果と Web の結果を比べる）。
// node --test で実行する（Node 22.18 以降の型除去で .ts を直接読む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CANONICAL_CATEGORIES, normalizeCategoryName } from '../lib/categoryNormalization.ts';

// LINE の旧名 → bot が保存する正準名（bot の ALIAS_TO_CANONICAL と同じ。textParser.ts の VALID_CATEGORIES のうち正準名でないもの）
const LINE_LEGACY_TO_CANONICAL = {
  医療費: '医療・健康',
  娯楽費: '娯楽',
  衣服費: '衣服',
  教育費: '教育',
  交際費: '娯楽',
  投資: '貯金',
  貯蓄: '貯金',
  趣味: '娯楽',
};

test('LINE の旧名 8 種は bot と同じ正準名になる', () => {
  for (const [legacy, canonical] of Object.entries(LINE_LEGACY_TO_CANONICAL)) {
    assert.equal(normalizeCategoryName(legacy), canonical, legacy);
  }
});

test('正準名 19 種はそのまま', () => {
  assert.equal(CANONICAL_CATEGORIES.length, 19);
  for (const name of CANONICAL_CATEGORIES) {
    assert.equal(normalizeCategoryName(name), name);
  }
});

test('部分一致は表の上から順に見る: 「趣味の本」は娯楽（「趣味」は教育の「本」より前）', () => {
  assert.equal(normalizeCategoryName('趣味の本'), '娯楽');
  assert.equal(normalizeCategoryName('本'), '教育'); // 前提: 「本」だけなら教育
});

test('別名に無い名前は「その他」', () => {
  assert.equal(normalizeCategoryName('推し活'), 'その他');
  assert.equal(normalizeCategoryName(''), 'その他');
});
