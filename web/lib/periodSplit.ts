// 期間の折半精算の純関数。
// 期間内の世帯の支出（合計に含むもの）を 2 人で折半し、指定したメンバー（集金するメンバー）が
// すでに払った分を引いた額を、そのメンバーから集金する。立替（全額。isFullAdvance）は折半せず、
// 立て替えた人へ全額を返す（支出の日付の期間の精算に加算する）。
//   集金額 = 合計 ÷ 2 − 集金するメンバーの支払い + 相手の立替 − 集金するメンバーの立替（四捨五入）
// クレジットカードの自動取得・共通口座の固定費など、集金するメンバー以外の支払いは相手の負担として扱う。
// マイナスになるとき（集金するメンバーが半分より多く払っている）は、相手がその額を払う。
// 支払者は支出画面の支払い者別の集計と同じく payerId（無ければ登録者）で判定する。
// 立替精算済み（advance_settled）の明細は、立替の精算で半分ずつの負担になっているので折半しない（二重精算を防ぐ）。
import type { Expense } from './hooks';

export type SplitExpense = Pick<Expense, 'amount' | 'includeInTotal' | 'lineId'> &
  Partial<Pick<Expense, 'groupId' | 'payerId' | 'status' | 'date' | 'advanceBy' | 'advanceFull'>>;

export interface SplitMember {
  lineId: string;
  displayName: string;
}

export interface SplitTransfer {
  fromLineId: string;
  toLineId: string;
  amount: number;
}

/** 計算できない理由。not_two_members: 有効メンバーが 2 人でない / no_target: 集金するメンバーが未指定 */
export type SplitUnavailableReason = 'not_two_members' | 'no_target';

export interface PeriodSplit {
  /** 合計に含む世帯の支出の合計 */
  total: number;
  /** 合計に含む件数 */
  count: number;
  /** 合計から除外した件数 */
  excludedCount: number;
  /** 立替精算済みで折半しない件数 */
  settledCount: number;
  /** 立替（全額）の件数（折半せず、立て替えた人へ全額を返す） */
  advanceCount: number;
  /** 合計 ÷ 2（端数はそのまま。式の表示用） */
  half: number;
  /** 集金するメンバーと相手。決められないときは null */
  target: SplitMember | null;
  counterpart: SplitMember | null;
  /** 集金するメンバーの支払い（合計に含むもの） */
  targetPaid: number;
  /** 集金するメンバーの立替（全額。相手から返してもらう） */
  targetAdvanced: number;
  /** 相手の立替（全額。集金するメンバーが返す） */
  counterpartAdvanced: number;
  /** 精算。0 円や計算できないときは null */
  transfer: SplitTransfer | null;
  reason: SplitUnavailableReason | null;
}

function amountOf(e: SplitExpense): number {
  const n = Number(e.amount);
  return Number.isFinite(n) ? n : 0;
}

/** 世帯の、期間内の支出（computePeriodSplit が数える母集団） */
export function periodPool<E extends SplitExpense>(
  expenses: readonly E[],
  groupId: string,
  range?: { startDate: string; endDate: string }
): E[] {
  // 個人の支出（groupId なし・別の世帯）は折半しない。見る人によって金額が変わらないようにする
  return expenses.filter(
    (e) =>
      e.groupId === groupId &&
      (!range || (typeof e.date === 'string' && e.date >= range.startDate && e.date <= range.endDate))
  );
}

/**
 * 立替（全額）か: 「自分が立替」にした支出（advance_pending）のうち、全額を返す扱い（advanceFull）のもの。
 * advanceFull の無い advance_pending は全額にする前の立替で、これまでどおり支払った人の分として折半する
 * （過去の期間の金額を変えないため。精算タブで精算済みにできる）。
 */
export function isFullAdvance(e: Pick<SplitExpense, 'status' | 'advanceFull'>): boolean {
  return e.status === 'advance_pending' && e.advanceFull === true;
}

/** 立て替えた人（advanceBy、無ければ支払った人・登録者） */
export function advancerOf(e: Pick<SplitExpense, 'advanceBy' | 'payerId' | 'lineId'>): string {
  return e.advanceBy || e.payerId || e.lineId;
}

export function computePeriodSplit(input: {
  expenses: readonly SplitExpense[];
  groupId: string;
  members: readonly SplitMember[];
  targetLineId: string | null;
  /** 期間（YYYY-MM-DD の両端を含む）。指定したときは date がこの範囲の支出だけを数える */
  range?: { startDate: string; endDate: string };
}): PeriodSplit {
  const pool = periodPool(input.expenses, input.groupId, input.range);
  // 立替（全額）は折半せず、立て替えた人へ全額を返す
  const advances = pool.filter(isFullAdvance);
  const rest = pool.filter((e) => !isFullAdvance(e));
  const included = rest.filter((e) => e.includeInTotal);
  const counted = included.filter((e) => e.status !== 'advance_settled');
  const total = counted.reduce((sum, e) => sum + amountOf(e), 0);
  const base = {
    total,
    count: counted.length,
    excludedCount: rest.length - included.length,
    settledCount: included.length - counted.length,
    advanceCount: advances.length,
    half: total / 2,
  };
  const none = { target: null, counterpart: null, targetPaid: 0, targetAdvanced: 0, counterpartAdvanced: 0, transfer: null };

  const members = input.members.filter((m, i, all) => all.findIndex((o) => o.lineId === m.lineId) === i);
  if (members.length !== 2) {
    return { ...base, ...none, reason: 'not_two_members' };
  }
  const target = members.find((m) => m.lineId === input.targetLineId) ?? null;
  if (!target) {
    return { ...base, ...none, reason: 'no_target' };
  }
  const counterpart = members.find((m) => m.lineId !== target.lineId) as SplitMember;

  const targetPaid = counted
    .filter((e) => (e.payerId || e.lineId) === target.lineId)
    .reduce((sum, e) => sum + amountOf(e), 0);
  // 立替は立て替えた人（advanceBy、無ければ支払った人）で分ける。集金するメンバー以外の立替は相手の分として扱う
  const targetAdvanced = advances
    .filter((e) => advancerOf(e) === target.lineId)
    .reduce((sum, e) => sum + amountOf(e), 0);
  const counterpartAdvanced = advances.reduce((sum, e) => sum + amountOf(e), 0) - targetAdvanced;
  const diff = base.half - targetPaid + counterpartAdvanced - targetAdvanced;
  // 0.5 円は切り上げ（向きによらず絶対値で丸める）
  const amount = Math.round(Math.abs(diff));
  const transfer: SplitTransfer | null =
    amount === 0
      ? null
      : diff > 0
      ? { fromLineId: target.lineId, toLineId: counterpart.lineId, amount }
      : { fromLineId: counterpart.lineId, toLineId: target.lineId, amount };

  return { ...base, target, counterpart, targetPaid, targetAdvanced, counterpartAdvanced, transfer, reason: null };
}

/** 式の表示用: 整数ならそのまま、端数があれば小数 1 桁（160,426.5） */
export function formatYenExact(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `¥${rounded.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`;
}
