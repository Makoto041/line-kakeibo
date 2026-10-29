import { getFirestore } from 'firebase-admin/firestore';
import { CANONICAL_CATEGORIES } from './categoryNormalization';
import { errorFields, maskId } from './logSafe';

/**
 * 世帯ごとのカテゴリのルール（groups/{groupId}.categoryRules）。Web の設定「カテゴリ」で編集する。
 * - rules（確定ルール）: 内容に keyword が含まれたら、モデルを呼ばずに必ずそのカテゴリにする（上から順）
 * - examples（AI へ伝える例）: カテゴリごとの例。Jev の選択肢の説明と Gemini のプロンプトに足す（従うとは限らない）
 * 書き込みは bot の /household/category-rules（Admin SDK）だけ。groups はクライアントから書けない。
 */

export const MAX_RULES = 50;
export const MAX_KEYWORD_LENGTH = 30;
/** 言葉の最短。1 文字の言葉は何にでも当たって誤爆するので断る。英数字だけの言葉（au・gu・etc など）は店名の一部に当たりやすいので 3 文字から */
export const MIN_KEYWORD_LENGTH = 2;
export const MIN_ASCII_KEYWORD_LENGTH = 3;
export const MAX_EXAMPLES_PER_CATEGORY = 5;
export const MAX_EXAMPLE_LENGTH = 40;

/** Web に返す上限（Web の入力欄の上限と同じ値） */
export const CATEGORY_RULES_LIMITS = {
  maxRules: MAX_RULES,
  minKeywordLength: MIN_KEYWORD_LENGTH,
  minAsciiKeywordLength: MIN_ASCII_KEYWORD_LENGTH,
  maxKeywordLength: MAX_KEYWORD_LENGTH,
  maxExamplesPerCategory: MAX_EXAMPLES_PER_CATEGORY,
  maxExampleLength: MAX_EXAMPLE_LENGTH,
} as const;

export interface CategoryRule {
  keyword: string;
  category: string;
}

export interface CategoryRules {
  rules: CategoryRule[];
  /** カテゴリ名 → 例（空の配列は持たない） */
  examples: Record<string, string[]>;
}

export const EMPTY_CATEGORY_RULES: CategoryRules = { rules: [], examples: {} };

/**
 * 利用者の文を保存・モデルに渡せる形にする。見えない文字（ゼロ幅・双方向制御などの書式文字、対にならないサロゲート）と
 * 引用に使う「」は取り除き、制御文字（改行を含む）と行区切りは空白に、連続する空白を 1 つに、前後の空白を消して、
 * max 文字までに切る。何も残らなければ空文字
 */
export function sanitizeRuleText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = value
    .replace(/[\p{Cf}\p{Cs}「」]/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, max).join('').trim();
}

/** 照合用に揃える（全角・半角、大文字・小文字、前後と連続する空白を区別しない） */
export function normalizeForRuleMatch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 保存できる言葉か（整えたあとの文字数。英数字だけの言葉は長めに） */
export function isUsableKeyword(clean: string): boolean {
  const length = Array.from(clean).length;
  if (length < MIN_KEYWORD_LENGTH) return false;
  return !(/^[\x20-\x7e]+$/.test(clean) && length < MIN_ASCII_KEYWORD_LENGTH);
}

/**
 * 保存の入力を検査して、保存する形にする。形が違う・上限を超える・カテゴリが一覧にないときは null（丸めずに断る）。
 * 言葉（keyword）と例の文は sanitizeRuleText で整え、空になるもの・同じ言葉（照合用に揃えて同じ）は重複として 1 つにする
 */
export function parseCategoryRulesInput(input: unknown): CategoryRules | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const { rules: rawRules, examples: rawExamples } = input as { rules?: unknown; examples?: unknown };
  if (!Array.isArray(rawRules) || rawRules.length > MAX_RULES) return null;
  if (typeof rawExamples !== 'object' || rawExamples === null || Array.isArray(rawExamples)) return null;

  const rules: CategoryRule[] = [];
  const seen = new Set<string>();
  for (const item of rawRules) {
    if (typeof item !== 'object' || item === null) return null;
    const { keyword, category } = item as { keyword?: unknown; category?: unknown };
    if (typeof keyword !== 'string' || typeof category !== 'string') return null;
    if (!CANONICAL_CATEGORIES.includes(category)) return null;
    // 上限より長い言葉は丸めずに断る（途中で切れた言葉が意図しないものに当たらないように）
    if (Array.from(keyword.trim()).length > MAX_KEYWORD_LENGTH) return null;
    const clean = sanitizeRuleText(keyword, MAX_KEYWORD_LENGTH);
    if (!isUsableKeyword(clean)) return null;
    const key = normalizeForRuleMatch(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ keyword: clean, category });
  }

  const examples: Record<string, string[]> = {};
  for (const [category, list] of Object.entries(rawExamples as Record<string, unknown>)) {
    if (!CANONICAL_CATEGORIES.includes(category) || !Array.isArray(list) || list.length > MAX_EXAMPLES_PER_CATEGORY) return null;
    const cleaned: string[] = [];
    for (const text of list) {
      if (typeof text !== 'string' || Array.from(text.trim()).length > MAX_EXAMPLE_LENGTH) return null;
      const clean = sanitizeRuleText(text, MAX_EXAMPLE_LENGTH);
      if (!clean) return null;
      if (!cleaned.some((c) => normalizeForRuleMatch(c) === normalizeForRuleMatch(clean))) cleaned.push(clean);
    }
    if (cleaned.length > 0) examples[category] = cleaned;
  }
  return { rules, examples };
}

/** Firestore に保存してある値を読む。形が崩れているものは捨てる（読み取りでは断らず、読める分だけ使う） */
export function readStoredCategoryRules(raw: unknown): CategoryRules {
  if (typeof raw !== 'object' || raw === null) return EMPTY_CATEGORY_RULES;
  const { rules, examples } = raw as { rules?: unknown; examples?: unknown };
  const out: CategoryRules = { rules: [], examples: {} };
  if (Array.isArray(rules)) {
    for (const item of rules.slice(0, MAX_RULES)) {
      const { keyword, category } = (item ?? {}) as { keyword?: unknown; category?: unknown };
      const clean = sanitizeRuleText(keyword, MAX_KEYWORD_LENGTH);
      if (clean && typeof category === 'string' && CANONICAL_CATEGORIES.includes(category)) out.rules.push({ keyword: clean, category });
    }
  }
  if (typeof examples === 'object' && examples !== null && !Array.isArray(examples)) {
    for (const [category, list] of Object.entries(examples as Record<string, unknown>)) {
      if (!CANONICAL_CATEGORIES.includes(category) || !Array.isArray(list)) continue;
      const texts = list
        .slice(0, MAX_EXAMPLES_PER_CATEGORY)
        .map((t) => sanitizeRuleText(t, MAX_EXAMPLE_LENGTH))
        .filter((t) => t.length > 0);
      if (texts.length > 0) out.examples[category] = texts;
    }
  }
  return out;
}

/** 内容に言葉を含む最初のルールのカテゴリ。当たらなければ null */
export function matchCategoryRule(rules: CategoryRule[], description: string): string | null {
  const target = normalizeForRuleMatch(description);
  if (!target) return null;
  for (const rule of rules) {
    const key = normalizeForRuleMatch(rule.keyword);
    if (key && target.includes(key)) return rule.category;
  }
  return null;
}

/** 分類結果のキャッシュのキーに入れる版。ルールを変えたらキーが変わり、古い結果を使わない */
export function categoryRulesVersion(config: CategoryRules): string {
  const text = JSON.stringify([config.rules, Object.entries(config.examples).sort(([a], [b]) => a.localeCompare(b))]);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** 保存した版（更新時刻のミリ秒。保存したことがなければ 0）。ふたりの同時編集の検出に使う（householdApi.ts の category-rules） */
export function categoryRulesVersionOf(raw: unknown): number {
  const updatedAt = (raw as { updatedAt?: { toMillis?: () => number } } | null | undefined)?.updatedAt;
  const millis = typeof updatedAt?.toMillis === 'function' ? updatedAt.toMillis() : 0;
  return Number.isSafeInteger(millis) && millis > 0 ? millis : 0;
}

/** 選択肢の説明に利用者の例を足す。例が無ければ説明のまま（Jev・Gemini の両方で使う） */
export function describeWithExamples(base: string | null | undefined, examples: string[] | undefined): string | null {
  if (!examples || examples.length === 0) return base ?? null;
  const tail = `この家計では次もこのカテゴリ: ${examples.map((e) => `「${e}」`).join('、')}`;
  return base ? `${base}。${tail}` : tail;
}

// ---- 読み込み（世帯ごと。短い間は使い回す） ----

const RULES_CACHE_TTL_MS = 60_000;
const rulesCache = new Map<string, { value: CategoryRules; at: number }>();

/** 保存した直後に、このインスタンスのキャッシュを捨てる（ほかのインスタンスは TTL の分だけ遅れて反映される） */
export function invalidateCategoryRules(groupId: string): void {
  rulesCache.delete(groupId);
}

/** 世帯のルールを読む。読めなかったとき（Firestore の失敗）は null で、分類はルール無しで続ける（キャッシュしない） */
export async function loadCategoryRules(groupId: string): Promise<CategoryRules | null> {
  const cached = rulesCache.get(groupId);
  if (cached && Date.now() - cached.at < RULES_CACHE_TTL_MS) return cached.value;
  try {
    const snap = await getFirestore().collection('groups').doc(groupId).get();
    const value = readStoredCategoryRules(snap.data()?.categoryRules);
    rulesCache.set(groupId, { value, at: Date.now() });
    return value;
  } catch (error) {
    console.warn('Failed to load category rules', { group: maskId(groupId), ...errorFields(error) });
    return null;
  }
}
