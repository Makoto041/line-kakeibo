/**
 * Gemini 共通クライアント（geminiClient.generateJson）のスモークテスト
 *
 * @google/genai を偽物に差し替えて、本物の API を呼ばずに次を検証する。
 * - Flash-Lite だけを使う。モデル一覧 API で一番新しい Flash-Lite をメインにする
 * - メインが終了・提供停止（404 など）なら予備の Flash-Lite に切り替える。以後しばらくは予備を直接使う
 * - 思考レベルを受け付けない 400 なら、思考の設定なしで同じモデルにもう一度送る
 * - スキーマ誤りなど関係のない 400 では予備に切り替えない
 * - API に締め切り（httpOptions.timeout）を送らない（再試行の設定は送る）。打ち切りは呼び出し側の AbortController が受け持つ
 * - 応答を JSON として解釈できないとき・HTTP ステータスの無い例外のときは、ログに応答の断片（SyntaxError の文言）を出さず、
 *   固定文とエラー名だけを出す
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

/** fn の間のログを集める（画面には出さない） */
async function captureLogs(fn) {
  const logs = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => logs.push({ level, args });
  }
  try {
    return { result: await fn(), logs };
  } finally {
    Object.assign(console, original);
  }
}
/** 集めたログを 1 つの文字列にする（Error は JSON にすると {} になるので、入れ子のものも名前と文言にする） */
function logText(logs) {
  return JSON.stringify(
    logs.map((l) => l.args),
    (_key, value) => (value instanceof Error ? `${value.name}: ${value.message}` : value)
  );
}
/** 応答の断片がログに出たかを見る目印 */
const CANARY = '秘密CANARY本文';

// --- @google/genai の偽物 ---
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
let calls = [];
let listCalls = 0;
let behavior = () => ({ text: '{"ok":true}' });
// モデル一覧 API の偽物（null なら失敗させる）
let listedModels = null;
const fakeGenai = {
  Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER' },
  ThinkingLevel: { MINIMAL: 'MINIMAL', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' },
  GoogleGenAI: class {
    constructor() {
      this.models = {
        list: async () => {
          listCalls++;
          if (listedModels === null) throw new ApiError(500, 'list failed');
          const items = listedModels.map((m) =>
            typeof m === 'string' ? { name: `models/${m}`, supportedActions: ['generateContent'] } : m
          );
          return { async *[Symbol.asyncIterator]() { yield* items; } };
        },
        generateContent: async (params) => {
          calls.push({
            model: params.model,
            thinking: params.config?.thinkingConfig?.thinkingLevel ?? null,
            httpOptions: params.config?.httpOptions ?? null,
          });
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
const opts = { timeoutMs: 3000 };

async function main() {
  console.log('\n# Flash-Lite の判定と並べ替え');
  check('3.5 Flash-Lite は安定版', client.isStableFlashLiteModel('gemini-3.5-flash-lite'));
  check('Flash は対象外', !client.isStableFlashLiteModel('gemini-3.6-flash'));
  check('preview / image / 版番号付きは対象外', ['gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite-image', 'gemini-3.5-flash-lite-001'].every((m) => !client.isStableFlashLiteModel(m)));
  check('3.10 は 3.9 より新しい', client.sortFlashLiteModels(['gemini-3.9-flash-lite', 'gemini-3.10-flash-lite'])[0] === 'gemini-3.10-flash-lite');
  check('新しい順に並べる', client.sortFlashLiteModels(['gemini-2.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-4-flash-lite', 'gemini-3.5-flash-lite']).join(',') === 'gemini-4-flash-lite,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash-lite');
  check('既定は gemini-3.5-flash-lite', client.geminiModel() === 'gemini-3.5-flash-lite');
  process.env.GEMINI_MODEL = 'gemini-3.6-flash';
  check('GEMINI_MODEL に Flash を指定しても無視する', client.geminiModel() === 'gemini-3.5-flash-lite');
  process.env.GEMINI_MODEL = 'gemini-3.1-flash-lite';
  check('GEMINI_MODEL の Flash-Lite は有効', client.geminiModel() === 'gemini-3.1-flash-lite');
  delete process.env.GEMINI_MODEL;

  console.log('\n# 上位の Flash-Lite が一覧にあればそれをメインにする（Flash は使わない）');
  client.resetGeminiModelState();
  listedModels = ['gemini-3.8-flash', 'gemini-3.6-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite-preview'];
  calls = [];
  behavior = () => ({ text: '{"ok":0}' });
  const r0 = await client.generateJson('p', opts);
  check('一番新しい Flash-Lite を呼ぶ', r0 && calls.length === 1 && calls[0].model === 'gemini-3.6-flash-lite', JSON.stringify(calls));
  listCalls = 0;
  await client.generateJson('p', opts);
  check('一覧はキャッシュする（2 回目は取らない）', listCalls === 0, `listCalls=${listCalls}`);
  client.resetGeminiModelState();
  listedModels = [{ name: 'models/gemini-3.7-flash-lite', supportedActions: ['embedContent'] }, 'gemini-3.5-flash-lite'];
  calls = [];
  await client.generateJson('p', opts);
  check('generateContent に使えないモデルは選ばない', calls[0].model === 'gemini-3.5-flash-lite', JSON.stringify(calls));
  process.env.GEMINI_MODEL = 'gemini-3.1-flash-lite';
  check('GEMINI_MODEL を固定すると先頭、次に一覧の最上位', client.orderCandidates(['gemini-3.6-flash-lite', 'gemini-3.5-flash-lite']).join(',') === 'gemini-3.1-flash-lite,gemini-3.6-flash-lite');
  delete process.env.GEMINI_MODEL;
  listedModels = ['gemini-3.8-flash', 'gemini-3.6-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite-preview'];
  check('候補は Flash-Lite だけ（メイン + 予備）', client.orderCandidates(client.sortFlashLiteModels(listedModels)).join(',') === 'gemini-3.6-flash-lite,gemini-3.5-flash-lite');

  // 以降は一覧 API が失敗する（既知の一覧で動く）前提
  listedModels = null;

  console.log('\n# 通常: 既定モデルだけを呼ぶ');
  client.resetGeminiModelState();
  calls = [];
  behavior = () => ({ text: '{"category":"食費"}' });
  let r = await client.generateJson('p', opts);
  check('結果を返す', r && r.category === '食費', JSON.stringify(r));
  check('一覧が取れないときは既知の gemini-3.5-flash-lite', calls.length === 1 && calls[0].model === 'gemini-3.5-flash-lite', JSON.stringify(calls));
  check('思考は MINIMAL', calls[0].thinking === 'MINIMAL');

  console.log('\n# API に締め切り（httpOptions.timeout）を送らない（10 秒未満だと API が 400 で拒否する）');
  for (const timeoutMs of [3000, 8000, 15000]) {
    calls = [];
    behavior = () => ({ text: '{"ok":4}' });
    await client.generateJson('p', { timeoutMs });
    const httpOptions = calls[0]?.httpOptions;
    check(`timeoutMs ${timeoutMs}: 1 回だけ呼ぶ`, calls.length === 1, JSON.stringify(calls));
    check(`timeoutMs ${timeoutMs}: httpOptions に timeout を含めない`, !!httpOptions && !('timeout' in httpOptions), JSON.stringify(httpOptions));
    check(`timeoutMs ${timeoutMs}: 再試行の設定は送る`, httpOptions?.retryOptions?.attempts === 2, JSON.stringify(httpOptions));
  }

  console.log('\n# 既定モデルが終了（404）→ 予備に切り替え、以後は予備を直接使う');
  client.resetGeminiModelState();
  calls = [];
  behavior = (p) => {
    if (p.model === 'gemini-3.5-flash-lite') throw new ApiError(404, 'models/gemini-3.5-flash-lite is not found for API version v1beta');
    return { text: '{"category":"交通費"}' };
  };
  r = await client.generateJson('p', opts);
  check('予備の結果を返す', r && r.category === '交通費', JSON.stringify(r));
  check('既定 → 予備の順に呼ぶ', calls.map((c) => c.model).join(',') === 'gemini-3.5-flash-lite,gemini-3.1-flash-lite', JSON.stringify(calls));
  calls = [];
  r = await client.generateJson('p', opts);
  check('2 回目は予備だけを呼ぶ', calls.length === 1 && calls[0].model === 'gemini-3.1-flash-lite', JSON.stringify(calls));

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

  console.log('\n# 地域制限・API キー誤りの 400 では予備に切り替えない');
  for (const msg of ['User location is not supported for the API use.', 'API key not valid. Please pass a valid API key.', 'response_schema: JSON mode is not supported with this field']) {
    client.resetGeminiModelState();
    calls = [];
    behavior = () => {
      throw new ApiError(400, msg);
    };
    r = await client.generateJson('p', opts);
    check(`「${msg.slice(0, 28)}…」→ 切り替えない`, r === null && calls.length === 1, JSON.stringify(calls));
  }

  console.log('\n# 予備も使えないとき');
  client.resetGeminiModelState();
  calls = [];
  behavior = (p) => {
    throw new ApiError(404, `models/${p.model} is not found for API version v1beta`);
  };
  r = await client.generateJson('p', opts);
  check('null を返す（メイン → 予備の 2 回）', r === null && calls.length === 2, JSON.stringify(calls));
  calls = [];
  r = await client.generateJson('p', opts);
  check('次はメインをとばして予備だけ', calls.length === 1 && calls[0].model === 'gemini-3.1-flash-lite', JSON.stringify(calls));

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
  process.env.GEMINI_MODEL = 'gemini-2.5-flash-lite';
  calls = [];
  behavior = () => ({ text: '{"ok":3}' });
  r = await client.generateJson('p', opts);
  check('思考の設定なし', calls[0].model === 'gemini-2.5-flash-lite' && calls[0].thinking === null, JSON.stringify(calls));
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
  const abortHttpOptions = calls[0]?.httpOptions;
  check('打ち切りは呼び出し側の AbortController が受け持つ（httpOptions に timeout なし）', !!abortHttpOptions && !('timeout' in abortHttpOptions) && elapsed < 1500, `${JSON.stringify(abortHttpOptions)} ${elapsed}ms`);

  console.log('\n# 応答を JSON として解釈できない → null。ログに応答の断片を出さない（固定文とエラー名だけ）');
  for (const text of [`${CANARY}です`, `\`\`\`json\n{"category": ${CANARY}}\n\`\`\``]) {
    const label = text.startsWith('```') ? 'コードブロックの中の壊れた JSON' : 'JSON でない文';
    let parseMessage = '';
    try {
      JSON.parse(client.stripCodeFence(text));
    } catch (e) {
      parseMessage = e.message;
    }
    check(`${label}: （前提）SyntaxError の文言に断片が入る`, parseMessage.includes('CANARY'), parseMessage);
    client.resetGeminiModelState();
    calls = [];
    behavior = () => ({ text });
    const { result, logs } = await captureLogs(() => client.generateJson('p', opts));
    const logged = logText(logs);
    check(`${label}: null を返す`, result === null, JSON.stringify(result));
    check(`${label}: 予備には回さない（1 回だけ呼ぶ）`, calls.length === 1, JSON.stringify(calls));
    check(`${label}: ログに応答の断片を出さない`, !logged.includes('CANARY') && !logged.includes('秘密'), logged);
    const notJson = logs.find((l) => l.args[0] === 'Gemini response is not valid JSON');
    check(
      `${label}: 固定文 + オブジェクト（エラー名）で error に出す`,
      notJson?.level === 'error' && notJson.args.length === 2 && notJson.args[1].errorName === 'SyntaxError' && !('error' in notJson.args[1]),
      logged
    );
  }

  console.log('\n# HTTP ステータスの無い例外（SDK が応答を解釈するときの SyntaxError など）→ null。文言は出さない');
  client.resetGeminiModelState();
  calls = [];
  behavior = () => JSON.parse(`${CANARY}です`);
  {
    const { result, logs } = await captureLogs(() => client.generateJson('p', opts));
    const logged = logText(logs);
    check('null を返す', result === null, JSON.stringify(result));
    check('予備には回さない（1 回だけ呼ぶ）', calls.length === 1, JSON.stringify(calls));
    check('ログに応答の断片を出さない', !logged.includes('CANARY') && !logged.includes('秘密'), logged);
    const failedLog = logs.find((l) => l.args[0] === 'Gemini request failed');
    check(
      '固定文 + オブジェクト（エラー名）で error に出す',
      failedLog?.level === 'error' && failedLog.args[1]?.errorName === 'SyntaxError' && !('error' in failedLog.args[1]),
      logged
    );
  }

  console.log('\n# API のエラー（HTTP ステータスあり）は、ステータスと API のエラー文を出す（従来どおり）');
  client.resetGeminiModelState();
  calls = [];
  behavior = () => {
    throw new ApiError(429, 'Resource has been exhausted');
  };
  {
    const { result, logs } = await captureLogs(() => client.generateJson('p', opts));
    const failedLog = logs.find((l) => l.args[0] === 'Gemini request failed');
    check('null を返す', result === null, JSON.stringify(result));
    check('ステータスと API のエラー文を出す', failedLog?.args[1]?.status === 429 && failedLog.args[1].error === 'Resource has been exhausted', logText(logs));
  }

  console.log(failed ? `\n${failed} failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
