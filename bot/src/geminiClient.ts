import type * as GenAI from '@google/genai' with { 'resolution-mode': 'import' };

// @google/genai は "type": "module" のパッケージで、型定義は ESM として解釈される。
// bot は CommonJS なので、実行時はパッケージが用意している CommonJS 版（exports の require）を
// require で読み込み、型だけを ESM として参照する。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const genai: typeof GenAI = require('@google/genai');

/** 構造化出力のスキーマで使う型名（Type.STRING など）と思考の深さ（ThinkingLevel.MINIMAL など） */
export const { Type, ThinkingLevel } = genai;
export type Schema = GenAI.Schema;
export type ThinkingLevel = GenAI.ThinkingLevel;

/**
 * Gemini API の共通クライアント（カテゴリ分類・フィードバック解析で共用）。
 *
 * 使うのは Flash-Lite 系だけ（Flash 系は無料枠から外れるため、課金を避ける）。
 * - メイン: 利用できる Flash-Lite の安定版のうち一番新しいもの。モデル一覧 API で調べるので、
 *   上位の Flash-Lite（例: 3.6 Flash-Lite）が出れば自動でそれがメインになる
 * - 予備: その次に新しい Flash-Lite。メインが終了・提供停止になったら自動で切り替える
 * - 一覧を取れないときは既知の順（gemini-3.5-flash-lite → gemini-3.1-flash-lite）を使う
 * 環境変数 GEMINI_MODEL でメインを固定できる（Flash-Lite 以外の名前は無視する）。
 * 料金と廃止予定: https://ai.google.dev/gemini-api/docs/pricing / https://ai.google.dev/gemini-api/docs/deprecations
 */

/** 一覧を取れないときに使う既知の Flash-Lite（新しい順）。3.1 Flash-Lite は 2027/5/7 終了予定 */
export const KNOWN_FLASH_LITE_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
export const DEFAULT_GEMINI_MODEL = KNOWN_FLASH_LITE_MODELS[0];
/** 1 回の呼び出しで試すモデルの数の上限（メイン + 予備） */
const MAX_CANDIDATES = 2;

/** Flash-Lite の安定版のモデル ID か（-preview / -image / -001 などの派生は含めない） */
export function isStableFlashLiteModel(model: string): boolean {
  return /^gemini-\d+(\.\d+)?-flash-lite$/.test(model);
}

function versionOf(model: string): number {
  const match = model.match(/^gemini-(\d+(?:\.\d+)?)-/);
  return match ? Number(match[1]) : 0;
}

/** Flash-Lite の安定版だけを残し、新しい順に並べる（重複は除く） */
export function sortFlashLiteModels(models: string[]): string[] {
  return [...new Set(models.filter(isStableFlashLiteModel))].sort((x, y) => versionOf(y) - versionOf(x));
}

/** 環境変数 GEMINI_MODEL（Flash-Lite のときだけ有効） */
export function configuredModel(): string | null {
  const configured = process.env.GEMINI_MODEL?.trim();
  if (!configured) return null;
  if (!isStableFlashLiteModel(configured)) {
    console.warn('GEMINI_MODEL is not a stable Flash-Lite model; ignoring it', { model: configured });
    return null;
  }
  return configured;
}

/** 既知の一覧から決めたメインモデル（一覧 API を使わない場合の値。ログ・テスト用） */
export function geminiModel(): string {
  return configuredModel() ?? DEFAULT_GEMINI_MODEL;
}

// --- 利用できる Flash-Lite の一覧（モデル一覧 API の結果をインスタンス内にキャッシュ） ---
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000; // 成功: 24 時間
const DISCOVERY_RETRY_MS = 10 * 60 * 1000; // 失敗: 10 分は既知の一覧で動く
const DISCOVERY_TIMEOUT_MS = 3000;
let discovered: { models: string[]; expiresAt: number } | null = null;

/** モデル一覧 API から、generateContent に使える Flash-Lite の安定版を新しい順に取る */
async function discoverFlashLiteModels(ai: GenAI.GoogleGenAI): Promise<string[]> {
  if (discovered && Date.now() < discovered.expiresAt) return discovered.models;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const pager = await ai.models.list({ config: { pageSize: 100, abortSignal: controller.signal } });
    const names: string[] = [];
    for await (const model of pager) {
      const name = (model.name ?? '').replace(/^models\//, '');
      const actions = model.supportedActions;
      if (actions && !actions.includes('generateContent')) continue;
      names.push(name);
    }
    const models = sortFlashLiteModels(names);
    discovered = { models, expiresAt: Date.now() + (models.length ? DISCOVERY_TTL_MS : DISCOVERY_RETRY_MS) };
    console.log('Gemini Flash-Lite models discovered', { models });
    return models;
  } catch (error) {
    console.warn('Gemini model list unavailable; using the known Flash-Lite models', {
      status: (error as { status?: unknown })?.status,
    });
    discovered = { models: [], expiresAt: Date.now() + DISCOVERY_RETRY_MS };
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** このインスタンスで「使えない」と分かったモデルと、その記録の期限（一時的な誤判定で固定されないよう 1 時間） */
const UNAVAILABLE_TTL_MS = 60 * 60 * 1000;
const unavailableModels = new Map<string, number>();

function isMarkedUnavailable(model: string): boolean {
  const until = unavailableModels.get(model);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  unavailableModels.delete(model);
  return false;
}

/** テスト用: 使えないモデルの記録と一覧のキャッシュを消す */
export function resetGeminiModelState(): void {
  unavailableModels.clear();
  discovered = null;
}

/**
 * 今回試すモデルの順番（メイン → 予備）。すべて Flash-Lite。
 * GEMINI_MODEL → 一覧 API で見つかった新しい順 → 既知の一覧、の順に並べ、使えないと分かったものは後ろに回す。
 */
export function orderCandidates(discoveredModels: string[]): string[] {
  const preferred = configuredModel();
  const all = [...new Set([...(preferred ? [preferred] : []), ...discoveredModels, ...KNOWN_FLASH_LITE_MODELS])];
  const available = all.filter((m) => !isMarkedUnavailable(m));
  const ordered = available.length ? available : all;
  return ordered.slice(0, MAX_CANDIDATES);
}

/** モデルの終了・提供停止・権限なしによる失敗か（スキーマ誤りなどの 400 とは区別する） */
export function isModelUnavailableError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  const message = String((error as Error)?.message ?? '');
  if (status === 404) return true;
  if (status === 400 || status === 403) {
    return /not found|not supported|deprecat|no longer|discontinu|shut ?down|retired|is not available|not available to/i.test(message);
  }
  return false;
}

/** 思考の設定が受け付けられなかったときの 400 か（モデルによって使える思考レベルが違うため） */
export function isThinkingConfigError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return status === 400 && /thinking/i.test(String((error as Error)?.message ?? ''));
}

let client: GenAI.GoogleGenAI | null = null;
let clientKey: string | null = null;

function getClient(): GenAI.GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY not found in environment variables');
    return null;
  }
  if (!client || clientKey !== apiKey) {
    client = new genai.GoogleGenAI({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

/** thinkingLevel は Gemini 3 系の設定（2.5 系は thinkingBudget で、thinkingLevel を送ると 400 になる） */
function supportsThinkingLevel(model: string): boolean {
  return /^gemini-3/.test(model);
}

export function isGeminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

export interface GenerateJsonOptions {
  /** 応答の JSON スキーマ（指定すると構造化出力になり、パース失敗がほぼ無くなる） */
  schema?: Schema;
  /** 打ち切り時間（ミリ秒） */
  timeoutMs: number;
  /** 思考の深さ。分類のような単純作業は MINIMAL で十分（速く、出力トークンも減る） */
  thinkingLevel?: ThinkingLevel;
}

/**
 * プロンプトを送り、JSON として解釈した応答を返す。
 * 設定なし・タイムアウト・API エラー・JSON でない応答のときは null（呼び出し側でフォールバックする）。
 * プロンプトと応答本文は利用者の入力を含むためログに出さない。
 */
export async function generateJson<T = unknown>(
  prompt: string,
  options: GenerateJsonOptions
): Promise<T | null> {
  const ai = getClient();
  if (!ai) return null;

  // 打ち切り時間は予備モデルへの切り替えも含めた全体で守る
  const candidates = orderCandidates(await discoverFlashLiteModels(ai));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i];
      let useThinking = supportsThinkingLevel(model);
      for (;;) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              ...(options.schema ? { responseSchema: options.schema } : {}),
              ...(useThinking
                ? { thinkingConfig: { thinkingLevel: options.thinkingLevel ?? ThinkingLevel.MINIMAL } }
                : {}),
              abortSignal: controller.signal,
              // SDK の既定は最大 5 回・最大 60 秒待ちの再試行で、待ち中は abort が効かない。
              // 呼び出し側の打ち切り時間を守るため、再試行は 1 回・短い待ちに抑え、1 回ごとにも時間を区切る
              httpOptions: {
                timeout: options.timeoutMs,
                retryOptions: { attempts: 2, initialDelay: 0.5, maxDelay: 1 },
              },
            },
          });
          const text = (response.text ?? '').trim();
          console.log('Gemini response received', { model, chars: text.length });
          if (!text) return null;
          return JSON.parse(stripCodeFence(text)) as T;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // 思考レベルを受け付けないモデルなら、思考の設定なしで同じモデルにもう一度だけ送る
          if (useThinking && isThinkingConfigError(error)) {
            console.warn('Gemini rejected the thinking config; retrying without it', { model });
            useThinking = false;
            continue;
          }
          // モデルが終了・提供停止なら予備モデルへ
          if (isModelUnavailableError(error) && i < candidates.length - 1) {
            unavailableModels.set(model, Date.now() + UNAVAILABLE_TTL_MS);
            console.error('Gemini model is unavailable; switching to the fallback model', {
              model,
              fallback: candidates[i + 1],
              status: (error as { status?: unknown })?.status,
            });
            break;
          }
          throw error;
        }
      }
    }
    return null;
  } catch (error) {
    if (controller.signal.aborted) {
      console.warn('Gemini request timed out', { timeoutMs: options.timeoutMs });
    } else {
      console.error('Gemini request failed', {
        status: (error as { status?: unknown })?.status,
        error: (error as Error)?.message,
      });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** ```json ... ``` のようなコードブロックで返ってきた場合に中身だけを取り出す */
export function stripCodeFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1].trim() : text;
}
