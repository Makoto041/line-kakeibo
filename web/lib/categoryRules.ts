// カテゴリのルール（設定の「カテゴリ」タブ）の、画面側の純関数。保存の検査と整形は bot（bot/src/categoryRules.ts）が行う。
// ここは入力欄・一覧・「試してみる」のためのもので、照合は bot と同じ規則（全角・半角、大文字・小文字、空白を区別しない）。
import type { CategoryRule, CategoryRuleLimits } from './householdContract';

export interface CategoryRulesDraft {
  rules: CategoryRule[];
  examples: Record<string, string[]>;
}

/** 読み込む前に使う上限（bot が返す値と同じ） */
export const DEFAULT_CATEGORY_RULE_LIMITS: CategoryRuleLimits = {
  maxRules: 50,
  maxKeywordLength: 30,
  maxExamplesPerCategory: 5,
  maxExampleLength: 40,
};

/** 制御文字・連続する空白を 1 つの空白にして前後を消す（bot の sanitizeRuleText と同じ。長さは見ない） */
export function tidyText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeForMatch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const len = (s: string) => Array.from(s).length;

export type AddResult<T> = { ok: true; value: T } | { ok: false; reason: 'empty' | 'too_long' | 'duplicate' | 'limit' };

/** 確定ルールを足す（末尾）。空・長すぎ・同じ言葉（照合用に揃えて同じ）・件数の上限は断る */
export function addRule(
  draft: CategoryRulesDraft,
  keyword: string,
  category: string,
  limits: CategoryRuleLimits
): AddResult<CategoryRulesDraft> {
  const clean = tidyText(keyword);
  if (!clean) return { ok: false, reason: 'empty' };
  if (len(clean) > limits.maxKeywordLength) return { ok: false, reason: 'too_long' };
  if (draft.rules.length >= limits.maxRules) return { ok: false, reason: 'limit' };
  const key = normalizeForMatch(clean);
  if (draft.rules.some((r) => normalizeForMatch(r.keyword) === key)) return { ok: false, reason: 'duplicate' };
  return { ok: true, value: { ...draft, rules: [...draft.rules, { keyword: clean, category }] } };
}

export function removeRule(draft: CategoryRulesDraft, index: number): CategoryRulesDraft {
  return { ...draft, rules: draft.rules.filter((_, i) => i !== index) };
}

/** カテゴリの例を足す。空・長すぎ・同じ例・カテゴリごとの上限は断る */
export function addExample(
  draft: CategoryRulesDraft,
  category: string,
  text: string,
  limits: CategoryRuleLimits
): AddResult<CategoryRulesDraft> {
  const clean = tidyText(text);
  const list = draft.examples[category] ?? [];
  if (!clean) return { ok: false, reason: 'empty' };
  if (len(clean) > limits.maxExampleLength) return { ok: false, reason: 'too_long' };
  if (list.length >= limits.maxExamplesPerCategory) return { ok: false, reason: 'limit' };
  if (list.includes(clean)) return { ok: false, reason: 'duplicate' };
  return { ok: true, value: { ...draft, examples: { ...draft.examples, [category]: [...list, clean] } } };
}

export function removeExample(draft: CategoryRulesDraft, category: string, index: number): CategoryRulesDraft {
  const list = (draft.examples[category] ?? []).filter((_, i) => i !== index);
  const examples = { ...draft.examples };
  if (list.length > 0) examples[category] = list;
  else delete examples[category];
  return { ...draft, examples };
}

/** 内容に言葉を含む最初のルール。当たらなければ null（bot の matchCategoryRule と同じ） */
export function matchRule(rules: CategoryRule[], text: string): CategoryRule | null {
  const target = normalizeForMatch(text);
  if (!target) return null;
  for (const rule of rules) {
    const key = normalizeForMatch(rule.keyword);
    if (key && target.includes(key)) return rule;
  }
  return null;
}

/** 「試してみる」: 例に書いた言葉を含む最初のカテゴリ（AI がそのカテゴリを選びやすくなる目安） */
export function matchExampleCategory(examples: Record<string, string[]>, text: string): string | null {
  const target = normalizeForMatch(text);
  if (!target) return null;
  for (const [category, list] of Object.entries(examples)) {
    if (list.some((e) => normalizeForMatch(e) && target.includes(normalizeForMatch(e)))) return category;
  }
  return null;
}

/** 保存していない変更があるか */
export function isDirty(a: CategoryRulesDraft, b: CategoryRulesDraft): boolean {
  return JSON.stringify([a.rules, Object.entries(a.examples).sort()]) !== JSON.stringify([b.rules, Object.entries(b.examples).sort()]);
}

export function categoryRulesErrorText(reason: 'empty' | 'too_long' | 'duplicate' | 'limit', limits: CategoryRuleLimits, kind: 'rule' | 'example'): string {
  switch (reason) {
    case 'empty':
      return kind === 'rule' ? '言葉を入れてください' : '例を入れてください';
    case 'too_long':
      return `${kind === 'rule' ? limits.maxKeywordLength : limits.maxExampleLength}文字までです`;
    case 'duplicate':
      return kind === 'rule' ? '同じ言葉のルールがあります' : '同じ例があります';
    case 'limit':
      return kind === 'rule' ? `ルールは${limits.maxRules}件までです` : `1つのカテゴリに${limits.maxExamplesPerCategory}件までです`;
  }
}
