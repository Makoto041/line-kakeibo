// 中項目を Jev で決める（#235。辞書と時刻のルール〔subCategoryRules.ts の resolveSubCategory〕で決まらなかったときだけ）
//
// 大項目とは別の呼び出し（jevCategoryClassifier.ts の classifySubCategoryWithJev。評価 eval-classifier.js の --scheme stage2 と同じ形）で、
// 大項目の判定は変えずに、その後ろに足す段。呼ぶのは登録時の保存だけ（LINE の入力は line/expenseFlow.ts、Gmail のカード利用通知は
// gmail/handler.ts）。LINE で大項目を変えたとき（expenseActions.ts の decideSetCategory）は辞書だけで、Jev には聞き直さない。
//
// 次の順に見て、当たれば Jev を呼ばずに中項目なし（undefined）にする（括弧はログの outcome）:
//   1. 大項目（正準名）に中項目の一覧が無い（日用品・その他・カスタム名など）。ログも出さない
//   2. 説明・店名に手がかりが無い（空・空白だけ・「支出」・LINE でカテゴリだけを書いたときのカテゴリ名。isUninformativeSubCategoryText）（no_info）
//   3. allowModels が true でない（世帯メンバーでない送信者。#245。キャッシュも読まない）（models_not_allowed）
//   4. 鍵（TYPESAFE_API_KEY）が無い（not_configured）
//   5. 同じ処理で大項目の Jev が失敗した（Gemini・辞書で決まった、または決まらなかった。Gemini にも回さない）（jev_unavailable）
// そのあと、キャッシュ → Jev。Jev の答えは、確信度が SUB_MIN_CONFIDENCE 以上で「その他の食費」「その他の娯楽」でないときだけ採用する
// （adopted / low_confidence / other）。失敗・3 秒のタイムアウト・答えなし・一覧外は中項目なし（failed）。
// Jev が「外食」を返しても、時刻のルール（朝・昼・夜ご飯）は当てない。
import { toCanonicalCategoryName } from './categoryNormalization';
import { subCategoriesOf } from './categoryTaxonomy';
import { toModelInput } from './geminiCategoryClassifier';
import type { ClassificationSource } from './geminiCategoryClassifier';
import { classifySubCategoryWithJev, isJevConfigured } from './jevCategoryClassifier';
import type { CategoryOrigin } from './line/flexMessage';
import { errorFields } from './logSafe';
import { isUninformativeSubCategoryText } from './subCategoryRules';

/**
 * 中項目の Jev の答えを採用する確信度の下限（LINE・Gmail 共通）。大項目の下限（expenseFlow.ts の CLASSIFY_MIN_CONFIDENCE）と
 * 同じ 0.4 だが別の値（中項目の答えの確信度に当てる。片方を変えても、もう片方は変わらない）
 */
export const SUB_MIN_CONFIDENCE = 0.4;

// Jev の答えのキャッシュ（15 分）。採用しなかった答え（その他・低い確信度）も入れ、失敗は入れない（復旧後に聞き直す）。
// キーは経路・正準の大項目・モデルに送る入力（小文字・trim）で、利用者 ID は入れない（同じ入力なら誰の入力でも同じ答え）
const subCategoryCache = new Map<string, { subCategory: string; confidence: number; timestamp: number }>();
const SUB_CATEGORY_CACHE_TTL = 15 * 60 * 1000;

/** ログの outcome（上の説明を参照） */
type SubCategoryModelOutcome =
  | 'adopted'
  | 'low_confidence'
  | 'other'
  | 'failed'
  | 'no_info'
  | 'models_not_allowed'
  | 'jev_unavailable'
  | 'not_configured';

export interface SubCategoryByModelInput {
  /** 大項目（toCanonicalCategoryName の完全一致で正準名にしてから見る） */
  major: string;
  /** LINE の説明文、または Gmail の店名 */
  text: string;
  source: ClassificationSource;
  /** true のときだけモデルを呼ぶ（省略したら呼ばない） */
  allowModels?: boolean;
  /** 同じ処理で大項目の Jev が失敗したか（true なら呼ばない） */
  jevFailedForMajor?: boolean;
  /** 大項目の判定元（ログだけに使う） */
  majorOrigin?: CategoryOrigin;
  /** 大項目の分類の確信度（ログだけに使う） */
  majorConfidence?: number;
}

const round2 = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

/**
 * 辞書で決まらなかった中項目を Jev で決める。決まらなければ undefined。投げない（例外は受け止めて undefined）。
 * 大項目に中項目の一覧があるとき、結果を `Subcategory classified by model` のログに出す（固定文 + オブジェクト。
 * 入力・店名・ID は出さない。answer は一覧の中の名前だけ、確信度は小数 2 桁）
 */
export async function subCategoryByModel(input: SubCategoryByModelInput): Promise<string | undefined> {
  const started = Date.now();
  try {
    return await decideByModel(input, started);
  } catch (error) {
    console.warn('Subcategory classification by model failed', { source: input.source, ...errorFields(error) });
    return undefined;
  }
}

async function decideByModel(input: SubCategoryByModelInput, started: number): Promise<string | undefined> {
  const { major, text, source, allowModels, jevFailedForMajor, majorOrigin, majorConfidence } = input;
  const canonical = toCanonicalCategoryName(major);
  if (subCategoriesOf(canonical).length === 0) return undefined;

  const log = (outcome: SubCategoryModelOutcome, answer?: { subCategory: string; confidence: number }, cached = false) => {
    console.log('Subcategory classified by model', {
      source,
      majorOrigin: majorOrigin ?? null,
      majorConfidence: round2(majorConfidence),
      outcome,
      answer: answer?.subCategory ?? null, // 一覧の中の名前だけ（classifySubCategoryWithJev が確かめる）
      confidence: round2(answer?.confidence),
      cached,
      ms: Date.now() - started,
    });
  };

  if (isUninformativeSubCategoryText(text)) {
    log('no_info');
    return undefined;
  }
  if (allowModels !== true) {
    log('models_not_allowed');
    return undefined;
  }
  // 鍵の有無はここで見る（classifySubCategoryWithJev は鍵なしも失敗と同じ null を返すため）
  if (!isJevConfigured()) {
    log('not_configured');
    return undefined;
  }
  if (jevFailedForMajor === true) {
    log('jev_unavailable');
    return undefined;
  }

  const modelInput = toModelInput(text);
  const cacheKey = `${source}_${canonical}_${modelInput.toLowerCase().trim()}`;
  const hit = subCategoryCache.get(cacheKey);
  let answer: { subCategory: string; confidence: number };
  let cached = false;
  if (hit && Date.now() - hit.timestamp < SUB_CATEGORY_CACHE_TTL) {
    answer = { subCategory: hit.subCategory, confidence: hit.confidence };
    cached = true;
  } else {
    const result = await classifySubCategoryWithJev(canonical, modelInput, source);
    if (!result) {
      log('failed');
      return undefined;
    }
    answer = result;
    subCategoryCache.set(cacheKey, { ...answer, timestamp: Date.now() });
  }

  // 「その他の食費」「その他の娯楽」は手で選ぶためのもの（自動では付けない）
  if (answer.subCategory.startsWith('その他の')) {
    log('other', answer, cached);
    return undefined;
  }
  if (answer.confidence < SUB_MIN_CONFIDENCE) {
    log('low_confidence', answer, cached);
    return undefined;
  }
  log('adopted', answer, cached);
  return answer.subCategory;
}
