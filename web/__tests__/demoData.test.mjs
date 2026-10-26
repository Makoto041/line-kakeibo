// デモ（/demo）の架空データ（lib/demo/demoData.ts）と場面の一覧（lib/demo/demoScenes.ts）のテスト。
// 画面に出る主な数字（合計・支払った人ごとの合計・送金額）を、本番と同じ純関数に通した結果で固定する。
// 架空と分かるデータであること（LINE の ID の形でない・URL やレシートが無い・実在の店名らしい名前が無い）も確かめる。
// 発表後に /demo と一緒に消す。node --test で実行する（型除去で .ts を直接読む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEMO_BUDGET,
  DEMO_CARD_ID,
  DEMO_DEFAULT_MONTH_INDEX,
  DEMO_EXPENSES,
  DEMO_HOUSEHOLD_ID,
  DEMO_MEMBER_A,
  DEMO_MEMBER_B,
  DEMO_MEMBERS,
  DEMO_MONTHS,
  DEMO_NOW,
  DEMO_SHARED_ACCOUNT_ID,
  DEMO_TODAY,
  demoStats,
} from '../lib/demo/demoData.ts';
import { DEMO_INDEX_HREF, demoScenes, sceneIndexOf } from '../lib/demo/demoScenes.ts';
import {
  GMAIL_SYSTEM_LINE_ID,
  RECURRING_SYSTEM_LINE_ID,
  countPending,
  isPending,
  resolvePayerName,
  summarizeExpenses,
} from '../lib/expenseState.ts';
import { collectHistoricalUsers } from '../lib/expenseEdit.ts';
import { computePeriodSplit, isFullAdvance } from '../lib/periodSplit.ts';
import { computePeriodInsights } from '../lib/budgetAnalytics.ts';
import { toDrillItems, groupDrill } from '../lib/drilldown.ts';
import { subCategoriesOf } from '../lib/categoryTaxonomy.ts';

const [AUG, SEP, OCT] = DEMO_MONTHS;
const inMonth = (m) => DEMO_EXPENSES.filter((e) => e.date >= m.range.startDate && e.date <= m.range.endDate);
const users = collectHistoricalUsers(DEMO_EXPENSES);
const payerName = (e) => resolvePayerName(e, users);
const split = (m, target) =>
  computePeriodSplit({ expenses: DEMO_EXPENSES, groupId: DEMO_HOUSEHOLD_ID, members: DEMO_MEMBERS, targetLineId: target, range: m.range });

test('月と「今日」: 2026年8〜10月、最初に開くのは10月、今日は10月24日で固定', () => {
  assert.deepEqual(
    DEMO_MONTHS.map((m) => [m.title, m.range.startDate, m.range.endDate, m.range.mode]),
    [
      ['2026年8月', '2026-08-01', '2026-08-31', 'monthly'],
      ['2026年9月', '2026-09-01', '2026-09-30', 'monthly'],
      ['2026年10月', '2026-10-01', '2026-10-31', 'monthly'],
    ]
  );
  assert.equal(DEMO_MONTHS[DEMO_DEFAULT_MONTH_INDEX], OCT);
  assert.equal(DEMO_TODAY, '2026-10-24');
  assert.deepEqual([DEMO_NOW.getFullYear(), DEMO_NOW.getMonth() + 1, DEMO_NOW.getDate()], [2026, 10, 24]);
  // すべての支出がどれかの月に入り、10月は「今日」より後の日付が無い
  for (const e of DEMO_EXPENSES) {
    assert.ok(DEMO_MONTHS.some((m) => e.date >= m.range.startDate && e.date <= m.range.endDate), `${e.id} ${e.date}`);
    assert.ok(e.date <= DEMO_TODAY, `${e.id} ${e.date} が今日より後`);
  }
});

test('ホームの数字: 月の合計・件数・カテゴリ別（合計に含むものだけ）', () => {
  assert.deepEqual(
    DEMO_MONTHS.map((m) => {
      const s = demoStats(DEMO_EXPENSES, m.range);
      return [s.totalAmount, s.expenseCount];
    }),
    [
      [164470, 19],
      [157080, 21],
      [150540, 24],
    ]
  );
  const oct = demoStats(DEMO_EXPENSES, OCT.range);
  assert.deepEqual(oct.categoryTotals, {
    住居費: 64870,
    サブスク: 1190,
    食費: 42010,
    日用品: 4520,
    光熱費: 9410,
    衣服: 7860,
    通信費: 9140,
    娯楽: 7600,
    交通費: 3940,
  });
  assert.equal(Object.values(oct.dailyTotals).reduce((a, b) => a + b, 0), oct.totalAmount);
  // 判断インサイト（デモの予算・10月24日時点）
  const insights = computePeriodInsights({
    stats: oct,
    prevStats: demoStats(DEMO_EXPENSES, SEP.range),
    monthlyBudget: DEMO_BUDGET.monthlyBudget,
    range: OCT.range,
    mode: 'monthly',
    now: DEMO_NOW,
  });
  assert.deepEqual(
    [insights.budgetPct, insights.budgetRemaining, insights.daysLeft, insights.perDayAvailable, insights.momPct],
    [77, 45760, 7, 6537, -4]
  );
});

test('内訳: 10月の食費・娯楽は中項目の段が出る（中項目が 2 種類以上）', () => {
  const items = toDrillItems(DEMO_EXPENSES, {
    range: OCT.range,
    included: (e) => !!e.includeInTotal,
    payer: (e) => ({ key: payerName(e), name: payerName(e) }),
    pending: isPending,
    subCategoriesOf,
  }).filter((i) => i.included);
  for (const category of ['食費', '娯楽']) {
    const subs = groupDrill(items.filter((i) => i.category === category), 'subCategory');
    assert.ok(subs.length >= 2, `${category}: ${subs.map((g) => g.key).join(', ')}`);
    assert.ok(subs.every((g) => g.key !== '中項目なし'), `${category} に中項目なしがある`);
  }
  assert.deepEqual(
    groupDrill(items.filter((i) => i.category === '食費'), 'subCategory').map((g) => [g.key, g.total]),
    [
      ['食料品（スーパー）', 20300],
      ['外食', 7360],
      ['夜ご飯', 5470],
      ['デリバリー・テイクアウト', 3430],
      ['昼ご飯', 2400],
      ['カフェ', 1430],
      ['朝ご飯', 880],
      ['コンビニ', 740],
    ]
  );
});

test('支出一覧の数字: 10月の支払った人ごとの合計と除外の件数', () => {
  const summary = summarizeExpenses(inMonth(OCT), payerName);
  assert.equal(summary.count, 27);
  assert.equal(summary.total, 150540);
  assert.equal(summary.excludedCount, 3);
  assert.deepEqual(
    summary.payers.map((p) => [p.name, p.total, p.count]),
    [
      ['共通口座', 75200, 3],
      ['クレジットカード', 27600, 5],
      ['Aさん', 24720, 11],
      ['Bさん', 23020, 8],
    ]
  );
  assert.equal(countPending(inMonth(OCT)), 2);
});

test('精算の数字: 送金する人ごとの送金額（10月は立替（全額）を含む）', () => {
  const a = split(OCT, DEMO_MEMBER_A);
  assert.deepEqual(
    [a.total, a.count, a.excludedCount, a.advanceCount, a.half, a.targetPaid, a.targetAdvanced, a.counterpartAdvanced],
    [142680, 23, 3, 1, 71340, 16860, 7860, 0]
  );
  assert.deepEqual(a.transfer, { fromLineId: DEMO_MEMBER_A, toLineId: DEMO_MEMBER_B, amount: 46620 });
  assert.deepEqual(split(OCT, DEMO_MEMBER_B).transfer, { fromLineId: DEMO_MEMBER_B, toLineId: DEMO_MEMBER_A, amount: 56180 });
  assert.deepEqual(split(SEP, DEMO_MEMBER_A).transfer, { fromLineId: DEMO_MEMBER_A, toLineId: DEMO_MEMBER_B, amount: 56620 });
  assert.deepEqual(split(AUG, DEMO_MEMBER_A).transfer, { fromLineId: DEMO_MEMBER_A, toLineId: DEMO_MEMBER_B, amount: 39895 });
});

test('支払った人（Aさん・Bさん・カード・共通口座）と状態（立替（全額）・除外・要確認）が10月にそろっている', () => {
  // カード・共通口座の lineId は本番の定数と同じ（resolvePayerName・精算がこの値で見分ける）
  assert.equal(DEMO_CARD_ID, GMAIL_SYSTEM_LINE_ID);
  assert.equal(DEMO_SHARED_ACCOUNT_ID, RECURRING_SYSTEM_LINE_ID);
  const oct = inMonth(OCT);
  assert.deepEqual(new Set(oct.map(payerName)), new Set(['Aさん', 'Bさん', 'クレジットカード', '共通口座']));
  const advance = oct.filter(isFullAdvance);
  const excluded = oct.filter((e) => !e.includeInTotal && !isPending(e));
  const pending = oct.filter(isPending);
  assert.ok(advance.length >= 1 && excluded.length >= 1 && pending.length >= 1, `${advance.length}/${excluded.length}/${pending.length}`);
  // 立替（全額）は、払った人＝立て替えた人で、合計に含む（bot の［自分が立替］と同じ形）
  for (const e of advance) {
    assert.equal(e.advanceBy, e.payerId);
    assert.equal(e.includeInTotal, true);
  }
  // 要確認は合計に含まない（LINE で入れた直後と同じ）
  for (const e of pending) assert.equal(e.includeInTotal, false);
  // 世帯の支出として精算に入る
  for (const e of DEMO_EXPENSES) assert.equal(e.groupId, DEMO_HOUSEHOLD_ID, e.id);
});

test('ID は LINE の ID の形でない。レシート・URL・メールアドレスを持たない', () => {
  const LINE_ID = /^[UCR][0-9a-f]{32}$/;
  for (const m of DEMO_MEMBERS) assert.doesNotMatch(m.lineId, LINE_ID);
  assert.doesNotMatch(DEMO_HOUSEHOLD_ID, LINE_ID);
  assert.equal(new Set(DEMO_EXPENSES.map((e) => e.id)).size, DEMO_EXPENSES.length, 'id が重複している');
  for (const e of DEMO_EXPENSES) {
    for (const key of ['id', 'lineId', 'payerId', 'advanceBy', 'groupId', 'lineGroupId']) {
      if (e[key] !== undefined) assert.doesNotMatch(String(e[key]), LINE_ID, `${e.id}.${key}`);
    }
    assert.equal(e.receiptUrl, undefined, `${e.id} にレシートがある`);
    for (const value of Object.values(e)) {
      if (typeof value === 'string') assert.doesNotMatch(value, /:\/\/|@|www\./, `${e.id}: ${value}`);
    }
  }
  assert.deepEqual(
    DEMO_MEMBERS.map((m) => [m.lineId, m.displayName]),
    [
      [DEMO_MEMBER_A, 'Aさん'],
      [DEMO_MEMBER_B, 'Bさん'],
    ]
  );
});

test('中項目は大項目の一覧にある名前だけ。食費・娯楽には必ず付け、ほかの大項目には付けない', () => {
  for (const e of DEMO_EXPENSES) {
    const list = subCategoriesOf(e.category);
    if (list.length > 0) assert.ok(list.includes(e.subCategory), `${e.id}: ${e.category} › ${e.subCategory}`);
    else assert.equal(e.subCategory, undefined, `${e.id}: ${e.category} › ${e.subCategory}`);
  }
});

test('説明・店名に実在の店・ブランドらしい名前が無い（カタカナは一般名詞と「サンプル」だけ）', () => {
  // カタカナの屋号を入れないよう、使ってよいカタカナの語を決めておく
  const ALLOWED_KATAKANA = new Set(['サンプル', 'スーパー', 'カフェ', 'コンビニ', 'デリバリー', 'ティッシュ', 'ゴミ', 'ライブ', 'チケット', 'ゲーム', 'タクシー', 'シャンプー']);
  // 念のため、よく知られた名前の一部（最小限）
  const BANNED = /セブン|ローソン|ファミ|イオン|スタバ|マクド|ユニクロ|アマゾン|楽天|無印|ニトリ|ダイソー|amazon|apple|google|netflix|uber/i;
  for (const e of DEMO_EXPENSES) {
    for (const word of e.description.match(/[ァ-ヶー]{2,}/g) ?? []) {
      assert.ok(ALLOWED_KATAKANA.has(word), `${e.id}: 「${word}」（${e.description}）`);
    }
    assert.doesNotMatch(e.description, BANNED, e.id);
    // 英字は「Aさん」「Bさん」だけ
    assert.doesNotMatch(e.description.replace(/[AB]さん/g, ''), /[A-Za-zＡ-Ｚａ-ｚ]/, `${e.id}: 英字の名前（${e.description}）`);
  }
  // カード（メールから取込）の説明は店名なので、架空と分かる「サンプル…」にする
  for (const e of DEMO_EXPENSES.filter((x) => x.inputSource === 'gmail_auto')) {
    assert.match(e.description, /^サンプル/, e.id);
  }
});

test('場面の一覧: リンクは /demo/ 以下（末尾スラッシュ付き）、key は重ならない、URL から位置が分かる', () => {
  assert.equal(DEMO_INDEX_HREF, '/demo/');
  assert.deepEqual(
    demoScenes.map((s) => s.key),
    ['home', 'expenses', 'settlement']
  );
  assert.equal(new Set(demoScenes.map((s) => s.key)).size, demoScenes.length);
  for (const s of demoScenes) {
    assert.match(s.href, /^\/demo\/[a-z-]+\/$/, s.href);
    assert.ok(s.label && s.description, s.key);
  }
  assert.equal(sceneIndexOf('/demo/home/'), 0);
  assert.equal(sceneIndexOf('/demo/expenses'), 1);
  assert.equal(sceneIndexOf('/demo/settlement/'), 2);
  assert.equal(sceneIndexOf('/demo/'), -1);
  assert.equal(sceneIndexOf('/demo/xyz/'), -1);
  assert.equal(sceneIndexOf('/demo/home/xyz/'), -1); // 場面の下の存在しない URL（404）は場面にしない
  assert.equal(sceneIndexOf('/demo'), -1);
  assert.equal(sceneIndexOf(null), -1);
});
