/**
 * LINE から登録する支出に付けるグループ所属（groupId / lineGroupId）を決める。
 *
 * bot の LINE 側の集計（家計簿・立替一覧・精算）はすべて lineGroupId で支出を引く。
 * 世帯の LINE グループに居るだけの非メンバー（第三者、脱退済みの元メンバー、
 * 別の家計グループを作った人など）の支出に lineGroupId を付けると、Web には出ないのに
 * 世帯の LINE 集計・精算にだけ混入してしまう。firestore.rules がクライアントに禁じている
 * 「groupId なしで lineGroupId だけを持つ支出」を Admin SDK 経由で作らないよう、
 * 発言元の LINE グループに紐づくグループの有効なメンバーである場合に限って両方を付け、
 * それ以外は個人支出（どちらも付けない）として保存する。
 *
 * @param activeGroup 発言者が有効なメンバーであるグループ（無ければ null）
 * @param lineGroupId 発言元の LINE グループ ID（個人チャットなら null）
 */
export function resolveExpenseGroupScope(
  activeGroup: { id?: string; lineGroupId?: string } | null | undefined,
  lineGroupId: string | null | undefined
): { groupId?: string; lineGroupId?: string } {
  if (!lineGroupId) {
    // 個人チャット: 所属グループがあればその支出として扱う（LINE グループは付けない）
    return { groupId: activeGroup?.id || undefined, lineGroupId: undefined };
  }
  const inHousehold =
    !!activeGroup && !!activeGroup.id && activeGroup.lineGroupId === lineGroupId;
  return inHousehold
    ? { groupId: activeGroup!.id, lineGroupId }
    : { groupId: undefined, lineGroupId: undefined };
}
