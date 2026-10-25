/**
 * 中項目を辞書と時刻で決める resolveSubCategory（subCategoryRules）と、確定した中項目の一覧のスモークテスト（#235）
 *
 * 架空・一般的な語だけを使う。評価データ（bot/scripts/eval/*.local.json）は読まない。Jev・Gemini は呼ばない。
 *   node bot/scripts/smoke-subcategory.js
 */
const {
  normalizeForMatch,
  SUB_CATEGORY_RULES,
  mealOfJst,
  usedAtHasClockTime,
  resolveSubCategory,
} = require('../dist/subCategoryRules');
const { SUB_CATEGORIES, SUB_CATEGORY_DESCRIPTIONS } = require('../dist/categoryTaxonomy');
const { CANONICAL_CATEGORIES } = require('../dist/categoryNormalization');
const { parseJSTWallClock } = require('../dist/time');
const { countDescribed } = require('./eval/eval-classifier');
const { validSubLabel } = require('./eval/review-golden');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** JST の壁時計の時刻（2026-10-01）を Date にする。ローカルの TZ に左右されないよう +09:00 を付ける */
const jst = (hhmm, date = '2026-10-01') => new Date(`${date}T${hhmm}:00+09:00`);
const food = (text, opts = {}) => resolveSubCategory({ major: '食費', text, source: 'text', ...opts });
const fun = (text, opts = {}) => resolveSubCategory({ major: '娯楽', text, source: 'text', ...opts });
const shop = (text, hhmm, extra = {}) =>
  resolveSubCategory({ major: '食費', text, source: 'merchant', usedAt: jst(hhmm), hasTime: true, ...extra });

console.log('\n# 中項目の一覧（確定）');
check(
  '食費は 10 個（並び順のとおり）',
  JSON.stringify(SUB_CATEGORIES['食費']) ===
    JSON.stringify(['食料品（スーパー）', '外食', '朝ご飯', '昼ご飯', '夜ご飯', 'カフェ', 'コンビニ', '自販機', 'デリバリー・テイクアウト', 'その他の食費']),
  SUB_CATEGORIES['食費'].join(',')
);
check(
  '娯楽は 8 個（並び順のとおり）',
  JSON.stringify(SUB_CATEGORIES['娯楽']) ===
    JSON.stringify(['映画', '銭湯・サウナ', 'スポーツ・アウトドア', 'ゲーム・課金', '本・漫画', '音楽・ライブ', 'レジャー・テーマパーク', 'その他の娯楽']),
  SUB_CATEGORIES['娯楽'].join(',')
);
// #250 の仮の一覧の名前。評価データに付けたラベルが、確定した一覧でも使える
const PROVISIONAL = {
  食費: ['食料品（スーパー）', '外食', 'コンビニ', 'カフェ', '自販機', 'デリバリー・テイクアウト', 'その他の食費'],
  娯楽: ['映画', '銭湯・サウナ', 'ゲーム・課金', '本・漫画', '音楽・ライブ', 'レジャー・テーマパーク', 'その他の娯楽'],
};
for (const [major, list] of Object.entries(PROVISIONAL)) {
  const invalid = list.filter((sub) => validSubLabel({ label: major, subLabel: sub }) !== true);
  check(`${major}: 仮の一覧の名前はすべて有効なラベルのまま`, invalid.length === 0, invalid.join(','));
}
const described = countDescribed(SUB_CATEGORIES, SUB_CATEGORY_DESCRIPTIONS);
check('全中項目に説明がある（countDescribed）', described.described === described.total && described.total === 18, JSON.stringify(described));

console.log('\n# normalizeForMatch');
check('半角カナ → 全角（NFKC）', normalizeForMatch('ﾏｸﾄﾞﾅﾙﾄﾞ') === 'マクドナルド', normalizeForMatch('ﾏｸﾄﾞﾅﾙﾄﾞ'));
check('全角英数 → 半角・小文字', normalizeForMatch('ＳＴＡＲＢＵＣＫＳ') === 'starbucks');
check('空白・記号を除く（長音符は残す）', normalizeForMatch(' STARBUCKS  COFFEE・渋谷店（架空）!') === 'starbuckscoffee渋谷店架空', normalizeForMatch(' STARBUCKS  COFFEE・渋谷店（架空）!'));
check('数字は残す', normalizeForMatch('7-Eleven') === '7eleven');
check('文字列でなければ空文字', normalizeForMatch(undefined) === '' && normalizeForMatch(null) === '' && normalizeForMatch(123) === '');
check('100 文字に切る', normalizeForMatch('あ'.repeat(150)) === 'あ'.repeat(100));
// U+FDFA は NFKC で 18 文字（空白を含む）に伸びる
const expanded = normalizeForMatch('ﷺ'.repeat(100));
check('NFKC で伸びても 100 文字以内', expanded.length > 0 && expanded.length <= 100, String(expanded.length));

console.log('\n# 時間帯（mealOfJst。JST）');
const boundaries = [
  ['04:59', '夜ご飯'],
  ['05:00', '朝ご飯'],
  ['10:59', '朝ご飯'],
  ['11:00', '昼ご飯'],
  ['16:59', '昼ご飯'],
  ['17:00', '夜ご飯'],
  ['00:00', '夜ご飯'],
  ['23:59', '夜ご飯'],
];
for (const [hhmm, expected] of boundaries) {
  check(`${hhmm} → ${expected}`, mealOfJst(jst(hhmm)) === expected, String(mealOfJst(jst(hhmm))));
}
check('読めない日時は null', mealOfJst(new Date(NaN)) === null && mealOfJst('架空') === null && mealOfJst(undefined) === null);

console.log('\n# usedAtHasClockTime');
check('JST 00:00:00 ちょうどは時刻なし', usedAtHasClockTime(jst('00:00')) === false);
check('Gmail で時刻が無いとき（parseJSTWallClock の 00:00）は時刻なし', usedAtHasClockTime(parseJSTWallClock('2026-10-01', '00:00')) === false);
check('JST 00:00:01 は時刻あり', usedAtHasClockTime(new Date('2026-10-01T00:00:01+09:00')) === true);
check('JST 00:00:00.001 は時刻あり', usedAtHasClockTime(new Date('2026-10-01T00:00:00.001+09:00')) === true);
check('JST 12:30 は時刻あり', usedAtHasClockTime(jst('12:30')) === true);
check('UTC 00:00（JST 09:00）は時刻あり', usedAtHasClockTime(new Date('2026-10-01T00:00:00Z')) === true);
check('読めない日時は false', usedAtHasClockTime(new Date(NaN)) === false && usedAtHasClockTime(undefined) === false);

console.log('\n# 時刻のルール（Gmail の店名・飲食店）');
function runTimeRuleChecks(label) {
  const got = [];
  for (const [hhmm, expected] of boundaries.filter(([h]) => h !== '23:59')) {
    const r = shop('架空食堂', hhmm);
    got.push(r);
    check(`${label}架空食堂 ${hhmm} → ${expected}`, r === expected, String(r));
  }
  const noTime = shop('架空食堂', '00:00', { hasTime: false });
  got.push(noTime);
  check(`${label}00:00 で hasTime: false → 外食`, noTime === '外食', String(noTime));
  return got;
}
const inLocal = runTimeRuleChecks('');

console.log('\n# TZ を変えても同じ（JST で判定）');
const tzBefore = process.env.TZ;
const offsets = {};
const results = {};
for (const tz of ['UTC', 'America/Los_Angeles']) {
  process.env.TZ = tz;
  offsets[tz] = new Date('2026-10-01T00:00:00Z').getTimezoneOffset();
  results[tz] = runTimeRuleChecks(`[TZ=${tz}] `);
}
if (tzBefore === undefined) delete process.env.TZ;
else process.env.TZ = tzBefore;
check('TZ の切り替えが効いている（UTC と America/Los_Angeles でオフセットが違う）', offsets['UTC'] === 0 && offsets['America/Los_Angeles'] !== 0, JSON.stringify(offsets));
check(
  'UTC・America/Los_Angeles・元の TZ で結果が同じ',
  JSON.stringify(results['UTC']) === JSON.stringify(inLocal) && JSON.stringify(results['America/Los_Angeles']) === JSON.stringify(inLocal),
  JSON.stringify(results)
);
process.env.TZ = 'UTC';
check('[TZ=UTC] usedAtHasClockTime: JST 00:00 は時刻なし', usedAtHasClockTime(jst('00:00')) === false && usedAtHasClockTime(parseJSTWallClock('2026-10-01', '00:00')) === false);
if (tzBefore === undefined) delete process.env.TZ;
else process.env.TZ = tzBefore;

console.log('\n# 時刻のルールを当てない場合');
check('text（LINE）には当てない: 架空食堂 12:30 → 外食', food('架空食堂', { usedAt: jst('12:30'), hasTime: true }) === '外食');
check('text（LINE）には当てない: ラーメン 08:00 → 外食', food('ラーメン', { usedAt: jst('08:00'), hasTime: true }) === '外食');
check('merchant でも usedAt が無ければ外食', resolveSubCategory({ major: '食費', text: '架空食堂', source: 'merchant', hasTime: true }) === '外食');
check('merchant でも hasTime が無ければ外食', resolveSubCategory({ major: '食費', text: '架空食堂', source: 'merchant', usedAt: jst('12:30') }) === '外食');
check('merchant で usedAt が読めなければ外食', shop('架空食堂', '12:30', { usedAt: new Date(NaN) }) === '外食');
check('飲み会系には当てない: 居酒屋を 19:00 に Gmail → 外食', shop('架空居酒屋', '19:00') === '外食');
check('カフェには当てない', shop('架空カフェ', '08:00') === 'カフェ');
check('コンビニには当てない', shop('ローソン 架空店', '12:30') === 'コンビニ');
check('自販機には当てない', shop('架空 自動販売機', '12:30') === '自販機');
check('デリバリーには当てない', shop('ウーバーイーツ', '19:00') === 'デリバリー・テイクアウト');
check('食料品には当てない', shop('架空スーパー', '19:00') === '食料品（スーパー）');

console.log('\n# 優先順位');
check('コンビニ ランチ → 昼ご飯', food('コンビニ ランチ') === '昼ご飯', String(food('コンビニ ランチ')));
check('コンビニ弁当 → コンビニ', food('コンビニ弁当') === 'コンビニ', String(food('コンビニ弁当')));
check('居酒屋を 19:00 に Gmail → 外食', shop('居酒屋', '19:00') === '外食');
check('バーガー → 外食', food('架空バーガー') === '外食', String(food('架空バーガー')));
check('マックスバリュ → 食料品（スーパー）', food('マックスバリュ') === '食料品（スーパー）', String(food('マックスバリュ')));
check('スーパー銭湯（娯楽）→ 銭湯・サウナ', fun('スーパー銭湯') === '銭湯・サウナ', String(fun('スーパー銭湯')));
check('ドライブ → レジャー・テーマパーク（ライブより先）', fun('ドライブ') === 'レジャー・テーマパーク', String(fun('ドライブ')));
check('ライブ → 音楽・ライブ', fun('架空ライブ') === '音楽・ライブ');
check('モーニング（カフェより先）→ 朝ご飯', food('カフェ モーニング') === '朝ご飯');
check('朝ご飯の語は Gmail の時刻より優先（夜でも朝ご飯）', shop('朝食 架空', '19:00') === '朝ご飯');
check('別名の大項目（外食 → 食費）でも引ける', resolveSubCategory({ major: '外食', text: 'ラーメン', source: 'text' }) === '外食');
check('別名の大項目（エンタメ → 娯楽）でも引ける', resolveSubCategory({ major: 'エンタメ', text: '映画', source: 'text' }) === '映画');
check('前後の空白がある大項目', resolveSubCategory({ major: ' 食費 ', text: 'ラーメン', source: 'text' }) === '外食');

console.log('\n# 半角カナ・ローマ字');
check('ﾏｸﾄﾞﾅﾙﾄﾞ を 12:30 に → 昼ご飯', shop('ﾏｸﾄﾞﾅﾙﾄﾞ', '12:30') === '昼ご飯', String(shop('ﾏｸﾄﾞﾅﾙﾄﾞ', '12:30')));
check('STARBUCKS COFFEE → カフェ', shop('STARBUCKS COFFEE', '12:30') === 'カフェ', String(shop('STARBUCKS COFFEE', '12:30')));
check('全角の ＳＴＡＲＢＵＣＫＳ → カフェ', food('ＳＴＡＲＢＵＣＫＳ') === 'カフェ');

console.log('\n# null');
check('大項目が日用品', resolveSubCategory({ major: '日用品', text: 'コンビニ', source: 'text' }) === null);
check('大項目がカスタム名「飲食代」', resolveSubCategory({ major: '飲食代', text: 'ラーメン', source: 'text' }) === null);
check('大項目が空文字', resolveSubCategory({ major: '', text: 'ラーメン', source: 'text' }) === null);
check('大項目がその他', resolveSubCategory({ major: 'その他', text: 'ラーメン', source: 'text' }) === null);
check('大項目が文字列でない', resolveSubCategory({ major: undefined, text: 'ラーメン', source: 'text' }) === null);
check(
  'プロトタイプのキーは大項目にしない',
  ['constructor', '__proto__', 'toString', 'hasOwnProperty'].every((m) => resolveSubCategory({ major: m, text: 'ラーメン', source: 'text' }) === null)
);
check('説明が空', food('') === null && food('   ') === null && food('・！') === null);
check('説明が文字列でない', food(undefined) === null);
check('説明がカテゴリ名だけ（食費）', food('食費') === null);
check('説明がカテゴリ名だけ（娯楽費。LINE の入力でカテゴリ名が説明になる）', resolveSubCategory({ major: '娯楽費', text: '娯楽費', source: 'text' }) === null);
check('説明がカテゴリ名だけ（交際費 → 娯楽）', resolveSubCategory({ major: '交際費', text: '交際費', source: 'text' }) === null);
check('説明が「支出」だけ', food('支出') === null && fun('支出') === null);
const canonicalHits = [];
for (const major of Object.keys(SUB_CATEGORIES)) {
  for (const name of [...CANONICAL_CATEGORIES, '娯楽費', '交際費', '医療費', '趣味', '貯蓄', '支出']) {
    const r = resolveSubCategory({ major, text: name, source: 'merchant', usedAt: jst('12:30'), hasTime: true });
    if (r !== null) canonicalHits.push(`${major}/${name}→${r}`);
  }
}
check('説明がどのカテゴリ名だけでも null（食費・娯楽とも）', canonicalHits.length === 0, canonicalHits.join(','));
check('辞書に当たらなければ null', food('架空の何か') === null && fun('架空の何か') === null);
check('大項目が違えば当たらない（娯楽でラーメン）', fun('ラーメン') === null);

console.log('\n# 長い入力');
const long = 'あ'.repeat(10000);
check('1 万文字でも null を返す', food(long) === null);
check('101 文字目以降の語は見ない', food(`${'a'.repeat(200)}ランチ`) === null && food(`${'あ'.repeat(100)}ランチ`) === null);
check('先頭 100 文字の中の語は見る', food(`ランチ${'x'.repeat(9997)}`) === '昼ご飯');
const started = process.hrtime.bigint();
for (let i = 0; i < 1000; i++) {
  food(long);
  shop(`架空食堂${long}`, '12:30');
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
check('1 万文字 × 2,000 回が 2 秒以内', elapsedMs < 2000, `${elapsedMs.toFixed(1)}ms`);

console.log('\n# 辞書の衛生');
const ruleMajors = Object.keys(SUB_CATEGORY_RULES);
check('辞書の大項目は中項目の一覧がある大項目と同じ', JSON.stringify(ruleMajors.slice().sort()) === JSON.stringify(Object.keys(SUB_CATEGORIES).sort()), ruleMajors.join(','));
check('辞書は書き換えられない（freeze）', Object.isFrozen(SUB_CATEGORY_RULES) && ruleMajors.every((m) => Object.isFrozen(SUB_CATEGORY_RULES[m]) && SUB_CATEGORY_RULES[m].every((g) => Object.isFrozen(g) && Object.isFrozen(g.keywords))));
const FORBIDDEN = ['マック', 'バー', 'スパ'].map(normalizeForMatch);
for (const [major, groups] of Object.entries(SUB_CATEGORY_RULES)) {
  const list = SUB_CATEGORIES[major] || [];
  const subs = groups.map((g) => g.sub);
  const notInList = subs.filter((s) => !list.includes(s));
  check(`${major}: 返す中項目がすべて一覧にある`, notInList.length === 0, notInList.join(','));
  check(`${major}: 「その他の…」を返さない`, subs.every((s) => !s.startsWith('その他')), subs.join(','));
  const mealGroups = groups.filter((g) => g.mealTime !== undefined);
  check(`${major}: mealTime は true だけで、外食のグループだけ`, mealGroups.every((g) => g.mealTime === true && g.sub === '外食'));
  const all = groups.flatMap((g) => g.keywords);
  const notNormalized = all.filter((k) => typeof k !== 'string' || normalizeForMatch(k) !== k);
  check(`${major}: キーワードが正規化済み`, notNormalized.length === 0, notNormalized.join(','));
  const tooShort = all.filter((k) => Array.from(k).length < 2);
  check(`${major}: キーワードは 2 文字以上`, tooShort.length === 0, tooShort.join(','));
  const shortAscii = all.filter((k) => /^[a-z0-9]+$/.test(k) && k.length < 4);
  check(`${major}: 英数字だけのキーワードは 4 文字以上`, shortAscii.length === 0, shortAscii.join(','));
  const forbidden = all.filter((k) => FORBIDDEN.includes(k));
  check(`${major}: 「マック」「バー」「スパ」を持たない`, forbidden.length === 0, forbidden.join(','));
  const dup = all.filter((k, i) => all.indexOf(k) !== i);
  check(`${major}: キーワードが重ならない（揃えた後で同じ語が無い）`, dup.length === 0, dup.join(','));
  // 前のグループの語を含む語は、前のグループに先に当たるので、決して使われない（例: 前に「ライブ」があると「ドライブ」は死ぬ）
  const dead = [];
  groups.forEach((g, i) => {
    const earlier = groups.slice(0, i).flatMap((e) => e.keywords);
    for (const k of g.keywords) {
      const hit = earlier.find((e) => k.includes(e));
      if (hit) dead.push(`${g.sub}:${k}（${hit}）`);
    }
  });
  check(`${major}: 前のグループの語に隠れて使われない語が無い`, dead.length === 0, dead.join(','));
  // 各グループの各キーワードが、単独の入力でそのグループの中項目になる（text なので時刻のルールは当たらない）
  const unreachable = [];
  for (const g of groups) {
    for (const k of g.keywords) {
      const r = resolveSubCategory({ major, text: k, source: 'text' });
      if (r !== g.sub) unreachable.push(`${k}→${r}`);
    }
  }
  check(`${major}: 各キーワードは単独でそのグループの中項目になる`, unreachable.length === 0, unreachable.join(','));
}

if (failed > 0) {
  console.log(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nすべて ok');
