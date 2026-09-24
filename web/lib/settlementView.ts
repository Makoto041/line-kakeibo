// ふたり（精算）の表示用の純関数。
// 実データの値はすべてサーバー応答（SettlementResponse）から作る。ゲスト用のサンプルだけは
// サンプルの支出から同じ式（bot の getAdvanceSummaryByUser / calculateSettlement と同じ）で導出する。
import type { Expense } from './hooks';
import type {
  SettlementBasis,
  SettlementItem,
  SettlementMember,
  SettlementResponse,
  SettlementTransfer,
} from './householdContract';

// ---- 計算（bot と同じ式） -------------------------------------------------------

export interface AdvanceSummary {
  userId: string;
  totalAdvanced: number;
  expenseIds: string[];
}

type AdvanceFields = Pick<Expense, 'id' | 'amount'> & Partial<Pick<Expense, 'status' | 'advanceBy' | 'payerId'>>;

/** 未精算の立替を立替者（advanceBy、無ければ payerId）ごとに合計する */
export function summarizeAdvances(expenses: readonly AdvanceFields[]): AdvanceSummary[] {
  const byUser = new Map<string, AdvanceSummary>();
  for (const e of expenses) {
    if (e.status !== 'advance_pending') continue;
    const userId = e.advanceBy || e.payerId || '';
    let summary = byUser.get(userId);
    if (!summary) {
      summary = { userId, totalAdvanced: 0, expenseIds: [] };
      byUser.set(userId, summary);
    }
    summary.totalAdvanced += Number(e.amount) || 0;
    summary.expenseIds.push(e.id);
  }
  return Array.from(byUser.values());
}

/** bot の calculateSettlement と同じ: 2 人の差額の 1/2 を Math.round。差額 0 なら null */
function calculateSettlement(
  a: Pick<AdvanceSummary, 'userId' | 'totalAdvanced'>,
  b: Pick<AdvanceSummary, 'userId' | 'totalAdvanced'>
): SettlementTransfer | null {
  const diff = a.totalAdvanced - b.totalAdvanced;
  if (diff === 0) return null;
  return diff > 0
    ? { fromUserId: b.userId, toUserId: a.userId, amount: Math.round(diff / 2) }
    : { fromUserId: a.userId, toUserId: b.userId, amount: Math.round(Math.abs(diff) / 2) };
}

/**
 * 世帯の精算額。
 * - none: 立替なし
 * - pair: 2 人とも立替あり
 * - single_advancer: 1 人だけ立替（相手を 0 円として補う）
 * - undeterminable: 有効メンバーが 2 人でない・立替者がメンバー外（金額を出さない）
 */
export function computeHouseholdSettlement(
  summaries: ReadonlyArray<Pick<AdvanceSummary, 'userId' | 'totalAdvanced'>>,
  activeMemberIds: readonly string[]
): { basis: SettlementBasis; settlement: SettlementTransfer | null } {
  if (summaries.length === 0) return { basis: 'none', settlement: null };
  const members = Array.from(new Set(activeMemberIds));
  const allMembers = summaries.every((s) => members.includes(s.userId));
  if (members.length !== 2 || !allMembers) return { basis: 'undeterminable', settlement: null };
  if (summaries.length === 2) {
    return { basis: 'pair', settlement: calculateSettlement(summaries[0], summaries[1]) };
  }
  if (summaries.length === 1) {
    const other = members.find((id) => id !== summaries[0].userId) as string;
    return {
      basis: 'single_advancer',
      settlement: calculateSettlement(summaries[0], { userId: other, totalAdvanced: 0 }),
    };
  }
  return { basis: 'undeterminable', settlement: null };
}

function createdMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'object' && value !== null && typeof (value as { seconds?: unknown }).seconds === 'number') {
    return (value as { seconds: number }).seconds * 1000;
  }
  return 0;
}

type LocalAdvanceFields = AdvanceFields &
  Partial<Pick<Expense, 'date' | 'description' | 'category' | 'createdAt'>>;

/**
 * 支出の一覧からサーバー応答と同じ形を作る（ゲスト用サンプル）。
 * items は登録日時の降順（getPendingAdvances と同じ）。
 */
export function buildLocalSettlementResponse(input: {
  groupId: string;
  members: readonly SettlementMember[];
  expenses: readonly LocalAdvanceFields[];
  asOf: string;
}): SettlementResponse {
  const pending = input.expenses
    .filter((e) => e.status === 'advance_pending')
    .map((e, index) => ({ e, index }))
    .sort((a, b) => createdMillis(b.e.createdAt) - createdMillis(a.e.createdAt) || a.index - b.index)
    .map(({ e }) => e);
  const summaries = summarizeAdvances(pending);
  const memberIds = input.members.map((m) => m.lineId);
  const totals: Record<string, number> = {};
  for (const id of memberIds) totals[id] = 0;
  for (const s of summaries) totals[s.userId] = (totals[s.userId] ?? 0) + s.totalAdvanced;
  const { basis, settlement } = computeHouseholdSettlement(summaries, memberIds);
  return {
    groupId: input.groupId,
    scope: 'group',
    members: input.members.map((m) => ({ ...m })),
    totals,
    basis,
    settlement,
    items: pending.map((e) => ({
      id: e.id,
      date: e.date ?? '',
      description: e.description ?? '',
      amount: Number(e.amount) || 0,
      category: e.category ?? '',
      advanceBy: e.advanceBy || e.payerId || null,
    })),
    expenseIds: pending.map((e) => e.id),
    asOf: input.asOf,
  };
}

// ---- 頭文字 ------------------------------------------------------------------

function chars(name: string): string[] {
  return Array.from(name.trim());
}

function capitalize(text: string): string {
  const [first = '', ...rest] = Array.from(text);
  return first.toUpperCase() + rest.join('');
}

/**
 * アバターと「◯の立替」に使う頭文字（表示名の先頭 1 文字。英字は大文字）。
 * 頭文字が他の人と重なるときは先頭 2 文字にする。名前が無ければ「?」。
 */
export function initialsFor(names: readonly string[]): string[] {
  const first = names.map((n) => capitalize(chars(n).slice(0, 1).join('')) || '?');
  return names.map((n, i) => {
    const clash = first.some((other, j) => j !== i && other === first[i]);
    if (!clash) return first[i];
    const two = chars(n).slice(0, 2).join('');
    return two ? capitalize(two) : first[i];
  });
}

// ---- 表示モデル ---------------------------------------------------------------

export type AvatarTone = 'a' | 'b' | 'neutral';

export interface SettlementPerson {
  lineId: string;
  name: string;
  initial: string;
  tone: AvatarTone;
}

export interface SettlementMemberRow {
  lineId: string;
  initial: string;
  total: number;
}

export interface SettlementViewModel {
  /** 左のアバター（払う人。精算なしのときはメンバーの 1 人目） */
  left: SettlementPerson | null;
  /** 右のアバター（受け取る人。精算なしのときはメンバーの 2 人目） */
  right: SettlementPerson | null;
  /** 精算額が 0（矢印と右のアバターを薄くする） */
  idle: boolean;
  /** 精算額。計算できないときは null（「—」を出す） */
  amount: number | null;
  /** メンバーごとの立替（計算できないときは出さない） */
  rows: SettlementMemberRow[];
  count: number;
  expenseIds: string[];
  undeterminable: boolean;
  canSettle: boolean;
  canOpenBreakdown: boolean;
}

export function buildSettlementViewModel(
  resp: SettlementResponse | null,
  opts: { apiAvailable: boolean; guest: boolean }
): SettlementViewModel {
  if (!resp) {
    return {
      left: null,
      right: null,
      idle: true,
      amount: 0,
      rows: [],
      count: 0,
      expenseIds: [],
      undeterminable: false,
      canSettle: false,
      canOpenBreakdown: false,
    };
  }

  const initials = initialsFor(resp.members.map((m) => m.displayName));
  const people = new Map<string, SettlementPerson>();
  resp.members.forEach((m, i) => {
    people.set(m.lineId, {
      lineId: m.lineId,
      name: m.displayName,
      initial: initials[i],
      tone: i === 0 ? 'a' : i === 1 ? 'b' : 'neutral',
    });
  });
  const personFor = (lineId: string): SettlementPerson =>
    people.get(lineId) ?? { lineId, name: '', initial: '?', tone: 'neutral' };

  const undeterminable = resp.basis === 'undeterminable';
  const transfer = undeterminable ? null : resp.settlement;
  const left = transfer ? personFor(transfer.fromUserId) : (resp.members[0] ? personFor(resp.members[0].lineId) : null);
  const right = transfer ? personFor(transfer.toUserId) : (resp.members[1] ? personFor(resp.members[1].lineId) : null);

  const rows = undeterminable
    ? []
    : resp.members.map((m, i) => ({ lineId: m.lineId, initial: initials[i], total: resp.totals[m.lineId] ?? 0 }));

  const count = resp.expenseIds.length;
  return {
    left,
    right,
    idle: !transfer || transfer.amount === 0,
    amount: undeterminable ? null : (transfer?.amount ?? 0),
    rows,
    count,
    expenseIds: [...resp.expenseIds],
    undeterminable,
    canSettle: opts.apiAvailable && !opts.guest && !undeterminable && count > 0,
    canOpenBreakdown: resp.items.length > 0,
  };
}

export interface BreakdownGroup {
  lineId: string;
  name: string;
  total: number;
  items: SettlementItem[];
}

/** 内訳: 立替者ごと（メンバーの並び → メンバー外）に合計と明細をまとめる */
export function groupSettlementItems(resp: SettlementResponse): BreakdownGroup[] {
  const names = new Map(resp.members.map((m) => [m.lineId, m.displayName]));
  const groups = new Map<string, BreakdownGroup>();
  for (const m of resp.members) groups.set(m.lineId, { lineId: m.lineId, name: m.displayName, total: 0, items: [] });
  for (const item of resp.items) {
    const key = item.advanceBy ?? '';
    let group = groups.get(key);
    if (!group) {
      group = { lineId: key, name: names.get(key) ?? '', total: 0, items: [] };
      groups.set(key, group);
    }
    group.total += item.amount;
    group.items.push(item);
  }
  return Array.from(groups.values()).filter((g) => g.items.length > 0);
}
