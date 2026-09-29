// 精算画面の表示用の純関数。値はすべてサーバー応答（SettlementResponse）から作る。
import type { SettlementItem, SettlementMember, SettlementResponse } from './householdContract';

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

/** 自分自身のキーだけを読む（lineId が constructor などでも Object.prototype の値を拾わない） */
function ownValue<V>(record: Readonly<Record<string, V>> | undefined, key: string): V | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** 表示名（応答の名前が空なら、世帯のメンバー名で補う） */
function displayNameOf(m: SettlementMember, fallbackNames?: Readonly<Record<string, string>>): string {
  return m.displayName.trim() || ownValue(fallbackNames, m.lineId)?.trim() || '';
}

export function buildSettlementViewModel(
  resp: SettlementResponse | null,
  opts: { apiAvailable: boolean; guest: boolean; fallbackNames?: Readonly<Record<string, string>> }
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

  const initials = initialsFor(resp.members.map((m) => displayNameOf(m, opts.fallbackNames)));
  const people = new Map<string, SettlementPerson>();
  resp.members.forEach((m, i) => {
    people.set(m.lineId, {
      lineId: m.lineId,
      name: displayNameOf(m, opts.fallbackNames),
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
    : resp.members.map((m, i) => ({ lineId: m.lineId, initial: initials[i], total: ownValue(resp.totals, m.lineId) ?? 0 }));

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
export function groupSettlementItems(
  resp: SettlementResponse,
  fallbackNames?: Readonly<Record<string, string>>
): BreakdownGroup[] {
  const names = new Map(resp.members.map((m) => [m.lineId, displayNameOf(m, fallbackNames)]));
  const groups = new Map<string, BreakdownGroup>();
  for (const m of resp.members) {
    groups.set(m.lineId, { lineId: m.lineId, name: names.get(m.lineId) ?? '', total: 0, items: [] });
  }
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

/** 精算を記録できたあとの内容（未精算なし）。取り直しが終わるまで古い金額を出さないために使う */
export function clearedSettlement(resp: SettlementResponse): SettlementResponse {
  const totals: Record<string, number> = {};
  for (const m of resp.members) if (m.isMember) totals[m.lineId] = 0;
  return {
    ...resp,
    members: resp.members.filter((m) => m.isMember),
    totals,
    basis: 'none',
    reason: null,
    settlement: null,
    items: [],
    expenseIds: [],
  };
}
