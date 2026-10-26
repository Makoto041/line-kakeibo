// デモ（/demo。ログイン不要・架空データだけ）のデータ。発表後に web/app/demo・components/demo・lib/demo ごと消す。
// 人物（Aさん・Bさん）・お店・金額はすべて架空。店名が要るものは「サンプル食堂」のように架空と分かる名前にする。
// 画面の数字（合計・内訳・送金額）は、この配列を本番と同じ純関数に通して出す（手で書いた合計は置かない）。
// node --test から直接読めるよう、他のモジュールからは型だけを import する
// （カード・共通口座の lineId は lib/expenseState.ts と同じ値を書き、一致は __tests__/demoData.test.mjs で確かめる）。
import type { BudgetConfig, Expense, ExpenseStats, HouseholdMember } from '../hooks';
import type { PeriodSplitRange } from '../../components/PeriodSplitView';

/** デモの「今日」。描画に本当の今日を使わない（サーバーとブラウザで日付がずれないように） */
export const DEMO_TODAY = '2026-10-24';
/** DEMO_TODAY の正午（予算のペースを測る日。BudgetProgress / computePeriodInsights の now） */
export const DEMO_NOW = new Date(2026, 9, 24, 12);

// LINE の userId（U + 16 進 32 桁）の形にしない
export const DEMO_MEMBER_A = 'demo-member-a';
export const DEMO_MEMBER_B = 'demo-member-b';
export const DEMO_HOUSEHOLD_ID = 'demo-household';
/** カード取込（Gmail）の lineId。lib/expenseState.ts の GMAIL_SYSTEM_LINE_ID と同じ */
export const DEMO_CARD_ID = 'gmail-auto-system';
/** 固定費（共通口座）の lineId。lib/expenseState.ts の RECURRING_SYSTEM_LINE_ID と同じ */
export const DEMO_SHARED_ACCOUNT_ID = 'recurring-system';

export const DEMO_MEMBERS: readonly HouseholdMember[] = [
  { lineId: DEMO_MEMBER_A, displayName: 'Aさん' },
  { lineId: DEMO_MEMBER_B, displayName: 'Bさん' },
];

export const DEMO_BUDGET: BudgetConfig = {
  monthlyBudget: 220000,
  categoryBudgets: {
    食費: 50000,
    日用品: 10000,
    交通費: 8000,
    娯楽: 15000,
    衣服: 10000,
    住居費: 85000,
    光熱費: 12000,
    通信費: 8000,
    サブスク: 2000,
  },
  alertThreshold: 20,
};

export interface DemoMonth {
  /** YYYY-MM */
  key: string;
  /** 見出し（「2026年10月」） */
  title: string;
  /** 期間。精算の表示（PeriodSplitView）は range の参照で計算を使い回すので、月ごとに同じオブジェクトを使う */
  range: PeriodSplitRange;
}

function month(year: number, m: number): DemoMonth {
  const mm = String(m).padStart(2, '0');
  const lastDay = new Date(year, m, 0).getDate();
  return {
    key: `${year}-${mm}`,
    title: `${year}年${m}月`,
    range: { startDate: `${year}-${mm}-01`, endDate: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`, mode: 'monthly' },
  };
}

/** 切り替えられる月（古い順）。最初に開くのは最後（基準月の 2026年10月） */
export const DEMO_MONTHS: readonly DemoMonth[] = [month(2026, 8), month(2026, 9), month(2026, 10)];
export const DEMO_DEFAULT_MONTH_INDEX = DEMO_MONTHS.length - 1;

// ---- 支出 ------------------------------------------------------------------

/** 支払った人: Aさん / Bさん / カード（メールから取込） / 共通口座（固定費） */
type Payer = 'A' | 'B' | 'card' | 'shared';
/** 状態: 共同費 / 立替（全額） / 除外（個人） / 要確認（LINE で入れて未確認） */
type State = 'shared' | 'advance' | 'personal' | 'pending';
type Row = [id: string, date: string, amount: number, description: string, category: string, subCategory: string | null, payer: Payer, state?: State];

const MEMBER_OF = { A: DEMO_MEMBERS[0], B: DEMO_MEMBERS[1] } as const;

function toExpense([id, date, amount, description, category, subCategory, payer, state = 'shared']: Row): Expense {
  const base = {
    id: `demo-${id}`,
    groupId: DEMO_HOUSEHOLD_ID,
    amount,
    description,
    date,
    category,
    ...(subCategory ? { subCategory } : {}),
  };
  if (payer === 'card') {
    return { ...base, lineId: DEMO_CARD_ID, payerId: DEMO_CARD_ID, inputSource: 'gmail_auto', status: 'shared', confirmed: true, includeInTotal: true };
  }
  if (payer === 'shared') {
    return { ...base, lineId: DEMO_SHARED_ACCOUNT_ID, payerId: DEMO_SHARED_ACCOUNT_ID, inputSource: 'recurring', status: 'shared', confirmed: true, includeInTotal: true };
  }
  const member = MEMBER_OF[payer];
  const person = {
    ...base,
    lineId: member.lineId,
    payerId: member.lineId,
    userDisplayName: member.displayName,
    payerDisplayName: member.displayName,
    inputSource: 'line_text' as const,
  };
  switch (state) {
    case 'advance':
      return { ...person, status: 'advance_pending', advanceBy: member.lineId, advanceFull: true, confirmed: true, includeInTotal: true };
    case 'personal':
      return { ...person, status: 'personal', confirmed: true, includeInTotal: false };
    case 'pending':
      return { ...person, confirmed: false, includeInTotal: false };
    default:
      return { ...person, status: 'shared', confirmed: true, includeInTotal: true };
  }
}

const ROWS: readonly Row[] = [
  // 2026年8月
  ['a01', '2026-08-01', 85000, '家賃', '住居費', null, 'shared'],
  ['a02', '2026-08-01', 1490, '動画配信', 'サブスク', null, 'shared'],
  ['a03', '2026-08-02', 3870, 'スーパー', '食費', '食料品（スーパー）', 'A'],
  ['a04', '2026-08-04', 1100, '昼ご飯', '食費', '昼ご飯', 'A'],
  ['a05', '2026-08-06', 9180, 'サンプル電力', '光熱費', null, 'card'],
  ['a06', '2026-08-08', 4680, 'スーパー', '食費', '食料品（スーパー）', 'B'],
  ['a07', '2026-08-09', 6200, 'サンプル食堂', '食費', '外食', 'card'],
  ['a08', '2026-08-10', 7600, '携帯電話', '通信費', null, 'shared'],
  ['a09', '2026-08-11', 9800, 'ライブのチケット', '娯楽', '音楽・ライブ', 'B'],
  ['a10', '2026-08-12', 1620, '日焼け止め', '日用品', null, 'B'],
  ['a11', '2026-08-14', 14000, '新幹線（Bさんの分）', '交通費', null, 'A', 'advance'],
  ['a12', '2026-08-15', 1180, 'カフェ', '食費', 'カフェ', 'A'],
  ['a13', '2026-08-17', 5320, 'スーパー', '食費', '食料品（スーパー）', 'A'],
  ['a14', '2026-08-19', 2980, 'デリバリー', '食費', 'デリバリー・テイクアウト', 'B'],
  ['a15', '2026-08-21', 3600, '映画', '娯楽', '映画', 'A'],
  ['a16', '2026-08-23', 5740, 'サンプル商店', '食費', '食料品（スーパー）', 'card'],
  ['a17', '2026-08-25', 4200, '夜ご飯', '食費', '夜ご飯', 'B'],
  ['a18', '2026-08-27', 1560, 'サンプル薬局', '日用品', null, 'card'],
  ['a19', '2026-08-29', 960, 'コンビニ', '食費', 'コンビニ', 'B'],
  ['a20', '2026-08-30', 2900, 'ゲーム（Aさん個人）', '娯楽', 'ゲーム・課金', 'A', 'personal'],

  // 2026年9月
  ['s01', '2026-09-01', 85000, '家賃', '住居費', null, 'shared'],
  ['s02', '2026-09-01', 1490, '動画配信', 'サブスク', null, 'shared'],
  ['s03', '2026-09-02', 4120, 'スーパー', '食費', '食料品（スーパー）', 'A'],
  ['s04', '2026-09-03', 1050, '昼ご飯', '食費', '昼ご飯', 'B'],
  ['s05', '2026-09-05', 8640, 'サンプル食堂', '食費', '外食', 'card'],
  ['s06', '2026-09-06', 2180, '洗剤・ゴミ袋', '日用品', null, 'A'],
  ['s07', '2026-09-07', 6920, 'サンプル電力', '光熱費', null, 'card'],
  ['s08', '2026-09-08', 1280, 'カフェ', '食費', 'カフェ', 'B'],
  ['s09', '2026-09-10', 7600, '携帯電話', '通信費', null, 'shared'],
  ['s10', '2026-09-11', 5860, 'スーパー', '食費', '食料品（スーパー）', 'B'],
  ['s11', '2026-09-13', 2400, '日帰り温泉', '娯楽', '銭湯・サウナ', 'A'],
  ['s12', '2026-09-14', 3200, '夜ご飯', '食費', '夜ご飯', 'A'],
  ['s13', '2026-09-15', 1540, '電車', '交通費', null, 'B'],
  ['s14', '2026-09-17', 5980, 'サンプル商店', '食費', '食料品（スーパー）', 'card'],
  ['s15', '2026-09-19', 12800, '遊園地', '娯楽', 'レジャー・テーマパーク', 'B'],
  ['s16', '2026-09-20', 880, 'コンビニ', '食費', 'コンビニ', 'A'],
  ['s17', '2026-09-22', 4400, '美容院（Bさん個人）', '美容', null, 'B', 'personal'],
  ['s18', '2026-09-24', 2760, 'デリバリー', '食費', 'デリバリー・テイクアウト', 'B'],
  ['s19', '2026-09-26', 4980, 'スーパー', '食費', '食料品（スーパー）', 'A'],
  ['s20', '2026-09-27', 1200, '昼ご飯', '食費', '昼ご飯', 'A'],
  ['s21', '2026-09-28', 2640, 'サンプル書店', '娯楽', '本・漫画', 'card'],
  ['s22', '2026-09-29', 1890, 'サンプル薬局', '日用品', null, 'card'],

  // 2026年10月（基準月。DEMO_TODAY まで）
  ['o01', '2026-10-01', 85000, '家賃', '住居費', null, 'shared'],
  ['o02', '2026-10-01', 1490, '動画配信', 'サブスク', null, 'shared'],
  ['o03', '2026-10-02', 980, '昼ご飯', '食費', '昼ご飯', 'A'],
  ['o04', '2026-10-03', 4320, 'スーパー', '食費', '食料品（スーパー）', 'B'],
  ['o05', '2026-10-04', 6380, 'サンプル食堂', '食費', '外食', 'card'],
  ['o06', '2026-10-05', 1580, 'ティッシュ・洗剤', '日用品', null, 'A'],
  ['o07', '2026-10-06', 1240, 'カフェ', '食費', 'カフェ', 'A'],
  ['o08', '2026-10-07', 7480, 'サンプル電力', '光熱費', null, 'card'],
  ['o09', '2026-10-08', 3980, 'スーパー', '食費', '食料品（スーパー）', 'A'],
  ['o10', '2026-10-09', 640, 'コンビニ', '食費', 'コンビニ', 'B'],
  ['o11', '2026-10-10', 6800, '靴（Bさんの分）', '衣服', null, 'A', 'advance'],
  ['o12', '2026-10-10', 7600, '携帯電話', '通信費', null, 'shared'],
  ['o13', '2026-10-11', 5400, '夜ご飯', '食費', '夜ご飯', 'B'],
  ['o14', '2026-10-12', 3600, '映画', '娯楽', '映画', 'B'],
  ['o15', '2026-10-12', 1320, '電車', '交通費', null, 'B'],
  ['o16', '2026-10-13', 6150, 'サンプル商店', '食費', '食料品（スーパー）', 'card'],
  ['o17', '2026-10-14', 1980, 'サンプル書店', '娯楽', '本・漫画', 'card'],
  ['o18', '2026-10-15', 1100, '昼ご飯', '食費', '昼ご飯', 'B'],
  ['o19', '2026-10-16', 2340, 'サンプル薬局', '日用品', null, 'card'],
  ['o20', '2026-10-17', 2980, 'デリバリー', '食費', 'デリバリー・テイクアウト', 'A'],
  ['o21', '2026-10-18', 1000, '銭湯', '娯楽', '銭湯・サウナ', 'A'],
  ['o22', '2026-10-18', 760, '朝ご飯', '食費', '朝ご飯', 'A'],
  ['o23', '2026-10-19', 2100, 'タクシー', '交通費', null, 'A'],
  ['o24', '2026-10-20', 5240, 'スーパー', '食費', '食料品（スーパー）', 'B'],
  ['o25', '2026-10-21', 2200, '漫画（Aさん個人）', '娯楽', '本・漫画', 'A', 'personal'],
  ['o26', '2026-10-23', 1050, '昼ご飯', '食費', '昼ご飯', 'A', 'pending'],
  ['o27', '2026-10-23', 2480, 'シャンプー', '日用品', null, 'B', 'pending'],
];

/** デモの支出（3 か月分。すべて世帯 DEMO_HOUSEHOLD_ID のもの） */
export const DEMO_EXPENSES: readonly Expense[] = ROWS.map(toExpense);

// ---- 集計 ------------------------------------------------------------------

export function inDemoRange(e: Pick<Expense, 'date'>, range: { startDate: string; endDate: string }): boolean {
  return e.date >= range.startDate && e.date <= range.endDate;
}

/**
 * 期間の集計（ホームの合計・件数・カテゴリ別・日別）。本番の useMonthlyStats（lib/hooks.ts）と同じ数え方:
 * 合計に含むもの（includeInTotal）だけを数え、カテゴリは保存された名前のまま、日別は date ごと
 */
export function demoStats(expenses: readonly Expense[], range: { startDate: string; endDate: string }): ExpenseStats {
  const included = expenses.filter((e) => inDemoRange(e, range) && e.includeInTotal);
  const categoryTotals: Record<string, number> = {};
  const dailyTotals: Record<string, number> = {};
  let totalAmount = 0;
  for (const e of included) {
    totalAmount += e.amount;
    categoryTotals[e.category] = (categoryTotals[e.category] || 0) + e.amount;
    dailyTotals[e.date] = (dailyTotals[e.date] || 0) + e.amount;
  }
  return { totalAmount, expenseCount: included.length, categoryTotals, dailyTotals };
}
