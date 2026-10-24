/**
 * Jev によるカテゴリ分類（jevCategoryClassifier と、geminiCategoryClassifier の Jev → Gemini）のスモークテスト
 *
 * @typesafe-ai/sdk の TypeSafeClient を偽物に差し替え、Gemini と Firestore も差し替えて、本物の API を呼ばずに次を検証する。
 * - Jev が成功したら Gemini は呼ばない（辞書が先の text では、辞書で決まれば Jev も呼ばない）
 * - Jev が例外・タイムアウト・鍵なし・一覧に無いカテゴリ・答えが無いなら Gemini の結果を使う
 * - 選択肢は利用者のカテゴリ一覧から作り、説明の無いカスタムカテゴリは null で入る
 * - Jev・Gemini の失敗はキャッシュしない
 * - ログに入力・店名を出さない
 *   node bot/scripts/smoke-jev-classifier.js
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

// --- @typesafe-ai/sdk の偽物（choice やエラーの型は本物を使い、TypeSafeClient だけ差し替える） ---
const sdkPath = require.resolve('@typesafe-ai/sdk', { paths: [path.join(__dirname, '..')] });
const realSdk = require(sdkPath);
const clientConfigs = [];
let jevCalls = [];
let jevBehavior = () => {
  throw new Error('jevBehavior is not set');
};
class FakeTypeSafeClient {
  constructor(config) {
    clientConfigs.push(config);
  }
  async systemOne(request) {
    jevCalls.push(request);
    return jevBehavior(request);
  }
}
require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  loaded: true,
  exports: { ...realSdk, TypeSafeClient: FakeTypeSafeClient },
};
const jevAnswer = (category, confidence = 0.9) => () => ({
  model: 'jev-1.13.0',
  answers: { category: { type: 'choice', choice: category, confidence, probabilities: { [category]: confidence } } },
  usage: { input_tokens: 100, output_tokens: 0 },
});

// --- Gemini と Firestore の偽物（classifier は呼び出し時に exports を参照する） ---
const geminiClient = require('../dist/geminiClient');
const firestore = require('../dist/firestore');
let geminiCalls = [];
let geminiReply = null;
geminiClient.generateJson = async (prompt, options) => {
  geminiCalls.push({ prompt, options });
  return geminiReply;
};
// lineId ごとのカテゴリ一覧（無ければ空 = 既定の 19 カテゴリ）
const categoriesByUser = {
  U_custom: [{ name: '食費' }, { name: '推し活' }, { name: 'その他' }],
};
firestore.getAllUserCategories = async (lineId) => categoriesByUser[lineId] ?? [];

const { classifyExpenseWithGemini } = require('../dist/geminiCategoryClassifier');
const { JEV_MODEL } = require('../dist/jevCategoryClassifier');
const { CATEGORY_GUIDE } = require('../dist/categoryGuide');

// 分類中のログを集める（画面には出さない）。logs はケースごとに消し、allLogs は最後の確認に使う
const logs = [];
const allLogs = [];
const inputs = [];
async function classify(lineId, description, options) {
  inputs.push(description);
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      logs.push({ level, args });
      allLogs.push({ level, args });
    };
  }
  try {
    return await classifyExpenseWithGemini(lineId, description, options);
  } finally {
    Object.assign(console, original);
  }
}
const lastProviderLog = () => logs.filter((l) => l.args[0] === 'Category classified').pop()?.args[1];
function reset() {
  jevCalls = [];
  geminiCalls = [];
  logs.length = 0;
}

async function main() {
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.GEMINI_API_KEY = 'test-key';

  console.log('\n# クライアントは最初の呼び出しで作る');
  check('読み込んだだけでは作らない', clientConfigs.length === 0);

  console.log('\n# (a) Jev が成功したら Gemini は呼ばない（text）');
  reset();
  jevBehavior = jevAnswer('娯楽', 0.92);
  geminiReply = { category: '食費', confidence: 0.9 };
  let r = await classify('U_text', 'ボルダリング');
  check('Jev の結果を採用', r.category === '娯楽' && r.reasoning === 'Jev classification', JSON.stringify(r));
  check('信頼度はそのまま', r.confidence === 0.92, JSON.stringify(r));
  check('Jev を 1 回呼ぶ', jevCalls.length === 1);
  check('Gemini は呼ばれない', geminiCalls.length === 0);
  check('モデル固定・3 秒で打ち切り・再試行なし', clientConfigs.length === 1 && clientConfigs[0].defaultModel === JEV_MODEL && JEV_MODEL === 'jev-1.13.0' && clientConfigs[0].timeout === 3000 && clientConfigs[0].retry?.maxRetries === 0, JSON.stringify(clientConfigs));
  check('ログは warn・接続先は既定に固定（環境変数で変わらない）', clientConfigs[0].logLevel === 'warn' && clientConfigs[0].baseURL === 'https://api.typesafe.ai', JSON.stringify(clientConfigs[0]));
  const req = jevCalls[0];
  check('入力は state.input', req?.state?.input === 'ボルダリング');
  check('category の choice で聞く', req?.questions?.category?.type === 'choice');
  check('text 用の質問文', /家計簿アプリに利用者が入力した/.test(req?.questions?.category?.instructions || ''));
  const criteria = req?.questions?.category?.criteria || {};
  check('既定の 19 カテゴリが選択肢', Object.keys(criteria).length === 19, Object.keys(criteria).join(','));
  check('食費は v3 の説明', /飲み会/.test(criteria['食費'] || ''));
  check('娯楽は v3 の説明', /宿泊を伴う旅行は含めない/.test(criteria['娯楽'] || ''));
  check('その他は CATEGORY_GUIDE のまま', criteria['その他'] === CATEGORY_GUIDE['その他']);
  check('提供元のログ（jev）', lastProviderLog()?.provider === 'jev' && lastProviderLog()?.source === 'text' && typeof lastProviderLog()?.ms === 'number', JSON.stringify(lastProviderLog()));

  console.log('\n# 成功した結果はキャッシュする');
  reset();
  r = await classify('U_text', 'ボルダリング');
  check('同じ入力は API を呼ばない', r.category === '娯楽' && jevCalls.length === 0 && geminiCalls.length === 0);

  console.log('\n# text: 辞書で決まれば Jev も呼ばない');
  reset();
  r = await classify('U_text', 'ランチ');
  check('ランチ → 食費（辞書）', r.category === '食費' && r.reasoning === 'Fast local keyword matching', JSON.stringify(r));
  check('Jev は呼ばれない', jevCalls.length === 0);

  console.log('\n# (a) merchant: 辞書より Jev を優先');
  reset();
  jevBehavior = jevAnswer('交通費', 0.88);
  // "AUTOBACS" は辞書の "au"（通信費）に誤って一致する例
  r = await classify('gmail-auto-system', 'AUTOBACS ｵｰﾄﾊﾞｯｸｽ', { source: 'merchant' });
  check('辞書の誤一致ではなく Jev の結果', r.category === '交通費', JSON.stringify(r));
  check('Gemini は呼ばれない', geminiCalls.length === 0);
  check('店名用の質問文', /利用明細/.test(jevCalls[0]?.questions?.category?.instructions || ''));

  console.log('\n# 信頼度は 0〜1 に丸める');
  reset();
  jevBehavior = jevAnswer('衣服', 1.4);
  r = await classify('U_text', 'ワークマンの作業着');
  check('1 を超えたら 1', r.confidence === 1, JSON.stringify(r));
  reset();
  jevBehavior = jevAnswer('衣服', -0.2);
  r = await classify('U_text', '作業用手袋');
  check('0 未満なら 0', r.confidence === 0, JSON.stringify(r));

  console.log('\n# 信頼度が低くても Gemini に回さない');
  reset();
  jevBehavior = jevAnswer('娯楽', 0.1);
  geminiReply = { category: '食費', confidence: 0.9 };
  r = await classify('U_text', 'ペタンク');
  check('Jev の結果をそのまま返す', r.category === '娯楽' && r.confidence === 0.1 && r.reasoning === 'Jev classification', JSON.stringify(r));
  check('Gemini は呼ばれない', geminiCalls.length === 0);

  console.log('\n# 長い入力は先頭 100 文字だけをモデルに送る');
  reset();
  // サロゲートペアの文字で、文字単位（UTF-16 の単位ではなく）で切ることも見る
  const long = '🧗'.repeat(150);
  jevBehavior = () => {
    throw new Error('boom');
  };
  geminiReply = { category: '娯楽', confidence: 0.8 };
  r = await classify('U_text', long);
  check('Jev には 100 文字', jevCalls[0]?.state?.input === '🧗'.repeat(100), `${Array.from(jevCalls[0]?.state?.input || '').length} 文字`);
  const prompt = geminiCalls[0]?.prompt || '';
  check('Gemini にも 100 文字', prompt.includes(JSON.stringify('🧗'.repeat(100))) && !prompt.includes('🧗'.repeat(101)));
  check('結果は採用する', r.category === '娯楽', JSON.stringify(r));

  console.log('\n# (b) Jev がタイムアウト → Gemini');
  reset();
  jevBehavior = () => {
    throw new realSdk.APITimeoutError(3000);
  };
  geminiReply = { category: '娯楽', confidence: 0.8 };
  r = await classify('U_text', 'スカッシュ');
  check('Gemini の結果を採用', r.category === '娯楽' && r.reasoning === 'Gemini classification', JSON.stringify(r));
  check('Jev 1 回 → Gemini 1 回', jevCalls.length === 1 && geminiCalls.length === 1);
  check('Gemini にも同じカテゴリ一覧', Array.isArray(geminiCalls[0]?.options?.schema?.properties?.category?.enum) && geminiCalls[0].options.schema.properties.category.enum.length === 19);
  const timeoutLog = logs.find((l) => l.args[0] === 'Jev classification failed');
  check('失敗はエラーの種類だけをログに出す', timeoutLog?.args[1]?.error === 'APITimeoutError' && Object.keys(timeoutLog.args[1]).sort().join(',') === 'error,status', JSON.stringify(timeoutLog?.args));
  check('提供元のログ（gemini）', lastProviderLog()?.provider === 'gemini', JSON.stringify(lastProviderLog()));

  console.log('\n# (b) Jev が API エラー（429）→ Gemini');
  reset();
  jevBehavior = () => {
    throw realSdk.APIError.fromResponse(429, { error: 'rate limited' }, new Headers());
  };
  geminiReply = { category: '交通費', confidence: 0.9 };
  r = await classify('gmail-auto-system', 'ENEOS ｴﾈｵｽ', { source: 'merchant' });
  check('Gemini の結果を採用', r.category === '交通費' && r.reasoning === 'Gemini classification', JSON.stringify(r));
  const rateLog = logs.find((l) => l.args[0] === 'Jev classification failed');
  check('HTTP ステータスをログに出す', rateLog?.args[1]?.status === 429 && rateLog?.args[1]?.error === 'RateLimitError', JSON.stringify(rateLog?.args));

  console.log('\n# (c) TYPESAFE_API_KEY が無い → Gemini');
  reset();
  delete process.env.TYPESAFE_API_KEY;
  geminiReply = { category: '娯楽', confidence: 0.7 };
  r = await classify('U_text', 'ダーツバー');
  check('Gemini の結果を採用', r.category === '娯楽' && r.reasoning === 'Gemini classification', JSON.stringify(r));
  check('Jev は呼ばれない', jevCalls.length === 0);
  process.env.TYPESAFE_API_KEY = 'test-key';

  console.log('\n# (d) Jev が一覧に無いカテゴリ → Gemini');
  reset();
  jevBehavior = jevAnswer('謎カテゴリ', 0.99);
  geminiReply = { category: '日用品', confidence: 0.8 };
  r = await classify('U_text', '電球');
  check('Gemini の結果を採用', r.category === '日用品' && r.reasoning === 'Gemini classification', JSON.stringify(r));
  check('Jev 1 回 → Gemini 1 回', jevCalls.length === 1 && geminiCalls.length === 1);

  console.log('\n# (d) Jev の応答に category が無い → Gemini');
  reset();
  jevBehavior = () => ({ answers: {} });
  geminiReply = { category: '日用品', confidence: 0.8 };
  r = await classify('U_text', 'ペンキ');
  check('Gemini の結果を採用', r.category === '日用品' && r.reasoning === 'Gemini classification', JSON.stringify(r));
  check('Jev 1 回 → Gemini 1 回', jevCalls.length === 1 && geminiCalls.length === 1);
  check('答えが無いことを warn で出す', logs.some((l) => l.level === 'warn' && l.args[0] === 'Jev returned no category'), JSON.stringify(logs));

  console.log('\n# (e) カスタムカテゴリ: 選択肢は利用者の一覧、説明の無いものは null');
  reset();
  jevBehavior = jevAnswer('推し活', 0.9);
  r = await classify('U_custom', 'アクスタ');
  check('カスタムカテゴリも採用できる', r.category === '推し活', JSON.stringify(r));
  const custom = jevCalls[0]?.questions?.category?.criteria || {};
  check('選択肢は利用者の一覧だけ', Object.keys(custom).join(',') === '食費,推し活,その他', Object.keys(custom).join(','));
  check('説明の無いカスタムカテゴリは null', Object.prototype.hasOwnProperty.call(custom, '推し活') && custom['推し活'] === null);
  check('既定のカテゴリには説明が入る', /飲み会/.test(custom['食費'] || '') && custom['その他'] === CATEGORY_GUIDE['その他']);

  console.log('\n# (f) Jev・Gemini の失敗はキャッシュしない');
  reset();
  jevBehavior = () => {
    throw new Error('boom');
  };
  geminiReply = null;
  r = await classify('U_text', 'ネジ');
  check('どちらも失敗なら null', r.category === null, JSON.stringify(r));
  check('提供元のログは出さない', lastProviderLog() === undefined);
  reset();
  jevBehavior = jevAnswer('日用品', 0.8);
  r = await classify('U_text', 'ネジ');
  check('復旧後は Jev で判定し直す', r.category === '日用品' && jevCalls.length === 1, JSON.stringify(r));

  reset();
  jevBehavior = () => {
    throw new realSdk.APITimeoutError(3000);
  };
  geminiReply = null;
  r = await classify('gmail-auto-system', 'ﾛｰｿﾝ ローソン', { source: 'merchant' });
  check('merchant: どちらも失敗なら辞書（ローソン → 食費）', r.category === '食費' && r.reasoning === 'Fast local keyword matching', JSON.stringify(r));
  reset();
  jevBehavior = jevAnswer('日用品', 0.7);
  r = await classify('gmail-auto-system', 'ﾛｰｿﾝ ローソン', { source: 'merchant' });
  check('merchant: 復旧後は Jev で判定し直す', r.category === '日用品' && r.reasoning === 'Jev classification' && jevCalls.length === 1, JSON.stringify(r));

  console.log('\n# どちらも使えないとき');
  reset();
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  r = await classify('gmail-auto-system', 'ﾕﾆｸﾛ ユニクロ', { source: 'merchant' });
  check('辞書だけで判定（ユニクロ → 衣服）', r.category === '衣服', JSON.stringify(r));
  check('どちらも呼ばれない', jevCalls.length === 0 && geminiCalls.length === 0);

  console.log('\n# ログ');
  const logged = JSON.stringify(allLogs);
  const leaked = inputs.filter((text) => logged.includes(text));
  check('入力・店名をログに出さない', allLogs.length > 0 && leaked.length === 0, `${leaked.length} 件の入力がログに出た`);

  console.log(failed ? `\n${failed} failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
