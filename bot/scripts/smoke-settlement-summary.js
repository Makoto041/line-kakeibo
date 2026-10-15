/**
 * 期間の精算サマリー（settlementSummary.ts / line/settlementSummaryMessage.ts / periodSplit.ts）の純関数のテスト。
 * ビルド済みの dist を読む（npm run smoke から実行）。
 *
 * periodSplit.ts は Web（web/lib/periodSplit.ts）と同じ式でなければならないので、同じ入力で両方を動かして
 * 結果を突き合わせる（Web 側は Node の型除去で .ts を直接読む）。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  periodStartDay,
  closedPeriodFor,
  buildSettlementSummary,
  isPendingManual,
  summaryRetryKey,
} = require('../dist/settlementSummary');
const { buildSettlementSummaryMessages, periodLabel, SETTLEMENT_URL } = require('../dist/line/settlementSummaryMessage');
const botSplit = require('../dist/periodSplit');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n${error.stack}`);
    process.exitCode = 1;
  }
}

const A = 'U' + 'a'.repeat(32); // 光麦（集金するメンバー）
const B = 'U' + 'b'.repeat(32); // 誠
const MEMBERS = [
  { lineId: B, displayName: '岩渕 誠' },
  { lineId: A, displayName: '光麦' },
];
const G = 'g1';
const RANGE = { startDate: '2026-09-15', endDate: '2026-10-14' };
const e = (amount, payerId, extra = {}) => ({
  amount,
  lineId: payerId,
  payerId,
  groupId: G,
  includeInTotal: true,
  status: 'shared',
  confirmed: true,
  date: '2026-09-20',
  category: '食費',
  inputSource: 'line_text',
  ...extra,
});

(async () => {
  console.log('\n[期間]');
  await test('起算日: 固定期間は null、15日起算は 15、未設定は 1', () => {
    assert.equal(periodStartDay({ mode: 'custom', startDate: '2026-01-01', endDate: '2026-01-31' }), null);
    assert.equal(periodStartDay({ mode: 'customStart', customStartDay: 15 }), 15);
    assert.equal(periodStartDay({ mode: 'monthly', customStartDay: 15 }), 15);
    assert.equal(periodStartDay({ mode: 'monthly' }), 1);
    assert.equal(periodStartDay(null), 1);
    // custom でも期間が欠けていれば Web と同じく月ごと扱い
    assert.equal(periodStartDay({ mode: 'custom', customStartDay: 10 }), 10);
  });
  await test('締まった期間: 起算日だけ前の期間を返す', () => {
    assert.deepEqual(closedPeriodFor('2026-10-15', 15), RANGE);
    assert.equal(closedPeriodFor('2026-10-14', 15), null);
    assert.equal(closedPeriodFor('2026-10-16', 15), null);
    assert.deepEqual(closedPeriodFor('2026-10-01', 1), { startDate: '2026-09-01', endDate: '2026-09-30' });
    assert.deepEqual(closedPeriodFor('2026-03-01', 1), { startDate: '2026-02-01', endDate: '2026-02-28' });
    assert.deepEqual(closedPeriodFor('2026-01-15', 15), { startDate: '2025-12-15', endDate: '2026-01-14' });
    assert.equal(closedPeriodFor('2026-10-15', null), null);
    // 起算日が無い月（2 月の 31 日）の分は次の回に含める
    assert.deepEqual(closedPeriodFor('2026-03-31', 31), { startDate: '2026-01-31', endDate: '2026-03-30' });
    assert.deepEqual(closedPeriodFor('2026-01-31', 31), { startDate: '2025-12-31', endDate: '2026-01-30' });
    assert.deepEqual(closedPeriodFor('2026-03-30', 30), { startDate: '2026-01-30', endDate: '2026-03-29' });
    assert.deepEqual(closedPeriodFor('2028-03-29', 29), { startDate: '2028-02-29', endDate: '2028-03-28' });
    assert.equal(closedPeriodFor('2026-02-28', 31), null);
  });
  await test('期間の表記（年をまたぐときは年も）', () => {
    assert.equal(periodLabel(RANGE), '9/15〜10/14');
    assert.equal(periodLabel({ startDate: '2025-12-15', endDate: '2026-01-14' }), '2025/12/15〜2026/1/14');
  });

  console.log('\n[Web の期間の精算と同じ計算]');
  const web = await import(pathToFileURL(path.join(__dirname, '../../web/lib/periodSplit.ts')).href);
  await test('ランダムな明細 300 通りで Web の computePeriodSplit と一致する', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const payers = [A, B, 'gmail-auto-system', 'recurring-system'];
    const statuses = ['shared', 'personal', 'advance_pending', 'advance_settled', 'pending', undefined];
    for (let round = 0; round < 300; round++) {
      const expenses = Array.from({ length: Math.floor(rnd() * 12) }, () => {
        const payer = payers[Math.floor(rnd() * payers.length)];
        return {
          amount: Math.floor(rnd() * 20000) + (rnd() < 0.2 ? 0.5 : 0),
          lineId: payer,
          payerId: rnd() < 0.2 ? undefined : payer,
          groupId: rnd() < 0.9 ? G : 'other',
          includeInTotal: rnd() < 0.85,
          status: statuses[Math.floor(rnd() * statuses.length)],
          date: rnd() < 0.85 ? '2026-10-01' : '2026-10-20',
        };
      });
      const target = [A, B, null][Math.floor(rnd() * 3)];
      const input = { expenses, groupId: G, members: MEMBERS, targetLineId: target, range: RANGE };
      assert.deepEqual(botSplit.computePeriodSplit(input), web.computePeriodSplit(input), `round ${round}`);
    }
    assert.equal(botSplit.formatYenExact(160426.5), web.formatYenExact(160426.5));
  });

  console.log('\n[サマリーの中身]');
  const expenses = [
    e(120000, 'recurring-system', { category: '住居費', inputSource: 'recurring' }),
    e(30000, 'gmail-auto-system', { category: '食費', inputSource: 'gmail_auto' }),
    e(4900, A, { category: '日用品' }),
    e(8000, B, { category: '娯楽' }),
    e(3000, 'gmail-auto-system', { category: '交通費', inputSource: 'gmail_auto' }),
    e(2000, 'gmail-auto-system', { category: '通信費', inputSource: 'gmail_auto' }),
    e(1000, 'gmail-auto-system', { category: '衣服', inputSource: 'gmail_auto' }),
    e(500, 'gmail-auto-system', { category: 'サブスク', inputSource: 'gmail_auto' }),
    // 要確認（手入力・未確認。合計には入らない）
    e(2180, A, { status: undefined, confirmed: false, includeInTotal: false }),
    // 以前のカード取込（pending）は要確認に数えない
    e(700, 'gmail-auto-system', { status: 'pending', confirmed: false, inputSource: 'gmail_auto', category: '食費' }),
    // 期間外・別の世帯は数えない
    e(99999, B, { date: '2026-10-15' }),
    e(99999, B, { groupId: 'other' }),
  ];
  const summary = buildSettlementSummary({
    groupId: G,
    range: RANGE,
    members: MEMBERS,
    collectFrom: A,
    expenses,
    advances: { count: 2, total: 6000, transfer: { fromLineId: B, toLineId: A, amount: 1000 } },
  });
  await test('合計・集金額は Web の式どおり（光麦が払う）', () => {
    assert.equal(summary.split.total, 170100);
    assert.equal(summary.split.targetPaid, 4900);
    assert.equal(summary.othersPaid, 165200);
    assert.deepEqual(summary.split.transfer, { fromLineId: A, toLineId: B, amount: 80150 });
  });
  await test('カテゴリは金額の多い順に上位 5 つ、残りは「ほか」', () => {
    assert.deepEqual(summary.categories.map((c) => c.category), ['住居費', '食費', '娯楽', '日用品', '交通費']);
    assert.equal(summary.categories[0].percentage, 70.5);
    assert.deepEqual(summary.otherCategories, { count: 3, amount: 3500 });
  });
  await test('要確認は手入力の未確認だけ（以前のカード取込の pending は数えない）', () => {
    assert.deepEqual(summary.pending, { count: 1, amount: 2180 });
    assert.equal(isPendingManual({ inputSource: 'gmail_auto', status: 'pending', confirmed: false }), false);
    assert.equal(isPendingManual({ inputSource: 'recurring', confirmed: false }), false);
    assert.equal(isPendingManual({ inputSource: 'line_text', confirmed: false }), true);
    assert.equal(isPendingManual({ inputSource: 'line_text', status: 'shared', confirmed: false }), false);
  });

  console.log('\n[LINE のメッセージ]');
  const [text, flex] = buildSettlementSummaryMessages(summary);
  await test('1 通目: 送金する人と受け取る人をメンションしたテキスト', () => {
    assert.equal(text.type, 'textV2');
    assert.equal(text.text, '9/15〜10/14 の精算（折半）です。\n{u1} から {u2} へ ¥80,150 の送金をお願いします。');
    assert.deepEqual(text.substitution.u1, { type: 'mention', mentionee: { type: 'user', userId: A } });
    assert.deepEqual(text.substitution.u2, { type: 'mention', mentionee: { type: 'user', userId: B } });
  });
  const json = JSON.stringify(flex);
  await test('2 通目: Flex に送金額・内訳・カテゴリ・要確認・立替・精算へのリンク', () => {
    assert.equal(flex.type, 'flex');
    assert.equal(flex.altText, '9/15〜10/14 の精算: 光麦→岩渕 誠 ¥80,150');
    for (const s of ['¥80,150', '光麦  →  岩渕 誠', '合計（9件・除外1件）', '¥170,100', '¥85,050', '− 光麦の支払い', '岩渕 誠・カード・共通口座の支払い', '住居費', '70.5%', 'ほか 3カテゴリ ¥3,500', '要確認が 1件（¥2,180）', '未精算の立替が 2件あります（岩渕 誠→光麦 ¥1,000）', SETTLEMENT_URL]) {
      assert.ok(json.includes(s), `Flex に「${s}」が無い`);
    }
    assert.ok(json.includes('/icons/cat-housing.png'), 'カテゴリのアイコン');
    // LINE の Flex の上限（1 メッセージ 30KB）に十分収まる
    assert.ok(json.length < 9000, `Flex が大きすぎる: ${json.length}`);
  });
  await test('送金なし（ちょうど半分ずつ）: 2 人ともメンションして「送金なし」', () => {
    const even = buildSettlementSummary({
      groupId: G,
      range: RANGE,
      members: MEMBERS,
      collectFrom: A,
      expenses: [e(5000, A), e(5000, B)],
      advances: { count: 0, total: 0, transfer: null },
    });
    const [t, f] = buildSettlementSummaryMessages(even);
    assert.equal(t.type, 'textV2');
    assert.ok(t.text.includes('{u1} {u2}') && t.text.includes('今回は送金なし'));
    assert.equal(f.altText, '9/15〜10/14 の精算: 送金なし');
    assert.ok(!JSON.stringify(f).includes('未精算の立替'), '立替 0 件なら出さない');
    assert.ok(!JSON.stringify(f).includes('要確認'), '要確認 0 件なら出さない');
  });
  await test('LINE の userId でないメンバーはメンションせず名前を書く', () => {
    const odd = buildSettlementSummary({
      groupId: G,
      range: RANGE,
      members: [{ lineId: 'legacy-a', displayName: 'あ' }, { lineId: B, displayName: '誠' }],
      collectFrom: 'legacy-a',
      expenses: [e(10000, B)],
      advances: null,
    });
    const [t] = buildSettlementSummaryMessages(odd);
    assert.equal(t.type, 'textV2');
    assert.ok(t.text.includes('あ から {u2} へ ¥5,000'), t.text);
    assert.equal(t.substitution.u1, undefined);
  });

  console.log('\n[重複送信の防止]');
  await test('X-Line-Retry-Key は同じ世帯・期間で同じ UUID、期間が違えば別', () => {
    const k = summaryRetryKey(G, '2026-10-14');
    assert.match(k, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(k, summaryRetryKey(G, '2026-10-14'));
    assert.notEqual(k, summaryRetryKey(G, '2026-11-14'));
    assert.notEqual(k, summaryRetryKey('g2', '2026-10-14'));
  });

  console.log(`\nsettlement summary smoke: ${passed} passed`);
})();
