// 期間の折半精算の純関数。
// 期間内の世帯の支出（合計に含むもの）を 2 人で折半し、指定したメンバー（集金するメンバー）が
// すでに払った分を引いた額を、そのメンバーから集金する。
//   集金額 = 合計 ÷ 2 − 集金するメンバーの支払い（四捨五入）
// クレジットカードの自動取得・共通口座の固定費など、集金するメンバー以外の支払いは相手の負担として扱う。
// マイナスになるとき（集金するメンバーが半分より多く払っている）は、相手がその額を払う。
import type { Expense } from './hooks';

export type SplitExpense = Pick<Expense, 'amount' | 'includeInTotal' | 'lineId'> &
  Partial<Pick<Expense, 'groupId' | 'payerId'>>;

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
  /** 合計 ÷ 2（端数はそのまま。式の表示用） */
  half: number;
  /** 集金するメンバーと相手。決められないときは null */
  target: SplitMember | null;
  counterpart: SplitMember | null;
  /** 集金するメンバーの支払い（合計に含むもの） */
  targetPaid: number;
  /** 精算。0 円や計算できないときは null */
  transfer: SplitTransfer | null;
  reason: SplitUnavailableReason | null;
}

function amountOf(e: SplitExpense): number {
  const n = Number(e.amount);
  return Number.isFinite(n) ? n : 0;
}

export function computePeriodSplit(input: {
  expenses: readonly SplitExpense[];
  groupId: string;
  members: readonly SplitMember[];
  targetLineId: string | null;
}): PeriodSplit {
  // 個人の支出（groupId なし・別の世帯）は折半しない。見る人によって金額が変わらないようにする
  const pool = input.expenses.filter((e) => e.groupId === input.groupId);
  const counted = pool.filter((e) => e.includeInTotal);
  const total = counted.reduce((sum, e) => sum + amountOf(e), 0);
  const base = {
    total,
    count: counted.length,
    excludedCount: pool.length - counted.length,
    half: total / 2,
  };

  const members = input.members.filter((m, i, all) => all.findIndex((o) => o.lineId === m.lineId) === i);
  if (members.length !== 2) {
    return { ...base, target: null, counterpart: null, targetPaid: 0, transfer: null, reason: 'not_two_members' };
  }
  const target = members.find((m) => m.lineId === input.targetLineId) ?? null;
  if (!target) {
    return { ...base, target: null, counterpart: null, targetPaid: 0, transfer: null, reason: 'no_target' };
  }
  const counterpart = members.find((m) => m.lineId !== target.lineId) as SplitMember;

  const targetPaid = counted
    .filter((e) => (e.payerId || e.lineId) === target.lineId)
    .reduce((sum, e) => sum + amountOf(e), 0);
  const diff = base.half - targetPaid;
  // 0.5 円は切り上げ（向きによらず絶対値で丸める）
  const amount = Math.round(Math.abs(diff));
  const transfer: SplitTransfer | null =
    amount === 0
      ? null
      : diff > 0
      ? { fromLineId: target.lineId, toLineId: counterpart.lineId, amount }
      : { fromLineId: counterpart.lineId, toLineId: target.lineId, amount };

  return { ...base, target, counterpart, targetPaid, transfer, reason: null };
}

/** 式の表示用: 整数ならそのまま、端数があれば小数 1 桁（160,426.5） */
export function formatYenExact(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `¥${rounded.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`;
}
