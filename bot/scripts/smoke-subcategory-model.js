/**
 * 辞書で決まらない中項目を Jev で決める段（subCategoryClassifier.ts の subCategoryByModel と、
 * jevCategoryClassifier.ts の classifySubCategoryWithJev）のスモークテスト（#235）
 *
 * @typesafe-ai/sdk の TypeSafeClient を偽物に差し替え（smoke-jev-classifier.js と同じ方法）、Gemini も差し替えて、
 * 本物の API を呼ばずに次を確かめる。
 * - 呼ばない場面: 中項目の一覧の無い大項目（日用品・その他・カスタム名）・手がかりの無い説明（空・空白だけ・「支出」・
 *   textParser.ts の VALID_CATEGORIES の名前そのもの）・allowModels が true でない（キャッシュも読まない）・
 *   大項目の Jev が失敗した直後（jevFailedForMajor）・鍵なし。辞書で決まる入力で呼ばないことは smoke-expense-card.js で確かめる
 * - 呼ぶ場面: カテゴリの別名（「書籍」「エンタメ」「飲食」）の説明
 * - 要求の形: 質問は subCategory の 1 問だけ、選択肢は中項目の一覧と同じ並び（「その他の…」を含む）で説明つき、
 *   質問文に大項目名、入力は先頭 100 文字、クライアントは大項目と同じ 1 つ
 * - 答えの扱い: 確信度 0.4 以上の一覧の中項目は採用してキャッシュする。「その他の食費」・確信度 0.4 未満は中項目なしでキャッシュする。
 *   一覧外・答えなし・タイムアウト・429 は中項目なしでキャッシュしない。Gemini には回さない
 * - ログ: `Subcategory classified by model` は固定文 + 決まったキーのオブジェクト。入力・店名は出さない。
 *   失敗は大項目と別の文言（`Jev classification failed` を数える式を変えない）
 *   node bot/scripts/smoke-subcategory-model.js
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 手元のシェルに本物の鍵があっても使わない（各ケースで架空の値を入れ直す）
delete process.env.TYPESAFE_API_KEY;
delete process.env.GEMINI_API_KEY;

// --- @typesafe-ai/sdk の偽物（choice やエラーの型は本物を使い、TypeSafeClient だけ差し替える） ---
const sdkPath = require.resolve('@typesafe-ai/sdk', { paths: [path.join(__dirname, '..')] });
const realSdk = require(sdkPath);
const clientConfigs = [];
let jevCalls = [];
/** 質問の名前（category / subCategory）ごとの答え方 */
let majorBehavior = () => {
  throw new Error('majorBehavior is not set');
};
let subBehavior = () => {
  throw new Error('subBehavior is not set');
};
class FakeTypeSafeClient {
  constructor(config) {
    clientConfigs.push(config);
  }
  async systemOne(request) {
    jevCalls.push(request);
    return 'subCategory' in (request.questions || {}) ? subBehavior(request) : majorBehavior(request);
  }
}
require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  loaded: true,
  exports: { ...realSdk, TypeSafeClient: FakeTypeSafeClient },
};
const answerOf = (name, choice, confidence) => () => ({
  model: 'jev-1.13.0',
  answers: { [name]: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } },
  usage: { input_tokens: 100, output_tokens: 0 },
});
const subAnswer = (choice, confidence = 0.8) => answerOf('subCategory', choice, confidence);

// --- Gemini と Firestore の偽物（呼ばれないことを数える） ---
const geminiClient = require('../dist/geminiClient');
const firestore = require('../dist/firestore');
let geminiCalls = 0;
geminiClient.generateJson = async () => {
  geminiCalls++;
  return { category: '食費', confidence: 0.9 };
};
firestore.getAllUserCategories = async () => [];

// 時計（キャッシュの期限のケースで進める）
const MINUTE = 60 * 1000;
const realDateNow = Date.now;
let clockOffset = 0;
Date.now = () => realDateNow() + clockOffset;

const { subCategoryByModel, SUB_MIN_CONFIDENCE } = require('../dist/subCategoryClassifier');
const { JEV_MODEL, JEV_SUB_QUESTIONS, jevSubCriteria } = require('../dist/jevCategoryClassifier');
const { classifyExpense } = require('../dist/geminiCategoryClassifier');
const { SUB_CATEGORIES, SUB_CATEGORY_DESCRIPTIONS } = require('../dist/categoryTaxonomy');

// 処理中のログを集める（画面には出さない）。logs はケースごとに消し、allLogs は最後の確認に使う
const logs = [];
const allLogs = [];
const inputs = [];
async function quiet(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      logs.push({ level, args });
      allLogs.push({ level, args });
    };
  }
  try {
    return await fn();
  } finally {
    Object.assign(console, original);
  }
}
/** subCategoryByModel を呼ぶ（既定はメンバーの LINE の入力・大項目は Jev で決まった） */
async function sub(text, overrides = {}) {
  if (typeof text === 'string') inputs.push(text);
  return quiet(() =>
    subCategoryByModel({
      major: '食費',
      text,
      source: 'text',
      allowModels: true,
      jevFailedForMajor: false,
      majorOrigin: 'jev',
      majorConfidence: 0.9,
      ...overrides,
    })
  );
}
const MODEL_LOG = 'Subcategory classified by model';
const modelLogs = () => logs.filter((l) => l.args[0] === MODEL_LOG);
const lastModelLog = () => modelLogs().pop()?.args[1];
const LOG_KEYS = ['source', 'majorOrigin', 'majorConfidence', 'outcome', 'answer', 'confidence', 'cached', 'ms'];
function reset() {
  jevCalls = [];
  geminiCalls = 0;
  logs.length = 0;
}

async function main() {
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.GEMINI_API_KEY = 'test-key';
  subBehavior = subAnswer('外食', 0.8);
  majorBehavior = answerOf('category', '食費', 0.9);

  console.log('\n# 下限');
  check('SUB_MIN_CONFIDENCE は 0.4', SUB_MIN_CONFIDENCE === 0.4);

  console.log('\n# 呼ばない: 中項目の一覧の無い大項目（日用品・その他・カスタム名）。ログも出さない');
  for (const major of ['日用品', 'その他', '推し活', '']) {
    reset();
    const r = await sub('架空亭', { major });
    // ログは中項目の段のものだけを見る（Node の ExperimentalWarning などが console に出ることがあるため）
    check(
      `${major || '空の大項目'}: 中項目なし・Jev を呼ばない・ログなし`,
      r === undefined && jevCalls.length === 0 && modelLogs().length === 0 && !logs.some((l) => l.level === 'warn'),
      JSON.stringify(logs)
    );
  }

  console.log('\n# 呼ばない: 手がかりの無い説明（no_info。textParser.ts が説明に入れる決まった文字列）');
  for (const [label, desc, major] of [
    ['空', '', '食費'],
    ['空白だけ', ' 　 ', '食費'],
    ['「支出」（説明もカテゴリも無い入力）', '支出', '食費'],
    ['「食費」（「食費 500」の説明）', '食費', '食費'],
    ['「娯楽費」（「娯楽費 800」の説明）', '娯楽費', '娯楽'],
    ['「趣味」（「趣味 800」の説明）', '趣味', '娯楽'],
    ['前後に空白のある「食費」', ' 食費 ', '食費'],
  ]) {
    reset();
    const r = await sub(desc, { major });
    check(`${label}: 中項目なし・Jev を呼ばない`, r === undefined && jevCalls.length === 0, `${jevCalls.length} 回`);
    check(`${label}: outcome は no_info`, lastModelLog()?.outcome === 'no_info', JSON.stringify(lastModelLog()));
  }

  console.log('\n# 呼ぶ: カテゴリの別名・正準名の説明（「娯楽費 書籍 1500」「1500 エンタメ」「食費 飲食 800」など）');
  for (const [label, desc, major, answer] of [
    ['「書籍」（教育の別名）', '書籍', '娯楽', '本・漫画'],
    ['「エンタメ」（娯楽の別名）', 'エンタメ', '娯楽', '音楽・ライブ'],
    ['「飲食」（食費の別名）', '飲食', '食費', '外食'],
    ['「娯楽」（正準名。LINE の入力ではカテゴリの指定にならず、説明に残る）', '娯楽', '娯楽', 'その他の娯楽'],
  ]) {
    reset();
    subBehavior = subAnswer(answer, 0.8);
    const r = await sub(desc, { major });
    check(`${label}: Jev を 1 回呼ぶ`, jevCalls.length === 1 && jevCalls[0]?.state?.input === desc, `${jevCalls.length} 回`);
    check(`${label}: 答えの扱いは通常どおり`, r === (answer.startsWith('その他の') ? undefined : answer) && lastModelLog()?.outcome !== 'no_info', JSON.stringify(lastModelLog()));
  }
  subBehavior = subAnswer('外食', 0.8);

  console.log('\n# 呼ぶ: 大項目の別名は正準名にする（「外食」→ 食費）');
  reset();
  let r = await sub('架空亭 別名', { major: '外食' });
  const aliasReq = jevCalls[0];
  check('Jev を 1 回呼ぶ', jevCalls.length === 1, `${jevCalls.length} 回`);
  check('質問文の大項目は正準名（「食費」）', aliasReq?.questions?.subCategory?.instructions === JEV_SUB_QUESTIONS.text('食費'), aliasReq?.questions?.subCategory?.instructions);
  check('答え（外食 0.8）を採用', r === '外食', JSON.stringify(r));

  console.log('\n# 要求の形（LINE の入力）');
  reset();
  r = await sub('架空亭');
  const req = jevCalls[0];
  check('Jev を 1 回呼ぶ・Gemini は呼ばない', jevCalls.length === 1 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);
  check('質問は subCategory の 1 問だけ', same(Object.keys(req?.questions || {}), ['subCategory']), JSON.stringify(Object.keys(req?.questions || {})));
  check('choice で聞く', req?.questions?.subCategory?.type === 'choice');
  check('入力は state.input', same(req?.state, { input: '架空亭' }), JSON.stringify(req?.state));
  const instructions = req?.questions?.subCategory?.instructions || '';
  check('質問文は LINE の入力用で、大項目名を含む', instructions === JEV_SUB_QUESTIONS.text('食費') && instructions.includes('「食費」') && /家計簿アプリに利用者が入力した/.test(instructions), instructions);
  const criteria = req?.questions?.subCategory?.criteria || {};
  check('選択肢は中項目の一覧と同じ並び（「その他の食費」を含む）', same(Object.keys(criteria), [...SUB_CATEGORIES['食費']]) && 'その他の食費' in criteria, JSON.stringify(Object.keys(criteria)));
  check('選択肢に説明（SUB_CATEGORY_DESCRIPTIONS）が付く', SUB_CATEGORIES['食費'].every((s) => criteria[s] === SUB_CATEGORY_DESCRIPTIONS['食費'][s]), JSON.stringify(criteria));
  check('jevSubCriteria と同じ', same(criteria, jevSubCriteria('食費')));
  check('一覧の無い大項目の jevSubCriteria は空', same(jevSubCriteria('日用品'), {}) && same(jevSubCriteria('constructor'), {}));
  check('答え（外食 0.8）を採用', r === '外食', JSON.stringify(r));
  let log = lastModelLog();
  check('ログ: adopted・answer 外食・confidence 0.8・cached false', log?.outcome === 'adopted' && log.answer === '外食' && log.confidence === 0.8 && log.cached === false && log.source === 'text' && log.majorOrigin === 'jev' && log.majorConfidence === 0.9 && typeof log.ms === 'number', JSON.stringify(log));

  console.log('\n# 要求の形（カード利用通知の店名・娯楽）');
  reset();
  subBehavior = subAnswer('映画', 0.9);
  r = await sub('SAMPLE THEATER', { major: '娯楽', source: 'merchant', majorOrigin: 'jev', majorConfidence: 0.876 });
  const mreq = jevCalls[0];
  check('質問文は店名用で、大項目名を含む', mreq?.questions?.subCategory?.instructions === JEV_SUB_QUESTIONS.merchant('娯楽') && /利用明細/.test(mreq?.questions?.subCategory?.instructions || ''), mreq?.questions?.subCategory?.instructions);
  check('選択肢は娯楽の一覧', same(Object.keys(mreq?.questions?.subCategory?.criteria || {}), [...SUB_CATEGORIES['娯楽']]));
  check('答え（映画）を採用', r === '映画', JSON.stringify(r));
  check('大項目の確信度は小数 2 桁（0.876 → 0.88）', lastModelLog()?.majorConfidence === 0.88 && lastModelLog()?.source === 'merchant', JSON.stringify(lastModelLog()));

  console.log('\n# 入力は先頭 100 文字（文字単位）');
  reset();
  subBehavior = subAnswer('外食', 0.8);
  const long = '🍜'.repeat(150);
  r = await sub(long);
  check('Jev には 100 文字', jevCalls[0]?.state?.input === '🍜'.repeat(100), `${Array.from(jevCalls[0]?.state?.input || '').length} 文字`);

  console.log('\n# クライアントは大項目と同じ 1 つ（3 秒・再試行なし・モデル固定）');
  reset();
  majorBehavior = answerOf('category', '食費', 0.9);
  const major = await quiet(() => classifyExpense('U_sub_model', '架空亭 大項目'));
  check('大項目の分類も同じ偽物のクライアントで動く', major.category === '食費' && major.provider === 'jev', JSON.stringify(major));
  check('大項目の要求の質問は category の 1 問だけ', same(Object.keys(jevCalls[0]?.questions || {}), ['category']));
  check(
    'クライアントは 1 つだけ作る（モデル固定・3 秒・再試行なし）',
    clientConfigs.length === 1 && clientConfigs[0].defaultModel === JEV_MODEL && clientConfigs[0].timeout === 3000 && clientConfigs[0].retry?.maxRetries === 0,
    JSON.stringify(clientConfigs)
  );

  console.log('\n# 成功した答えはキャッシュする（15 分）');
  reset();
  r = await sub('架空亭');
  check('同じ入力は Jev を呼ばずに同じ答え', r === '外食' && jevCalls.length === 0, `${jevCalls.length} 回`);
  check('ログは cached: true', lastModelLog()?.cached === true && lastModelLog()?.outcome === 'adopted', JSON.stringify(lastModelLog()));
  reset();
  r = await sub(' 架空亭 ');
  check('前後の空白は同じキー', r === '外食' && jevCalls.length === 0);
  reset();
  r = await sub('架空亭', { source: 'merchant' });
  check('経路（merchant）が違えば聞き直す', jevCalls.length === 1);
  reset();
  r = await sub('架空亭', { major: '娯楽' });
  check('大項目が違えば聞き直す（答えの外食は娯楽の一覧外 → 中項目なし）', jevCalls.length === 1 && r === undefined && lastModelLog()?.outcome === 'failed', JSON.stringify(lastModelLog()));
  reset();
  clockOffset = 16 * MINUTE;
  r = await sub('架空亭');
  check('16 分後は聞き直す', jevCalls.length === 1 && r === '外食', `${jevCalls.length} 回`);
  clockOffset = 0;

  console.log('\n# 「その他の食費」は中項目なし（キャッシュする）');
  reset();
  subBehavior = subAnswer('その他の食費', 0.95);
  r = await sub('架空亭 その他');
  check('中項目なし', r === undefined, JSON.stringify(r));
  log = lastModelLog();
  check('outcome は other、answer は その他の食費', log?.outcome === 'other' && log.answer === 'その他の食費' && log.confidence === 0.95, JSON.stringify(log));
  reset();
  r = await sub('架空亭 その他');
  check('キャッシュする（聞き直さない）', r === undefined && jevCalls.length === 0 && lastModelLog()?.outcome === 'other' && lastModelLog()?.cached === true, JSON.stringify(lastModelLog()));

  console.log('\n# 確信度 0.4 未満は中項目なし（キャッシュする）・0.4 ちょうどは採用');
  reset();
  subBehavior = subAnswer('外食', 0.3);
  r = await sub('架空亭 低い');
  check('0.3 は中項目なし（low_confidence）', r === undefined && lastModelLog()?.outcome === 'low_confidence' && lastModelLog()?.answer === '外食' && lastModelLog()?.confidence === 0.3, JSON.stringify(lastModelLog()));
  reset();
  r = await sub('架空亭 低い');
  check('キャッシュする（聞き直さない）', r === undefined && jevCalls.length === 0 && lastModelLog()?.cached === true);
  reset();
  subBehavior = subAnswer('カフェ', 0.4);
  r = await sub('架空亭 境目');
  check('0.4 は採用', r === 'カフェ', JSON.stringify(r));
  reset();
  subBehavior = subAnswer('カフェ', 1.7);
  r = await sub('架空亭 丸め');
  check('確信度は 0〜1 に丸める（1.7 → 1）', r === 'カフェ' && lastModelLog()?.confidence === 1, JSON.stringify(lastModelLog()));
  reset();
  subBehavior = subAnswer('カフェ', 0.83333);
  r = await sub('架空亭 桁');
  check('確信度は小数 2 桁（0.83333 → 0.83）', lastModelLog()?.confidence === 0.83, JSON.stringify(lastModelLog()));

  console.log('\n# 失敗は中項目なしで、キャッシュしない・Gemini に回さない');
  const failures = [
    ['一覧外の答え', subAnswer('映画', 0.9), 'Jev suggested a subcategory outside the list'],
    ['答えなし', () => ({ answers: {} }), 'Jev returned no subcategory'],
    ['大項目の名前の答えだけ', answerOf('category', '外食', 0.9), 'Jev returned no subcategory'],
    [
      'タイムアウト',
      () => {
        throw new realSdk.APITimeoutError(3000);
      },
      'Jev subcategory classification failed',
    ],
    [
      'API エラー（429）',
      () => {
        throw realSdk.APIError.fromResponse(429, { error: 'rate limited' }, new Headers());
      },
      'Jev subcategory classification failed',
    ],
  ];
  let n = 0;
  for (const [label, behavior, warning] of failures) {
    n++;
    const desc = `架空亭 失敗${n}`;
    reset();
    subBehavior = behavior;
    r = await sub(desc);
    check(`${label}: 中項目なし（failed）`, r === undefined && lastModelLog()?.outcome === 'failed' && lastModelLog()?.answer === null && lastModelLog()?.confidence === null, JSON.stringify(lastModelLog()));
    const warn = logs.find((l) => l.level === 'warn' && l.args[0] === warning);
    check(`${label}: 警告「${warning}」`, warn !== undefined, JSON.stringify(logs));
    check(`${label}: 大項目の失敗の文言は出さない`, !logs.some((l) => ['Jev classification failed', 'Jev returned no category', 'Jev suggested a category outside the list'].includes(l.args[0])));
    check(`${label}: Gemini は呼ばない`, geminiCalls === 0);
    reset();
    subBehavior = subAnswer('外食', 0.8);
    r = await sub(desc);
    check(`${label}: キャッシュしない（次は聞き直して採用）`, jevCalls.length === 1 && r === '外食', `${jevCalls.length} 回 / ${r}`);
  }
  reset();
  subBehavior = () => {
    throw new realSdk.APITimeoutError(3000);
  };
  await sub('架空亭 時間切れ');
  const timeoutWarn = logs.find((l) => l.args[0] === 'Jev subcategory classification failed');
  check('失敗の警告はエラーの種類だけ（errorFields。状態の無いタイムアウトは errorName だけ）', same(timeoutWarn?.args[1], { errorName: 'APITimeoutError' }), JSON.stringify(timeoutWarn?.args));
  reset();
  subBehavior = () => {
    throw realSdk.APIError.fromResponse(429, { error: 'rate limited' }, new Headers());
  };
  await sub('架空亭 混雑');
  const rateWarn = logs.find((l) => l.args[0] === 'Jev subcategory classification failed');
  check('429 は errorStatus を出す', same(rateWarn?.args[1], { errorName: 'RateLimitError', errorStatus: 429 }), JSON.stringify(rateWarn?.args));
  reset();
  subBehavior = () => {
    throw Object.assign(new Error('架空亭 の応答本文'), { name: 'APIError', status: '架空亭' });
  };
  await sub('架空亭 状態が文字列');
  const oddWarn = logs.find((l) => l.args[0] === 'Jev subcategory classification failed');
  check('status が 100〜599 の整数でなければ出さない（文言も出さない）', same(oddWarn?.args[1], { errorName: 'APIError' }), JSON.stringify(oddWarn?.args));
  subBehavior = subAnswer('外食', 0.8);

  console.log('\n# 呼ばない: allowModels が true でない（世帯メンバーでない送信者）。キャッシュも読まない');
  // 「架空亭」は上で外食がキャッシュされている
  reset();
  r = await sub('架空亭', { allowModels: false });
  check('allowModels: false は中項目なし（キャッシュの外食を使わない）', r === undefined && jevCalls.length === 0, JSON.stringify(r));
  check('outcome は models_not_allowed・cached false', lastModelLog()?.outcome === 'models_not_allowed' && lastModelLog()?.cached === false && lastModelLog()?.answer === null, JSON.stringify(lastModelLog()));
  reset();
  r = await quiet(() => subCategoryByModel({ major: '食費', text: '架空亭', source: 'text' }));
  check('allowModels を省略したら呼ばない', r === undefined && jevCalls.length === 0 && lastModelLog()?.outcome === 'models_not_allowed', JSON.stringify(lastModelLog()));
  reset();
  r = await sub('架空亭 ゲスト', { allowModels: false });
  check('キャッシュに無い入力でも呼ばない', r === undefined && jevCalls.length === 0);

  console.log('\n# 呼ばない: 大項目の Jev が失敗した直後（jevFailedForMajor）');
  reset();
  r = await sub('架空亭 退避', { jevFailedForMajor: true, majorOrigin: 'gemini' });
  check('中項目なし・Jev も Gemini も呼ばない', r === undefined && jevCalls.length === 0 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);
  check('outcome は jev_unavailable', lastModelLog()?.outcome === 'jev_unavailable' && lastModelLog()?.majorOrigin === 'gemini', JSON.stringify(lastModelLog()));

  console.log('\n# 呼ばない: 鍵なし');
  reset();
  delete process.env.TYPESAFE_API_KEY;
  r = await sub('架空亭 鍵なし', { jevFailedForMajor: true, majorOrigin: 'default', majorConfidence: undefined });
  check('中項目なし・Jev を呼ばない', r === undefined && jevCalls.length === 0);
  check('outcome は not_configured（jevFailedForMajor より先に見る）', lastModelLog()?.outcome === 'not_configured' && lastModelLog()?.majorConfidence === null, JSON.stringify(lastModelLog()));
  process.env.TYPESAFE_API_KEY = 'test-key';

  console.log('\n# 時刻のルールは当てない（Jev が外食を返したら外食のまま）');
  reset();
  subBehavior = subAnswer('外食', 0.8);
  r = await sub('SAMPLE DINER', { source: 'merchant' });
  check('店名でも外食のまま', r === '外食', JSON.stringify(r));

  console.log('\n# ログ');
  const models = allLogs.filter((l) => l.args[0] === MODEL_LOG);
  check(
    `${MODEL_LOG} は固定文 + 決まったキーのオブジェクト`,
    models.length > 0 && models.every((l) => l.level === 'log' && l.args.length === 2 && same(Object.keys(l.args[1]), LOG_KEYS)),
    JSON.stringify(models.find((l) => !same(Object.keys(l.args[1] || {}), LOG_KEYS))?.args)
  );
  const outcomes = new Set(models.map((l) => l.args[1].outcome));
  check(
    'outcome を一通り出した',
    ['adopted', 'low_confidence', 'other', 'failed', 'no_info', 'models_not_allowed', 'jev_unavailable', 'not_configured'].every((o) => outcomes.has(o)),
    JSON.stringify([...outcomes])
  );
  const answers = models.map((l) => l.args[1].answer).filter((a) => a !== null);
  const allSubs = Object.values(SUB_CATEGORIES).flat();
  check('answer は一覧の中の名前か null', answers.every((a) => allSubs.includes(a)), JSON.stringify(answers));
  const logged = JSON.stringify(allLogs);
  const leaked = inputs.filter((t) => t.trim() !== '' && !['支出', '食費', '娯楽費', '娯楽'].includes(t.trim()) && logged.includes(t));
  check('ログに入力・店名を出さない', leaked.length === 0, JSON.stringify(leaked));
  check('ログに架空の店名の目印を出さない', !logged.includes('架空亭') && !logged.includes('SAMPLE'));

  console.log(failed ? `\n${failed} failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
