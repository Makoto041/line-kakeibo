/**
 * 階層化（#235）の評価（eval/eval-classifier.js --scheme stage2|flat）の純関数のスモークテスト
 *
 * 架空のデータだけを使う。評価データ（bot/scripts/eval/*.local.json）は読まない。Jev・Gemini は呼ばない。
 *   node bot/scripts/smoke-eval-hierarchy.js
 */
const envBefore = JSON.stringify(process.env);
const {
  PRICES,
  FLAT_SEP,
  SUB_QUESTIONS,
  checkSchemeOptions,
  schemeTag,
  pickItems,
  countDescribed,
  subCriteria,
  flatChoices,
  decodeFlat,
  scoreHierarchical,
  summarizeHierarchy,
} = require('./eval/eval-classifier');
const { validSubLabel } = require('./eval/review-golden');
const { SUB_CATEGORIES, SUB_CATEGORY_DESCRIPTIONS, subCategoriesOf } = require('../dist/categoryTaxonomy');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throwsWith = (fn, text) => {
  try {
    fn();
    return false;
  } catch (e) {
    return String(e && e.message).includes(text);
  }
};

console.log('\n# 読み込み');
check('require しても .env を読まない（環境変数が変わらない）', JSON.stringify(process.env) === envBefore);

console.log('\n# checkSchemeOptions');
const base = { provider: 'jev', scheme: 'major', subDesc: 'off', decode: 'argmax', stage2Major: 'pred', given: {} };
const ok = (o) => !throwsWith(() => checkSchemeOptions({ ...base, ...o }), '');
check('既定（major）は gemini / jev とも通る', ok({}) && ok({ provider: 'gemini' }));
check('stage2 / flat は jev で通る', ok({ scheme: 'stage2' }) && ok({ scheme: 'flat' }));
check('stage2 のオプション', ok({ scheme: 'stage2', subDesc: 'on', stage2Major: 'gold', given: { subDesc: true, stage2Major: true } }));
check('flat のオプション', ok({ scheme: 'flat', subDesc: 'on', decode: 'sum', given: { subDesc: true, decode: true } }));
for (const [name, o, text] of [
  ['gemini で stage2 は止める', { provider: 'gemini', scheme: 'stage2' }, '--scheme stage2 は --provider jev のときだけ（Gemini には送らない）'],
  ['gemini で flat は止める', { provider: 'gemini', scheme: 'flat' }, '--scheme flat は --provider jev のときだけ'],
  ['不正な --scheme', { scheme: 'two' }, '--scheme は major / stage2 / flat（指定: two）'],
  ['--scheme の値なし', { scheme: undefined }, '（指定: 値なし）'],
  ['--scheme の値が次のオプション', { scheme: '--limit' }, '（指定: 値なし）'],
  ['不正な --sub-desc', { scheme: 'stage2', subDesc: 'yes' }, '--sub-desc は on / off（指定: yes）'],
  ['不正な --decode', { scheme: 'flat', decode: 'max' }, '--decode は argmax / sum（指定: max）'],
  ['不正な --stage2-major', { scheme: 'stage2', stage2Major: 'x' }, '--stage2-major は pred / gold（指定: x）'],
  ['major に --sub-desc', { given: { subDesc: true } }, '--sub-desc は --scheme stage2 / flat のときだけ'],
  ['stage2 に --decode', { scheme: 'stage2', given: { decode: true } }, '--decode は --scheme flat のときだけ'],
  ['flat に --stage2-major', { scheme: 'flat', given: { stage2Major: true } }, '--stage2-major は --scheme stage2 のときだけ'],
]) {
  check(name, throwsWith(() => checkSchemeOptions({ ...base, ...o }), text));
}

console.log('\n# schemeTag');
check('major は空', schemeTag(base) === '');
check('stage2', schemeTag({ ...base, scheme: 'stage2', subDesc: 'on', stage2Major: 'gold' }) === '-stage2-subdesc-on-major-gold');
check('flat', schemeTag({ ...base, scheme: 'flat', decode: 'sum' }) === '-flat-subdesc-off-sum');

console.log('\n# pickItems（validSubLabel で絞るのは tune / hold の振り分けの後、--limit はその後）');
const food = SUB_CATEGORIES['食費'];
const fun = SUB_CATEGORIES['娯楽'];
const items = [
  { id: 'a', source: 'text', label: '食費', subLabel: food[0] },
  { id: 'b', source: 'text', label: '日用品', subLabel: food[0] },
  { id: 'c', source: 'text', label: '娯楽', subLabel: fun[1] },
  { id: 'd', source: 'text', label: '食費', subLabel: null },
  { id: 'e', source: 'text', label: '食費', subLabel: food[2] },
  { id: 'f', source: 'merchant', label: '衣服' },
  { id: 'g', source: 'merchant', label: '娯楽', subLabel: food[0] },
  { id: 'h', source: 'merchant', label: '食費', subLabel: food[3] },
];
const idsOf = (list) => list.map((it) => it.id).join(',');
const both = ['text', 'merchant'];
check('keep なしは従来どおり（経路ごと・並び順のまま）', idsOf(pickItems(items, { sources: both, subset: 'all', limit: Infinity })) === 'a,b,c,d,e,f,g,h');
check('keep なしの tune', idsOf(pickItems(items, { sources: both, subset: 'tune', limit: Infinity })) === 'a,c,e,f,h');
check('validSubLabel: a,c,e,h', idsOf(pickItems(items, { sources: both, subset: 'all', limit: Infinity, keep: validSubLabel })) === 'a,c,e,h');
const tune = idsOf(pickItems(items, { sources: both, subset: 'tune', limit: Infinity, keep: validSubLabel }));
const hold = idsOf(pickItems(items, { sources: both, subset: 'hold', limit: Infinity, keep: validSubLabel }));
// 先に絞ると text は a,c,e → tune a,e / hold c になり、major の hold（b,d）と食い違う。振り分けの後に絞れば各件の tune / hold は major と同じ
check('tune は major の tune（a,c,e,f,h）の中から: a,c,e,h', tune === 'a,c,e,h', tune);
check('hold は空（b・d・g は対象外）', hold === '', hold);
check('--limit は絞った後（merchant の先頭 f は対象外なので h）', idsOf(pickItems(items, { sources: ['merchant'], subset: 'all', limit: 1, keep: validSubLabel })) === 'h');
check('--limit 0 は 0 件', pickItems(items, { sources: both, subset: 'all', limit: 0, keep: validSubLabel }).length === 0);

console.log('\n# subCriteria / countDescribed');
check('説明なし（null）', same(subCriteria(food, '食費', null), Object.fromEntries(food.map((s) => [s, null]))));
check('説明あり（SUB_CATEGORY_DESCRIPTIONS）', same(subCriteria(food, '食費', SUB_CATEGORY_DESCRIPTIONS), Object.fromEntries(food.map((s) => [s, SUB_CATEGORY_DESCRIPTIONS['食費'][s]]))));
const partial = { 食費: { [food[0]]: '架空の説明', [food[1]]: 3 } };
const pc = subCriteria(food, '食費', partial);
check('説明の無い中項目・文字列でない説明は null', pc[food[0]] === '架空の説明' && pc[food[1]] === null && pc[food[2]] === null);
check('別の大項目の説明は使わない', Object.values(subCriteria(fun, '娯楽', partial)).every((v) => v === null));
check('プロトタイプのキーは説明にしない', subCriteria(['constructor', 'toString'], '食費', {}).constructor === null);
check('countDescribed: 全部ある', same(countDescribed(SUB_CATEGORIES, SUB_CATEGORY_DESCRIPTIONS), { described: food.length + fun.length, total: food.length + fun.length }));
check('countDescribed: 一部', same(countDescribed(SUB_CATEGORIES, partial), { described: 1, total: food.length + fun.length }));
check('countDescribed: 説明なし', countDescribed(SUB_CATEGORIES, null).described === 0);

console.log('\n# SUB_QUESTIONS（stage2 の 2 回目の質問文）');
check('大項目名と input を含む（text / merchant）', ['text', 'merchant'].every((s) => SUB_QUESTIONS[s]('食費').includes('「食費」') && SUB_QUESTIONS[s]('食費').includes('`input`')));
check('merchant は店名の説明', SUB_QUESTIONS.merchant('娯楽').includes('店名') && !SUB_QUESTIONS.text('娯楽').includes('店名'));

console.log('\n# flatChoices');
const majors = { 食費: '架空の食費の説明', 日用品: '架空の日用品の説明', 娯楽: null, その他: null };
const subsOf = (m) => ({ 食費: ['外食', 'カフェ'], 娯楽: ['映画'] })[m] || [];
let fc = flatChoices(majors, subsOf, null);
check('選択肢: 大項目の並び → 中項目の並び。中項目があれば「大項目/中項目」', same(Object.keys(fc.criteria), ['食費/外食', '食費/カフェ', '日用品', '娯楽/映画', 'その他']), JSON.stringify(Object.keys(fc.criteria)));
check('FLAT_SEP は /', FLAT_SEP === '/');
check('説明: 中項目の無い大項目は大項目の説明、中項目は null（--sub-desc off）',
  fc.criteria['日用品'] === '架空の日用品の説明' && fc.criteria['その他'] === null && fc.criteria['食費/外食'] === null && fc.criteria['娯楽/映画'] === null);
check('index: 選択肢名 → { major, sub }',
  same(fc.index.get('食費/カフェ'), { major: '食費', sub: 'カフェ' }) && same(fc.index.get('日用品'), { major: '日用品', sub: null }) && fc.index.size === 5);
fc = flatChoices(majors, subsOf, { 食費: { 外食: '架空の外食の説明' } });
check('--sub-desc on: 中項目の説明（無いものは null）', fc.criteria['食費/外食'] === '架空の外食の説明' && fc.criteria['食費/カフェ'] === null && fc.criteria['日用品'] === '架空の日用品の説明');
const subsOfA = (m) => (m === 'A' ? ['B'] : []);
check('選択肢名が重なったら止める', throwsWith(() => flatChoices({ 'A/B': null, A: null }, subsOfA, null), 'flat の選択肢の名前が重なる: A/B'));
const real = flatChoices(Object.fromEntries(['食費', '娯楽', 'その他'].map((m) => [m, null])), subCategoriesOf, null);
check('実際の一覧（subCategoriesOf）で作れる', real.index.size === food.length + fun.length + 1);

console.log('\n# decodeFlat');
const index = flatChoices(majors, subsOf, null).index;
check('argmax: choice をそのまま', same(decodeFlat({ choice: '食費/カフェ', confidence: 0.4, probabilities: {} }, 'argmax', index), { major: '食費', sub: 'カフェ', confidence: 0.4 }));
check('argmax: 中項目の無い大項目は sub: null', same(decodeFlat({ choice: '日用品', confidence: 0.9 }, 'argmax', index), { major: '日用品', sub: null, confidence: 0.9 }));
check('argmax: 選択肢に無い名前は null', decodeFlat({ choice: '食費/架空', confidence: 0.9 }, 'argmax', index) === null);
check('argmax: confidence が数でなければ 0', decodeFlat({ choice: '日用品', confidence: NaN }, 'argmax', index).confidence === 0);
check('答えなしは null', decodeFlat(null, 'argmax', index) === null && decodeFlat(undefined, 'sum', index) === null);
const probs = { '食費/外食': 0.25, '食費/カフェ': 0.2, 日用品: 0.1, '娯楽/映画': 0.3, その他: 0.15 };
check('argmax は Jev の choice（確率の合計は見ない）', decodeFlat({ choice: '娯楽/映画', confidence: 0.3, probabilities: probs }, 'argmax', index).major === '娯楽');
let d = decodeFlat({ choice: '娯楽/映画', confidence: 0.3, probabilities: probs }, 'sum', index);
check('sum: 大項目ごとに合計（食費 0.45 > 娯楽 0.3）→ 食費、その中で最も高い 外食', d.major === '食費' && d.sub === '外食' && Math.abs(d.confidence - 0.45) < 1e-9, JSON.stringify(d));
d = decodeFlat({ probabilities: { '食費/外食': 0.1, '食費/カフェ': 0.2, 日用品: 0.3, '娯楽/映画': 0.3, その他: 0.1 } }, 'sum', index);
check('sum: 同点（食費 0.3・日用品 0.3・娯楽 0.3）は並び順で先の大項目', d.major === '食費' && d.sub === 'カフェ', JSON.stringify(d));
d = decodeFlat({ probabilities: { '食費/外食': 0.2, '食費/カフェ': 0.2, 日用品: 0.1 } }, 'sum', index);
check('sum: 中項目の同点は並び順で先の中項目', d.sub === '外食', JSON.stringify(d));
d = decodeFlat({ probabilities: { 日用品: 0.6, '食費/外食': 0.4 } }, 'sum', index);
check('sum: 中項目の無い大項目は sub: null', d.major === '日用品' && d.sub === null);
d = decodeFlat({ probabilities: { '食費/外食': 'x', 日用品: Infinity, '娯楽/映画': 0.2 } }, 'sum', index);
check('sum: 数でない・有限でない確率は無視', d.major === '娯楽' && d.sub === '映画', JSON.stringify(d));
check('sum: 確率が無い・使える確率が無いなら null',
  decodeFlat({ choice: '日用品' }, 'sum', index) === null && decodeFlat({ probabilities: { 架空: 1 } }, 'sum', index) === null);
check('sum: confidence は 1 を超えない', decodeFlat({ probabilities: { '食費/外食': 0.7, '食費/カフェ': 0.7 } }, 'sum', index).confidence === 1);

console.log('\n# scoreHierarchical');
const item = { label: '食費', subLabel: '外食' };
check('両方正解', same(scoreHierarchical(item, { major: '食費', sub: '外食', subMajor: '食費' }), { majorCorrect: true, subCorrect: true, bothCorrect: true }));
check('大項目だけ正解', same(scoreHierarchical(item, { major: '食費', sub: 'カフェ', subMajor: '食費' }), { majorCorrect: true, subCorrect: false, bothCorrect: false }));
check('中項目なし（null）', same(scoreHierarchical(item, { major: '食費', sub: null, subMajor: null }), { majorCorrect: true, subCorrect: false, bothCorrect: false }));
check('別の大項目の下で同じ名前の中項目は不正解', scoreHierarchical(item, { major: '娯楽', sub: '外食', subMajor: '娯楽' }).subCorrect === false);
check('gold: 大項目は外れ、正解の大項目の下で中項目は正解', same(scoreHierarchical(item, { major: '娯楽', sub: '外食', subMajor: '食費' }), { majorCorrect: false, subCorrect: true, bothCorrect: false }));
check('答えなし', same(scoreHierarchical(item, { major: null, sub: null, subMajor: null }), { majorCorrect: false, subCorrect: false, bothCorrect: false }));

console.log('\n# summarizeHierarchy（手計算と比べる）');
const call = (stage, ms, inTok, model = 'jev-1.13.0', error = false) => ({ stage, ms, error, inTok, outTok: 0, model: error ? null : model });
// 4 件: r1 両方正解（2 回）/ r2 大項目だけ正解（2 回）/ r3 大項目外れ（1 回目だけ）/ r4 1 回目失敗・gold で 2 回目の中項目は正解
const rows = [
  { correct: true, subCorrect: true, bothCorrect: true, ms: 150, stages: [call(1, 100, 1000), call(2, 50, 300)] },
  { correct: true, subCorrect: false, bothCorrect: false, ms: 170, stages: [call(1, 110, 1000), call(2, 60, 300)] },
  { correct: false, subCorrect: false, bothCorrect: false, ms: 120, stages: [call(1, 120, 1000)] },
  { correct: false, subCorrect: true, bothCorrect: false, ms: 200, stages: [call(1, 130, 0, null, true), call(2, 70, 300)] },
];
const h = summarizeHierarchy(rows, [1, 2]);
check('件数・正解', h.n === 4 && h.majorCorrect === 2 && h.majorAccuracy === 0.5 && h.bothCorrect === 1 && h.bothCorrectRate === 0.25, JSON.stringify(h));
check('大項目が正解の件の中での中項目の正解率 1/2', h.subAccuracyAmongMajorCorrect === 0.5);
check('中項目の正解率（全件）2/4', h.subCorrect === 2 && h.subAccuracy === 0.5);
check('1 件あたりの呼び出し 7/4 = 1.75', h.callsPerItem === 1.75);
check('1 件の合計のレイテンシ（120,150,170,200）p50 150 / p95 200', same(h.latencyTotalMs, { p50: 150, p95: 200 }));
check('1 回目: 4 回（失敗 1）、入力 3000（成功した 1 回 1000、1 件 750）、p50 110 / p95 130',
  h.stages.stage1.calls === 4 && h.stages.stage1.errors === 1 && same(h.stages.stage1.tokens, { input: 3000, output: 0, inputPerCall: 1000, inputPerItem: 750 }) &&
    same(h.stages.stage1.latencyMs, { p50: 110, p95: 130 }), JSON.stringify(h.stages.stage1));
check('2 回目: 3 回、入力 900（1 回 300）、p50 60 / p95 70',
  h.stages.stage2.calls === 3 && h.stages.stage2.errors === 0 && h.stages.stage2.tokens.input === 900 && h.stages.stage2.tokens.inputPerCall === 300 &&
    same(h.stages.stage2.latencyMs, { p50: 60, p95: 70 }), JSON.stringify(h.stages.stage2));
// 3000 × 0.042 / 1e6 = 0.000126（1,000 件あたり 0.0315）、900 × 0.042 / 1e6 = 0.0000378 → 0.000038（0.00945 → 0.0095 付近）
check('段ごとのコスト', h.stages.stage1.costUsdPaidRate === 0.000126 && h.stages.stage1.costUsdPer1000 === 0.0315 && h.stages.stage2.costUsdPaidRate === 0.000038,
  JSON.stringify([h.stages.stage1.costUsdPaidRate, h.stages.stage1.costUsdPer1000, h.stages.stage2.costUsdPaidRate]));
check('2 段の合計は 1 回目の (3000 + 900) / 3000 = 1.3 倍', h.costRatioToStage1 === 1.3);
const total = (3000 + 900) * PRICES['jev-1.13.0'].input / 1e6;
check('段のコストの和 = 全体のコスト（±1e-6）', Math.abs(h.stages.stage1.costUsdPaidRate + h.stages.stage2.costUsdPaidRate - total) <= 1e-6);
const unknown = summarizeHierarchy([{ ...rows[0], stages: [call(1, 100, 1000), call(2, 50, 300, 'jev-9.9.9')] }], [1, 2]);
check('単価の無いモデルがある段は null、倍率も null', unknown.stages.stage1.costUsdPaidRate !== null && unknown.stages.stage2.costUsdPaidRate === null && unknown.costRatioToStage1 === null);
const flat = summarizeHierarchy(rows.map((r) => ({ ...r, stages: r.stages.filter((c) => c.stage === 1) })), [1]);
check('flat（[1]）: 段は stage1 だけ、倍率なし', same(Object.keys(flat.stages), ['stage1']) && !('costRatioToStage1' in flat) && flat.callsPerItem === 1);
check('2 回目の呼び出しが無い段は、レイテンシ・1 回あたりが null', (() => {
  const s = summarizeHierarchy([rows[2]], [1, 2]).stages.stage2;
  return s.calls === 0 && s.tokens.inputPerCall === null && s.latencyMs.p50 === null && s.costUsdPaidRate === 0;
})());
check('0 件は null', summarizeHierarchy([], [1, 2]) === null);

if (failed > 0) {
  console.log(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nすべて ok');
