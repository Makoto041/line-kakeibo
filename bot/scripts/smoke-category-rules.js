/**
 * 世帯のカテゴリのルール（categoryRules.ts と、classifyExpense への組み込み）のスモークテスト
 *
 * 純関数（入力の検査・整形・照合・版）と、classifyExpense が確定ルールを最優先にし、例を Jev・Gemini に渡すことを確かめる。
 * Jev・Gemini・Firestore は偽物に差し替える（本物の API は呼ばない）。
 *   node bot/scripts/smoke-category-rules.js
 */
const path = require('path');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- Jev・Gemini・Firestore の偽物 ---
const sdkPath = require.resolve('@typesafe-ai/sdk', { paths: [path.join(__dirname, '..')] });
const realSdk = require(sdkPath);
let jevCalls = [];
let jevCategory = '娯楽';
class FakeTypeSafeClient {
  async systemOne(request) {
    jevCalls.push(request);
    return {
      model: 'jev-1.13.0',
      answers: { category: { type: 'choice', choice: jevCategory, confidence: 0.9, probabilities: { [jevCategory]: 0.9 } } },
      usage: { input_tokens: 1, output_tokens: 0 },
    };
  }
}
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: { ...realSdk, TypeSafeClient: FakeTypeSafeClient } };

const geminiClient = require('../dist/geminiClient');
let geminiCalls = [];
geminiClient.generateJson = async (prompt) => {
  geminiCalls.push(prompt);
  return null;
};
require('../dist/firestore').getAllUserCategories = async () => [];

const rulesModule = require('../dist/categoryRules');
let stored = null; // groupId → CategoryRules
let ruleReads = 0;
let ruleReadFails = false;
rulesModule.loadCategoryRules = async (groupId) => {
  ruleReads++;
  if (ruleReadFails) return null;
  return stored?.[groupId] ?? rulesModule.EMPTY_CATEGORY_RULES;
};

const {
  parseCategoryRulesInput,
  readStoredCategoryRules,
  matchCategoryRule,
  sanitizeRuleText,
  normalizeForRuleMatch,
  categoryRulesVersion,
  describeWithExamples,
  CATEGORY_RULES_LIMITS,
} = rulesModule;
const { classifyExpense, buildClassificationPrompt } = require('../dist/geminiCategoryClassifier');
const { jevCriteria } = require('../dist/jevCategoryClassifier');
const { CATEGORY_ORIGIN_LABELS } = require('../dist/line/flexMessage');

async function main() {
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.GEMINI_API_KEY = 'test-key';
  const quiet = async (fn) => {
    const original = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = () => {};
    try {
      return await fn();
    } finally {
      Object.assign(console, original);
    }
  };

  console.log('\n# 文の整形');
  check('改行・制御文字・連続する空白を 1 つの空白にする', sanitizeRuleText('  ド\nン\tキ\u0007  ホーテ ', 30) === 'ド ン キ ホーテ', sanitizeRuleText('  ド\nン\tキ\u0007  ホーテ ', 30));
  check('行区切り（U+2028）も空白にする', sanitizeRuleText('a b', 30) === 'a b');
  check('max 文字までに切る（サロゲートペアを割らない）', sanitizeRuleText('😀😀😀😀', 3) === '😀😀😀');
  check('文字列でなければ空', sanitizeRuleText(5, 10) === '' && sanitizeRuleText(null, 10) === '');
  check('照合用は全角・半角と大文字・小文字を区別しない', normalizeForRuleMatch(' ＤＯＮＫＩ  ﾄﾞﾝｷ ') === 'donki ドンキ');

  console.log('\n# 保存の入力の検査');
  const ok = parseCategoryRulesInput({
    rules: [{ keyword: ' ドンキ ', category: '日用品' }, { keyword: 'ドンキ', category: '食費' }, { keyword: 'Switch', category: '娯楽' }],
    examples: { 医療・健康: [' ジムのプロテイン ', 'ジムのプロテイン', 'マッサージ'], 食費: [] },
  });
  check('整えて保存する形になる', ok && ok.rules.length === 2 && ok.rules[0].keyword === 'ドンキ' && ok.rules[1].keyword === 'Switch', JSON.stringify(ok));
  check('同じ言葉は先のものだけ残る', ok.rules[0].category === '日用品');
  check('例は重複を除き、空のカテゴリは持たない', JSON.stringify(ok.examples) === JSON.stringify({ '医療・健康': ['ジムのプロテイン', 'マッサージ'] }), JSON.stringify(ok.examples));
  const bad = (v) => parseCategoryRulesInput(v) === null;
  check('配列でない rules は断る', bad({ rules: {}, examples: {} }));
  check('examples が無いものは断る', bad({ rules: [] }));
  check('一覧にないカテゴリは断る', bad({ rules: [{ keyword: 'a', category: 'なぞ' }], examples: {} }) && bad({ rules: [], examples: { なぞ: ['a'] } }));
  check('空の言葉は断る', bad({ rules: [{ keyword: '  \n ', category: '食費' }], examples: {} }));
  check('長すぎる言葉は丸めずに断る', bad({ rules: [{ keyword: 'あ'.repeat(CATEGORY_RULES_LIMITS.maxKeywordLength + 1), category: '食費' }], examples: {} }));
  check('上限ちょうどは通る', !bad({ rules: [{ keyword: 'あ'.repeat(CATEGORY_RULES_LIMITS.maxKeywordLength), category: '食費' }], examples: {} }));
  check('ルールが上限を超えたら断る', bad({ rules: Array.from({ length: CATEGORY_RULES_LIMITS.maxRules + 1 }, (_, i) => ({ keyword: `k${i}`, category: '食費' })), examples: {} }));
  check('例が上限を超えたら断る', bad({ rules: [], examples: { 食費: Array.from({ length: CATEGORY_RULES_LIMITS.maxExamplesPerCategory + 1 }, (_, i) => `e${i}`) } }));
  check('長すぎる例は断る', bad({ rules: [], examples: { 食費: ['あ'.repeat(CATEGORY_RULES_LIMITS.maxExampleLength + 1)] } }));
  check('オブジェクトでない入力は断る', bad(null) && bad('x') && bad([]));
  check('文字列でない言葉は断る', bad({ rules: [{ keyword: 1, category: '食費' }], examples: {} }));

  console.log('\n# 保存してある値の読み取り（崩れた分は捨て、読める分を使う）');
  const read = readStoredCategoryRules({
    rules: [{ keyword: 'ドンキ', category: '日用品' }, { keyword: '', category: '食費' }, { keyword: 'x', category: 'なぞ' }, 5],
    examples: { 食費: ['a', '', 7], なぞ: ['b'], 娯楽: 'x' },
    updatedBy: 'U1',
  });
  check('壊れたルールは捨てる', read.rules.length === 1 && read.rules[0].keyword === 'ドンキ', JSON.stringify(read));
  check('壊れた例は捨てる', JSON.stringify(read.examples) === JSON.stringify({ 食費: ['a'] }), JSON.stringify(read.examples));
  check('値が無ければ空', readStoredCategoryRules(undefined).rules.length === 0 && readStoredCategoryRules(null).rules.length === 0);

  console.log('\n# 照合');
  const rules = [{ keyword: 'ドンキ', category: '日用品' }, { keyword: 'switch', category: '娯楽' }];
  check('言葉を含めば当たる', matchCategoryRule(rules, 'ドンキで洗剤') === '日用品');
  check('大文字・小文字と全角・半角を区別しない', matchCategoryRule(rules, 'Ｎｉｎｔｅｎｄｏ SWITCH 本体') === '娯楽' && matchCategoryRule([{ keyword: 'ﾄﾞﾝｷ', category: '日用品' }], 'ドンキ') === '日用品');
  check('上から順に当てる', matchCategoryRule([{ keyword: 'a', category: '食費' }, { keyword: 'ab', category: '娯楽' }], 'ab') === '食費');
  check('当たらなければ null・空の入力も null', matchCategoryRule(rules, 'ランチ') === null && matchCategoryRule(rules, '  ') === null);

  console.log('\n# 版と説明');
  const a = { rules: [{ keyword: 'a', category: '食費' }], examples: { 食費: ['x'] } };
  check('同じ内容なら同じ版', categoryRulesVersion(a) === categoryRulesVersion(JSON.parse(JSON.stringify(a))));
  check('ルールが変われば版が変わる', categoryRulesVersion(a) !== categoryRulesVersion({ ...a, rules: [{ keyword: 'b', category: '食費' }] }));
  check('例が変われば版が変わる', categoryRulesVersion(a) !== categoryRulesVersion({ ...a, examples: { 食費: ['y'] } }));
  check('例が無ければ説明のまま', describeWithExamples('基本', undefined) === '基本' && describeWithExamples(null, []) === null);
  check('例は説明の後ろに足す', describeWithExamples('基本', ['ジム']) === '基本。この家計では次もこのカテゴリ: 「ジム」', describeWithExamples('基本', ['ジム']));
  check('説明が無くても例だけ入る', describeWithExamples(null, ['ジム']) === 'この家計では次もこのカテゴリ: 「ジム」');
  check('判定元の表示名にルールがある', CATEGORY_ORIGIN_LABELS.rule === 'ルール');

  console.log('\n# 選択肢・プロンプトに例が入る');
  const crit = jevCriteria(['食費', '医療・健康'], { '医療・健康': ['ジムのプロテイン'] });
  check('Jev の選択肢の説明に例が入る', /ジムのプロテイン/.test(crit['医療・健康'] || '') && !/この家計/.test(crit['食費'] || ''), JSON.stringify(crit));
  check('例なしは従来どおり', JSON.stringify(jevCriteria(['食費'])) === JSON.stringify(jevCriteria(['食費'], undefined)));
  const prompt = buildClassificationPrompt('プロテイン', ['食費', '医療・健康'], 'text', { '医療・健康': ['ジムのプロテイン'] });
  check('Gemini のプロンプトに例が入る', /- 医療・健康: .*この家計では次もこのカテゴリ: 「ジムのプロテイン」/.test(prompt));
  check('例なしのプロンプトは従来どおり', buildClassificationPrompt('x', ['食費'], 'text') === buildClassificationPrompt('x', ['食費'], 'text', {}));

  console.log('\n# classifyExpense: 確定ルールが最優先');
  stored = { G1: { rules: [{ keyword: 'ドンキ', category: '日用品' }, { keyword: 'マッサージ', category: '医療・健康' }], examples: { 美容: ['まつ毛パーマ'] } } };
  jevCalls = [];
  geminiCalls = [];
  let r = await quiet(() => classifyExpense('U1', 'ドンキで買い物', { groupId: 'G1' }));
  check('ルールのカテゴリ・確信度 1・判定元 rule', r.category === '日用品' && r.confidence === 1 && r.provider === 'rule', JSON.stringify(r));
  check('Jev も Gemini も呼ばない', jevCalls.length === 0 && geminiCalls.length === 0);
  r = await quiet(() => classifyExpense('gmail', 'ドンキホーテ 渋谷', { source: 'merchant', groupId: 'G1' }));
  check('カード利用の店名にも効く（モデルより先）', r.category === '日用品' && r.provider === 'rule' && jevCalls.length === 0, JSON.stringify(r));
  r = await quiet(() => classifyExpense('U1', 'ランチ', { groupId: 'G1', allowModels: false }));
  check('モデルを使えない送信者でもルールは効く（辞書の結果は従来どおり）', r.category === '食費' && r.provider === 'dictionary', JSON.stringify(r));
  r = await quiet(() => classifyExpense('U1', 'マッサージ ランチ', { groupId: 'G1', allowModels: false }));
  check('ルールは辞書より先', r.category === '医療・健康' && r.provider === 'rule', JSON.stringify(r));

  console.log('\n# 当たらなければ例を Jev に渡す');
  jevCalls = [];
  jevCategory = '美容';
  r = await quiet(() => classifyExpense('U1', 'ほにゃららの施術', { groupId: 'G1' }));
  check('Jev の結果を使う', r.category === '美容' && r.provider === 'jev', JSON.stringify(r));
  const sent = jevCalls[0]?.questions?.category?.criteria || {};
  check('美容の説明に利用者の例が入る', /まつ毛パーマ/.test(sent['美容'] || ''), JSON.stringify(sent['美容']));

  console.log('\n# groupId が無ければルールを読まない');
  ruleReads = 0;
  jevCalls = [];
  r = await quiet(() => classifyExpense('U2', 'ドンキで買い物'));
  check('Firestore（ルール）を読まない', ruleReads === 0);
  check('例も渡さない', !/この家計/.test(JSON.stringify(jevCalls[0]?.questions?.category?.criteria || {})));

  console.log('\n# ルールを変えたら古い結果を使わない（キャッシュのキーに版）');
  stored = { G2: { rules: [], examples: {} } };
  jevCalls = [];
  jevCategory = '娯楽';
  r = await quiet(() => classifyExpense('U3', 'ボルダリング', { groupId: 'G2' }));
  check('1 回目は Jev', r.category === '娯楽' && jevCalls.length === 1);
  await quiet(() => classifyExpense('U3', 'ボルダリング', { groupId: 'G2' }));
  check('同じルールならキャッシュから', jevCalls.length === 1);
  stored = { G2: { rules: [{ keyword: 'ボルダ', category: '医療・健康' }], examples: {} } };
  r = await quiet(() => classifyExpense('U3', 'ボルダリング', { groupId: 'G2' }));
  check('ルールを足したらすぐ効く', r.category === '医療・健康' && r.provider === 'rule', JSON.stringify(r));
  stored = { G2: { rules: [], examples: { 娯楽: ['壁登り'] } } };
  r = await quiet(() => classifyExpense('U3', 'ボルダリング', { groupId: 'G2' }));
  check('例を変えたら Jev に聞き直す', jevCalls.length === 2, String(jevCalls.length));

  console.log('\n# ルールが読めないときはルール無しで続ける');
  ruleReadFails = true;
  jevCalls = [];
  jevCategory = '娯楽';
  r = await quiet(() => classifyExpense('U4', 'ぴよぴよの遊び', { groupId: 'G3' }));
  check('分類は続く', r.category === '娯楽' && r.provider === 'jev', JSON.stringify(r));
  ruleReadFails = false;

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
