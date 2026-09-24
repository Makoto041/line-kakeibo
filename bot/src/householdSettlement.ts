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
 *
 * 表示名: groupMembers の displayName を優先するが、世帯作成時に作成者のメンバー文書へ入る仮名「作成者」
 * （firestore.ts の createGroup）は名前として扱わない（立替サマリーの名前があればそちら、無ければ空文字）。
 * 仮名として扱うのは作成者（groups.createdBy）の文書だけで、作成者が分からないときは全員の文書で扱う。
 * LINE で補った相手（立替 0 円）の名前が分からないときは `fillPartnerName` で LINE のプロフィールから引く。
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

/**
 * 世帯作成時に作成者のメンバー文書へ入る仮の表示名（firestore.ts の createGroup → addGroupMember）
 *
 * LINE のグループで自動作成された世帯では、作成者が発言していてもこのまま更新されないことがある。
 */
export const CREATOR_PLACEHOLDER_NAME = '作成者';

/**
 * groupMembers の displayName を表示名として使える形にする（文字列以外は空文字）
 *
 * @param mayBePlaceholder 作成者の文書（または作成者が分からない）なら true。このときだけ仮名「作成者」を空文字にする
 */
export function memberDisplayName(name: unknown, mayBePlaceholder = true): string {
  if (typeof name !== 'string') return '';
  return mayBePlaceholder && name === CREATOR_PLACEHOLDER_NAME ? '' : name;
}

/** 表示名が分からないときの代わり（index.ts のプロフィール取得失敗時と同じ形） */
export function fallbackDisplayName(userId: string): string {
  return `User_${userId.slice(-6)}`;
}

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
 * @param members 有効なメンバー（`sortActiveMembers` の結果。表示順で、仮名「作成者」は空にしてある。
 *   名前はここを優先し、空なら立替サマリーの名前）
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
      displayName: typeof member.displayName === 'string' ? member.displayName : '',
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
 * 表示名は `memberDisplayName` で整える（仮名「作成者」を空にするのは createdBy の文書だけ。
 * createdBy が分からなければ全員の文書で空にする）。
 *
 * @param createdBy 世帯の作成者の lineId（groups.createdBy）
 */
export function sortActiveMembers(members: GroupMember[], createdBy?: string | null): SettlementMember[] {
  const creatorKnown = typeof createdBy === 'string' && createdBy.length > 0;
  const sorted = members
    .filter((m) => m && m.isActive === true && typeof m.lineId === 'string' && m.lineId.length > 0)
    .sort((a, b) => joinedAtMillis(a) - joinedAtMillis(b) || (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));

  const seen = new Map<string, SettlementMember>();
  for (const m of sorted) {
    const existing = seen.get(m.lineId);
    const displayName = memberDisplayName(m.displayName, !creatorKnown || m.lineId === createdBy);
    if (!existing) {
      seen.set(m.lineId, { lineId: m.lineId, displayName });
    } else if (!existing.displayName && displayName) {
      existing.displayName = displayName;
    }
  }
  return Array.from(seen.values());
}

/**
 * LINE グループに紐づく世帯の有効メンバー（computeLineGroupSettlement が立替者 1 人のときだけ読む）
 *
 * 読み取りに失敗しても LINE のコマンド自体は止めない（メンバー 0 人として扱い、従来どおり金額を出さない）。
 */
async function loadLineGroupMembers(lineGroupId: string): Promise<SettlementMember[]> {
  try {
    const group = await getGroupByLineGroupId(lineGroupId);
    if (!group?.id) return [];
    return sortActiveMembers(await getGroupMembers(group.id), group.createdBy);
  } catch (error) {
    console.warn(`Failed to load members for LINE group ${maskId(lineGroupId)}:`, errorMessage(error));
    return [];
  }
}

/** 表示名を引く関数（LINE のグループメンバーのプロフィールなど）。分からなければ undefined */
export type DisplayNameResolver = (userId: string) => Promise<string | undefined>;

/**
 * single_advancer で補った相手（立替 0 円）の表示名が分からないとき、resolveName で補う
 *
 * 相手はメンバー文書だけから分かる人なので、displayName が空か仮名「作成者」だと LINE の文面が
 * 「 まこと」「作成者 まこと」になる（仮名は sortActiveMembers で空にしてある）。resolveName が返すのは
 * LINE のプロフィール名（本人の名前）なのでそのまま使う。resolveName が無い・失敗した・空を返したときは
 * `User_xxxxxx`。
 * 立替者の名前は立替サマリー（支出に記録された名前）なので触らない。pair などはそのまま返す。
 */
export async function fillPartnerName(
  result: HouseholdSettlement,
  summaries: AdvanceSummary[],
  resolveName?: DisplayNameResolver
): Promise<HouseholdSettlement> {
  const settlement = result.settlement;
  if (result.basis !== 'single_advancer' || !settlement || summaries.length !== 1) return result;
  const partner = result.participants.find((p) => p.isMember && p.userId !== summaries[0].userId);
  if (!partner || partner.displayName) return result;

  let name = '';
  if (resolveName) {
    try {
      const resolved = await resolveName(partner.userId);
      name = typeof resolved === 'string' ? resolved.trim() : '';
    } catch (error) {
      console.warn(`Failed to resolve display name for ${maskId(partner.userId)}:`, errorMessage(error));
    }
  }
  if (!name) name = fallbackDisplayName(partner.userId);

  return {
    ...result,
    settlement: {
      ...settlement,
      fromUserName: settlement.fromUserId === partner.userId ? name : settlement.fromUserName,
      toUserName: settlement.toUserId === partner.userId ? name : settlement.toUserName,
    },
    participants: result.participants.map((p) => (p === partner ? { ...p, displayName: name } : p)),
  };
}

/**
 * LINE の「立替一覧」「精算」用: LINE グループの立替サマリーから精算額を決める
 *
 * 従来の挙動（立替者がちょうど 2 人なら計算）を保ち、Q15（1 人だけ立替・有効メンバー 2 人）だけを足す。
 * `legacyPair` では立替者が 0 人・2 人・3 人以上のときの結果はメンバーに左右されないので、世帯の
 * メンバーを読むのは立替者が 1 人のときだけ（従来の経路に Firestore の読み取りを足さない）。
 *
 * @param resolveName 補った相手の表示名が分からないときに使う（index.ts は LINE のグループメンバーのプロフィール）
 */
export async function computeLineGroupSettlement(
  lineGroupId: string,
  summaries: AdvanceSummary[],
  resolveName?: DisplayNameResolver
): Promise<HouseholdSettlement> {
  const members = summaries.length === 1 ? await loadLineGroupMembers(lineGroupId) : [];
  const result = computeHouseholdSettlement(summaries, members, { legacyPair: true });
  return fillPartnerName(result, summaries, resolveName);
}

/** 金額を出せる（pair / single_advancer）か */
export function isSettlementComputable(basis: SettlementBasis): boolean {
  return basis === 'pair' || basis === 'single_advancer';
}
