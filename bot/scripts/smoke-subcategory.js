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
const { parseTextExpense } = require('../dist/textParser');
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
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

/** JST の壁時計の時刻（2026-10-01）を Date にする。ローカルの TZ に左右されないよう +09:00 を付ける */
const jst = (hhmm, date = '2026-10-01') => new Date(`${date}T${hhmm}:00+09:00`);
const food = (text, opts = {}) => resolveSubCategory({ major: '食費', text, source: 'text', ...opts });
const fun = (text, opts = {}) => resolveSubCategory({ major: '娯楽', text, source: 'text', ...opts });
/** Gmail の店名で、時刻が分かったとき（usedAt を渡す） */
const shop = (text, hhmm, extra = {}) => resolveSubCategory({ major: '食費', text, source: 'merchant', usedAt: jst(hhmm), ...extra });
/** LINE の入力を textParser で解析した説明文で判定する */
const line = (input, major) => resolveSubCategory({ major, text: parseTextExpense(input).description, source: 'text' });

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
check('有効な Date でなければ null', mealOfJst(new Date(NaN)) === null && mealOfJst(undefined) === null && mealOfJst(Date.now()) === null);
check('文字列は受けない（null）', mealOfJst('2026-10-01T12:30:00+09:00') === null && mealOfJst('2026-10-01 12:30') === null);

console.log('\n# usedAtHasClockTime（再判定専用のフォールバック）');
check('JST 00:00:00 ちょうどは時刻なし', usedAtHasClockTime(jst('00:00')) === false);
check('Gmail で時刻が無いとき（parseJSTWallClock の 00:00）は時刻なし', usedAtHasClockTime(parseJSTWallClock('2026-10-01', '00:00')) === false);
check('JST 00:00:01 は時刻あり', usedAtHasClockTime(new Date('2026-10-01T00:00:01+09:00')) === true);
check('JST 00:00:00.001 は時刻あり', usedAtHasClockTime(new Date('2026-10-01T00:00:00.001+09:00')) === true);
check('JST 12:30 は時刻あり', usedAtHasClockTime(jst('12:30')) === true);
check('UTC 00:00（JST 09:00）は時刻あり', usedAtHasClockTime(new Date('2026-10-01T00:00:00Z')) === true);
check('有効な Date でなければ false', usedAtHasClockTime(new Date(NaN)) === false && usedAtHasClockTime(undefined) === false);
check('文字列・数・Timestamp 風のものは false', [
  '2026-10-01T12:30:00+09:00',
  Date.now(),
  { toDate: () => jst('12:30') },
].every((v) => usedAtHasClockTime(v) === false));

console.log('\n# 時刻のルール（Gmail の店名・飲食店。時刻が分かるときだけ usedAt を渡す）');
function runTimeRuleChecks(label) {
  const got = [];
  for (const [hhmm, expected] of boundaries.filter(([h]) => h !== '23:59')) {
    const r = shop('架空食堂', hhmm);
    got.push(r);
    check(`${label}架空食堂 ${hhmm} → ${expected}`, r === expected, String(r));
  }
  // 時刻が分からない（00:00 にした）件は、呼び出し側が usedAtHasClockTime で見て usedAt を渡さない
  const midnight = jst('00:00');
  const noTime = resolveSubCategory({
    major: '食費',
    text: '架空食堂',
    source: 'merchant',
    usedAt: usedAtHasClockTime(midnight) ? midnight : undefined,
  });
  got.push(noTime);
  check(`${label}00:00 で時刻なし（usedAt を渡さない）→ 外食`, noTime === '外食', String(noTime));
  return got;
}
const inLocal = runTimeRuleChecks('');

console.log('\n# TZ を変えても同じ（JST で判定）');
const tzBefore = process.env.TZ;
const restoreTz = () => {
  if (tzBefore === undefined) delete process.env.TZ;
  else process.env.TZ = tzBefore;
};
const offsets = {};
const results = {};
for (const tz of ['UTC', 'America/Los_Angeles']) {
  process.env.TZ = tz;
  offsets[tz] = new Date('2026-10-01T00:00:00Z').getTimezoneOffset();
  results[tz] = runTimeRuleChecks(`[TZ=${tz}] `);
}
restoreTz();
check('TZ の切り替えが効いている（UTC と America/Los_Angeles でオフセットが違う）', offsets['UTC'] === 0 && offsets['America/Los_Angeles'] !== 0, JSON.stringify(offsets));
check(
  'UTC・America/Los_Angeles・元の TZ で結果が同じ',
  JSON.stringify(results['UTC']) === JSON.stringify(inLocal) && JSON.stringify(results['America/Los_Angeles']) === JSON.stringify(inLocal),
  JSON.stringify(results)
);
process.env.TZ = 'UTC';
check('[TZ=UTC] usedAtHasClockTime: JST 00:00 は時刻なし', usedAtHasClockTime(jst('00:00')) === false && usedAtHasClockTime(parseJSTWallClock('2026-10-01', '00:00')) === false);
restoreTz();

console.log('\n# 時刻のルールを当てない場合');
check('text（LINE）には当てない: 架空食堂 12:30 → 外食', food('架空食堂', { usedAt: jst('12:30') }) === '外食');
check('text（LINE）には当てない: ラーメン 08:00 → 外食', food('ラーメン', { usedAt: jst('08:00') }) === '外食');
check('merchant でも usedAt が無ければ外食', resolveSubCategory({ major: '食費', text: '架空食堂', source: 'merchant' }) === '外食');
check('merchant で usedAt が null なら外食', shop('架空食堂', '12:30', { usedAt: null }) === '外食');
check('merchant で usedAt が無効な Date なら外食', shop('架空食堂', '12:30', { usedAt: new Date(NaN) }) === '外食');
check(
  'merchant で usedAt が Date でない（文字列・数・Timestamp 風）なら外食',
  ['2026-10-01T12:30:00+09:00', jst('12:30').getTime(), { toDate: () => jst('12:30') }].every((v) => shop('架空食堂', '12:30', { usedAt: v }) === '外食')
);
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
check('カラオケ → 音楽・ライブ', fun('架空カラオケ') === '音楽・ライブ');
check('モーニング（カフェより先）→ 朝ご飯', food('カフェ モーニング') === '朝ご飯');
check('朝ご飯の語は Gmail の時刻より優先（夜でも朝ご飯）', shop('朝食 架空', '19:00') === '朝ご飯');
check('別名の大項目（外食 → 食費）でも引ける', resolveSubCategory({ major: '外食', text: 'ラーメン', source: 'text' }) === '外食');
check('別名の大項目（エンタメ → 娯楽）でも引ける', resolveSubCategory({ major: 'エンタメ', text: '映画', source: 'text' }) === '映画');
check('前後の空白がある大項目', resolveSubCategory({ major: ' 食費 ', text: 'ラーメン', source: 'text' }) === '外食');

console.log('\n# 完全一致だけの語（exact）');
check('LINE「マック 500」→ 外食', line('マック 500', '食費') === '外食', String(line('マック 500', '食費')));
check('LINE「本 1500」→ 本・漫画', line('本 1500', '娯楽') === '本・漫画', String(line('本 1500', '娯楽')));
check('マック を 12:30 に Gmail → 昼ご飯（飲食店のグループ）', shop('マック', '12:30') === '昼ご飯');
check('モス・KFC → 外食', food('モス') === '外食' && food('KFC') === '外食' && food('ＫＦＣ') === '外食');
check('スキー → スポーツ・アウトドア', fun('スキー') === 'スポーツ・アウトドア');
check('釣り → スポーツ・アウトドア', fun('釣り') === 'スポーツ・アウトドア');
check('イオン → 食料品（スーパー）', food('イオン') === '食料品（スーパー）');
check('AEON（部分一致のまま）→ 食料品（スーパー）', food('AEON 架空店') === '食料品（スーパー）');
check('「ウイスキー」は当てない（娯楽・食費）', fun('ウイスキー') === null && food('ウイスキー') === null);
check('「お釣り」は当てない（娯楽・食費）', fun('お釣り') === null && food('お釣り') === null);
check('「銀座ライオン」は当てない（食費）', food('銀座ライオン') === null);
check('「イオンモール」は当てない（食料品とは限らない）', food('イオンモール') === null);
check('「本田」「本日」は当てない（娯楽）', fun('本田') === null && fun('本日') === null);
check('「マック」を含むだけの語は当てない', food('マックブック') === null);
check('完全一致は揃えた後の全体で見る（「マック！」「 本 」も当たる）', food('マック！') === '外食' && fun(' 本 ') === '本・漫画');

console.log('\n# ディズニー（動画配信の定期課金をテーマパークにしない）');
check('「DISNEY+」は当てない', fun('DISNEY+') === null);
check('「ディズニープラス」は当てない', fun('ディズニープラス') === null);
check('「ディズニーランド」→ レジャー・テーマパーク', fun('ディズニーランド') === 'レジャー・テーマパーク');
check('「東京ディズニーシー」→ レジャー・テーマパーク', fun('東京ディズニーシー') === 'レジャー・テーマパーク');
check('「TOKYO DISNEY RESORT」→ レジャー・テーマパーク', fun('TOKYO DISNEY RESORT') === 'レジャー・テーマパーク');

console.log('\n# 足した語・ローマ字の店名');
check('夜ごはん・晩ごはん・夕ご飯・夕ごはん → 夜ご飯', ['夜ごはん', '晩ごはん', '夕ご飯', '夕ごはん'].every((t) => food(t) === '夜ご飯'));
check('朝飯 → 朝ご飯、昼飯 → 昼ご飯', food('朝飯') === '朝ご飯' && food('昼飯') === '昼ご飯');
check('スポーツ・アウトドア → スポーツ・アウトドア', fun('架空スポーツ') === 'スポーツ・アウトドア' && fun('アウトドア用品') === 'スポーツ・アウトドア');
check('ウーバー → デリバリー・テイクアウト', food('ウーバー') === 'デリバリー・テイクアウト');
check('フードコート・食べ放題・パスタ → 外食', ['架空フードコート', '焼肉食べ放題', '架空パスタ'].every((t) => food(t) === '外食'));
check('パン屋・ベーカリー・コープ → 食料品（スーパー）', ['架空パン屋', '架空ベーカリー', '架空コープ'].every((t) => food(t) === '食料品（スーパー）'));
check('YOSHINOYA を 19:00 に Gmail → 夜ご飯', shop('YOSHINOYA 架空店', '19:00') === '夜ご飯');
check('SAIZERIYA を 12:30 に Gmail → 昼ご飯', shop('SAIZERIYA', '12:30') === '昼ご飯');
check('SEVEN-ELEVEN → コンビニ', shop('SEVEN-ELEVEN 架空店', '12:30') === 'コンビニ');
check('DAILY YAMAZAKI → コンビニ', food('DAILY YAMAZAKI') === 'コンビニ');
check('MAXVALU・SEIJO ISHII・ITO YOKADO → 食料品（スーパー）', ['MAXVALU', 'SEIJO ISHII', 'ITO YOKADO'].every((t) => food(t) === '食料品（スーパー）'));
check('DEMAE-CAN・PIZZALA・DOMINOS → デリバリー・テイクアウト', ['DEMAE-CAN', 'PIZZALA', "DOMINO'S"].every((t) => food(t) === 'デリバリー・テイクアウト'));

console.log('\n# 半角カナ・ローマ字');
check('ﾏｸﾄﾞﾅﾙﾄﾞ を 12:30 に → 昼ご飯', shop('ﾏｸﾄﾞﾅﾙﾄﾞ', '12:30') === '昼ご飯', String(shop('ﾏｸﾄﾞﾅﾙﾄﾞ', '12:30')));
check('STARBUCKS COFFEE → カフェ', shop('STARBUCKS COFFEE', '12:30') === 'カフェ', String(shop('STARBUCKS COFFEE', '12:30')));
check('全角の ＳＴＡＲＢＵＣＫＳ → カフェ', food('ＳＴＡＲＢＵＣＫＳ') === 'カフェ');

console.log('\n# 引数が無い・壊れている');
check('引数なし・undefined・null でも投げずに null', !throws(() => resolveSubCategory()) && resolveSubCategory() === null && resolveSubCategory(undefined) === null && resolveSubCategory(null) === null);
check('空のオブジェクトは null', resolveSubCategory({}) === null);

console.log('\n# 大項目は正準名にしてから見る（別名が辞書の語でもある場合）');
// 説明がカテゴリ名だけかは、正準名と「支出」とだけ比べる（別名とは比べない）
check('{ major: ランチ, text: ランチ } → 昼ご飯（ランチ → 食費）', resolveSubCategory({ major: 'ランチ', text: 'ランチ', source: 'text' }) === '昼ご飯');
check('{ major: カフェ, text: カフェ } → カフェ（カフェ → 食費）', resolveSubCategory({ major: 'カフェ', text: 'カフェ', source: 'text' }) === 'カフェ');

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
check('LINE「娯楽費 3000」（説明はカテゴリ名）→ null', line('娯楽費 3000', '娯楽費') === null);
check('説明がカテゴリ名だけ（交際費 → 娯楽）', resolveSubCategory({ major: '交際費', text: '交際費', source: 'text' }) === null);
check('説明が「支出」だけ', food('支出') === null && fun('支出') === null);
const CATEGORY_NAMES = [...CANONICAL_CATEGORIES, '娯楽費', '交際費', '医療費', '趣味', '貯蓄', '支出'];
const canonicalHits = [];
for (const major of Object.keys(SUB_CATEGORIES)) {
  for (const name of CATEGORY_NAMES) {
    const r = resolveSubCategory({ major, text: name, source: 'merchant', usedAt: jst('12:30') });
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
check(
  '辞書は書き換えられない（freeze）',
  Object.isFrozen(SUB_CATEGORY_RULES) &&
    ruleMajors.every(
      (m) =>
        Object.isFrozen(SUB_CATEGORY_RULES[m]) &&
        SUB_CATEGORY_RULES[m].every((g) => Object.isFrozen(g) && Object.isFrozen(g.keywords) && (g.exact === undefined || Object.isFrozen(g.exact)))
    )
);
const FORBIDDEN = ['マック', 'バー', 'スパ'].map(normalizeForMatch);
const exactOf = (g) => g.exact ?? [];
for (const [major, groups] of Object.entries(SUB_CATEGORY_RULES)) {
  const list = SUB_CATEGORIES[major] || [];
  const subs = groups.map((g) => g.sub);
  const notInList = subs.filter((s) => !list.includes(s));
  check(`${major}: 返す中項目がすべて一覧にある`, notInList.length === 0, notInList.join(','));
  check(`${major}: 「その他の…」を返さない`, subs.every((s) => !s.startsWith('その他')), subs.join(','));
  const mealGroups = groups.filter((g) => g.mealTime !== undefined);
  check(`${major}: mealTime は true だけで、外食のグループだけ`, mealGroups.every((g) => g.mealTime === true && g.sub === '外食'));
  const keywords = groups.flatMap((g) => g.keywords);
  const exacts = groups.flatMap(exactOf);
  const all = [...keywords, ...exacts];
  const notNormalized = all.filter((k) => typeof k !== 'string' || k === '' || normalizeForMatch(k) !== k);
  check(`${major}: 部分一致・完全一致の語が正規化済みで空でない`, notNormalized.length === 0, notNormalized.join(','));
  const tooShort = keywords.filter((k) => Array.from(k).length < 2);
  check(`${major}: 部分一致の語は 2 文字以上`, tooShort.length === 0, tooShort.join(','));
  const shortAscii = keywords.filter((k) => /^[a-z0-9]+$/.test(k) && k.length < 4);
  check(`${major}: 部分一致の英数字だけの語は 4 文字以上`, shortAscii.length === 0, shortAscii.join(','));
  const forbidden = keywords.filter((k) => FORBIDDEN.includes(k));
  check(`${major}: 部分一致に「マック」「バー」「スパ」を持たない`, forbidden.length === 0, forbidden.join(','));
  const dup = all.filter((k, i) => all.indexOf(k) !== i);
  check(`${major}: 語が重ならない（部分一致・完全一致を合わせて、揃えた後で同じ語が無い）`, dup.length === 0, dup.join(','));
  // 前のグループの部分一致の語を含む語は、前のグループに先に当たるので、決して使われない（例: 前に「ライブ」があると「ドライブ」は死ぬ）。
  // 完全一致の語は、同じグループの部分一致の語を含んでも意味が無い（部分一致で先に当たる）
  const dead = [];
  groups.forEach((g, i) => {
    const earlier = groups.slice(0, i).flatMap((e) => e.keywords);
    for (const k of g.keywords) {
      const hit = earlier.find((e) => k.includes(e));
      if (hit) dead.push(`${g.sub}:${k}（${hit}）`);
    }
    for (const k of exactOf(g)) {
      const hit = [...earlier, ...g.keywords].find((e) => k.includes(e));
      if (hit) dead.push(`${g.sub}:${k}［完全一致］（${hit}）`);
    }
  });
  check(`${major}: 前のグループの語に隠れて使われない語が無い（完全一致を含む）`, dead.length === 0, dead.join(','));
  // 各グループの各語が、単独の入力でそのグループの中項目になる（text なので時刻のルールは当たらない）
  const unreachable = [];
  for (const g of groups) {
    for (const k of [...g.keywords, ...exactOf(g)]) {
      const r = resolveSubCategory({ major, text: k, source: 'text' });
      if (r !== g.sub) unreachable.push(`${k}→${r}`);
    }
  }
  check(`${major}: 各語は単独でそのグループの中項目になる（完全一致を含む）`, unreachable.length === 0, unreachable.join(','));
}
// 説明がカテゴリ名だけのときの判定（正準名・「支出」との比較）に頼らなくても、カテゴリ名はどの語にも当たらない
const nameHits = [];
for (const [major, groups] of Object.entries(SUB_CATEGORY_RULES)) {
  for (const name of CATEGORY_NAMES) {
    const n = normalizeForMatch(name);
    const g = groups.find((x) => exactOf(x).includes(n) || x.keywords.some((k) => n.includes(k)));
    if (g) nameHits.push(`${major}/${name}→${g.sub}`);
  }
}
check('カテゴリ名・「支出」は、辞書のどの語にも当たらない', nameHits.length === 0, nameHits.join(','));

if (failed > 0) {
  console.log(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nすべて ok');
