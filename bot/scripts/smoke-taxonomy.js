/**
 * 中項目の定義（categoryTaxonomy）と、評価データに中項目を付ける道具（eval/review-golden.js --sub）のスモークテスト
 *
 * 架空のデータだけを使う。評価データ（bot/scripts/eval/*.local.json）は読まない・書かない
 * （保存・バックアップの確認は、OS の一時フォルダーに作った架空のファイルで行い、最後に消す）。
 *   node bot/scripts/smoke-taxonomy.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SUB_CATEGORIES, subCategoriesOf } = require('../dist/categoryTaxonomy');
const { CANONICAL_CATEGORIES } = require('../dist/categoryNormalization');
const { SUB_NULL_KEY, applySubLabel, itemsToLabelSub, validSubLabel, saveGolden, backupGolden } = require('./eval/review-golden');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n# 中項目の定義');
const majors = Object.keys(SUB_CATEGORIES);
check('大項目は正準名だけ', majors.every((m) => CANONICAL_CATEGORIES.includes(m)), majors.join(','));
for (const [major, list] of Object.entries(SUB_CATEGORIES)) {
  check(`${major}: 中項目が 1 つ以上`, Array.isArray(list) && list.length > 0);
  check(`${major}: 中項目名が一意`, new Set(list).size === list.length, list.join(','));
  check(
    `${major}: 中項目名が空でない文字列（前後の空白なし）`,
    list.every((s) => typeof s === 'string' && s.trim() !== '' && s.trim() === s)
  );
  check(`${major}: 中項目名が 50 文字以内`, list.every((s) => s.length <= 50));
  check(`${major}: 中項目名が CLI のキー（番号・s・q）と重ならない`,list.every((s) => !/^\d+$/.test(s) && s !== 's' && s !== 'q'));
}

console.log('\n# subCategoriesOf');
check('食費 → 食費の一覧', subCategoriesOf('食費') === SUB_CATEGORIES['食費']);
check('娯楽 → 娯楽の一覧', subCategoriesOf('娯楽') === SUB_CATEGORIES['娯楽']);
check('別名「外食」→ 食費の一覧', subCategoriesOf('外食') === SUB_CATEGORIES['食費']);
check('別名「エンタメ」→ 娯楽の一覧', subCategoriesOf('エンタメ') === SUB_CATEGORIES['娯楽']);
check('前後の空白は無視', subCategoriesOf(' 食費 ') === SUB_CATEGORIES['食費']);
check('中項目の無い大項目（日用品）は空', subCategoriesOf('日用品').length === 0);
check('その他は空', subCategoriesOf('その他').length === 0);
check('一覧に無い名前は空', subCategoriesOf('架空のカテゴリ').length === 0);
check('空文字は空', subCategoriesOf('').length === 0);

console.log('\n# applySubLabel');
const food = SUB_CATEGORIES['食費'];
const base = { id: 'text-901', source: 'text', description: '架空の説明', saved: '食費', label: '食費', reviewed: true, excluded: false };
const snapshot = JSON.stringify(base);
let r = applySubLabel(base, '2', food);
check('番号 2 → 2 番目の中項目', r && r.subLabel === food[1], JSON.stringify(r));
check('subLabel 以外のキーは変えない', r && JSON.stringify({ ...r, subLabel: undefined }) === snapshot, JSON.stringify(r));
check('元の item は変えない', JSON.stringify(base) === snapshot);
r = applySubLabel(base, ` ${food.length} `, food);
check('最後の番号（前後の空白あり）', r && r.subLabel === food[food.length - 1], JSON.stringify(r));
r = applySubLabel(base, food[0], food);
check('中項目名でも付けられる', r && r.subLabel === food[0], JSON.stringify(r));
r = applySubLabel(base, SUB_NULL_KEY, food);
check('0 → 決められない（null）', r && r.subLabel === null && Object.prototype.hasOwnProperty.call(r, 'subLabel'), JSON.stringify(r));
check('null のときも label・reviewed は変えない', r && r.label === '食費' && r.reviewed === true && r.excluded === false);
check('範囲外の番号は null', applySubLabel(base, String(food.length + 1), food) === null);
check('負の番号は null', applySubLabel(base, '-1', food) === null);
check('空の答えは null', applySubLabel(base, '', food) === null);
check('s・q は null（CLI 側で扱う）', applySubLabel(base, 's', food) === null && applySubLabel(base, 'q', food) === null);
check('別の大項目の中項目名は null', applySubLabel(base, SUB_CATEGORIES['娯楽'][0], food) === null);
check('一覧が空なら、番号・0 でも null', applySubLabel(base, '1', []) === null && applySubLabel(base, SUB_NULL_KEY, []) === null);
r = applySubLabel({ ...base, subLabel: food[0] }, '3', food);
check('すでにある subLabel を上書きする', r && r.subLabel === food[2], JSON.stringify(r));

console.log('\n# itemsToLabelSub');
const items = [
  { id: 'a', source: 'text', description: '架空1', label: '食費', reviewed: true, excluded: false },
  { id: 'b', source: 'merchant', description: '架空2', label: '娯楽', reviewed: true, excluded: false },
  { id: 'c', source: 'text', description: '架空3', label: '食費', reviewed: false },
  { id: 'd', source: 'text', description: '架空4', label: '食費', reviewed: true, excluded: true },
  { id: 'e', source: 'merchant', description: '架空5', label: '日用品', reviewed: true, excluded: false },
  { id: 'f', source: 'merchant', description: '架空6', label: '食費', reviewed: true, excluded: false, subLabel: food[0] },
  { id: 'g', source: 'text', description: '架空7', label: '娯楽', reviewed: true, excluded: false, subLabel: null },
  { id: 'h', source: 'merchant', description: '架空8', label: '娯楽', reviewed: true, excluded: false, subLabel: food[0] },
];
const ids = (list) => list.map((it) => it.id).join(',');
let q = itemsToLabelSub(items);
check('既定: 未付与の a・b と、一覧に無い subLabel の h だけ', ids(q) === 'a,b,h', ids(q));
check('items の要素そのものを返す', q[0] === items[0]);
q = itemsToLabelSub(items, { redo: true });
check('--redo: 付与済みの f・g も対象（未見直し・除外・一覧なしは対象外のまま）', ids(q) === 'a,b,f,g,h', ids(q));
q = itemsToLabelSub(items, { ids: ['b', 'c', 'f'] });
check('ids で絞る（未見直しの c・付与済みの f は対象外のまま）', ids(q) === 'b', ids(q));
q = itemsToLabelSub(items, { ids: new Set(['f']), redo: true });
check('ids（Set）と --redo', ids(q) === 'f', ids(q));
q = itemsToLabelSub(items, { label: '娯楽' });
check('label で絞る', ids(q) === 'b,h', ids(q));
q = itemsToLabelSub(items, { source: 'text' });
check('source で絞る', ids(q) === 'a', ids(q));
check('元の items は変えない', items.length === 8 && items[5].subLabel === food[0] && items[6].subLabel === null);

console.log('\n# validSubLabel（評価で中項目の正解として使えるか）');
check('いまの大項目の一覧にある', validSubLabel({ label: '食費', subLabel: food[1] }) === true);
check('別名の大項目（外食 → 食費）でも一覧で見る', validSubLabel({ label: '外食', subLabel: food[1] }) === true);
check('決められない（null）は使わない', validSubLabel({ label: '食費', subLabel: null }) === false);
check('subLabel が無い', validSubLabel({ label: '食費' }) === false);
check('大項目を直して一覧から外れた subLabel（娯楽に食費の中項目）', validSubLabel({ label: '娯楽', subLabel: food[0] }) === false);
check('一覧の無い大項目に直した件（日用品）', validSubLabel({ label: '日用品', subLabel: food[0] }) === false);
check('文字列でない subLabel', validSubLabel({ label: '食費', subLabel: 1 }) === false);

console.log('\n# saveGolden / backupGolden（OS の一時フォルダーの架空のファイル）');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-taxonomy-'));
const file = path.join(dir, 'golden.local.json');
const listDir = () => fs.readdirSync(dir).sort().join(',');
const fixture = {
  meta: { note: '架空' },
  items: [
    { id: 'a', source: 'text', description: '架空1', label: '食費', reviewed: true, subLabel: food[1] },
    { id: 'b', source: 'merchant', description: '架空2', label: '娯楽', reviewed: false, subLabel: null },
  ],
};
// 変更前の review-golden.js と同じ書式（1 件 1 行、末尾に改行）
const expected =
  '{\n  "meta": {"note":"架空"},\n  "items": [\n' +
  `    {"id":"a","source":"text","description":"架空1","label":"食費","reviewed":true,"subLabel":"${food[1]}"},\n` +
  '    {"id":"b","source":"merchant","description":"架空2","label":"娯楽","reviewed":false,"subLabel":null}\n  ]\n}\n';
const realWrite = fs.writeFileSync;
const realRename = fs.renameSync;
try {
  saveGolden(file, fixture);
  check('保存した内容が従来の書式のとおり', fs.readFileSync(file, 'utf8') === expected);
  check('一時ファイルが残らない', listDir() === 'golden.local.json', listDir());
  saveGolden(file, { ...fixture, items: [fixture.items[0]] });
  check('既存のファイルを置き換える', JSON.parse(fs.readFileSync(file, 'utf8')).items.length === 1);
  saveGolden(file, fixture);

  // 一時ファイルへの書き込みが途中で失敗（空き容量不足など）
  fs.writeFileSync = (p, text) => {
    realWrite(p, String(text).slice(0, 10));
    throw new Error('simulated write failure');
  };
  let threw = false;
  try {
    saveGolden(file, { ...fixture, items: [] });
  } catch (_e) {
    threw = true;
  }
  fs.writeFileSync = realWrite;
  check('書き込みの失敗は投げる', threw);
  check('書き込みに失敗しても元のファイルはそのまま', fs.readFileSync(file, 'utf8') === expected);
  check('書き込みに失敗したら一時ファイルを消す', listDir() === 'golden.local.json', listDir());

  // 置き換え（rename）が失敗
  fs.renameSync = () => {
    throw new Error('simulated rename failure');
  };
  threw = false;
  try {
    saveGolden(file, { ...fixture, items: [] });
  } catch (_e) {
    threw = true;
  }
  fs.renameSync = realRename;
  check('置き換えの失敗は投げる', threw);
  check('置き換えに失敗しても元のファイルはそのまま', fs.readFileSync(file, 'utf8') === expected);
  check('置き換えに失敗したら一時ファイルを消す', listDir() === 'golden.local.json', listDir());

  // 書き込み先のフォルダーが無い
  threw = false;
  try {
    saveGolden(path.join(dir, 'no-such-dir', 'golden.local.json'), fixture);
  } catch (_e) {
    threw = true;
  }
  check('存在しないフォルダーへの保存は投げる', threw);
  check('存在しないフォルダーへの保存で何も作らない', listDir() === 'golden.local.json', listDir());

  const at = new Date('2026-10-24T01:02:03.004Z');
  const backup = backupGolden(file, at);
  check('バックアップの名前', path.basename(backup) === 'golden.sub-backup-20261024T010203004Z.local.json', backup);
  check('バックアップは同じフォルダー・*.local.json', path.dirname(backup) === dir && backup.endsWith('.local.json'));
  check('バックアップは元と同じ内容', fs.readFileSync(backup, 'utf8') === expected);
  threw = false;
  try {
    backupGolden(file, at);
  } catch (_e) {
    threw = true;
  }
  check('同じ名前のバックアップは上書きしない', threw && fs.readFileSync(backup, 'utf8') === expected);
} finally {
  fs.writeFileSync = realWrite;
  fs.renameSync = realRename;
  for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
  fs.rmdirSync(dir);
}

if (failed > 0) {
  console.log(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nすべて ok');
