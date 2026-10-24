// @typesafe-ai/sdk は exports の require に CommonJS 版と型（index.d.cts）を持つので、CommonJS の bot から
// そのまま import できる（geminiClient.ts のような require + 型だけの参照は要らない）
import { TypeSafeClient, choice } from '@typesafe-ai/sdk';
import { CATEGORY_GUIDE } from './categoryGuide';
import type { ClassificationSource, GeminiClassificationResult } from './geminiCategoryClassifier';

/**
 * Jev（TypeSafe AI の System One 決定モデル）によるカテゴリ分類。分類のメイン。
 * 失敗したら呼び出し側（geminiCategoryClassifier.ts）が Gemini に回す。
 * 質問文と選択肢の説明は、評価で選んだもの。
 */

/**
 * モデルは固定する（SDK の既定 jev-latest のように自動で変わる名前は使わない）。
 * 版が変わると分類の傾向も変わるため、モデルや SDK の版を上げるときは評価してから変える
 */
export const JEV_MODEL = 'jev-1.13.0';
// 打ち切り時間。LINE の返信とカード利用通知がこの分遅れ、失敗時はさらに Gemini（最大 8 秒）を待つので短くする。
// 再試行しない（待って再試行するより Gemini に回すほうが早い）
const JEV_TIMEOUT_MS = 3000;

/** Jev 用に CATEGORY_GUIDE から差し替える説明（食費・娯楽の取り違えが多かったため書き足した） */
const JEV_DESCRIPTION_OVERRIDES: Record<string, string> = {
  '食費': '食材、外食（飲食店・居酒屋・ファストフード・ラーメン・牛丼・寿司）、カフェ、コンビニ・スーパー・自販機での買い物、飲み物、弁当・デリバリー、飲み会',
  '娯楽': '映画、ゲーム、書籍、漫画、おもちゃ、カラオケ、ライブ、趣味用品、スポーツ観戦、ゲームセンター、銭湯・サウナなどのレジャー施設。宿泊を伴う旅行は含めない',
};

/** 質問文（`input` は state のキー） */
export const JEV_QUESTIONS: Record<ClassificationSource, string> = {
  text: '`input` は家計簿アプリに利用者が入力した支出の内容。この支出は家計簿のどのカテゴリ？',
  merchant:
    '`input` はクレジットカードの利用明細に載った店名（半角カナ・ローマ字・略称が混ざる）。店の業態から、この支出は家計簿のどのカテゴリ？店名だけで中身が決まらないものは「その他」。',
};

/** 選択肢（カテゴリ名 → 説明）。説明の無い名前（利用者のカスタムカテゴリなど）は null */
export function jevCriteria(categoryNames: string[]): Record<string, string | null> {
  return Object.fromEntries(
    categoryNames.map((name) => [name, JEV_DESCRIPTION_OVERRIDES[name] ?? CATEGORY_GUIDE[name] ?? null])
  );
}

export function isJevConfigured(): boolean {
  return !!process.env.TYPESAFE_API_KEY;
}

/** SDK の既定の接続先。環境変数 TYPESAFE_BASE_URL で変わらないよう固定する */
const JEV_BASE_URL = 'https://api.typesafe.ai';

let client: TypeSafeClient | null = null;

/**
 * 鍵は SDK が TYPESAFE_API_KEY から読む。
 * debug は要求本文（利用者の入力）を出すので warn に固定
 */
function getClient(): TypeSafeClient {
  client ??= new TypeSafeClient({
    baseURL: JEV_BASE_URL,
    defaultModel: JEV_MODEL,
    timeout: JEV_TIMEOUT_MS,
    retry: { maxRetries: 0 },
    logLevel: 'warn',
  });
  return client;
}

/**
 * Jev で分類する。使えない・エラー・タイムアウト・一覧に無いカテゴリを返したときは null（例外は投げない）。
 * 入力と応答本文は利用者の入力を含むためログに出さない。失敗はエラーの種類だけを出す
 */
export async function classifyWithJev(
  categoryNames: string[],
  description: string,
  source: ClassificationSource
): Promise<GeminiClassificationResult | null> {
  if (!isJevConfigured()) return null;
  try {
    const { answers } = await getClient().systemOne({
      state: { input: description },
      questions: { category: choice(JEV_QUESTIONS[source], jevCriteria(categoryNames)) },
    });
    const answer = answers.category;
    if (typeof answer?.choice !== 'string') {
      console.warn('Jev returned no category');
      return null;
    }
    // 選択肢の中からしか選ばないはずだが、万一一覧外が返ったときは採用せずキャッシュもしない
    if (!categoryNames.includes(answer.choice)) {
      console.warn('Jev suggested a category outside the list');
      return null;
    }
    const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : 0;
    return {
      category: answer.choice,
      confidence: Math.max(0, Math.min(1, confidence)),
      reasoning: 'Jev classification',
    };
  } catch (error) {
    // SDK のエラー文は API の応答本文から作られるので出さない（種類と HTTP ステータスだけ）
    console.warn('Jev classification failed', {
      error: (error as Error)?.name,
      status: (error as { status?: unknown })?.status,
    });
    return null;
  }
}
