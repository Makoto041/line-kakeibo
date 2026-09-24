/**
 * 世帯の精算額（LINE の「立替一覧」「精算」と Web のふたりタブで共通）
 *
 * 金額の計算そのものは既存の `calculateSettlement`（差額の 1/2 を Math.round）をそのまま使う。
 * ここで決めるのは「誰と誰の間で計算するか」だけ。
 *
 * 計算できるのは、世帯の有効メンバーがちょうど 2 人で、未精算の立替がある人が全員そのどちらかのとき:
 * - 2 人とも立替あり → そのまま計算（pair）
 * - 1 人だけ立替あり → もう 1 人を立替 0 円として補って計算（single_advancer。Q15）。
 *   例: A だけが ¥10,000 立て替えている → B → A ¥5,000
 * - それ以外（メンバー 3 人以上・立替者がメンバー外・相手が分からない）は金額を出さない（undeterminable。Q17）。
 *   Web は記録も受け付けない。
 *
 * LINE（`legacyPair: true`）は Q15 以外の挙動を変えないため、立替者がちょうど 2 人なら従来どおり
 * メンバー登録に関係なく pair で計算する（`groups` 文書が無い・メンバーの読み込みに失敗した場合も同じ）。
 * 1 人だけのときの補完は Web と同じ条件、それ以外は従来どおり金額を出さない（「精算」は記録まで行う）。
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

/**
 * 計算できない理由
 * - more_than_two: 関係者（有効メンバー ∪ 立替者）が 3 人以上
 * - partner_unknown: 世帯の相手が分からない（有効メンバーが 2 人そろっていない。本人だけ、または
 *   立替者がメンバー外・脱退済み）
 */
export type UndeterminableReason = 'partner_unknown' | 'more_than_two';

export interface SettlementMember {
  lineId: string;
  displayName?: string;
}

export interface SettlementParticipant {
  userId: string;
  displayName: string;
  totalAdvanced: number;
  /** 有効メンバーか（false はメンバー外・脱退済みの立替者） */
  isMember: boolean;
}

export interface HouseholdSettlement {
  basis: SettlementBasis;
  reason: UndeterminableReason | null;
  settlement: SettlementResult | null;
  /** 関係者（members の順、その後にメンバー外の立替者を summaries の順） */
  participants: SettlementParticipant[];
}

export interface SettlementRuleOptions {
  /**
   * LINE の「立替一覧」「精算」用（既定 false）。立替者がちょうど 2 人なら、メンバー登録に関係なく
   * 従来どおり pair で計算する。
   */
  legacyPair?: boolean;
}

/**
 * 立替のサマリーと有効メンバーから精算額を決める（純関数）
 *
 * @param summaries `getAdvanceSummaryByUser` の結果（立替者ごとに 1 件）
 * @param members 有効なメンバー（表示順。名前はここを優先し、無ければ立替サマリーの名前）
 */
export function computeHouseholdSettlement(
  summaries: AdvanceSummary[],
  members: SettlementMember[],
  options: SettlementRuleOptions = {}
): HouseholdSettlement {
  const byId = new Map<string, SettlementParticipant>();
  for (const member of members) {
    if (!member.lineId || byId.has(member.lineId)) continue;
    byId.set(member.lineId, {
      userId: member.lineId,
      displayName: member.displayName || '',
      totalAdvanced: 0,
      isMember: true,
    });
  }
  const memberCount = byId.size;
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
        isMember: false,
      });
    }
  }
  const participants = Array.from(byId.values());
  const result = (
    basis: SettlementBasis,
    settlement: SettlementResult | null = null,
    reason: UndeterminableReason | null = null
  ): HouseholdSettlement => ({ basis, reason, settlement, participants });

  if (summaries.length === 0) return result('none');

  // 従来の LINE の計算そのまま（差額 0 なら null）
  if (options.legacyPair && summaries.length === 2) return result('pair', calculateSettlement(summaries));

  const advancersAreMembers = summaries.every((s) => byId.get(s.userId)?.isMember === true);
  if (memberCount === 2 && advancersAreMembers) {
    if (summaries.length === 2) return result('pair', calculateSettlement(summaries));
    if (summaries.length === 1) {
      // 立替者 1 人 + 立替の無いもう 1 人のメンバー
      const advancer = summaries[0];
      const other = participants.find((p) => p.isMember && p.userId !== advancer.userId)!;
      return result(
        'single_advancer',
        calculateSettlement([
          advancer,
          { userId: other.userId, userDisplayName: other.displayName, totalAdvanced: 0, expenses: [] },
        ])
      );
    }
  }

  return result('undeterminable', null, participants.length > 2 ? 'more_than_two' : 'partner_unknown');
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
 * 読み取りに失敗しても LINE のコマンド自体は止めない（メンバー 0 人として扱う。`legacyPair` なので
 * 2 人とも立替がある場合は従来どおり金額を出し、1 人だけのときは従来どおり金額を出さない）。
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

/**
 * LINE の「立替一覧」「精算」用: LINE グループの立替サマリーから精算額を決める
 *
 * 従来の挙動（立替者がちょうど 2 人なら計算）を保ち、Q15（1 人だけ立替・有効メンバー 2 人）だけを足す。
 */
export async function computeLineGroupSettlement(
  lineGroupId: string,
  summaries: AdvanceSummary[]
): Promise<HouseholdSettlement> {
  return computeHouseholdSettlement(summaries, await loadLineGroupMembers(lineGroupId), { legacyPair: true });
}

/** 金額を出せる（pair / single_advancer）か */
export function isSettlementComputable(basis: SettlementBasis): boolean {
  return basis === 'pair' || basis === 'single_advancer';
}
