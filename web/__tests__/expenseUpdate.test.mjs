// 編集で大項目を変えたときの中項目（subCategory）の扱いのテスト（#235）。
// node --test で実行する（Node 22.18 以降の型除去で .ts を直接読む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formFromExpense,
  buildEditUpdate,
  shouldClearSubCategory,
  buildExpenseUpdate,
} from '../lib/expenseEdit.ts';

// firebase/firestore の deleteField() の代わり（呼ばれた回数も数える）
const DELETE = Symbol('deleteField');
function fakeDeleteField() {
  let calls = 0;
  const fn = () => {
    calls += 1;
    return DELETE;
  };
  return { fn, calls: () => calls };
}

function expense(overrides = {}) {
  return {
    id: 'e1',
    lineId: 'U-me',
    amount: 1000,
    description: 'ランチ',
    date: '2026-09-12',
    category: '食費',
    includeInTotal: true,
    ...overrides,
  };
}

// 編集ドロワーの保存と同じ流れ: フォーム → 変更した項目だけの差分 → Firestore に送る内容
function save(original, changes, deleteField) {
  const update = buildEditUpdate({ ...formFromExpense(original), ...changes }, original);
  return { update, write: buildExpenseUpdate(update, original, deleteField) };
}

test('大項目を変える: 元の支出が中項目を持つなら、中項目の削除を足す', () => {
  const original = expense({ subCategory: '外食' });
  const del = fakeDeleteField();
  const { write } = save(original, { category: '日用品' }, del.fn);
  assert.deepEqual(write, { category: '日用品', subCategory: DELETE });
  assert.equal(del.calls(), 1);
  assert.equal(shouldClearSubCategory({ category: '日用品' }, original), true);

  // 他の項目と一緒に変えても同じ
  const both = save(original, { category: '日用品', description: '洗剤' }, del.fn).write;
  assert.deepEqual(both, { description: '洗剤', category: '日用品', subCategory: DELETE });
});

// 一覧は 1 回きりの読み込みなので、読み込んだ後に bot が中項目を書いた支出でも、手元では
// 「中項目なし」に見える。大項目を変えるときは、手元の一覧に中項目が無くても削除を送る
test('大項目を変える: 元の支出が中項目を持たなくても、中項目の削除を足す', () => {
  const original = expense();
  const del = fakeDeleteField();
  const { write } = save(original, { category: '日用品' }, del.fn);
  assert.deepEqual(write, { category: '日用品', subCategory: DELETE });
  assert.equal(del.calls(), 1);
  assert.equal(shouldClearSubCategory({ category: '日用品' }, original), true);
});

test('大項目を変えない: 中項目には触れない（更新内容は今と同じ）', () => {
  for (const original of [expense({ subCategory: '外食' }), expense()]) {
    const del = fakeDeleteField();

    const { update, write } = save(original, { description: 'ランチ（修正）', amount: 1200 }, del.fn);
    assert.deepEqual(write, { amount: 1200, description: 'ランチ（修正）' });
    assert.deepEqual(write, update);

    // 合計に含めるトグル（category を送らない）
    assert.deepEqual(buildExpenseUpdate({ includeInTotal: false }, original, del.fn), { includeInTotal: false });

    // 同じ大項目を送っても（変化なし）消さない。別名を正規化した結果が元と同じ大項目になる場合もこれ
    assert.deepEqual(buildExpenseUpdate({ category: '食費' }, original, del.fn), { category: '食費' });
    assert.equal(del.calls(), 0);
  }
});

test('精算済みの支出: 大項目の変更と中項目の削除だけを送る（金額・日付・支払者は送らない）', () => {
  for (const original of [
    expense({ status: 'advance_settled', subCategory: '外食' }),
    expense({ status: 'advance_settled' }),
  ]) {
    const del = fakeDeleteField();
    const { write } = save(original, { amount: 9999, date: '2026-01-01', category: '旅行' }, del.fn);
    assert.deepEqual(write, { category: '旅行', subCategory: DELETE });
  }
});

test('元の支出が無い・更新が中項目を自分で指定しているときは、削除を足さない', () => {
  const del = fakeDeleteField();
  assert.deepEqual(buildExpenseUpdate({ category: '日用品' }, undefined, del.fn), { category: '日用品' });
  assert.deepEqual(buildExpenseUpdate({ category: '日用品' }, null, del.fn), { category: '日用品' });

  for (const original of [expense({ subCategory: '外食' }), expense()]) {
    assert.deepEqual(
      buildExpenseUpdate({ category: '日用品', subCategory: '洗剤' }, original, del.fn),
      { category: '日用品', subCategory: '洗剤' }
    );
  }
  assert.equal(del.calls(), 0);
});
