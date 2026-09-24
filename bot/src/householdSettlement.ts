/**
 * 世帯の精算額（LINE の「立替一覧」「精算」と Web のふたりタブで共通）
 *
 * 金額の計算そのものは既存の `calculateSettlement`（差額の 1/2 を Math.round）をそのまま使う。
 * ここで決めるのは「誰と誰の間で計算するか」だけ。
 *
 * 計算できるのは、精算の関係者（有効なメンバー ∪ 未精算の立替がある人）がちょうど 2 人のとき:
 * - 2 人とも立替あり → そのまま計算（pair。従来の LINE と同じ）
 * - 1 人だけ立替あり → もう 1 人を立替 0 円として補って計算（single_advancer）。
 *   例: A だけが ¥10,000 立て替えている → B → A ¥5,000
 * - それ以外（3 人以上・相手が分からない）は金額を出さない（undeterminable）。
 *   LINE の「精算」は従来どおり記録まで行い、Web は記録を受け付けない。
 */

import {
  calculateSettlement,
  getGroupByLineGroupId,
  getGroupMembers,
  type AdvanceSummary,
  type GroupMember,
  type SettlementResult,
} from './firestore';
import { errorMessage, maskId } from './logSafe';

/** none=未精算の立替なし / pair=2人とも立替あり / single_advancer=1人だけ立替あり / undeterminable=計算できない */
export type SettlementBasis = 'none' | 'pair' | 'single_advancer' | 'undeterminable';

/** 計算できない理由: partner_unknown=相手が分からない（関係者が1人）/ more_than_two=関係者が3人以上 */
export type UndeterminableReason = 'partner_unknown' | 'more_than_two';

export interface SettlementMember {
  lineId: string;
  displayName?: string;
}

export interface SettlementParticipant {
  userId: string;
  displayName: string;
  totalAdvanced: number;
}

export interface HouseholdSettlement {
  basis: SettlementBasis;
  reason: UndeterminableReason | null;
  settlement: SettlementResult | null;
  /** 関係者（members の順、その後にメンバー外の立替者を summaries の順） */
  participants: SettlementParticipant[];
}

/**
 * 立替のサマリーと有効メンバーから精算額を決める（純関数）
 *
 * @param summaries `getAdvanceSummaryByUser` の結果
 * @param members 有効なメンバー（表示順。名前はここを優先し、無ければ立替サマリーの名前）
 */
export function computeHouseholdSettlement(
  summaries: AdvanceSummary[],
  members: SettlementMember[]
): HouseholdSettlement {
  const byId = new Map<string, SettlementParticipant>();
  for (const member of members) {
    if (!member.lineId || byId.has(member.lineId)) continue;
    byId.set(member.lineId, {
      userId: member.lineId,
      displayName: member.displayName || '',
      totalAdvanced: 0,
    });
  }
  for (const summary of summaries) {
    const known = byId.get(summary.userId);
    if (known) {
      known.totalAdvanced += summary.totalAdvanced;
      if (!known.displayName) known.displayName = summary.userDisplayName || '';
    } else {
      byId.set(summary.userId, {
        userId: summary.userId,
        displayName: summary.userDisplayName || '',
        totalAdvanced: summary.totalAdvanced,
      });
    }
  }
  const participants = Array.from(byId.values());

  if (summaries.length === 0) {
    return { basis: 'none', reason: null, settlement: null, participants };
  }
  if (participants.length > 2) {
    return { basis: 'undeterminable', reason: 'more_than_two', settlement: null, participants };
  }
  if (participants.length < 2) {
    return { basis: 'undeterminable', reason: 'partner_unknown', settlement: null, participants };
  }
  if (summaries.length === 2) {
    // 従来の LINE の計算そのまま（差額 0 なら null）
    return { basis: 'pair', reason: null, settlement: calculateSettlement(summaries), participants };
  }

  // 立替者 1 人 + 立替の無いもう 1 人
  const advancer = summaries[0];
  const other = participants.find((p) => p.userId !== advancer.userId)!;
  const settlement = calculateSettlement([
    advancer,
    { userId: other.userId, userDisplayName: other.displayName, totalAdvanced: 0, expenses: [] },
  ]);
  return { basis: 'single_advancer', reason: null, settlement, participants };
}

function joinedAtMillis(member: GroupMember): number {
  const joinedAt = member.joinedAt as { toMillis?: () => number } | undefined;
  return typeof joinedAt?.toMillis === 'function' ? joinedAt.toMillis() : Number.POSITIVE_INFINITY;
}

/**
 * 有効メンバーを表示順（joinedAt 昇順、同時刻は lineId 順）に並べ、lineId の重複を除く
 *
 * 自動 ID の古い groupMembers 文書が決定的 ID の文書と並存していても 1 人として数える。
 */
export function sortActiveMembers(members: GroupMember[]): SettlementMember[] {
  const sorted = members
    .filter((m) => m && m.isActive === true && typeof m.lineId === 'string' && m.lineId.length > 0)
    .sort((a, b) => joinedAtMillis(a) - joinedAtMillis(b) || (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));

  const seen = new Map<string, SettlementMember>();
  for (const m of sorted) {
    const existing = seen.get(m.lineId);
    if (!existing) {
      seen.set(m.lineId, { lineId: m.lineId, displayName: m.displayName || '' });
    } else if (!existing.displayName && m.displayName) {
      existing.displayName = m.displayName;
    }
  }
  return Array.from(seen.values());
}

/**
 * LINE グループに紐づく世帯の有効メンバー
 *
 * 読み取りに失敗しても LINE のコマンド自体は止めない（メンバー 0 人として扱う。2 人とも立替が
 * ある場合は従来どおり金額を出し、1 人だけのときは従来どおり金額を出さない）。
 */
async function loadLineGroupMembers(lineGroupId: string): Promise<SettlementMember[]> {
  try {
    const group = await getGroupByLineGroupId(lineGroupId);
    if (!group?.id) return [];
    return sortActiveMembers(await getGroupMembers(group.id));
  } catch (error) {
    console.warn(`Failed to load members for LINE group ${maskId(lineGroupId)}:`, errorMessage(error));
    return [];
  }
}

/** LINE の「立替一覧」「精算」用: LINE グループの立替サマリーから精算額を決める */
export async function computeLineGroupSettlement(
  lineGroupId: string,
  summaries: AdvanceSummary[]
): Promise<HouseholdSettlement> {
  return computeHouseholdSettlement(summaries, await loadLineGroupMembers(lineGroupId));
}

/** 金額を出せる（pair / single_advancer）か */
export function isSettlementComputable(basis: SettlementBasis): boolean {
  return basis === 'pair' || basis === 'single_advancer';
}
