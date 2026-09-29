// 画面刷新のロジック層（純関数）のテスト。node --test で実行する（Node 22.18 以降の型除去で .ts を直接読む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPending,
  isAdvance,
  isSettled,
  splitChip,
  countPending,
  parseSegment,
  matchesSegment,
  matchesQuery,
  sortForList,
  isCardSource,
  resolvePayerName,
  timestampToMillis,
  canClientWrite,
  canClientDelete,
  canServerConfirm,
  isPersonalExpense,
  filterExpenses,
  categoriesIn,
  summarizeExpenses,
} from '../lib/expenseState.ts';
import {
  computePeriodInsights,
  getActualSpending,
  calculatePace,
  idealProgress,
  buildCategoryBudgetRows,
} from '../lib/budgetAnalytics.ts';
import { getSampleExpenses, getSampleStats } from '../lib/sampleData.ts';
import {
  formFromExpense,
  validateEditForm,
  buildEditUpdate,
  hasEditChanges,
  collectHistoricalUsers,
  collectGroupExpenseUsers,
  mergeAvailableMembers,
  buildPayerOptions,
  payerDisplayNameFor,
  buildCategoryOptions,
} from '../lib/expenseEdit.ts';
import { yen } from '../lib/money.ts';
import {
  deriveApiBase,
  isValidDocId,
  parseSettlementResponse,
  parseConfirmResponse,
  parseSettleResult,
  classifyHouseholdFailure,
} from '../lib/householdContract.ts';
import {
  initialsFor,
  buildSettlementViewModel,
  groupSettlementItems,
  clearedSettlement,
} from '../lib/settlementView.ts';

const ME = 'U-me';
const PARTNER = 'U-partner';
const GMAIL = 'gmail-auto-system';

function expense(overrides = {}) {
  return {
    id: 'e1',
    lineId: ME,
    amount: 1000,
    description: 'スーパー',
    date: '2026-09-12',
    category: '食費',
    includeInTotal: true,
    ...overrides,
  };
}

// ---- 要確認・区分 ---------------------------------------------------------------

test('isPending: status なし / pending で confirmed !== true のものだけ', () => {
  assert.equal(isPending({}), true); // LINE 手入力（status なし）
  assert.equal(isPending({ status: 'pending', confirmed: false }), true); // Gmail 取込
  assert.equal(isPending({ status: undefined, confirmed: true }), false); // 旧データの確認済み
  assert.equal(isPending({ status: 'pending', confirmed: true }), false);
  assert.equal(isPending({ status: 'shared' }), false);
  assert.equal(isPending({ status: 'personal' }), false);
  assert.equal(isPending({ status: 'advance_pending' }), false);
  assert.equal(isPending({ status: 'advance_settled' }), false);
  assert.equal(countPending([{}, { status: 'shared' }, { status: 'pending' }, { confirmed: true }]), 2);
});

test('splitChip と状態の判定（bot の deriveExpenseSettings と同じ分け方）', () => {
  assert.equal(splitChip({}), 'shared');
  assert.equal(splitChip({ status: 'pending' }), 'shared');
  assert.equal(splitChip({ status: 'shared' }), 'shared');
  assert.equal(splitChip({ status: 'personal' }), 'personal');
  assert.equal(splitChip({ status: 'advance_pending' }), 'advance');
  assert.equal(splitChip({ status: 'advance_settled' }), 'settled');
  assert.equal(isAdvance({ status: 'advance_pending' }), true);
  assert.equal(isAdvance({ status: 'advance_settled' }), true);
  assert.equal(isAdvance({ status: 'shared' }), false);
  assert.equal(isSettled({ status: 'advance_settled' }), true);
  assert.equal(isSettled({ status: 'advance_pending' }), false);
});

test('セグメントと検索', () => {
  assert.equal(parseSegment('pending'), 'pending');
  assert.equal(parseSegment('advance'), 'advance');
  assert.equal(parseSegment('x'), 'all');
  assert.equal(parseSegment(null), 'all');
  assert.equal(matchesSegment({ status: 'shared' }, 'all'), true);
  assert.equal(matchesSegment({}, 'pending'), true);
  assert.equal(matchesSegment({ status: 'shared' }, 'pending'), false);
  assert.equal(matchesSegment({ status: 'advance_settled' }, 'advance'), true);
  assert.equal(matchesSegment({ status: 'pending' }, 'advance'), false);

  const e = { description: 'ｽｰﾊﾟｰ まいばすけっと', category: '食費' };
  assert.equal(matchesQuery(e, ''), true);
  assert.equal(matchesQuery(e, '  '), true);
  assert.equal(matchesQuery(e, 'スーパー'), true); // 半角カナも NFKC で一致
  assert.equal(matchesQuery(e, '食費'), true); // カテゴリも対象
  assert.equal(matchesQuery(e, 'スーパー 食費'), true);
  assert.equal(matchesQuery(e, 'スーパー 交通'), false);
  assert.equal(matchesQuery({ description: 'ＡＢＣ Mart' }, 'abc mart'), true);
  assert.equal(matchesQuery({}, 'x'), false);
});

// ---- 並び -------------------------------------------------------------

test('sortForList: 日付の降順・金額の降順（同じ値は元の順）', () => {
  const list = [
    { id: 'a', date: '2026-09-10', amount: 100 },
    { id: 'b', date: '2026-09-12', amount: 300 },
    { id: 'c', date: '2026-09-11', amount: 100 },
    { id: 'd', date: '2026-09-12', amount: 200 },
  ];
  assert.deepEqual(sortForList(list).map((e) => e.id), ['b', 'd', 'c', 'a']);
  assert.deepEqual(sortForList(list, 'amount').map((e) => e.id), ['b', 'd', 'a', 'c']);
  // 入力は変更しない
  assert.deepEqual(list.map((e) => e.id), ['a', 'b', 'c', 'd']);
});

test('timestampToMillis: Timestamp 風・Date・文字列・不正値', () => {
  assert.equal(timestampToMillis({ seconds: 2, nanoseconds: 5e8 }), 2000);
  assert.equal(timestampToMillis(new Date(1234)), 1234);
  assert.equal(timestampToMillis({ toMillis: () => 42 }), 42);
  assert.equal(timestampToMillis('1970-01-01T00:00:01.000Z'), 1000);
  assert.equal(timestampToMillis(undefined), 0);
  assert.equal(timestampToMillis('x'), 0);
});

// ---- 編集（PR #172 の入力チェックの移植） ---------------------------------------------

test('formFromExpense: 支払い者の既定は入力者', () => {
  const e = expense({ userDisplayName: 'あおい' });
  assert.deepEqual(formFromExpense(e), {
    amount: 1000,
    description: 'スーパー',
    date: '2026-09-12',
    category: '食費',
    includeInTotal: true,
    payerId: ME,
    payerDisplayName: 'あおい',
  });
  const paid = formFromExpense(expense({ payerId: PARTNER, payerDisplayName: 'べん', userDisplayName: 'あおい' }));
  assert.equal(paid.payerId, PARTNER);
  assert.equal(paid.payerDisplayName, 'べん');
});

test('validateEditForm: 変更した項目だけを PR #172 と同じ順・文言で検査する', () => {
  const original = expense();
  const base = formFromExpense(original);
  assert.equal(validateEditForm(base, original), null);

  assert.equal(validateEditForm({ ...base, date: '2026/09/12' }, original)?.message, '日付を入力してください');
  assert.equal(validateEditForm({ ...base, date: '' }, original)?.field, 'date');
  assert.equal(
    validateEditForm({ ...base, amount: -1 }, original)?.message,
    '金額は 0〜10,000,000 円の範囲で入力してください'
  );
  assert.equal(validateEditForm({ ...base, amount: 10_000_001 }, original)?.field, 'amount');
  assert.equal(validateEditForm({ ...base, amount: Number.NaN }, original)?.field, 'amount');
  assert.equal(validateEditForm({ ...base, amount: 10_000_000 }, original), null);
  assert.equal(
    validateEditForm({ ...base, description: 'あ'.repeat(501) }, original)?.message,
    '説明は 500 文字以内で入力してください'
  );
  assert.equal(
    validateEditForm({ ...base, category: 'あ'.repeat(51) }, original)?.message,
    'カテゴリは 50 文字以内で入力してください'
  );
  // 判定順: 日付 → 金額
  assert.equal(validateEditForm({ ...base, date: 'x', amount: -1 }, original)?.field, 'date');

  // 既存データが上限を超えていても、触れていなければ通す
  const long = expense({ description: 'あ'.repeat(600) });
  assert.equal(validateEditForm({ ...formFromExpense(long), amount: 2000 }, long), null);

  // 精算済み: 金額・日付・支払者は変えられない（説明は変えられる）
  const settled = expense({ status: 'advance_settled' });
  const sBase = formFromExpense(settled);
  const lockedMsg = '精算済みの支出は金額・日付・支払者を変更できません';
  assert.equal(validateEditForm({ ...sBase, amount: 2000 }, settled)?.message, lockedMsg);
  assert.equal(validateEditForm({ ...sBase, date: '2026-09-13' }, settled)?.field, 'date');
  assert.equal(validateEditForm({ ...sBase, payerId: PARTNER }, settled)?.field, 'payerId');
  assert.equal(validateEditForm({ ...sBase, description: '旅行' }, settled), null);
});

test('buildEditUpdate: 変更したキーだけ・精算済みは 4 キーを送らない', () => {
  // payerDisplayName を持たない支出（Gmail 取込など）で説明だけ直しても、表示名を書き足さない
  const gmail = expense({ lineId: GMAIL, groupId: 'g1', inputSource: 'gmail_auto', status: 'pending' });
  const form = { ...formFromExpense(gmail), description: 'スーパー（修正）' };
  assert.deepEqual(buildEditUpdate(form, gmail), { description: 'スーパー（修正）' });
  assert.equal(hasEditChanges(buildEditUpdate(formFromExpense(gmail), gmail)), false);

  // 支払い者を変えたら表示名も一緒に送る
  const e = expense({ userDisplayName: 'あおい' });
  const payerChanged = { ...formFromExpense(e), payerId: PARTNER, payerDisplayName: 'べん' };
  assert.deepEqual(buildEditUpdate(payerChanged, e), { payerId: PARTNER, payerDisplayName: 'べん' });

  const toggled = { ...formFromExpense(e), includeInTotal: false, amount: 1350 };
  assert.deepEqual(buildEditUpdate(toggled, e), { amount: 1350, includeInTotal: false });

  // 精算済み
  const settled = expense({ status: 'advance_settled', userDisplayName: 'あおい' });
  const sForm = {
    ...formFromExpense(settled),
    amount: 9999,
    date: '2026-01-01',
    payerId: PARTNER,
    payerDisplayName: 'べん',
    description: '旅行',
    category: '旅行',
  };
  assert.deepEqual(buildEditUpdate(sForm, settled), { description: '旅行', category: '旅行' });
});

test('支払い者の候補と表示名（既存の編集ドロワーと同じ優先順位）', () => {
  const expenses = [
    expense({ id: 'a', lineId: ME, userDisplayName: 'あおい', groupId: 'g1' }),
    expense({ id: 'b', lineId: PARTNER, userDisplayName: 'べん', groupId: 'g1', payerId: 'U-x', payerDisplayName: 'えっくす' }),
    expense({ id: 'c', lineId: 'U-other', userDisplayName: 'ほか', groupId: 'g2' }),
    expense({ id: 'd', lineId: 'U-solo', userDisplayName: '個人' }),
  ];
  const historical = collectHistoricalUsers(expenses);
  assert.deepEqual(historical.map((u) => u.lineId), [ME, PARTNER, 'U-x', 'U-other']);

  const groupUsers = collectGroupExpenseUsers(expenses, { groupId: 'g1' });
  assert.deepEqual(groupUsers.map((u) => u.lineId), [ME, PARTNER, 'U-x']);
  assert.deepEqual(collectGroupExpenseUsers(expenses, {}), []);
  assert.deepEqual(collectGroupExpenseUsers(expenses, null), []);

  const members = mergeAvailableMembers(
    [
      { lineId: ME, displayName: 'Unknown_abc' },
      { lineId: 'U-quiet', displayName: 'メンバー' },
    ],
    groupUsers,
    historical
  );
  assert.deepEqual(
    members.map((m) => [m.lineId, m.displayName, m.source]),
    [
      [ME, 'あおい', 'group'],
      ['U-quiet', 'メンバー', 'group'],
      [PARTNER, 'べん', 'group-history'],
      ['U-x', 'えっくす', 'group-history'],
      ['U-other', 'ほか', 'all-history'],
    ]
  );

  const options = buildPayerOptions(expenses[0], members, expenses, { payerId: 'U-gone', payerDisplayName: '' });
  assert.deepEqual(options[0], { value: ME, label: 'あおい（入力者）' });
  assert.deepEqual(options.find((o) => o.value === PARTNER), { value: PARTNER, label: 'べん（このグループ）' });
  assert.deepEqual(options.find((o) => o.value === 'U-other'), { value: 'U-other', label: 'ほか（他グループ）' });
  assert.deepEqual(options.at(-1), { value: 'U-gone', label: '不明なユーザー' });

  // 候補が無いときは支出履歴から
  const fallback = buildPayerOptions(null, [], expenses, { payerId: ME, payerDisplayName: 'あおい' });
  assert.deepEqual(fallback[0], { value: ME, label: 'あおい（支出履歴から）' });

  assert.equal(payerDisplayNameFor(PARTNER, members, expenses), 'べん');
  assert.equal(payerDisplayNameFor('U-solo', [], expenses), '個人');
  assert.equal(payerDisplayNameFor('U-none', [], expenses), 'U-none');
});

test('resolvePayerName: Gmail はクレジットカード、固定費の自動計上は共通口座、不明系は履歴で補う', () => {
  const historical = [{ lineId: ME, displayName: 'あおい' }];
  assert.equal(resolvePayerName(expense({ inputSource: 'gmail_auto' }), historical), 'クレジットカード');
  assert.equal(
    resolvePayerName(expense({ inputSource: 'recurring', payerId: 'recurring-system', lineId: 'recurring-system' }), historical),
    '共通口座'
  );
  // 固定費でも個人が立て替えたもの（支払い者がメンバー）は、その人の名前
  assert.equal(
    resolvePayerName(expense({ inputSource: 'recurring', payerId: ME, payerDisplayName: 'あおい' }), historical),
    'あおい'
  );
  assert.equal(resolvePayerName(expense({ payerDisplayName: 'べん' }), historical), 'べん');
  assert.equal(resolvePayerName(expense({ userDisplayName: 'メンバー' }), historical), 'あおい');
  assert.equal(resolvePayerName(expense({ userDisplayName: 'Unknown_1' }), historical), 'あおい');
  assert.equal(resolvePayerName(expense({}), historical), 'あおい');
  assert.equal(resolvePayerName(expense({ lineId: 'U-z' }), historical), '個人');
});

test('isCardSource: Gmail 取込と固定費の自動計上（共通口座）', () => {
  assert.equal(isCardSource({ inputSource: 'gmail_auto' }), true);
  assert.equal(isCardSource({ inputSource: 'recurring', payerId: 'recurring-system' }), true);
  assert.equal(isCardSource({ inputSource: 'recurring', payerId: ME }), false);
  assert.equal(isCardSource({ inputSource: 'line_text', payerId: 'recurring-system' }), false);
  assert.equal(isCardSource({}), false);
});

test('buildCategoryOptions: 正準 → 既存 → 現在値', () => {
  const opts = buildCategoryOptions(['食費', '交通費'], [{ category: '趣味' }, { category: '食費' }, { category: '' }], '謎');
  assert.deepEqual(opts, ['食費', '交通費', '趣味', '謎']);
});

// ---- 書き込み可否（master と PR #172 の共通部分） --------------------------------------

test('canClientWrite / canServerConfirm', () => {
  const groups = ['g1'];
  // 個人支出: 所有者だけ
  assert.equal(canClientWrite(expense(), ME, groups), true);
  assert.equal(canClientWrite(expense({ lineId: PARTNER }), ME, groups), false);
  // グループ支出: 有効メンバーなら入力者を問わない（Gmail 取込も）
  assert.equal(canClientWrite(expense({ groupId: 'g1', lineId: PARTNER }), ME, groups), true);
  assert.equal(canClientWrite(expense({ groupId: 'g1', lineId: GMAIL }), ME, groups), true);
  // 脱退済み（有効メンバーでない）グループは自分の支出でも不可
  // 脱退したグループ・旧形式は所有者でも不可（ルールの canWriteExistingExpense）
  assert.equal(canClientWrite(expense({ groupId: 'g9' }), ME, groups), false);
  assert.equal(canClientWrite(expense({ lineGroupId: 'C1' }), ME, groups), false);
  // 他人の支出は、脱退したグループ・旧形式では不可
  assert.equal(canClientWrite(expense({ groupId: 'g9', lineId: PARTNER }), ME, groups), false);
  assert.equal(canClientWrite(expense({ lineGroupId: 'C1', lineId: PARTNER }), ME, groups), false);
  // 所属が未確定（null）は許可扱い（最終判断はルール）
  assert.equal(canClientWrite(expense({ groupId: 'g9', lineId: PARTNER }), ME, null), true);
  assert.equal(canClientWrite(expense({ lineGroupId: 'C1', lineId: PARTNER }), ME, null), false);
  // 未ログイン
  assert.equal(canClientWrite(expense(), null, groups), false);
  // 精算済みでも編集（許可されたキー）はできる
  assert.equal(canClientWrite(expense({ status: 'advance_settled', groupId: 'g1' }), ME, groups), true);

  assert.equal(canServerConfirm(expense({ groupId: 'g1', lineId: GMAIL }), ME, groups), true);
  assert.equal(canServerConfirm(expense({ lineGroupId: 'C1' }), ME, groups), false);
  assert.equal(canServerConfirm(expense({ groupId: 'g9' }), ME, groups), false);
  assert.equal(canServerConfirm(expense({ groupId: 'g1', lineId: PARTNER }), ME, groups), true);
  assert.equal(isPersonalExpense({}), true);
  assert.equal(isPersonalExpense({ lineGroupId: 'C1' }), false);
});

test('canClientDelete', () => {
  const groups = ['g1'];
  assert.equal(canClientDelete(expense(), ME, groups), true);
  assert.equal(canClientDelete(expense({ lineId: PARTNER }), ME, groups), false);
  // グループ支出: 本人の登録分と Gmail 取込分だけ
  assert.equal(canClientDelete(expense({ groupId: 'g1' }), ME, groups), true);
  assert.equal(canClientDelete(expense({ groupId: 'g1', lineId: GMAIL }), ME, groups), true);
  assert.equal(canClientDelete(expense({ groupId: 'g1', lineId: 'recurring-system' }), ME, groups), true);
  assert.equal(canClientDelete(expense({ lineId: 'recurring-system' }), ME, groups), false);
  assert.equal(canClientDelete(expense({ groupId: 'g1', lineId: PARTNER }), ME, groups), false);
  // 脱退済み・旧形式
  assert.equal(canClientDelete(expense({ groupId: 'g9' }), ME, groups), false);
  assert.equal(canClientDelete(expense({ lineGroupId: 'C1' }), ME, groups), false);
  assert.equal(canClientDelete(expense({ groupId: 'g9', lineId: GMAIL }), ME, groups), false);
  assert.equal(canClientDelete(expense({ lineGroupId: 'C1', lineId: PARTNER }), ME, groups), false);
  // 精算済みは誰でも不可
  assert.equal(canClientDelete(expense({ status: 'advance_settled' }), ME, groups), false);
  assert.equal(canClientDelete(expense({ status: 'advance_settled', groupId: 'g1', lineId: GMAIL }), ME, groups), false);
  // 所属未確定
  assert.equal(canClientDelete(expense({ groupId: 'g9', lineId: GMAIL }), ME, null), true);
  assert.equal(canClientDelete(expense({ groupId: 'g9', lineId: PARTNER }), ME, null), false);
  assert.equal(canClientDelete(expense(), null, groups), false);
});

// ---- 金額 ------------------------------------------------------------

test('yen', () => {
  assert.equal(yen(3150, 'ja-JP'), '¥3,150');
  assert.equal(yen(0, 'ja-JP'), '¥0');
  assert.equal(yen(1234567, 'ja-JP'), '¥1,234,567');
  assert.equal(yen(-500, 'ja-JP'), '¥-500');
  assert.equal(yen(3150).codePointAt(0), 0xa5); // 半角の円記号
  // ロケール省略時は Number.prototype.toLocaleString() と同じ（既存の表示と同じ）
  assert.equal(yen(1234567), `¥${(1234567).toLocaleString()}`);
});

// ---- household API の契約 ------------------------------------------------------

test('deriveApiBase: 明示 → 認証エンドポイントから導出（|| で空文字は未設定扱い）', () => {
  const auth = 'https://us-central1-example.cloudfunctions.net/api/auth/line';
  assert.equal(deriveApiBase(undefined, auth), 'https://us-central1-example.cloudfunctions.net/api');
  assert.equal(deriveApiBase('', auth), 'https://us-central1-example.cloudfunctions.net/api');
  assert.equal(deriveApiBase('  ', `${auth}/`), 'https://us-central1-example.cloudfunctions.net/api');
  assert.equal(deriveApiBase('http://127.0.0.1:5199/api/', auth), 'http://127.0.0.1:5199/api');
  assert.equal(deriveApiBase(undefined, undefined), null);
  assert.equal(deriveApiBase(undefined, 'https://example.com/other'), null);
  assert.equal(deriveApiBase('not a url', auth), null);
  assert.equal(deriveApiBase('javascript:alert(1)', auth), null);
  assert.equal(deriveApiBase('https://example.com/api?x=1', auth), null);
  // http は手元だけ（ID トークンを平文で送らない）
  assert.equal(deriveApiBase('http://localhost:5199/api', auth), 'http://localhost:5199/api');
  assert.equal(deriveApiBase('http://api.example.com/api', auth), null);
  assert.equal(deriveApiBase(undefined, 'http://api.example.com/api/auth/line'), null);
  // off / none で止める
  assert.equal(deriveApiBase('off', auth), null);
  assert.equal(deriveApiBase(' NONE ', auth), null);
});

test('isValidDocId', () => {
  assert.equal(isValidDocId('abc123'), true);
  assert.equal(isValidDocId('a'.repeat(128)), true);
  assert.equal(isValidDocId('a'.repeat(129)), false);
  assert.equal(isValidDocId(''), false);
  assert.equal(isValidDocId('a/b'), false);
  assert.equal(isValidDocId('.'), false);
  assert.equal(isValidDocId('..'), false);
  assert.equal(isValidDocId('__x__'), false);
  assert.equal(isValidDocId('__a\nb__'), false);
  assert.equal(isValidDocId('___'), true);
  assert.equal(isValidDocId(['a']), false);
});

const sampleResponse = {
  groupId: 'g1',
  scope: 'line_group',
  members: [
    { lineId: 'U-a', displayName: 'aoi' },
    { lineId: 'U-b', displayName: 'Ben' },
  ],
  totals: { 'U-a': 9000, 'U-b': 3000 },
  basis: 'pair',
  settlement: { fromUserId: 'U-b', toUserId: 'U-a', amount: 3000 },
  items: [
    { id: 'e1', date: '2026-09-12', description: 'スーパー', amount: 9000, category: '食費', advanceBy: 'U-a' },
    { id: 'e2', date: '2026-09-10', description: 'カフェ', amount: 3000, category: '食費', advanceBy: 'U-b' },
  ],
  expenseIds: ['e1', 'e2'],
  asOf: '2026-09-24T07:00:00.000Z',
};

test('parseSettlementResponse: 形を検証して揃える', () => {
  const parsed = parseSettlementResponse(sampleResponse);
  assert.equal(parsed.basis, 'pair');
  assert.deepEqual(parsed.settlement, { fromUserId: 'U-b', toUserId: 'U-a', amount: 3000 });
  assert.equal(parsed.items.length, 2);
  assert.equal(parseSettlementResponse(null), null);
  assert.equal(parseSettlementResponse({ ...sampleResponse, basis: 'weird' }), null);
  assert.equal(parseSettlementResponse({ ...sampleResponse, members: 'x' }), null);
  // totals の欠けは 0 で埋め、メンバーの重複は除く
  const loose = parseSettlementResponse({
    ...sampleResponse,
    members: [...sampleResponse.members, { lineId: 'U-a', displayName: 'dup' }],
    totals: undefined,
    settlement: null,
  });
  assert.deepEqual(loose.totals, { 'U-a': 0, 'U-b': 0 });
  assert.equal(loose.members.length, 2);
  assert.equal(loose.settlement, null);
});

test('parseConfirmResponse / parseSettleResult', () => {
  assert.deepEqual(
    parseConfirmResponse({
      ok: true,
      expense: { id: 'e1', status: 'shared', includeInTotal: true, confirmed: true, advanceBy: null, category: '食費', updatedAt: 'x' },
    }),
    { id: 'e1', status: 'shared', includeInTotal: true, confirmed: true, advanceBy: null, category: '食費' }
  );
  assert.equal(parseConfirmResponse({ ok: true }), null);
  assert.equal(parseConfirmResponse({ ok: true, expense: { id: 'e1', status: 'hacked' } }).status, undefined);
  assert.deepEqual(parseSettleResult({ ok: true, settled: 2, skipped: 0, basis: 'pair', settlement: null }), {
    settled: 2,
    skipped: 0,
    basis: 'pair',
    settlement: null,
  });
  assert.equal(parseSettleResult({ error: 'x' }), null);
});

test('エラーの分類（K5-1）', () => {
  assert.equal(classifyHouseholdFailure(409, { error: 'settled', message: '精算済みのため変更できません' }), 'settled');
  assert.equal(classifyHouseholdFailure(409, { error: 'stale' }), 'failed');
  assert.equal(classifyHouseholdFailure(403, {}), 'forbidden');
  assert.equal(classifyHouseholdFailure(404, '<html>'), 'not_found');
  assert.equal(classifyHouseholdFailure(429, null), 'rate_limited');
  assert.equal(classifyHouseholdFailure(503, null), 'internal');
  assert.equal(classifyHouseholdFailure(401, null), 'unauthenticated');
  assert.equal(classifyHouseholdFailure(418, { error: '__proto__' }), 'failed');
});

// ---- 精算 ---------------------------------------------------------------------

test('initialsFor: 先頭 1 文字・英字は大文字・重なれば 2 文字', () => {
  assert.deepEqual(initialsFor(['aoi', 'ben']), ['A', 'B']);
  assert.deepEqual(initialsFor(['あおい', 'べん']), ['あ', 'べ']);
  assert.deepEqual(initialsFor(['aoi', 'ami']), ['Ao', 'Am']);
  assert.deepEqual(initialsFor(['  まこと', '']), ['ま', '?']);
  assert.deepEqual(initialsFor(['😀smile', 'x']), ['😀', 'X']);
});

test('buildSettlementViewModel: 左＝払う人・右＝受け取る人、無効状態', () => {
  const resp = parseSettlementResponse(sampleResponse);
  const vm = buildSettlementViewModel(resp, { apiAvailable: true, guest: false });
  assert.equal(vm.left.lineId, 'U-b');
  assert.equal(vm.left.tone, 'b');
  assert.equal(vm.right.lineId, 'U-a');
  assert.equal(vm.right.initial, 'A');
  assert.equal(vm.amount, 3000);
  assert.equal(vm.idle, false);
  assert.deepEqual(vm.rows, [
    { lineId: 'U-a', initial: 'A', total: 9000 },
    { lineId: 'U-b', initial: 'B', total: 3000 },
  ]);
  assert.equal(vm.count, 2);
  assert.equal(vm.canSettle, true);
  assert.equal(vm.canOpenBreakdown, true);

  // API 未設定・ゲストでは精算できない
  assert.equal(buildSettlementViewModel(resp, { apiAvailable: false, guest: false }).canSettle, false);
  assert.equal(buildSettlementViewModel(resp, { apiAvailable: true, guest: true }).canSettle, false);

  // 差額 0 でも未精算があれば精算できる（矢印は薄く）
  const even = buildSettlementViewModel({ ...resp, settlement: null }, { apiAvailable: true, guest: false });
  assert.equal(even.amount, 0);
  assert.equal(even.idle, true);
  assert.equal(even.left.lineId, 'U-a');
  assert.equal(even.right.lineId, 'U-b');
  assert.equal(even.canSettle, true);

  // 未精算 0 件
  const none = buildSettlementViewModel(
    { ...resp, basis: 'none', settlement: null, items: [], expenseIds: [], totals: { 'U-a': 0, 'U-b': 0 } },
    { apiAvailable: true, guest: false }
  );
  assert.equal(none.canSettle, false);
  assert.equal(none.canOpenBreakdown, false);
  assert.equal(none.amount, 0);

  // 計算できない（3 人以上など）: 金額は null、メンバー行なし、精算不可
  const three = buildSettlementViewModel(
    {
      ...resp,
      basis: 'undeterminable',
      settlement: null,
      members: [...resp.members, { lineId: 'U-c', displayName: 'Cat' }],
    },
    { apiAvailable: true, guest: false }
  );
  assert.equal(three.amount, null);
  assert.deepEqual(three.rows, []);
  assert.equal(three.canSettle, false);

  // 世帯なし・未取得
  const empty = buildSettlementViewModel(null, { apiAvailable: true, guest: false });
  assert.equal(empty.amount, 0);
  assert.equal(empty.left, null);
  assert.equal(empty.canSettle, false);
});

test('groupSettlementItems: 立替者ごとに合計', () => {
  const resp = parseSettlementResponse({
    ...sampleResponse,
    items: [
      ...sampleResponse.items,
      { id: 'e3', date: '2026-09-01', description: '旧', amount: 500, category: 'その他', advanceBy: 'U-x' },
    ],
  });
  const groups = groupSettlementItems(resp);
  assert.deepEqual(
    groups.map((g) => [g.lineId, g.name, g.total, g.items.length]),
    [
      ['U-a', 'aoi', 9000, 1],
      ['U-b', 'Ben', 3000, 1],
      ['U-x', '', 500, 1],
    ]
  );
});


// ---- 絞り込み・集計（フィルター・合計カード） -------------------------------------------

test('filterExpenses: 文字・予算・カテゴリの順に絞る', () => {
  const NO_FILTER = { query: '', budget: 'all', category: 'all' };
  const list = [
    expense({ id: 'a', description: 'スーパー 駅前', category: '食費', includeInTotal: true }),
    expense({ id: 'b', description: 'カフェ', category: '食費', includeInTotal: false }),
    expense({ id: 'c', description: '電車', category: '交通費', includeInTotal: true }),
  ];
  assert.deepEqual(filterExpenses(list, NO_FILTER).map((e) => e.id), ['a', 'b', 'c']);
  assert.deepEqual(filterExpenses(list, { ...NO_FILTER, query: 'ｽｰﾊﾟｰ' }).map((e) => e.id), ['a']);
  assert.deepEqual(filterExpenses(list, { ...NO_FILTER, query: '食費' }).map((e) => e.id), ['a', 'b']);
  assert.deepEqual(filterExpenses(list, { ...NO_FILTER, budget: 'included' }).map((e) => e.id), ['a', 'c']);
  assert.deepEqual(filterExpenses(list, { ...NO_FILTER, budget: 'excluded' }).map((e) => e.id), ['b']);
  assert.deepEqual(filterExpenses(list, { ...NO_FILTER, category: '交通費' }).map((e) => e.id), ['c']);
  assert.deepEqual(categoriesIn(list), ['食費', '交通費']);
});

test('summarizeExpenses: 合計カード・支払い者別カードの集計', () => {
  const list = [
    expense({ id: 'a', amount: 1000, includeInTotal: true, payerDisplayName: 'Aoi' }),
    expense({ id: 'b', amount: 500, includeInTotal: false, payerDisplayName: 'Aoi' }),
    expense({ id: 'c', amount: 3000, includeInTotal: true, payerDisplayName: 'Ben' }),
    expense({ id: 'd', amount: 700, includeInTotal: false, payerDisplayName: 'Cat' }),
  ];
  const summary = summarizeExpenses(list, (e) => e.payerDisplayName);
  assert.equal(summary.count, 4);
  assert.equal(summary.total, 4000);
  assert.equal(summary.excludedCount, 2);
  // 計上するものが無い人（Cat）は出さない。件数は計上しないものも数える
  assert.deepEqual(summary.payers, [
    { name: 'Ben', total: 3000, count: 1 },
    { name: 'Aoi', total: 1000, count: 2 },
  ]);
});

// ---- 予算（ホームの判断インサイト・予算管理） ------------------------------------------

test('computePeriodInsights: ホームの判断インサイトの式', () => {
  const x = computePeriodInsights({
    stats: { totalAmount: 90000, expenseCount: 12 },
    prevStats: { totalAmount: 100000 },
    monthlyBudget: 150000,
    range: { startDate: '2026-09-01', endDate: '2026-09-30' },
    mode: 'monthly',
    now: '2026-09-24T20:00:00',
  });
  assert.equal(x.totalExpense, 90000);
  assert.equal(x.expenseCount, 12);
  assert.equal(x.dailyAverage, 3000);
  assert.equal(x.budgetPct, 60);
  assert.equal(x.budgetRemaining, 60000);
  assert.equal(x.daysLeft, 6); // 9/24 20:00 → 9/30（日数差 + 1）
  assert.equal(x.perDayAvailable, 10000);
  assert.equal(x.momPct, -10);
  // 期間指定では前月比を出さない。前期間が 0 でも出さない
  assert.equal(computePeriodInsights({ stats: null, prevStats: { totalAmount: 5 }, monthlyBudget: 0, range: { startDate: '2026-09-01', endDate: '2026-09-30' }, mode: 'custom' }).momPct, null);
  const none = computePeriodInsights({ stats: null, prevStats: null, monthlyBudget: 0, range: { startDate: '2026-09-01', endDate: '2026-09-30' }, mode: 'monthly', now: '2026-10-05' });
  assert.equal(none.budgetPct, null);
  assert.equal(none.daysLeft, 0);
  assert.equal(none.perDayAvailable, null);
  assert.equal(none.momPct, null);
});

test('カテゴリ別予算: 旧キーの逆引き・行の並び・ペース', () => {
  assert.equal(getActualSpending('娯楽費', { 娯楽: 1000, 娯楽費: 200 }), 1200);
  assert.equal(getActualSpending('独自', { 独自: 300 }), 300);
  const rows = buildCategoryBudgetRows({ 食費: 30000, 家賃: 80000, ペット用品: 500 }, { 食費: 40000, 住居費: 80000, 旧キー: 1000 });
  assert.deepEqual(rows.map((r) => [r.category, r.budget, r.actual]), [
    ['住居費', 80000, 80000],
    ['食費', 40000, 30000],
    ['旧キー', 1000, 0],
    ['ペット用品', 0, 500],
  ]);
  assert.equal(calculatePace(0, 0, '2026-09-15'), 'unset');
  assert.equal(calculatePace(15000, 30000, '2026-09-15'), 'good');
  assert.equal(calculatePace(16500, 30000, '2026-09-15'), 'warning');
  assert.equal(calculatePace(20000, 30000, '2026-09-15'), 'danger');
  assert.equal(Math.round(idealProgress('2026-09-15')), 50);
});

test('ゲスト用サンプル: 要確認 2 件・集計は計上するものだけ・参照デザインの金額を使わない', () => {
  const list = getSampleExpenses();
  assert.equal(countPending(list), 2);
  const stats = getSampleStats();
  assert.equal(stats.totalAmount, list.filter((e) => e.includeInTotal).reduce((s, e) => s + e.amount, 0));
  assert.equal(stats.expenseCount, list.filter((e) => e.includeInTotal).length);
  const referenceAmounts = [42600, 237400, 280000, 4200, 12400, 4000, 2480, 1200, 720];
  for (const e of list) assert.equal(referenceAmounts.includes(e.amount), false, `${e.description} ${e.amount}`);
  assert.equal(referenceAmounts.includes(stats.totalAmount), false);
});

test('parseSettlementResponse: bot の participants・reason を読む', () => {
  const parsed = parseSettlementResponse({
    groupId: 'g1',
    scope: 'line_group',
    participants: [
      { lineId: 'U-a', displayName: 'aoi', isMember: true },
      { lineId: 'U-b', displayName: '', isMember: true },
      { lineId: 'U-x', displayName: 'old', isMember: false },
    ],
    totals: { 'U-a': 100, 'U-b': 0, 'U-x': 50 },
    basis: 'undeterminable',
    reason: 'more_than_two',
    settlement: null,
    items: [],
    expenseIds: ['e1'],
    asOf: 'now',
  });
  assert.equal(parsed.members.length, 3);
  assert.equal(parsed.members[2].isMember, false);
  assert.equal(parsed.reason, 'more_than_two');
  // 計算できないときはメンバーの行を出さず、金額は —（null）、ボタンは無効
  const vm = buildSettlementViewModel(parsed, { apiAvailable: true, guest: false, fallbackNames: { 'U-b': 'ben' } });
  assert.equal(vm.amount, null);
  assert.deepEqual(vm.rows, []);
  assert.equal(vm.canSettle, false);
  assert.equal(vm.right.initial, 'B'); // 空の名前は世帯のメンバー名で補う
  // reason は undeterminable のときだけ
  assert.equal(parseSettlementResponse({ ...sampleResponse, reason: 'more_than_two' }).reason, null);
});

test('clearedSettlement: 精算後は未精算なし・¥0・ボタン無効', () => {
  const cleared = clearedSettlement(parseSettlementResponse(sampleResponse));
  assert.equal(cleared.basis, 'none');
  assert.deepEqual(cleared.expenseIds, []);
  assert.deepEqual(cleared.totals, { 'U-a': 0, 'U-b': 0 });
  const vm = buildSettlementViewModel(cleared, { apiAvailable: true, guest: false });
  assert.equal(vm.amount, 0);
  assert.equal(vm.idle, true);
  assert.equal(vm.canSettle, false);
  assert.equal(vm.canOpenBreakdown, false);
});

