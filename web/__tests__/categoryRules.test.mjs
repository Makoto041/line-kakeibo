// カテゴリのルール（lib/categoryRules.ts の画面側の純関数と、householdContract.ts の応答の読み取り）のテスト。node --test で実行する。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CATEGORY_RULE_LIMITS as L,
  addExample,
  addRule,
  isDirty,
  matchExampleCategory,
  matchRule,
  normalizeForMatch,
  removeExample,
  removeRule,
  tidyText,
} from '../lib/categoryRules.ts';
import { parseCategoryRulesResponse } from '../lib/householdContract.ts';

const empty = { rules: [], examples: {} };

test('文の整形: 制御文字と連続する空白を 1 つの空白にして前後を消す', () => {
  assert.equal(tidyText('  ド\nン\tキ\u0007  ホーテ '), 'ド ン キ ホーテ');
  assert.equal(tidyText('a b'), 'a b');
  assert.equal(tidyText(' \n '), '');
});

test('照合用は全角・半角、大文字・小文字、空白を区別しない', () => {
  assert.equal(normalizeForMatch(' ＤＯＮＫＩ  ﾄﾞﾝｷ '), 'donki ドンキ');
});

test('ルールを足す: 末尾に入り、整える', () => {
  const r = addRule(empty, ' ドンキ ', '日用品', L);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.rules, [{ keyword: 'ドンキ', category: '日用品' }]);
});

test('ルールを足せないとき: 空・長すぎ・同じ言葉・上限', () => {
  assert.deepEqual(addRule(empty, '  ', '食費', L), { ok: false, reason: 'empty' });
  assert.deepEqual(addRule(empty, 'あ'.repeat(L.maxKeywordLength + 1), '食費', L), { ok: false, reason: 'too_long' });
  assert.equal(addRule(empty, 'あ'.repeat(L.maxKeywordLength), '食費', L).ok, true);
  const one = addRule(empty, 'Switch', '娯楽', L).value;
  assert.deepEqual(addRule(one, ' ｓｗｉｔｃｈ ', '食費', L), { ok: false, reason: 'duplicate' });
  const full = { rules: Array.from({ length: L.maxRules }, (_, i) => ({ keyword: `k${i}`, category: '食費' })), examples: {} };
  assert.deepEqual(addRule(full, 'new', '食費', L), { ok: false, reason: 'limit' });
});

test('ルールを消す', () => {
  const d = { rules: [{ keyword: 'a', category: '食費' }, { keyword: 'b', category: '娯楽' }], examples: {} };
  assert.deepEqual(removeRule(d, 0).rules, [{ keyword: 'b', category: '娯楽' }]);
});

test('例を足す・消す: 空のカテゴリは持たない', () => {
  const a = addExample(empty, '医療・健康', ' ジムのプロテイン ', L);
  assert.equal(a.ok, true);
  assert.deepEqual(a.value.examples, { '医療・健康': ['ジムのプロテイン'] });
  assert.deepEqual(addExample(a.value, '医療・健康', 'ジムのプロテイン', L), { ok: false, reason: 'duplicate' });
  assert.deepEqual(addExample(empty, '食費', 'あ'.repeat(L.maxExampleLength + 1), L), { ok: false, reason: 'too_long' });
  assert.deepEqual(addExample(empty, '食費', '', L), { ok: false, reason: 'empty' });
  let d = empty;
  for (let i = 0; i < L.maxExamplesPerCategory; i++) d = addExample(d, '食費', `e${i}`, L).value;
  assert.deepEqual(addExample(d, '食費', 'extra', L), { ok: false, reason: 'limit' });
  assert.deepEqual(removeExample(a.value, '医療・健康', 0).examples, {});
});

test('照合: 言葉を含む最初のルール。当たらなければ null', () => {
  const rules = [{ keyword: 'ドンキ', category: '日用品' }, { keyword: 'switch', category: '娯楽' }];
  assert.equal(matchRule(rules, 'ドンキで洗剤')?.category, '日用品');
  assert.equal(matchRule(rules, 'Nintendo SWITCH 本体')?.category, '娯楽');
  assert.equal(matchRule([{ keyword: 'a', category: '食費' }, { keyword: 'ab', category: '娯楽' }], 'ab')?.category, '食費');
  assert.equal(matchRule(rules, 'ランチ'), null);
  assert.equal(matchRule(rules, ' '), null);
});

test('試してみる: 例に書いた言葉を含むカテゴリ', () => {
  const examples = { '医療・健康': ['ジムのプロテイン'], 美容: ['まつ毛パーマ'] };
  assert.equal(matchExampleCategory(examples, 'ジムのプロテイン 購入'), '医療・健康');
  assert.equal(matchExampleCategory(examples, 'ランチ'), null);
});

test('保存していない変更の判定（例の並びの違いは変更にしない）', () => {
  const a = { rules: [{ keyword: 'a', category: '食費' }], examples: { 食費: ['x'], 娯楽: ['y'] } };
  assert.equal(isDirty(a, JSON.parse(JSON.stringify({ ...a, examples: { 娯楽: ['y'], 食費: ['x'] } }))), false);
  assert.equal(isDirty(a, { ...a, rules: [] }), true);
  assert.equal(isDirty(a, { ...a, examples: { 食費: ['x'] } }), true);
});

test('応答の読み取り: 正しい形と、崩れた形', () => {
  const good = { rules: [{ keyword: 'a', category: '食費' }], examples: { 食費: ['x'] }, limits: L };
  assert.deepEqual(parseCategoryRulesResponse(good), good);
  assert.equal(parseCategoryRulesResponse(null), null);
  assert.equal(parseCategoryRulesResponse({ ...good, rules: 'x' }), null);
  assert.equal(parseCategoryRulesResponse({ ...good, rules: [{ keyword: 1, category: '食費' }] }), null);
  assert.equal(parseCategoryRulesResponse({ ...good, examples: { 食費: [1] } }), null);
  assert.equal(parseCategoryRulesResponse({ ...good, limits: { ...L, maxRules: 0 } }), null);
  assert.equal(parseCategoryRulesResponse({ ...good, limits: undefined }), null);
});
