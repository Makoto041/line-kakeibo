/**
 * LINE から登録する支出に付けるグループ所属（groupId / lineGroupId）を決める。
 *
 * bot の LINE 側の集計（家計簿・以前の立替）は lineGroupId で支出を引く。
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

/**
 * LINE の入力の送信者が世帯のメンバーか（カテゴリ分類でモデル〔Jev・Gemini〕を呼んでよいか。#245）。
 *
 * 世帯 = LINE グループに紐づく（lineGroupId を持つ）グループ。「グループ作成」コマンドで誰でも
 * 自分だけのグループ（lineGroupId なし）の有効メンバーになれるため、グループに所属しているだけでは
 * メンバーとみなさない。LINE グループでの発言は、発言元の LINE グループに紐づくグループの
 * 有効メンバーに限る（resolveExpenseGroupScope が世帯の支出にするときと同じ条件）。
 *
 * @param activeGroup 発言者が有効なメンバーであるグループ（無ければ null）
 * @param lineGroupId 発言元の LINE グループ ID（個人チャットなら null）
 */
export function isHouseholdMember(
  activeGroup: { id?: string; lineGroupId?: string } | null | undefined,
  lineGroupId: string | null | undefined
): boolean {
  if (!activeGroup?.id || !activeGroup.lineGroupId) return false;
  return !lineGroupId || activeGroup.lineGroupId === lineGroupId;
}
