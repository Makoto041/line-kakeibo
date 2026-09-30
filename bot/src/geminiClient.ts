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
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await ai.models.generateContent({
      model: geminiModel(),
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        ...(options.schema ? { responseSchema: options.schema } : {}),
        thinkingConfig: { thinkingLevel: options.thinkingLevel ?? ThinkingLevel.MINIMAL },
        abortSignal: controller.signal,
      },
    });
    const text = (response.text ?? '').trim();
    console.log('Gemini response received', { model: geminiModel(), chars: text.length });
    if (!text) return null;
    return JSON.parse(stripCodeFence(text)) as T;
  } catch (error) {
    if (controller.signal.aborted) {
      console.warn('Gemini request timed out', { model: geminiModel(), timeoutMs: options.timeoutMs });
    } else {
      console.error('Gemini request failed', { model: geminiModel(), error: (error as Error)?.message });
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
