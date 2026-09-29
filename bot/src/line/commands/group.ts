/**
 * グループ機能コマンド: 「グループ作成 ○○」「参加 ○○」（無効化済み）「グループ一覧」
 */

import { createGroup, getGroupMembers, getUserGroups } from "../../firestore";
import { replyText } from "../client";

export async function handleGroupCommand(event: any, text: string): Promise<boolean> {
  if (text.startsWith("グループ作成 ")) {
    await createGroupCommand(event, text);
    return true;
  }

  if (text.startsWith("参加 ")) {
    // 招待コードでの参加は無効化した。世帯はオーナーとパートナーの2名で固定し、
    // メンバーの追加は管理者が scripts/manage-group-members.mjs で行う。
    // （コードが漏れると第三者が気付かれずに参加できてしまうため。SEC-15 / CRIT-05）
    await replyText(event.replyToken, "招待コードでの参加は受け付けていません。\nメンバーの追加は管理者にご依頼ください。");
    return true;
  }

  if (text === "グループ一覧") {
    await listGroupsCommand(event);
    return true;
  }

  return false;
}

async function createGroupCommand(event: any, text: string): Promise<void> {
  const groupName = text.replace("グループ作成 ", "").trim();
  if (!groupName) {
    await replyText(event.replyToken, "グループ名を指定してください。\n例: 「グループ作成 田中夫婦の家計簿」");
    return;
  }

  try {
    const groupId = await createGroup(groupName, event.source.userId);
    const groups = await getUserGroups(event.source.userId);
    const group = groups.find((g) => g.id === groupId);

    const message = `グループ「${group?.name ?? groupName}」を作成しました！\n\nメンバーの追加は管理者にご依頼ください。`;

    await replyText(event.replyToken, message);
  } catch (error) {
    console.error("Error creating group:", error);
    await replyText(event.replyToken, "グループの作成に失敗しました。もう一度お試しください。");
  }
}

async function listGroupsCommand(event: any): Promise<void> {
  try {
    const groups = await getUserGroups(event.source.userId);

    if (groups.length === 0) {
      await replyText(event.replyToken, "まだグループに参加していません。\n\nメンバーの追加は管理者にご依頼ください。");
      return;
    }

    let message = "参加中のグループ:\n\n";
    for (const group of groups) {
      const members = await getGroupMembers(group.id!);
      const memberNames = members.map((m) => m.displayName).join("、");
      message += `${group.name}\n`;
      message += `メンバー: ${memberNames}\n`;
      message += `\n`;
    }

    await replyText(event.replyToken, message);
  } catch (error) {
    console.error("Error getting groups:", error);
    await replyText(event.replyToken, "グループ情報の取得に失敗しました。");
  }
}
