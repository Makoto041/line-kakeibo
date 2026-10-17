/**
 * 世帯の有効メンバーと表示名（期間の精算サマリー・固定費の計上で共通）
 *
 * 表示名: groupMembers の displayName を優先するが、世帯作成時に作成者のメンバー文書へ入る仮名「作成者」
 * （firestore.ts の createGroup）は名前として扱わない（空文字にして、呼び出し側で補う）。
 * 仮名として扱うのは作成者（groups.createdBy）の文書だけで、作成者が分からないときは全員の文書で扱う。
 */

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { groupMemberDocId, type GroupMember } from './firestore';

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

/** 表示名が分からないときの代わり（line/expenseFlow.ts のプロフィール取得失敗時と同じ形） */
export function fallbackDisplayName(userId: string): string {
  return `User_${userId.slice(-6)}`;
}

export interface HouseholdMember {
  lineId: string;
  displayName?: string;
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
export function sortActiveMembers(members: GroupMember[], createdBy?: string | null): HouseholdMember[] {
  const creatorKnown = typeof createdBy === 'string' && createdBy.length > 0;
  const sorted = members
    .filter((m) => m && m.isActive === true && typeof m.lineId === 'string' && m.lineId.length > 0)
    .sort((a, b) => joinedAtMillis(a) - joinedAtMillis(b) || (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));

  const seen = new Map<string, HouseholdMember>();
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
 * groupMembers/{groupId}_{lineId} が有効（isActive === true）なら、その表示名（仮名「作成者」は空文字）。
 * 有効でなければ null。読み取りは tx があればトランザクション内で行う
 *
 * 文書 ID だけでなく文書の groupId・lineId も照合する（groupId は利用者が指定でき `_` を含みうるため、
 * `${groupId}_${lineId}` が別の組み合わせの文書 ID と一致しても通さない）。
 */
export async function readActiveMember(
  db: Firestore,
  groupId: string,
  lineId: string,
  tx?: Pick<Transaction, 'get'>
): Promise<{ displayName: string } | null> {
  const ref = db.collection('groupMembers').doc(groupMemberDocId(groupId, lineId));
  const snapshot = tx ? await tx.get(ref) : await ref.get();
  if (
    !snapshot.exists ||
    snapshot.get('isActive') !== true ||
    snapshot.get('groupId') !== groupId ||
    snapshot.get('lineId') !== lineId
  ) {
    return null;
  }
  return { displayName: memberDisplayName(snapshot.get('displayName')) };
}
