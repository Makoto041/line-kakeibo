// デモ（/demo）の LINE の場面が、bot の本物と食い違わないことのテスト。
// - 確認カード（lib/demo/demoLine.ts）と精算サマリー（lib/demo/demoSummary.ts）の文言・色・アイコン・判定元の表示名・ボタンを、
//   bot のソース（line/flexMessage.ts・line/postback.ts・line/settlementSummaryMessage.ts など）と突き合わせる。
// - LINE の文例が、bot の辞書（大項目: geminiCategoryClassifier.ts の FAST_KEYWORD_MAP、中項目: subCategoryRules.ts）で
//   デモに書いた大項目・中項目に決まること、カード利用の取込の店名と時刻が、中項目の時刻のルールで昼ご飯になることを確かめる。
// bot のモジュールは web から import できない（CommonJS・拡張子なしの import・firebase-admin など）ので、ソースを文字列として読む
// （前例: categoryTaxonomy.test.mjs）。辞書の照合は bot と同じ手順をここで再現する（手順の行もソースにあることを確かめる）。
// レイアウト（余白・折り返し・大きさ）のずれは検出できない。発表後に /demo と一緒に消す。node --test で実行する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import * as L from '../lib/demo/demoLine.ts';
import * as S from '../lib/demo/demoSummary.ts';
import { DEMO_DEFAULT_MONTH_INDEX, DEMO_EXPENSES, DEMO_HOUSEHOLD_ID, DEMO_MEMBER_A, DEMO_MEMBERS, DEMO_MONTHS, DEMO_TODAY } from '../lib/demo/demoData.ts';
import { demoScenes } from '../lib/demo/demoScenes.ts';
import { computePeriodSplit, periodPool } from '../lib/periodSplit.ts';
import { CANONICAL_CATEGORIES } from '../lib/categoryNormalization.ts';

// CI は web/ を作業ディレクトリにして実行するので、このファイルからの相対で読む
const bot = (rel) => readFileSync(new URL(`../../bot/src/${rel}`, import.meta.url), 'utf8');
const FLEX = bot('line/flexMessage.ts');
const POSTBACK = bot('line/postback.ts');
const SUMMARY_MESSAGE = bot('line/settlementSummaryMessage.ts');
const SUMMARY = bot('settlementSummary.ts');
const PERIOD_SPLIT = bot('periodSplit.ts');
const CLASSIFIER = bot('geminiCategoryClassifier.ts');
const RULES = bot('subCategoryRules.ts');
const TAXONOMY = bot('categoryTaxonomy.ts');
const TEXT_PARSER = bot('textParser.ts');
const EXPENSE_FLOW = bot('line/expenseFlow.ts');
const GMAIL_PARSER = bot('gmail/parser.ts');
const GMAIL_HANDLER = bot('gmail/handler.ts');
const INDEX = bot('index.ts');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** トップレベルの関数の本文（`function name(` から、次のトップレベルの宣言の手前まで） */
function bodyOf(source, name) {
  const start = source.search(new RegExp(`\\bfunction ${esc(name)}\\s*[(<]`));
  assert.notEqual(start, -1, `${name} が無い`);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:\/\*\*|export\s|(?:async\s+)?function\s|const\s|interface\s|type\s)/);
  return end === -1 ? source.slice(start) : source.slice(start, start + 1 + end);
}

/** `宣言 … {` から、行頭の `};` までのブロック */
function blockOf(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} が無い`);
  const end = source.indexOf('\n};', start);
  assert.notEqual(end, -1, `${declaration} の終わりが無い`);
  return source.slice(start, end + 3);
}

/** `  key: 'value',` の行だけでできたオブジェクト（キーは引用符あり・なし） */
function readFlatObject(block) {
  const out = {};
  for (const line of block.split('\n').slice(1, -1)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const m = trimmed.match(/^(?:'([^']+)'|([^\s:'"]+)):\s*'([^']*)',?$/);
    assert.ok(m, `決まった形でない行: ${trimmed}`);
    out[m[1] ?? m[2]] = m[3];
  }
  return out;
}

const includes = (source, snippet, where) => assert.ok(source.includes(snippet), `${where} に「${snippet}」が無い`);

/** source の中で first が second より前にある（どちらも見つかる） */
function assertBefore(source, first, second, message) {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert.ok(a !== -1 && b !== -1 && a < b, `${message}（「${first}」${a} /「${second}」${b}）`);
}

// ---- bot の辞書を読む --------------------------------------------------------------

/** 大項目のキーワード辞書（FAST_KEYWORD_MAP。大項目 → 語。並び順どおり） */
function readFastKeywordMap() {
  const block = blockOf(CLASSIFIER, 'const FAST_KEYWORD_MAP');
  const out = [];
  let current = null;
  for (const line of block.split('\n').slice(1, -1)) {
    const t = line.trim();
    if (t === '') continue;
    // 1 行に並べた大項目（'光熱費': ['電気', …],）
    const oneLine = t.match(/^'([^']+)':\s*\[((?:'[^']*',\s*)*'[^']*')\],?$/);
    if (oneLine && current === null) {
      out.push({ category: oneLine[1], keywords: [...oneLine[2].matchAll(/'([^']*)'/g)].map((m) => m[1]) });
      continue;
    }
    const header = t.match(/^'([^']+)':\s*\[$/);
    if (header) {
      current = { category: header[1], keywords: [] };
      out.push(current);
      continue;
    }
    if (/^\],?$/.test(t)) {
      current = null;
      continue;
    }
    assert.ok(current && /^(?:'[^']*',\s*)*'[^']*',?$/.test(t), `FAST_KEYWORD_MAP の決まった形でない行: ${t}`);
    for (const m of t.matchAll(/'([^']*)'/g)) current.keywords.push(m[1]);
  }
  assert.ok(out.length > 10 && out.every((c) => c.keywords.length > 0), 'FAST_KEYWORD_MAP を読めない');
  return out;
}

/** bot の normalizeForMatch と同じ手順（手順の行がソースにあることは別のテストで確かめる） */
function normalizeForMatch(s) {
  return s.slice(0, 100).normalize('NFKC').slice(0, 100).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 中項目の辞書（RAW_RULES。大項目 → 順番つきのグループ。語は normalizeForMatch 済み） */
function readSubCategoryRules() {
  const block = blockOf(RULES, 'const RAW_RULES');
  const parts = block.split(/\n {2}([^\s:]+): \[\n/);
  const out = {};
  for (let i = 1; i < parts.length; i += 2) {
    const segments = parts[i + 1].split(/\bsub: /).slice(1);
    out[parts[i]] = segments.map((seg) => {
      const list = (key) => {
        const m = seg.match(new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`));
        return m ? [...m[1].matchAll(/'([^']*)'/g)].map((x) => normalizeForMatch(x[1])) : [];
      };
      const sub = seg.match(/^'([^']+)'/);
      assert.ok(sub, `RAW_RULES の sub の形が想定と違う: ${seg.slice(0, 40)}`);
      return { sub: sub[1], keywords: list('keywords'), exact: list('exact'), mealTime: /\bmealTime:\s*true\b/.test(seg) };
    });
  }
  return out;
}

/** 中項目の一覧（SUB_CATEGORIES） */
function readSubCategories() {
  const block = blockOf(TAXONOMY, 'export const SUB_CATEGORIES');
  const out = {};
  for (const part of block.split(/\n {2}([^\s:]+): \[\n/).slice(1).reduce((acc, v, i, all) => (i % 2 === 0 ? [...acc, [v, all[i + 1]]] : acc), [])) {
    out[part[0]] = [...part[1].split('\n  ]')[0].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }
  return out;
}

/** テキストの入力から説明・金額を取り出す（bot の parseTextExpense の、デモの文例に関わる部分） */
function readTextParser() {
  const valid = [...blockOf(TEXT_PARSER, 'const VALID_CATEGORIES').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const payment = Object.keys(readFlatObject(blockOf(TEXT_PARSER, 'const PAYMENT_KEYWORDS')));
  assert.ok(valid.includes('食費') && payment.includes('カード'), 'VALID_CATEGORIES / PAYMENT_KEYWORDS を読めない');
  return (input) => {
    const tokens = input.trim().split(/\s+/);
    const amountIdx = tokens.findIndex((t) => /^\d+円?$/.test(t.replace(/,/g, '')));
    const rest = tokens.filter((_, i) => i !== amountIdx);
    return {
      amount: amountIdx === -1 ? null : Number(tokens[amountIdx].replace(/[,円]/g, '')),
      specified: rest.some((t) => valid.includes(t)),
      payment: rest.some((t) => payment.some((k) => k.toLowerCase() === t.toLowerCase())),
      description: rest.join(' '),
    };
  };
}

const FAST = readFastKeywordMap();
const SUB_RULES = readSubCategoryRules();
const SUB_CATEGORIES = readSubCategories();
const parseText = readTextParser();

/** 大項目のキーワード辞書で最初に当たる大項目（bot: fastLocalClassification） */
function majorByDictionary(description) {
  const desc = description.toLowerCase();
  for (const { category, keywords } of FAST) {
    if (keywords.some((k) => desc.includes(k.toLowerCase()))) return category;
  }
  return null;
}

/** 食事の時刻のルール（bot: mealOfJst の境目をソースから読む） */
const MEAL_RULES = [...bodyOf(RULES, 'mealOfJst').matchAll(/if \(hour >= (\d+) && hour <= (\d+)\) return '([^']+)';/g)].map((m) => ({
  from: Number(m[1]),
  to: Number(m[2]),
  sub: m[3],
}));
const MEAL_FALLBACK = bodyOf(RULES, 'mealOfJst').match(/\n\s*return '([^']+)';\n\}/)?.[1];
const mealOfHourFromBot = (hour) => MEAL_RULES.find((r) => hour >= r.from && hour <= r.to)?.sub ?? MEAL_FALLBACK;

/** 中項目の辞書で最初に当たるグループの中項目（bot: resolveSubCategory。usedAtHour は Gmail の時刻が分かるときだけ） */
function subByDictionary(major, text, source, usedAtHour) {
  const normalized = normalizeForMatch(text);
  const group = (SUB_RULES[major] ?? []).find((g) => g.exact.includes(normalized) || g.keywords.some((k) => normalized.includes(k)));
  if (!group) return null;
  const sub = group.mealTime && source === 'merchant' && usedAtHour !== undefined ? mealOfHourFromBot(usedAtHour) : group.sub;
  return { sub, group };
}

// ---- 確認カード ------------------------------------------------------------------------

test('判定元の表示名と注記の形は、bot の CATEGORY_ORIGIN_LABELS・categoryOriginNote と同じ', () => {
  assert.deepEqual({ ...L.CATEGORY_ORIGIN_LABELS }, readFlatObject(blockOf(FLEX, 'export const CATEGORY_ORIGIN_LABELS')));
  includes(FLEX, 'return origin ? `（${CATEGORY_ORIGIN_LABELS[origin]}）` : undefined;', 'categoryOriginNote');
  assert.equal(L.categoryOriginNote('dictionary'), '（辞書）');
  assert.equal(L.categoryOriginNote('jev'), '（Jev）');
});

test('カードの見出し（アイコン・文言・色）は、登録・カード利用・確定のそれぞれで bot と同じ', () => {
  const text = bodyOf(FLEX, 'buildTextExpenseFlexMessage');
  includes(text, `headerIconKey: '${L.CARD_HEADERS.text.iconKey}'`, 'buildTextExpenseFlexMessage');
  includes(text, `headerText: '${L.CARD_HEADERS.text.text}'`, 'buildTextExpenseFlexMessage');
  const gmail = bodyOf(FLEX, 'buildCardUsageFlexMessage');
  includes(gmail, `headerIconKey: '${L.CARD_HEADERS.gmail.iconKey}'`, 'buildCardUsageFlexMessage');
  includes(gmail, `headerText: '${L.CARD_HEADERS.gmail.text}'`, 'buildCardUsageFlexMessage');
  includes(gmail, `payer: '${L.CARD_TEXT.cardPayer}'`, 'buildCardUsageFlexMessage');
  // OK を押したあと: postback の replyUpdatedCard（アイコン）と handleConfirm（文言）
  includes(bodyOf(POSTBACK, 'replyUpdatedCard'), `headerIconKey: '${L.CARD_HEADERS.confirmed.iconKey}'`, 'replyUpdatedCard');
  includes(bodyOf(POSTBACK, 'handleConfirm'), `'${L.CARD_HEADERS.confirmed.text}'`, 'handleConfirm');
  includes(bodyOf(POSTBACK, 'handleConfirm'), 'decideConfirm()', 'handleConfirm');

  const card = bodyOf(FLEX, 'buildExpenseCard');
  const header = card.slice(card.indexOf('header: {'), card.indexOf('body: {'));
  assert.match(header, new RegExp(`text: headerText,\\s*weight: 'bold',\\s*size: 'md',\\s*color: '${L.CARD_COLORS.headerText}'`));
  includes(header, `backgroundColor: '${L.CARD_COLORS.headerBg}'`, 'buildExpenseCard の header');
  // 金額・日付
  assert.match(card, new RegExp(`text: \`¥\\$\\{amount\\.toLocaleString\\(\\)\\}\`,\\s*weight: 'bold',\\s*size: 'xl',\\s*color: '${L.CARD_COLORS.amount}'`));
  assert.match(card, new RegExp(`text: formatCardDate\\(date\\),\\s*size: 'sm',\\s*color: '${L.CARD_COLORS.date}'`));
  includes(bodyOf(FLEX, 'formatCardDate'), 'const matched = /^(\\d{4})-(\\d{1,2})-(\\d{1,2})$/.exec(date);', 'formatCardDate');
  includes(bodyOf(FLEX, 'formatCardDate'), 'return matched ? `${Number(matched[2])}/${Number(matched[3])}` : date;', 'formatCardDate');
  assert.equal(L.cardDate(DEMO_TODAY), '10/24');
  assert.equal(L.cardAmount(4000), '¥4,000');
});

test('下のボタン（アイコン・文言・強調）と OK の発言は bot と同じ並び', () => {
  const card = bodyOf(FLEX, 'buildExpenseCard');
  const buttons = [...card.matchAll(/iconActionButton\(\{\s*iconKey: '([^']+)',\s*label: '([^']+)',(?:\s*variant: '([^']+)',)?/g)].map((m) => [
    m[1],
    m[2],
    m[3] ?? 'secondary',
  ]);
  assert.deepEqual(
    buttons,
    Object.values(L.CARD_FOOTER).map((b) => [b.iconKey, b.label, b.variant])
  );
  includes(bodyOf(FLEX, 'iconActionButton'), "const variant = opts.variant ?? 'secondary';", 'iconActionButton');
  includes(
    bodyOf(FLEX, 'iconActionButton'),
    `? { bg: '${L.ICON_BUTTON_PALETTE.primary.bg}', text: '${L.ICON_BUTTON_PALETTE.primary.text}' }`,
    'iconActionButton'
  );
  includes(
    bodyOf(FLEX, 'iconActionButton'),
    `: { bg: '${L.ICON_BUTTON_PALETTE.secondary.bg}', text: '${L.ICON_BUTTON_PALETTE.secondary.text}' }`,
    'iconActionButton'
  );
  assert.match(card, new RegExp(`action: 'confirm', expenseId, source \\}\\),\\s*displayText: '${esc(L.CARD_TEXT.okDisplayText)}'`));
});

test('「現在の設定」: 見出し・4 行のラベルの並び・アイコン・文字の色・中項目の区切り・判定元の注記・行末のボタン', () => {
  const section = bodyOf(FLEX, 'buildCurrentSettingsSection');
  assert.match(section, new RegExp(`text: '${L.CARD_TEXT.sectionTitle}',\\s*size: 'xs',\\s*color: '${L.CARD_COLORS.sectionTitle}'`));
  assert.deepEqual(
    [...section.matchAll(/label: '([^']+)',\n\s*value:/g)].map((m) => m[1]),
    Object.values(L.CARD_TEXT.labels)
  );
  includes(section, 'iconUrl(derived.splitIconKey)', 'buildCurrentSettingsSection');
  includes(section, `iconUrl(payer === '${L.CARD_TEXT.cardPayer}' ? '${L.SETTING_ICONS.payerCard}' : '${L.SETTING_ICONS.payerMember}')`, 'buildCurrentSettingsSection');
  includes(section, `iconUrl('${L.SETTING_ICONS.advance}')`, 'buildCurrentSettingsSection');
  assert.match(section, new RegExp(`buttonLabel: '${L.CARD_TEXT.payerButton}',\\s*buttonTone: 'primary'`));
  includes(section, 'iconUrl: categoryIconUrl(category)', 'buildCurrentSettingsSection');
  includes(section, 'note: categoryOriginNote(categoryOrigin)', 'buildCurrentSettingsSection');
  includes(section, 'subValue: cardSubCategoryOf(category, subCategory),', 'buildCurrentSettingsSection');

  const row = bodyOf(FLEX, 'settingRow');
  includes(row, `{ type: 'span', text: \`\${opts.label}${L.CARD_TEXT.labelSuffix}\`, color: '${L.CARD_COLORS.label}' }`, 'settingRow');
  includes(row, `{ type: 'span', text: opts.value, color: '${L.CARD_COLORS.value}', weight: 'bold' }`, 'settingRow');
  includes(row, `{ type: 'span', text: '${L.CARD_TEXT.subSeparator}', color: '${L.CARD_COLORS.subSeparator}' }`, 'settingRow');
  includes(row, `{ type: 'span', text: opts.subValue, color: '${L.CARD_COLORS.value}', weight: 'bold' }`, 'settingRow');
  includes(row, `{ type: 'span', text: opts.note, size: 'xs', color: '${L.CARD_COLORS.note}' }`, 'settingRow');
  includes(row, `opts.buttonLabel ?? '${L.CARD_TEXT.categoryButton}'`, 'settingRow');

  // 支出区分・立替の表記とボタン（未確認・共同費）
  const derive = bodyOf(FLEX, 'deriveExpenseSettings');
  assert.match(derive, new RegExp(`splitIconKey: '${L.SETTING_ICONS.split}' as const,\\s*nextSplit: 'personal' as const,\\s*splitButtonLabel: '${L.CARD_TEXT.splitButton}',\\s*splitButtonTone: 'danger'`));
  assert.match(derive, new RegExp(`advanceLabel: '${esc(L.CARD_TEXT.noAdvance)}',\\s*nextAdvance: 'on' as const,\\s*advanceButtonLabel: '${L.CARD_TEXT.advanceButton}',\\s*advanceButtonTone: 'primary'`));
  assert.match(derive, new RegExp(`case 'shared':\\s*return \\{ splitLabel: '${L.CARD_TEXT.sharedSplit}', \\.\\.\\.shared, \\.\\.\\.noAdvance`));
  assert.match(derive, new RegExp(`default:[^]*?return \\{ splitLabel: '${esc(L.CARD_TEXT.pendingSplit)}', \\.\\.\\.shared, \\.\\.\\.noAdvance`));

  // 行末のボタンの色
  const tones = blockOf(FLEX, 'const ACTION_TONE_COLORS');
  for (const [tone, c] of Object.entries(L.ACTION_TONE_COLORS)) {
    includes(tones, `${tone}: { background: '${c.background}', text: '${c.text}' }`, 'ACTION_TONE_COLORS');
  }
});

test('カテゴリのアイコンは bot の CATEGORY_ICON_KEY と同じ。デモで使うアイコンの PNG がある', () => {
  const botIcons = readFlatObject(blockOf(FLEX, 'const CATEGORY_ICON_KEY'));
  for (const [category, key] of Object.entries(L.CATEGORY_ICON_KEYS)) {
    assert.equal(botIcons[category], key, category);
  }
  const used = new Set([
    ...Object.values(L.CARD_HEADERS).map((h) => h.iconKey),
    ...Object.values(L.CARD_FOOTER).map((b) => b.iconKey),
    ...Object.values(L.SETTING_ICONS),
    ...Object.values(L.CATEGORY_ICON_KEYS),
    S.SUMMARY_TEXT.headerIconKey,
  ]);
  for (const key of used) {
    assert.ok(existsSync(new URL(`../public/icons/${key}.png`, import.meta.url)), `web/public/icons/${key}.png が無い`);
  }
});

test('カードの中身: 文例のカード（未確認・辞書）、確定のカード（共同費・判定元なし）、カード利用のカード（カード・Jev）', () => {
  const rows = (card) => card.settings.map((r) => [r.iconKey, r.label, r.value, r.subValue ?? null, r.note ?? null, r.buttonLabel, r.buttonTone]);
  const lunch = L.DEMO_CHAT_EXAMPLES[0];
  const text = L.textExpenseCard(lunch, DEMO_TODAY);
  assert.deepEqual(
    [text.headerIconKey, text.headerText, text.title, text.amountText, text.dateText],
    ['receipt', '支出を登録しました', 'ランチ', '¥850', '10/24']
  );
  assert.deepEqual(rows(text), [
    ['users', '支出区分', '共同費（未確認）', null, null, '除外', 'danger'],
    ['wallet', '支払った人', 'Aさん', null, null, '自分が払った', 'primary'],
    ['hand-coins', '立替', 'なし（折半）', null, null, '自分が立替', 'primary'],
    ['cat-food', 'カテゴリ', '食費', '昼ご飯', '（辞書）', '変更', 'primary'],
  ]);
  const confirmed = L.confirmedTextCard(lunch, DEMO_TODAY);
  assert.deepEqual([confirmed.headerIconKey, confirmed.headerText], ['check', '登録を確定しました']);
  assert.deepEqual(rows(confirmed)[0], ['users', '支出区分', '共同費', null, null, '除外', 'danger']);
  assert.deepEqual(rows(confirmed)[3], ['cat-food', 'カテゴリ', '食費', '昼ご飯', null, '変更', 'primary']);
  // 確定のカードは保存した値から作り直すので、判定元を出さない（buildExpenseCardFromRecord は categoryOrigin を渡さない）
  assert.doesNotMatch(bodyOf(FLEX, 'buildExpenseCardFromRecord'), /categoryOrigin/);

  const gmail = L.cardUsageCard();
  assert.deepEqual(
    [gmail.headerIconKey, gmail.headerText, gmail.title, gmail.amountText, gmail.dateText],
    ['credit-card', 'カード利用を記録', 'サンプル食堂', '¥1,280', '10/24']
  );
  assert.deepEqual(rows(gmail), [
    ['users', '支出区分', '共同費', null, null, '除外', 'danger'],
    ['credit-card', '支払った人', 'カード', null, null, '自分が払った', 'primary'],
    ['hand-coins', '立替', 'なし（折半）', null, null, '自分が立替', 'primary'],
    ['cat-food', 'カテゴリ', '食費', '昼ご飯', '（Jev）', '変更', 'primary'],
  ]);
});

test('中項目と判定元は、保存・カードの組み立て・「現在の設定」の行まで渡される（受け渡しが抜けるとカードに出ない）', () => {
  // 分割代入の行（const { …, categoryOrigin, … } = info）と取り違えないよう、呼び出しの引数の行（単独の `name,`）だけを見る
  const passes = (source, name) => new RegExp(`^\\s*${name},(?:\\s*//.*)?$`, 'm').test(source);
  const callOf = (body, call) => {
    const start = body.indexOf(call);
    const end = body.indexOf('\n  });', start);
    assert.ok(start !== -1 && end !== -1, `${call} の呼び出しが読めない`);
    return body.slice(start, end);
  };
  for (const fn of ['buildTextExpenseFlexMessage', 'buildCardUsageFlexMessage']) {
    const call = callOf(bodyOf(FLEX, fn), 'return buildExpenseCard({');
    for (const name of ['subCategory', 'categoryOrigin']) assert.ok(passes(call, name), `${fn} が buildExpenseCard に ${name} を渡していない`);
  }
  includes(
    bodyOf(FLEX, 'buildExpenseCard'),
    'buildCurrentSettingsSection({ expenseId, source, category, subCategory, categoryOrigin, status, advanceFull, payer })',
    'buildExpenseCard'
  );
  // LINE の入力: 登録のカードの情報（textExpenseInfo）に中項目と判定元を入れる
  const infoStart = EXPENSE_FLOW.indexOf('const textExpenseInfo: TextExpenseInfo = {');
  const infoEnd = EXPENSE_FLOW.indexOf('\n      };', infoStart);
  assert.ok(infoStart !== -1 && infoEnd !== -1, 'textExpenseInfo が読めない');
  const infoBlock = EXPENSE_FLOW.slice(infoStart, infoEnd);
  for (const name of ['subCategory', 'categoryOrigin']) assert.ok(passes(infoBlock, name), `textExpenseInfo に ${name} が無い`);
  includes(EXPENSE_FLOW, 'await sendTextExpenseNotification(targetId, textExpenseInfo, replyToken);', 'expenseFlow.ts');
  // カード利用: 通知の情報（cardUsageOf）に中項目と判定元を入れ、保存した中項目を渡す
  const usage = bodyOf(GMAIL_HANDLER, 'cardUsageOf');
  for (const name of ['subCategory', 'categoryOrigin']) assert.ok(passes(usage, name), `cardUsageOf に ${name} が無い`);
  includes(GMAIL_HANDLER, 'cardUsageOf(parsed, category, expense.subCategory, categoryOrigin)', 'gmail/handler.ts');
});

// ---- 文例（LINE の手入力） --------------------------------------------------------------

test('辞書の照合の手順は、bot のソースと同じ（テストで再現している手順の行がある）', () => {
  includes(bodyOf(CLASSIFIER, 'fastLocalClassification'), 'const desc = description.toLowerCase();', 'fastLocalClassification');
  includes(bodyOf(CLASSIFIER, 'fastLocalClassification'), 'if (desc.includes(keyword.toLowerCase())) {', 'fastLocalClassification');
  includes(bodyOf(CLASSIFIER, 'fastLocalClassification'), 'return { category, confidence: 0.8 };', 'fastLocalClassification');
  includes(EXPENSE_FLOW, 'const CLASSIFY_MIN_CONFIDENCE = 0.4;', 'expenseFlow.ts');
  // テキストの入力は キャッシュ → 辞書 → モデル（辞書で決まれば判定元は辞書）
  const classify = bodyOf(CLASSIFIER, 'classifyExpense');
  assert.match(classify, /provider: 'dictionary'/);
  assertBefore(
    classify,
    'const local = byKeyword();\n  if (local) return remember(local);',
    'const byModel = await classifyWithModels(lineId, description, source);\n  return byModel',
    'テキストの入力で、辞書がモデルより先でない'
  );
  // 中項目: 揃えてから、最初に当たったグループ。テキストは時刻を渡さない
  const normalize = bodyOf(RULES, 'normalizeForMatch');
  for (const step of ['.slice(0, MATCH_INPUT_MAX)', ".normalize('NFKC')", '.toLowerCase()', ".replace(/[^\\p{L}\\p{N}]/gu, '')"]) includes(normalize, step, 'normalizeForMatch');
  includes(RULES, 'const MATCH_INPUT_MAX = 100;', 'subCategoryRules.ts');
  includes(bodyOf(RULES, 'matches'), 'return (group.exact?.includes(normalized) ?? false) || group.keywords.some((k) => normalized.includes(k));', 'matches');
  includes(bodyOf(RULES, 'resolveSubCategory'), "if (group.mealTime === true && source === 'merchant' && isValidDate(usedAt)) {", 'resolveSubCategory');
  includes(EXPENSE_FLOW, 'resolveSubCategory({ major: category, text: description, source: "text" })', 'textSubCategoryOf');

  // 読み取りと再現が働くこと（ソースのコメントにある例）
  assert.equal(subByDictionary('食費', 'コンビニ ランチ', 'text')?.sub, '昼ご飯');
  assert.equal(subByDictionary('食費', 'コンビニ弁当', 'text')?.sub, 'コンビニ');
  assert.equal(subByDictionary('娯楽', 'ドライブ', 'text')?.sub, 'レジャー・テーマパーク');
  assert.equal(subByDictionary('娯楽', 'ウイスキー', 'text'), null);
  assert.equal(majorByDictionary('温泉'), '旅行'); // 娯楽より先に旅行が当たる
  assert.equal(majorByDictionary('ガス代'), '光熱費');
  assert.deepEqual(Object.keys(SUB_RULES), Object.keys(SUB_CATEGORIES));
  assert.deepEqual(MEAL_RULES.map((r) => r.sub), ['朝ご飯', '昼ご飯']);
  assert.equal(MEAL_FALLBACK, '夜ご飯');
});

test('文例は、bot の辞書で書いたとおりの大項目（判定元は辞書）と中項目に決まる', () => {
  assert.ok(L.DEMO_CHAT_EXAMPLES.length >= 3);
  assert.equal(new Set(L.DEMO_CHAT_EXAMPLES.map((e) => e.key)).size, L.DEMO_CHAT_EXAMPLES.length);
  for (const ex of L.DEMO_CHAT_EXAMPLES) {
    const parsed = parseText(ex.text);
    assert.deepEqual(
      [parsed.description, parsed.amount, parsed.specified, parsed.payment],
      [ex.description, ex.amount, false, false],
      `${ex.text}: 説明・金額の取り出し（カテゴリ名・支払い方法の語を含めない）`
    );
    assert.equal(majorByDictionary(ex.description), ex.category, `${ex.text}: 大項目が辞書で決まらない`);
    const resolved = subByDictionary(ex.category, ex.description, 'text');
    assert.equal(resolved?.sub, ex.subCategory, `${ex.text}: 中項目`);
    assert.ok(SUB_CATEGORIES[ex.category]?.includes(ex.subCategory), `${ex.text}: ${ex.subCategory} が bot の中項目の一覧に無い`);
    assert.doesNotMatch(ex.subCategory, /^その他の/);
  }
  // 目次の LINE の説明に出す文例は、送れる文例のひとつ
  const line = demoScenes.find((s) => s.key === 'line');
  assert.ok(line && line.description.includes(`「${L.DEMO_CHAT_EXAMPLES[0].text}」`), line?.description);
});

// ---- カード利用の取込（Gmail） --------------------------------------------------------------

test('カード利用のメールは bot の読み取りで読める。店名は辞書で飲食店に当たり、利用時刻で中項目が決まる', () => {
  const body = L.cardEmailLines().join('\n');
  const AMOUNT = String.raw`(?:ご利用金額|◇利用金額)[：:]\s*([\d,]+)\s*円`;
  const MERCHANT = String.raw`(?:ご利用店名|◇利用先)[：:]\s*(.+?)(?:\n|\r|$)`;
  const USED_AT = String.raw`(?:ご利用日時|◇利用日)[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2})\s*(\d{1,2}:\d{2})?`;
  for (const re of [AMOUNT, MERCHANT, USED_AT]) includes(GMAIL_PARSER, `/${re}/`, 'gmail/parser.ts');
  assert.equal(Number(new RegExp(AMOUNT).exec(body)?.[1].replace(/,/g, '')), L.DEMO_CARD_EMAIL.amount);
  assert.equal(new RegExp(MERCHANT).exec(body)?.[1].trim(), L.DEMO_CARD_EMAIL.merchant);
  const usedAt = new RegExp(USED_AT).exec(body);
  assert.deepEqual([usedAt?.[1], usedAt?.[2]], [L.DEMO_CARD_EMAIL.usedAt.date, L.DEMO_CARD_EMAIL.usedAt.time]);
  assert.equal(L.cardEmailDate(), DEMO_TODAY);

  // 中項目: 時刻の分かるメールだけ usedAt を渡す（Gmail の店名は source: 'merchant'）
  includes(bodyOf(GMAIL_HANDLER, 'merchantSubCategoryOf'), "source: 'merchant',", 'merchantSubCategoryOf');
  includes(bodyOf(GMAIL_HANDLER, 'merchantSubCategoryOf'), 'usedAt: parsed.usedAtHasTime ? parsed.usedAt : undefined,', 'merchantSubCategoryOf');
  const hour = Number(L.DEMO_CARD_EMAIL.usedAt.time.split(':')[0]);
  const resolved = subByDictionary(L.DEMO_CARD_RESULT.category, L.DEMO_CARD_EMAIL.merchant, 'merchant', hour);
  assert.ok(resolved?.group.mealTime, '店名が飲食店のグループに当たらない');
  assert.ok(resolved.group.keywords.includes(normalizeForMatch(L.DEMO_CARD_RESULT.matchedKeyword)), '当たる語が飲食店のグループに無い');
  assert.ok(L.DEMO_CARD_EMAIL.merchant.includes(L.DEMO_CARD_RESULT.matchedKeyword));
  assert.equal(resolved.sub, L.DEMO_CARD_RESULT.subCategory);
  assert.ok(SUB_CATEGORIES[L.DEMO_CARD_RESULT.category].includes(L.DEMO_CARD_RESULT.subCategory));
  // 時刻なしなら外食のまま（デモの説明の前提）
  assert.equal(subByDictionary(L.DEMO_CARD_RESULT.category, L.DEMO_CARD_EMAIL.merchant, 'merchant')?.sub, '外食');

  // 時刻の帯と、デモの mealOfHour は bot の mealOfJst と同じ境目
  for (let h = 0; h < 24; h++) assert.equal(L.mealOfHour(h), mealOfHourFromBot(h), `${h} 時`);
  for (const band of L.MEAL_BANDS) {
    assert.equal(L.mealOfHour(band.fromHour), band.sub);
    assert.equal(L.mealOfHour(band.toHour), band.sub);
    assert.equal(band.range, `${String(band.fromHour).padStart(2, '0')}:00〜${String(band.toHour).padStart(2, '0')}:59`);
  }
});

test('カード利用の通知: 店名はモデルを先に使う。共同費で入り、残り予算の行は本番の通知に無い', () => {
  // classifyExpense の店名: キャッシュ → モデル（Jev → Gemini）→ 辞書
  const classify = bodyOf(CLASSIFIER, 'classifyExpense');
  const merchant = classify.slice(classify.indexOf("if (source === 'merchant') {"));
  assertBefore(merchant, 'await classifyWithModels(lineId, description, source)', 'const local = byKeyword();', '店名で、モデルが辞書より先でない');
  assertBefore(classify, 'classificationCache.get(cacheKey)', "if (source === 'merchant') {", 'キャッシュが先でない');
  const models = bodyOf(CLASSIFIER, 'classifyWithModels');
  assertBefore(models, 'await classifyWithJev(', 'await classifyWithGemini(', 'Jev が Gemini より先でない');
  assert.deepEqual([...L.MERCHANT_CLASSIFY_ORDER], ['キャッシュ', L.CATEGORY_ORIGIN_LABELS.jev, L.CATEGORY_ORIGIN_LABELS.gemini, L.CATEGORY_ORIGIN_LABELS.dictionary]);
  assert.equal(L.DEMO_CARD_RESULT.origin, 'jev');

  const usage = bodyOf(GMAIL_HANDLER, 'cardUsageOf');
  includes(usage, "status: 'shared',", 'cardUsageOf');
  // 本番は残り予算を渡さない（渡すようになったら、デモのカードにも「残り予算」の行を足す）
  assert.doesNotMatch(usage, /remainingBudget/);
});

test('架空のデータ: メールの差出人は .example、店は「サンプル」、カードの名前・実在の店名らしい語が無い', () => {
  assert.match(L.DEMO_CARD_EMAIL.from, /^[a-z]+@[a-z.-]+\.example$/);
  assert.match(L.DEMO_CARD_EMAIL.merchant, /^サンプル/);
  const strings = [
    ...Object.values(L.DEMO_CARD_EMAIL).flatMap((v) => (typeof v === 'object' ? Object.values(v) : [v])),
    ...L.cardEmailLines(),
    ...L.DEMO_CHAT_EXAMPLES.flatMap((e) => [e.text, e.description]),
    L.DEMO_LINE_GROUP.name,
    L.DEMO_BOT_NAME,
  ].map(String);
  const ALLOWED_KATAKANA = new Set(['サンプル', 'カード', 'ランチ', 'カフェ', 'カラオケ']);
  const BANNED = /visa|master|jcb|amex|diners|smbc|三井|住友|ゴールド|プラチナ|セブン|ローソン|ファミ|イオン|スタバ|マクド|amazon|楽天|google|apple/i;
  for (const s of strings) {
    assert.doesNotMatch(s, BANNED, s);
    assert.doesNotMatch(s, /:\/\/|www\./, s);
    for (const word of s.match(/[ァ-ヶー]{2,}/g) ?? []) assert.ok(ALLOWED_KATAKANA.has(word), `「${word}」（${s}）`);
    if (s !== L.DEMO_CARD_EMAIL.from) assert.doesNotMatch(s, /@/, s);
  }
});

// ---- 精算サマリー ----------------------------------------------------------------------------

const PERIOD = DEMO_MONTHS[DEMO_DEFAULT_MONTH_INDEX - 1];
const SPLIT = computePeriodSplit({
  expenses: DEMO_EXPENSES,
  groupId: DEMO_HOUSEHOLD_ID,
  members: DEMO_MEMBERS,
  targetLineId: DEMO_MEMBER_A,
  range: PERIOD.range,
});
const DEMO_SUMMARY = S.buildDemoSettlementSummary({
  range: PERIOD.range,
  members: DEMO_MEMBERS,
  split: SPLIT,
  pool: periodPool(DEMO_EXPENSES, DEMO_HOUSEHOLD_ID, PERIOD.range),
});

test('精算サマリーの色・見出し・ボタン・送る時刻は bot と同じ', () => {
  assert.deepEqual({ ...S.SUMMARY_COLORS }, readFlatObject(blockOf(SUMMARY_MESSAGE, 'const COLOR')));
  const flex = bodyOf(SUMMARY_MESSAGE, 'buildSettlementSummaryFlex');
  includes(flex, `{ type: 'icon', url: iconUrl('${S.SUMMARY_TEXT.headerIconKey}'), size: 'md' }`, 'buildSettlementSummaryFlex');
  includes(flex, `{ type: 'text', text: '${S.SUMMARY_TEXT.header}', weight: 'bold', size: 'md', color: COLOR.accent, margin: 'sm' }`, 'buildSettlementSummaryFlex');
  includes(flex, "{ type: 'text', text: label, size: 'sm', weight: 'bold', color: COLOR.accentDeep, margin: 'xs' }", 'buildSettlementSummaryFlex');
  includes(flex, `text: '${S.SUMMARY_TEXT.categories}'`, 'buildSettlementSummaryFlex');
  includes(flex, `row('${S.SUMMARY_TEXT.half}', formatYenExact(split.half))`, 'buildSettlementSummaryFlex');
  includes(flex, `: '${S.SUMMARY_TEXT.noTransfer}'`, 'buildSettlementSummaryFlex');
  includes(flex, `linkButton('${S.SUMMARY_TEXT.openSettlement}', SETTLEMENT_URL, true)`, 'buildSettlementSummaryFlex');
  includes(flex, `linkButton('${S.SUMMARY_TEXT.openExpenses}', \`\${WEB_APP_BASE}/expenses\`, false)`, 'buildSettlementSummaryFlex');
  includes(bodyOf(SUMMARY_MESSAGE, 'linkButton'), "color: primary ? COLOR.accent : '#F1F5F9',", 'linkButton');
  includes(SUMMARY, `export const SUMMARY_TOP_CATEGORIES = ${S.SUMMARY_TOP_CATEGORIES};`, 'settlementSummary.ts');
  // 毎日 9:10（JST）の実行で、起算日なら送る
  const [hh, mm] = S.SUMMARY_SEND_TIME.split(':');
  includes(INDEX, `schedule: "${Number(mm)} ${Number(hh)} * * *",`, 'index.ts の postRecurringExpenses');
  includes(bodyOf(SUMMARY_MESSAGE, 'periodLabel'), 'return sy === ey ? `${sm}/${sd}〜${em}/${ed}` : `${sy}/${sm}/${sd}〜${ey}/${em}/${ed}`;', 'periodLabel');
  assert.deepEqual([S.periodLabel(PERIOD.range), S.periodLabel({ startDate: '2026-12-15', endDate: '2027-01-14' })], ['9/1〜9/30', '2026/12/15〜2027/1/14']);
});

test('精算サマリーの文言の組み立ては bot と同じ（デモの出力を固定し、bot の組み立ての式があることを確かめる）', () => {
  const flex = bodyOf(SUMMARY_MESSAGE, 'buildSettlementSummaryFlex');
  for (const snippet of [
    '`${split.count}件`',
    "split.excludedCount > 0 ? `除外${split.excludedCount}件` : ''",
    "split.settledCount > 0 ? `立替精算済み${split.settledCount}件` : ''",
    "split.advanceCount > 0 ? `立替${split.advanceCount}件は全額で別` : ''",
    ".join('・')",
    'row(`合計（${countLabel}）`, yen(split.total))',
    'row(`− ${targetName}の支払い`, yen(split.targetPaid))',
    'row(`+ ${counterpartName}の立替（全額）`, yen(split.counterpartAdvanced))',
    'row(`− ${targetName}の立替（全額）`, yen(split.targetAdvanced))',
    'row(`${counterpartName}・カード・共通口座の支払い`, yen(summary.othersPaid), { muted: true, bold: false })',
    'text: transfer ? `${fromName}  →  ${toName}` : `${targetName}・${counterpartName}`,',
    ': `${fromName}が${toName}に送金`',
    'text: `ほか ${summary.otherCategories.count}カテゴリ ${yen(summary.otherCategories.amount)}`,',
    '`要確認が ${summary.pending.count}件（${yen(summary.pending.amount)}）あります。確認すると、この期間の合計に入ります`',
  ]) {
    includes(flex, snippet, 'buildSettlementSummaryFlex');
  }
  const categoryRow = bodyOf(SUMMARY_MESSAGE, 'categoryRow');
  includes(categoryRow, "{ type: 'text', text: `${percentage}%`, size: 'xxs', color: COLOR.muted, flex: 0, gravity: 'center', margin: 'sm' }", 'categoryRow');
  includes(categoryRow, "{ type: 'text', text: yen(amount), size: 'sm', weight: 'bold', color: COLOR.text, align: 'end', flex: 0, margin: 'md' }", 'categoryRow');
  includes(categoryRow, 'width: `${Math.max(2, Math.min(100, Math.round(percentage)))}%`,', 'categoryRow');
  const messages = bodyOf(SUMMARY_MESSAGE, 'buildSettlementSummaryMessages');
  includes(messages, '`${label} の精算（折半）です。\\n{u1} から {u2} へ ${yen(transfer.amount)} の送金をお願いします。`', 'buildSettlementSummaryMessages');
  includes(messages, '`{u1} {u2}\\n${label} の精算（折半）は、今回は送金なしです。`', 'buildSettlementSummaryMessages');
  includes(bodyOf(SUMMARY_MESSAGE, 'yen'), "return `¥${Math.round(n).toLocaleString('ja-JP')}`;", 'yen');

  // 9月分（Aさんが集金するメンバー）。送金額は精算の画面（demoData.test.mjs）と同じ
  assert.deepEqual(DEMO_SUMMARY.text, [
    { text: '9/1〜9/30 の精算（折半）です。\n' },
    { mention: 'Aさん' },
    { text: ' から ' },
    { mention: 'Bさん' },
    { text: ' へ ¥56,620 の送金をお願いします。' },
  ]);
  const f = DEMO_SUMMARY.flex;
  assert.deepEqual([f.people, f.amount, f.caption], ['Aさん  →  Bさん', '¥56,620', 'AさんがBさんに送金']);
  assert.deepEqual(f.rows, [
    { label: '合計（21件・除外1件）', value: '¥157,080' },
    { label: '1人あたり（÷ 2）', value: '¥78,540' },
    { label: '− Aさんの支払い', value: '¥21,920' },
  ]);
  assert.deepEqual(f.othersRow, { label: 'Bさん・カード・共通口座の支払い', value: '¥135,160' });
  assert.deepEqual(
    f.categories.map((c) => [c.category, c.amountText, c.percentage]),
    [
      ['住居費', '¥64,870', 41.3],
      ['食費', '¥46,000', 29.3],
      ['娯楽', '¥20,430', 13],
      ['通信費', '¥9,140', 5.8],
      ['光熱費', '¥8,970', 5.7],
    ]
  );
  assert.equal(f.others, 'ほか 3カテゴリ ¥7,670');
  assert.equal(f.pending, null);
  // カテゴリ別と「ほか」を足すと合計になる
  assert.equal(f.categories.reduce((sum, c) => sum + c.amount, 0) + 7670, SPLIT.total);

  // 10月（立替・要確認あり）の組み立て: 立替の行と要確認の注意
  const oct = DEMO_MONTHS[DEMO_DEFAULT_MONTH_INDEX];
  const octSummary = S.buildDemoSettlementSummary({
    range: oct.range,
    members: DEMO_MEMBERS,
    split: computePeriodSplit({ expenses: DEMO_EXPENSES, groupId: DEMO_HOUSEHOLD_ID, members: DEMO_MEMBERS, targetLineId: DEMO_MEMBER_A, range: oct.range }),
    pool: periodPool(DEMO_EXPENSES, DEMO_HOUSEHOLD_ID, oct.range),
  });
  assert.equal(octSummary.flex.rows[0].label, '合計（23件・除外3件・立替1件は全額で別）');
  assert.deepEqual(octSummary.flex.rows.at(-1), { label: '− Aさんの立替（全額）', value: '¥7,860' });
  assert.equal(octSummary.flex.pending, '要確認が 2件（¥4,070）あります。確認すると、この期間の合計に入ります');
});

test('精算サマリーの数え方（折半の対象・要確認・割合・上位 5 つ）は bot と同じ', () => {
  includes(bodyOf(PERIOD_SPLIT, 'isSplitCounted'), "return e.includeInTotal === true && e.status !== 'advance_settled' && !isFullAdvance(e);", 'isSplitCounted');
  includes(bodyOf(PERIOD_SPLIT, 'isFullAdvance'), "return e.status === 'advance_pending' && e.advanceFull === true;", 'isFullAdvance');
  const pending = bodyOf(SUMMARY, 'isPendingManual');
  includes(pending, "if (e.inputSource === 'gmail_auto' || e.inputSource === 'recurring') return false;", 'isPendingManual');
  includes(pending, "return (e.status == null || e.status === 'pending') && e.confirmed !== true;", 'isPendingManual');
  const build = bodyOf(SUMMARY, 'buildSettlementSummary');
  // bot は旧名（娯楽費など）を正準名にまとめて数える（#243）。デモの写しは保存された名前のまま数えるが、
  // デモの支出は正準名だけなので結果は同じ（正準名は toCanonicalCategoryName でそのまま）
  includes(build, "const category = typeof e.category === 'string' && e.category ? toCanonicalCategoryName(e.category) : 'その他';", 'buildSettlementSummary');
  for (const e of DEMO_EXPENSES) {
    assert.ok(CANONICAL_CATEGORIES.includes(e.category), `デモの支出 ${e.id} のカテゴリ「${e.category}」が正準名でない`);
  }
  includes(build, 'percentage: split.total > 0 ? Math.round((amount / split.total) * 1000) / 10 : 0,', 'buildSettlementSummary');
  includes(build, '.sort((a, b) => b.amount - a.amount);', 'buildSettlementSummary');
  includes(build, 'const rest = sorted.slice(SUMMARY_TOP_CATEGORIES);', 'buildSettlementSummary');
  includes(build, 'othersPaid: split.total - split.targetPaid,', 'buildSettlementSummary');
  includes(bodyOf(PERIOD_SPLIT, 'formatYenExact'), "return `¥${rounded.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`;", 'formatYenExact');
  // 金額は数値にできなければ 0（bot: amountOf）。カテゴリ別・要確認の合計に NaN を出さない
  includes(bodyOf(PERIOD_SPLIT, 'amountOf'), 'return Number.isFinite(n) ? n : 0;', 'amountOf');
  includes(build, 'byCategory.set(category, (byCategory.get(category) ?? 0) + amountOf(e));', 'buildSettlementSummary');
  includes(build, 'pending: { count: pending.length, amount: pending.reduce((sum, e) => sum + amountOf(e), 0) },', 'buildSettlementSummary');
  const broken = S.buildDemoSettlementSummary({
    range: PERIOD.range,
    members: DEMO_MEMBERS,
    split: { ...SPLIT, total: 1000 },
    pool: [
      { amount: 1000, category: '食費', includeInTotal: true, status: 'shared' },
      { amount: 'x', category: '食費', includeInTotal: true, status: 'shared' },
      { amount: 500, category: '日用品', includeInTotal: false, inputSource: 'line_text' },
      { amount: undefined, category: '日用品', includeInTotal: false, inputSource: 'line_text' },
    ],
  });
  assert.deepEqual(broken.flex.categories.map((c) => [c.category, c.amountText]), [['食費', '¥1,000']]);
  assert.equal(broken.flex.pending, '要確認が 2件（¥500）あります。確認すると、この期間の合計に入ります');
  assert.deepEqual([S.formatYenExact(78540), S.formatYenExact(160426.5)], ['¥78,540', '¥160,426.5']);
});
