/**
 * Gemini 共通クライアント（geminiClient.generateJson）のスモークテスト
 *
 * @google/genai を偽物に差し替えて、本物の API を呼ばずに次を検証する。
 * - 既定モデルが終了・提供停止（404 など）なら予備モデルに切り替える。以後は予備を直接使う
 * - 思考レベルを受け付けない 400 なら、思考の設定なしで同じモデルにもう一度送る
 * - スキーマ誤りなど関係のない 400 では予備に切り替えない
 *   node bot/scripts/smoke-gemini-client.js
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

// --- @google/genai の偽物 ---
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
let calls = [];
let behavior = () => ({ text: '{"ok":true}' });
const fakeGenai = {
  Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER' },
  ThinkingLevel: { MINIMAL: 'MINIMAL', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' },
  GoogleGenAI: class {
    constructor() {
      this.models = {
        generateContent: async (params) => {
          calls.push({ model: params.model, thinking: params.config?.thinkingConfig?.thinkingLevel ?? null });
          return behavior(params);
        },
      };
    }
  },
};
const genaiPath = require.resolve('@google/genai', { paths: [path.join(__dirname, '..')] });
require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: fakeGenai };

const client = require('../dist/geminiClient');
process.env.GEMINI_API_KEY = 'test-key';
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_FALLBACK_MODEL;
const opts = { timeoutMs: 3000 };

async function main() {
  console.log('\n# 既定と予備');
  check('既定は gemini-3.5-flash-lite', client.geminiModel() === 'gemini-3.5-flash-lite');
  check('予備は gemini-3.6-flash', client.geminiFallbackModel() === 'gemini-3.6-flash');
  process.env.GEMINI_FALLBACK_MODEL = 'none';
  check('GEMINI_FALLBACK_MODEL=none で予備なし', client.geminiFallbackModel() === null);
  process.env.GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
  check('予備が既定と同じなら予備なし', client.geminiFallbackModel() === null);
  delete process.env.GEMINI_FALLBACK_MODEL;

  console.log('\n# 通常: 既定モデルだけを呼ぶ');
  client.resetGeminiModelState();
  calls = [];
  behavior = () => ({ text: '{"category":"食費"}' });
  let r = await client.generateJson('p', opts);
  check('結果を返す', r && r.category === '食費', JSON.stringify(r));
  check('既定モデルを 1 回だけ呼ぶ', calls.length === 1 && calls[0].model === 'gemini-3.5-flash-lite', JSON.stringify(calls));
  check('思考は MINIMAL', calls[0].thinking === 'MINIMAL');

  console.log('\n# 既定モデルが終了（404）→ 予備に切り替え、以後は予備を直接使う');
  client.resetGeminiModelState();
  calls = [];
  behavior = (p) => {
    if (p.model === 'gemini-3.5-flash-lite') throw new ApiError(404, 'models/gemini-3.5-flash-lite is not found for API version v1beta');
    return { text: '{"category":"交通費"}' };
  };
  r = await client.generateJson('p', opts);
  check('予備の結果を返す', r && r.category === '交通費', JSON.stringify(r));
  check('既定 → 予備の順に呼ぶ', calls.map((c) => c.model).join(',') === 'gemini-3.5-flash-lite,gemini-3.6-flash', JSON.stringify(calls));
  calls = [];
  r = await client.generateJson('p', opts);
  check('2 回目は予備だけを呼ぶ', calls.length === 1 && calls[0].model === 'gemini-3.6-flash', JSON.stringify(calls));

  console.log('\n# 「廃止」「提供終了」の 400 / 403 も予備に切り替える');
  for (const [status, msg] of [
    [400, 'Model gemini-3.5-flash-lite has been deprecated'],
    [403, 'This model is no longer available to new users'],
  ]) {
    client.resetGeminiModelState();
    calls = [];
    behavior = (p) => {
      if (p.model === 'gemini-3.5-flash-lite') throw new ApiError(status, msg);
      return { text: '{"ok":1}' };
    };
    r = await client.generateJson('p', opts);
    check(`${status}「${msg.slice(0, 24)}…」→ 予備`, r && r.ok === 1 && calls.length === 2, JSON.stringify(calls));
  }

  console.log('\n# 関係のない 400（スキーマ誤りなど）では予備に切り替えない');
  client.resetGeminiModelState();
  calls = [];
  behavior = () => {
    throw new ApiError(400, 'Invalid JSON payload received. Unknown name "foo"');
  };
  r = await client.generateJson('p', opts);
  check('null を返す', r === null);
  check('既定モデルだけを呼ぶ', calls.length === 1, JSON.stringify(calls));

  console.log('\n# レート制限（429）でも予備に切り替えない（SDK の再試行に任せる）');
  client.resetGeminiModelState();
  calls = [];
  behavior = () => {
    throw new ApiError(429, 'Resource has been exhausted');
  };
  r = await client.generateJson('p', opts);
  check('null を返す', r === null);
  check('既定モデルだけを呼ぶ', calls.length === 1, JSON.stringify(calls));

  console.log('\n# 思考レベルを受け付けない 400 → 思考なしで同じモデルにもう一度');
  client.resetGeminiModelState();
  calls = [];
  behavior = (p) => {
    if (p.config?.thinkingConfig) throw new ApiError(400, 'thinking_level MINIMAL is not supported for this model');
    return { text: '{"ok":2}' };
  };
  r = await client.generateJson('p', opts);
  check('結果を返す', r && r.ok === 2, JSON.stringify(r));
  check('同じモデルを思考あり → なしで呼ぶ', calls.length === 2 && calls[0].model === calls[1].model && calls[0].thinking === 'MINIMAL' && calls[1].thinking === null, JSON.stringify(calls));

  console.log('\n# 2.5 系を指定したときは思考の設定を送らない');
  client.resetGeminiModelState();
  process.env.GEMINI_MODEL = 'gemini-2.5-flash';
  calls = [];
  behavior = () => ({ text: '{"ok":3}' });
  r = await client.generateJson('p', opts);
  check('思考の設定なし', calls[0].model === 'gemini-2.5-flash' && calls[0].thinking === null, JSON.stringify(calls));
  delete process.env.GEMINI_MODEL;

  console.log('\n# 打ち切り時間は予備への切り替えを含めた全体で守る');
  client.resetGeminiModelState();
  calls = [];
  behavior = (p) =>
    new Promise((resolve, reject) => {
      p.config.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const started = Date.now();
  r = await client.generateJson('p', { timeoutMs: 200 });
  const elapsed = Date.now() - started;
  check('null を返す', r === null);
  check('打ち切り時間で止まる', elapsed < 1500, `${elapsed}ms`);
  check('予備には進まない', calls.length === 1, JSON.stringify(calls));

  console.log(failed ? `\n${failed} failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
