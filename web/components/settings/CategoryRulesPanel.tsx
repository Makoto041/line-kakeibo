'use client';

// 設定の「カテゴリ」タブ。世帯のふたりで共有する、支出のカテゴリの決め方を編集する。
// - 確定ルール: 内容に言葉が含まれていたら、AI を使わずに必ずそのカテゴリにする（上から順）
// - AI へ伝える例: カテゴリごとの例。AI（Jev・Gemini）が判断するときの参考にする（従うとは限らない）
// 保存は bot の /household/category-rules（lib/householdApi.ts）。編集は手元の下書きで行い、［保存］で送る。
import React, { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Plus, Trash2, X } from 'lucide-react';
import { useHousehold } from '../../lib/hooks';
import { CANONICAL_CATEGORIES } from '../../lib/categoryNormalization';
import {
  fetchCategoryRules,
  householdErrorCode,
  isHouseholdApiConfigured,
  saveCategoryRules,
} from '../../lib/householdApi';
import type { CategoryRuleLimits } from '../../lib/householdContract';
import {
  DEFAULT_CATEGORY_RULE_LIMITS,
  addExample,
  addRule,
  categoryRulesErrorText,
  isDirty,
  matchExampleCategory,
  matchRule,
  removeExample,
  removeRule,
  type CategoryRulesDraft,
} from '../../lib/categoryRules';

const INPUT =
  'w-full min-w-0 rounded-lg border border-line bg-card px-3 py-2 text-base text-fg focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
const CARD = 'glass rounded-2xl p-5 shadow-glass';

const EMPTY: CategoryRulesDraft = { rules: [], examples: {} };

function saveErrorText(error: unknown): string {
  switch (householdErrorCode(error)) {
    case 'unauthenticated':
      return 'ログインの有効期限が切れました。ページを開き直してください';
    case 'forbidden':
      return 'この世帯のカテゴリのルールを変更する権限がありません';
    case 'invalid_request':
      return '入力内容を確認してください（文字数や件数が上限を超えている可能性があります）';
    case 'rate_limited':
      return '操作が多すぎます。少し待ってからやり直してください';
    default:
      return '保存できませんでした。時間をおいてやり直してください';
  }
}

function ExampleAdder({
  category,
  draft,
  limits,
  onChange,
}: {
  category: string;
  draft: CategoryRulesDraft;
  limits: CategoryRuleLimits;
  onChange: (next: CategoryRulesDraft) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const result = addExample(draft, category, text, limits);
    if (!result.ok) {
      setError(categoryRulesErrorText(result.reason, limits, 'example'));
      return;
    }
    setError(null);
    setText('');
    onChange(result.value);
  };
  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          maxLength={limits.maxExampleLength * 2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label={`${category}の例`}
          placeholder="例: ジムのプロテイン"
          className={INPUT}
        />
        <button
          type="button"
          onClick={submit}
          className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-fg hover:opacity-90"
        >
          追加
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}

export default function CategoryRulesPanel({ lineId }: { lineId: string }) {
  const { household } = useHousehold(lineId);
  const groupId = household?.groupId ?? null;
  const apiAvailable = isHouseholdApiConfigured();

  const [saved, setSaved] = useState<CategoryRulesDraft | null>(null);
  const [draft, setDraft] = useState<CategoryRulesDraft>(EMPTY);
  const [limits, setLimits] = useState<CategoryRuleLimits>(DEFAULT_CATEGORY_RULE_LIMITS);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState<string>(CANONICAL_CATEGORIES[0]);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [tryText, setTryText] = useState('');

  useEffect(() => {
    if (!groupId || !apiAvailable) return;
    let cancelled = false;
    fetchCategoryRules(groupId).then(
      (config) => {
        if (cancelled) return;
        const loaded = { rules: config.rules, examples: config.examples };
        setSaved(loaded);
        setDraft(loaded);
        setLimits(config.limits);
        setLoadFailed(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('Failed to load category rules:', error);
        setLoadFailed(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [groupId, apiAvailable, nonce]);

  const dirty = saved !== null && isDirty(saved, draft);
  const ruleHit = useMemo(() => matchRule(draft.rules, tryText), [draft.rules, tryText]);
  const exampleHit = useMemo(() => (ruleHit ? null : matchExampleCategory(draft.examples, tryText)), [draft.examples, tryText, ruleHit]);

  // 世帯に入っていない・API が使えない環境では出さない
  if (!groupId || !apiAvailable) {
    return (
      <div className={`${CARD} text-sm text-muted`}>
        カテゴリのルールは、世帯に入っているとき（LINE でログインしたとき）に編集できます。
      </div>
    );
  }
  if (!saved) {
    return loadFailed ? (
      <div className={`${CARD} text-sm text-muted`}>
        カテゴリのルールを読み込めませんでした。
        <button type="button" onClick={() => setNonce((n) => n + 1)} className="ml-1 font-medium text-accent hover:underline">
          再読み込み
        </button>
      </div>
    ) : (
      <div className="py-10 text-center">
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-accent" />
      </div>
    );
  }

  const submitRule = () => {
    const result = addRule(draft, keyword, category, limits);
    if (!result.ok) {
      setRuleError(categoryRulesErrorText(result.reason, limits, 'rule'));
      return;
    }
    setRuleError(null);
    setKeyword('');
    setDraft(result.value);
    setMessage(null);
  };

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setMessage(null);
    try {
      const config = await saveCategoryRules(groupId, draft);
      const next = { rules: config.rules, examples: config.examples };
      setSaved(next);
      setDraft(next);
      setLimits(config.limits);
      setMessage({ type: 'success', text: '保存しました。次の入力から使われます' });
    } catch (error) {
      console.error('Failed to save category rules:', error);
      setMessage({ type: 'error', text: saveErrorText(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className={CARD}>
        <h3 className="text-sm font-semibold text-fg">カテゴリの決まり方</h3>
        <p className="mt-1 text-sm text-muted">
          支出の内容を入力すると、①確定ルール ②キーワード辞書 ③AI（書いた例を参考に判断）の順でカテゴリが決まります。
          ふたりで同じルールを使い、LINE の入力にもカード利用メールにも効きます。
        </p>
      </div>

      <div className={CARD}>
        <h3 className="text-sm font-semibold text-fg">確定ルール</h3>
        <p className="mt-1 text-sm text-muted">
          内容にこの言葉が含まれていたら、AI を使わずに必ずこのカテゴリにします。上のものから順に当てはめます（最大 {limits.maxRules} 件）。
        </p>
        <ul className="mt-3 space-y-2">
          {draft.rules.length === 0 && <li className="text-sm text-muted">まだルールがありません。下の欄から足せます。</li>}
          {draft.rules.map((rule, i) => (
            <li key={`${rule.keyword}-${i}`} className="flex min-w-0 items-center gap-2 rounded-xl border border-line px-3 py-2">
              <span className="min-w-0 flex-1 break-words text-sm font-semibold text-fg">「{rule.keyword}」を含む</span>
              <span className="shrink-0 text-muted">→</span>
              <span className="shrink-0 rounded-full bg-accent/12 px-2.5 py-0.5 text-xs font-semibold text-accent">{rule.category}</span>
              <button
                type="button"
                onClick={() => {
                  setDraft(removeRule(draft, i));
                  setMessage(null);
                }}
                aria-label={`「${rule.keyword}」のルールを削除`}
                className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-fg/5 hover:text-fg"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            type="text"
            value={keyword}
            maxLength={limits.maxKeywordLength * 2}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitRule();
              }
            }}
            aria-label="言葉"
            placeholder="例: ドンキ"
            className={`${INPUT} flex-1 basis-40`}
          />
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="カテゴリ" className={`${INPUT} w-auto`}>
            {CANONICAL_CATEGORIES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={submitRule}
            className="inline-flex items-center gap-1 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-fg hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            追加
          </button>
        </div>
        {ruleError && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{ruleError}</p>}
        <p className="mt-2 text-xs text-muted">大文字・小文字と全角・半角の違いは区別しません。</p>
      </div>

      <div className={CARD}>
        <h3 className="text-sm font-semibold text-fg">AI へ伝える例</h3>
        <p className="mt-1 text-sm text-muted">
          カテゴリごとに「こういうものはここ」という例を書くと、確定ルールにない言葉でも AI が参考にします。必ず従うわけではないので、
          確実にしたいものは確定ルールに入れてください（1 カテゴリに {limits.maxExamplesPerCategory} 件まで）。
        </p>
        <div className="mt-3 space-y-2">
          {CANONICAL_CATEGORIES.map((name) => {
            const list = draft.examples[name] ?? [];
            return (
              <details key={name} open={list.length > 0} className="rounded-xl border border-line">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
                  <span className="text-sm font-semibold text-fg">{name}</span>
                  {list.length > 0 && <span className="ml-auto text-xs text-accent">{list.length} 件</span>}
                </summary>
                <div className="px-3 pb-3">
                  {list.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {list.map((text, i) => (
                        <span key={`${text}-${i}`} className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent/12 py-0.5 pl-3 pr-1 text-sm text-fg">
                          <span className="min-w-0 break-words">{text}</span>
                          <button
                            type="button"
                            onClick={() => {
                              setDraft(removeExample(draft, name, i));
                              setMessage(null);
                            }}
                            aria-label={`${text}を削除`}
                            className="shrink-0 rounded-full p-1 text-muted hover:text-fg"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <ExampleAdder
                    category={name}
                    draft={draft}
                    limits={limits}
                    onChange={(next) => {
                      setDraft(next);
                      setMessage(null);
                    }}
                  />
                </div>
              </details>
            );
          })}
        </div>
      </div>

      <div className={CARD}>
        <h3 className="text-sm font-semibold text-fg">試してみる</h3>
        <p className="mt-1 text-sm text-muted">支出の内容を入れると、今の編集内容でどうなるかを確かめられます（保存はされません）。</p>
        <input
          type="text"
          value={tryText}
          onChange={(e) => setTryText(e.target.value)}
          aria-label="支出の内容"
          placeholder="例: ドンキ 洗剤"
          className={`${INPUT} mt-3`}
        />
        {tryText.trim() && (
          <p className="mt-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-fg" aria-live="polite">
            {ruleHit ? (
              <>
                確定ルール「{ruleHit.keyword}」に一致 → <b className="text-accent">{ruleHit.category}</b>（AI は使いません）
              </>
            ) : (
              <>
                確定ルールには一致しません。辞書・AI が判断します。
                {exampleHit && <span className="text-muted">「{exampleHit}」に書いた例に近いので、AI は選びやすくなります。</span>}
              </>
            )}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-accent-fg shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          保存
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setDraft(saved);
              setMessage(null);
            }}
            className="text-sm text-muted hover:text-fg"
          >
            変更を元に戻す
          </button>
        )}
        {dirty && <span className="text-xs text-amber-700 dark:text-amber-300">保存していない変更があります</span>}
        {message && (
          <span className={`text-sm ${message.type === 'success' ? 'text-accent' : 'text-rose-600 dark:text-rose-400'}`} role="status">
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}
