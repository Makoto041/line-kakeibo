// @typesafe-ai/sdk は exports の require に CommonJS 版と型（index.d.cts）を持つので、CommonJS の bot から
// そのまま import できる（geminiClient.ts のような require + 型だけの参照は要らない）
import { TypeSafeClient, choice } from '@typesafe-ai/sdk';
import { CATEGORY_GUIDE } from './categoryGuide';
import { toCanonicalCategoryName } from './categoryNormalization';
import { SUB_CATEGORY_DESCRIPTIONS, subCategoriesOf } from './categoryTaxonomy';
import type { ClassificationSource, ClassificationResult } from './geminiCategoryClassifier';
import { errorFields } from './logSafe';

/**
 * Jev（TypeSafe AI の System One 決定モデル）によるカテゴリ分類。分類のメイン。
 * 失敗したら呼び出し側（geminiCategoryClassifier.ts）が Gemini に回す。
 * 質問文と選択肢の説明は、評価で選んだもの（評価スクリプト eval-classifier.js の --variant v3 はこのモジュールの値を使う）。
 * 中項目（食費・娯楽）も、辞書で決まらなかったときだけ大項目とは別の呼び出しで選ばせる（classifySubCategoryWithJev。
 * 呼ぶかどうかとキャッシュは subCategoryClassifier.ts）。
 */

/**
 * モデルは固定する（SDK の既定 jev-latest のように自動で変わる名前は使わない）。
 * 版が変わると分類の傾向も変わるため、モデルや SDK の版を上げるときは eval-classifier.js で評価してから変える
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
export const JEV_BASE_URL = 'https://api.typesafe.ai';
/** ログの詳しさ。環境変数 TYPESAFE_LOG_LEVEL で変わらないよう固定する（接続先とともに eval-classifier.js も使う） */
export const JEV_LOG_LEVEL = 'warn';

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
    logLevel: JEV_LOG_LEVEL,
  });
  return client;
}

/**
 * Jev で分類する。鍵なし・エラー・3 秒のタイムアウト・答えなし・選択肢にないカテゴリのときは null（例外は投げない）。
 * 入力と応答本文は利用者の入力を含むためログに出さない。失敗はエラーの種類だけを出す
 */
export async function classifyWithJev(
  categoryNames: string[],
  description: string,
  source: ClassificationSource
): Promise<ClassificationResult | null> {
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
      provider: 'jev',
    };
  } catch (error) {
    // SDK のエラー文は API の応答本文から作られるので出さない（種類と HTTP ステータスだけ。errorFields は
    // 100〜599 の整数の status だけを errorStatus に出す）
    console.warn('Jev classification failed', errorFields(error));
    return null;
  }
}

/**
 * 中項目の質問文（`input` は大項目と同じ state のキー。決まった大項目を質問文に入れる）。
 * 文言は評価スクリプト eval-classifier.js の SUB_QUESTIONS（--scheme stage2 の 2 回目）と同じ（smoke-eval-hierarchy.js で確かめる）
 */
export const JEV_SUB_QUESTIONS: Record<ClassificationSource, (major: string) => string> = {
  text: (major) => `\`input\` は家計簿アプリに利用者が入力した支出の内容。この支出は「${major}」に分類された。「${major}」のうち、どの中項目？`,
  merchant: (major) =>
    `\`input\` はクレジットカードの利用明細に載った店名（半角カナ・ローマ字・略称が混ざる）。この支出は「${major}」に分類された。店の業態から、「${major}」のうち、どの中項目？`,
};

/**
 * 中項目の選択肢（中項目名 → 説明）。「その他の食費」「その他の娯楽」も含む。説明は SUB_CATEGORY_DESCRIPTIONS（無い中項目は null）。
 * 中項目の一覧が無い大項目（プロトタイプの名前を含む）は空（subCategoriesOf）
 */
export function jevSubCriteria(major: string): Record<string, string | null> {
  const descriptions = SUB_CATEGORY_DESCRIPTIONS[toCanonicalCategoryName(major)];
  return Object.fromEntries(subCategoriesOf(major).map((sub) => [sub, descriptions?.[sub] ?? null]));
}

/**
 * Jev で中項目を選ばせる（大項目とは別の呼び出し。質問は subCategory の 1 問だけ）。major は正準名で、
 * input はモデルに送る長さに切った入力（geminiCategoryClassifier.ts の toModelInput）。
 * 鍵なし・エラー・3 秒のタイムアウト・答えなし・一覧外は null（例外は投げない。鍵の有無は呼び出し側が先に見る）。
 * 答えは一覧の中の名前（「その他の食費」なども含む）で、確信度は 0〜1 に丸める。
 * クライアントは大項目と同じもの（3 秒・再試行なし・モデル固定）。入力と応答本文はログに出さない。
 * 失敗のログは大項目と別の文言にする（`Jev classification failed` を数える失敗率の式を変えないため。SECURITY_OPERATIONS.md §7）
 */
export async function classifySubCategoryWithJev(
  major: string,
  input: string,
  source: ClassificationSource
): Promise<{ subCategory: string; confidence: number } | null> {
  if (!isJevConfigured()) return null;
  const criteria = jevSubCriteria(major);
  try {
    const { answers } = await getClient().systemOne({
      state: { input },
      questions: { subCategory: choice(JEV_SUB_QUESTIONS[source](major), criteria) },
    });
    const answer = answers.subCategory;
    if (typeof answer?.choice !== 'string') {
      console.warn('Jev returned no subcategory');
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(criteria, answer.choice)) {
      console.warn('Jev suggested a subcategory outside the list');
      return null;
    }
    const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : 0;
    return { subCategory: answer.choice, confidence: Math.max(0, Math.min(1, confidence)) };
  } catch (error) {
    // 大項目と同じく、種類と HTTP ステータスだけ（SDK のエラー文は API の応答本文から作られる）
    console.warn('Jev subcategory classification failed', errorFields(error));
    return null;
  }
}
