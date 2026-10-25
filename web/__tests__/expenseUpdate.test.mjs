// 編集での中項目（subCategory）の扱いのテスト（#235）。
// 大項目を変えたときの削除（#251）と、編集画面で中項目を選ぶ（選択肢・大項目を変えたときのリセット・保存）。
// node --test で実行する（Node 22.18 以降の型除去で .ts を直接読む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formFromExpense,
  validateEditForm,
  buildEditUpdate,
  hasEditChanges,
  shouldClearSubCategory,
  buildExpenseUpdate,
  buildSubCategoryOptions,
  changeEditCategory,
} from '../lib/expenseEdit.ts';
import { SUB_CATEGORIES, subCategoriesOf } from '../lib/categoryTaxonomy.ts';

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

// ---- 編集画面で中項目を選ぶ（#235 ⑥） ------------------------------------------------

const values = (options) => options.map((o) => o.value);
const optionsFor = (form) => buildSubCategoryOptions(subCategoriesOf(form.category), form.subCategory);

test('中項目の選択肢: 食費・娯楽だけ。先頭は「中項目なし」、続けて大項目の一覧（並び順のまま）', () => {
  const food = buildSubCategoryOptions(subCategoriesOf('食費'), '');
  assert.deepEqual(food[0], { value: '', label: '中項目なし' });
  assert.deepEqual(values(food), ['', ...SUB_CATEGORIES['食費']]);
  assert.equal(food.length, 11);
  assert.ok(values(food).includes('その他の食費'));
  for (const o of food) assert.equal(o.label, o.value || '中項目なし');

  const fun = buildSubCategoryOptions(subCategoriesOf('娯楽'), '');
  assert.deepEqual(values(fun), ['', ...SUB_CATEGORIES['娯楽']]);
  assert.equal(fun.length, 9);
  assert.ok(values(fun).includes('その他の娯楽'));

  // 一覧の無い大項目では欄を出さない（選択肢なし）。今の値があっても出さない
  for (const category of ['日用品', '交通費', 'その他', '旅行', '', '飲食代']) {
    assert.deepEqual(subCategoriesOf(category), []);
    assert.deepEqual(buildSubCategoryOptions(subCategoriesOf(category), ''), []);
    assert.deepEqual(buildSubCategoryOptions(subCategoriesOf(category), '洗剤'), []);
  }
  // 大項目は正準名の完全一致で引く（別名・Object のプロパティ名では引かない）
  assert.deepEqual(subCategoriesOf('外食'), []);
  assert.deepEqual(subCategoriesOf('toString'), []);
  assert.deepEqual(subCategoriesOf(undefined), []);
});

test('中項目の選択肢: 一覧に無い今の値は最後に残す（一覧にある値・中項目なしは重ねない）', () => {
  const free = buildSubCategoryOptions(subCategoriesOf('食費'), 'ラーメン');
  assert.deepEqual(values(free), ['', ...SUB_CATEGORIES['食費'], 'ラーメン']);
  assert.deepEqual(free.at(-1), { value: 'ラーメン', label: 'ラーメン' });

  // 別の大項目の中項目が残っている支出（娯楽なのに「外食」）も、最後に残す
  assert.deepEqual(values(buildSubCategoryOptions(subCategoriesOf('娯楽'), '外食')), ['', ...SUB_CATEGORIES['娯楽'], '外食']);

  assert.deepEqual(values(buildSubCategoryOptions(subCategoriesOf('食費'), '昼ご飯')), ['', ...SUB_CATEGORIES['食費']]);
  assert.deepEqual(values(buildSubCategoryOptions(subCategoriesOf('食費'), '')), ['', ...SUB_CATEGORIES['食費']]);

  // 開いただけ（触れていない）なら、一覧に無い値でも送らない
  const original = expense({ subCategory: 'ラーメン' });
  const form = formFromExpense(original);
  assert.equal(form.subCategory, 'ラーメン');
  assert.ok(values(optionsFor(form)).includes(form.subCategory));
  assert.equal(hasEditChanges(buildEditUpdate(form, original)), false);
});

test('大項目を変えたら、中項目は「中項目なし」に戻り、選択肢は新しい大項目の一覧に替わる', () => {
  const form = formFromExpense(expense({ subCategory: '昼ご飯' }));
  const { form: next, reset } = changeEditCategory(form, '娯楽');
  assert.equal(next.category, '娯楽');
  assert.equal(next.subCategory, '');
  assert.equal(reset, true);
  assert.deepEqual(values(optionsFor(next)), ['', ...SUB_CATEGORIES['娯楽']]);
  // 他の項目はそのまま
  assert.deepEqual({ ...next, category: form.category, subCategory: form.subCategory }, form);

  // 一覧の無い大項目に変えると、欄が消える（中項目は「中項目なし」）
  const toDaily = changeEditCategory(form, '日用品');
  assert.equal(toDaily.form.subCategory, '');
  assert.deepEqual(optionsFor(toDaily.form), []);

  // 同じ大項目を選び直しただけなら、何も変えない
  const same = changeEditCategory(form, '食費');
  assert.equal(same.form, form);
  assert.equal(same.reset, false);

  // もともと中項目なしなら、戻したことにはしない（注記を出さない）
  const none = changeEditCategory(formFromExpense(expense()), '娯楽');
  assert.equal(none.form.subCategory, '');
  assert.equal(none.reset, false);

  // 元の大項目に戻しても、中項目は戻さない（大項目を変えたら毎回「中項目なし」）
  const back = changeEditCategory(next, '食費');
  assert.equal(back.form.subCategory, '');
  assert.equal(back.reset, false); // 画面は最初の reset を、中項目を選び直すまで覚えておく
});

test('保存: 中項目だけを変える・中項目なしにする', () => {
  const original = expense({ subCategory: '昼ご飯' });

  // 別の中項目に変える
  let del = fakeDeleteField();
  let { update, write } = save(original, { subCategory: 'カフェ' }, del.fn);
  assert.deepEqual(update, { subCategory: 'カフェ' });
  assert.deepEqual(write, { subCategory: 'カフェ' });
  assert.equal(del.calls(), 0);

  // 中項目なしにする: '' は保存せず、削除を送る
  del = fakeDeleteField();
  ({ update, write } = save(original, { subCategory: '' }, del.fn));
  assert.deepEqual(update, { subCategory: '' });
  assert.deepEqual(write, { subCategory: DELETE });
  assert.equal(del.calls(), 1);
  assert.equal(shouldClearSubCategory({ subCategory: '' }, original), true);
  assert.equal(shouldClearSubCategory({ subCategory: '' }, undefined), true);

  // 中項目なしの支出に中項目を付ける
  del = fakeDeleteField();
  assert.deepEqual(save(expense(), { subCategory: '外食' }, del.fn).write, { subCategory: '外食' });
  assert.equal(del.calls(), 0);

  // 中項目なしのまま（触れていない）なら送らない
  assert.deepEqual(save(expense(), { description: 'ランチ（修正）' }, del.fn).write, { description: 'ランチ（修正）' });
});

test('保存: 大項目を変えたとき（中項目を戻した・選び直した）', () => {
  const original = expense({ subCategory: '昼ご飯' });

  // 戻したまま保存: 大項目の変更と中項目の削除
  let del = fakeDeleteField();
  const reset = changeEditCategory(formFromExpense(original), '娯楽').form;
  assert.deepEqual(save(original, reset, del.fn).write, { category: '娯楽', subCategory: DELETE });
  assert.equal(del.calls(), 1);

  // 新しい大項目の中項目を選んで保存: 両方を送り、削除は足さない
  del = fakeDeleteField();
  assert.deepEqual(save(original, { ...reset, subCategory: '映画' }, del.fn).write, { category: '娯楽', subCategory: '映画' });
  assert.equal(del.calls(), 0);

  // 中項目なしの支出で大項目を変える: これまでどおり削除を送る（#251）
  del = fakeDeleteField();
  const plain = expense();
  assert.deepEqual(
    save(plain, changeEditCategory(formFromExpense(plain), '日用品').form, del.fn).write,
    { category: '日用品', subCategory: DELETE }
  );
  // 中項目なしの支出で、大項目を変えて中項目も選ぶ
  assert.deepEqual(
    save(plain, { ...changeEditCategory(formFromExpense(plain), '娯楽').form, subCategory: '映画' }, del.fn).write,
    { category: '娯楽', subCategory: '映画' }
  );
  assert.equal(del.calls(), 1);

  // 大項目を変えて元に戻した（中項目は「中項目なし」のまま）: 大項目は送らず、中項目の削除だけ
  del = fakeDeleteField();
  const there = changeEditCategory(formFromExpense(original), '娯楽').form;
  const back = changeEditCategory(there, '食費').form;
  assert.deepEqual(save(original, back, del.fn).write, { subCategory: DELETE });
});

test('保存: 精算済みの支出でも中項目は変えられる（金額・日付・支払者は送らない）', () => {
  const original = expense({ status: 'advance_settled', subCategory: '外食' });
  const del = fakeDeleteField();
  assert.deepEqual(save(original, { subCategory: 'カフェ' }, del.fn).write, { subCategory: 'カフェ' });
  assert.deepEqual(
    save(original, { amount: 9999, date: '2026-01-01', subCategory: '' }, del.fn).write,
    { subCategory: DELETE }
  );
  assert.equal(validateEditForm({ ...formFromExpense(original), subCategory: 'カフェ' }, original), null);
});

test('入力チェック: 中項目は変えたときだけ 50 文字以内を確かめる', () => {
  const original = expense({ subCategory: 'x'.repeat(60) }); // 既存データの上限超え
  const base = formFromExpense(original);
  assert.equal(validateEditForm(base, original), null);
  assert.equal(validateEditForm({ ...base, description: 'ランチ（修正）' }, original), null);
  assert.equal(validateEditForm({ ...base, subCategory: '' }, original), null);
  assert.equal(validateEditForm({ ...base, subCategory: 'y'.repeat(50) }, original), null);
  assert.deepEqual(validateEditForm({ ...base, subCategory: 'y'.repeat(51) }, original), {
    field: 'subCategory',
    message: '中項目は 50 文字以内で選んでください',
  });
});
