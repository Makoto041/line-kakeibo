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
 * モデルは短い分類・要約が中心なので、安価で速い Flash-Lite を既定にする。
 * 環境変数 GEMINI_MODEL で差し替えられる（モデルの廃止・値上げ時にコード変更なしで切り替えるため）。
 * 料金と廃止予定: https://ai.google.dev/gemini-api/docs/pricing / https://ai.google.dev/gemini-api/docs/deprecations
 *
 * 既定モデルが終了・提供停止（404 や「not found / deprecated / no longer available」）になったときは、
 * 予備モデル（GEMINI_FALLBACK_MODEL、既定 gemini-3.6-flash）に自動で切り替える。予備は通常は呼ばれない。
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
/** 予備モデル。安定版で終了予定がなく、思考 MINIMAL にも対応している（単価は既定の約 1.5〜2.5 倍） */
export const DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-3.6-flash';

export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

/** 予備モデル。GEMINI_FALLBACK_MODEL=none で無効化できる */
export function geminiFallbackModel(): string | null {
  const configured = process.env.GEMINI_FALLBACK_MODEL?.trim();
  if (configured?.toLowerCase() === 'none') return null;
  const fallback = configured || DEFAULT_GEMINI_FALLBACK_MODEL;
  return fallback === geminiModel() ? null : fallback;
}

/** このインスタンスで「使えない」と分かったモデル（毎回失敗させないため、以後は予備を直接使う） */
const unavailableModels = new Set<string>();

/** テスト用: 使えないモデルの記録を消す */
export function resetGeminiModelState(): void {
  unavailableModels.clear();
}

/** 今回使うモデルの順番（既定 → 予備）。使えないと分かった既定はとばす */
export function modelCandidates(): string[] {
  const primary = geminiModel();
  const fallback = geminiFallbackModel();
  const list = unavailableModels.has(primary) && fallback ? [fallback] : [primary];
  if (fallback && !list.includes(fallback)) list.push(fallback);
  return list;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const candidates = modelCandidates();
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
            unavailableModels.add(model);
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
