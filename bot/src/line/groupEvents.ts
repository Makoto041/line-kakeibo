/**
 * LINE グループのイベント（bot の参加・退出、メンバーの参加・退出）
 */

import { deactivateLineGroupMembers } from "../firestore";
import { maskId } from "../logSafe";
import { pushText } from "./client";
import { forgetCachedProfiles } from "./expenseFlow";

export async function handleJoin(event: any) {
  try {
    // イベント全体には replyToken や ID が含まれるためそのまま出さない
    console.log(`Bot joined group: ${maskId(event.source?.groupId)}`);

    const lineGroupId = event.source.groupId;
    if (!lineGroupId) {
      console.warn("No group ID found in join event");
      return;
    }

    // Add delay to ensure group is properly set up
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Send welcome message with error handling
    try {
      await pushText(lineGroupId, "家計簿ボットがグループに参加しました！\n\nレシート画像を送信すると支出を自動記録\n「500 ランチ」のようにテキストでも記録\n「家計簿」で支出一覧を表示\n\nグループメンバーの支出が自動的に共有されます");

      console.log(
        `Bot successfully joined and sent welcome to LINE group: ${maskId(lineGroupId)}`
      );
    } catch (messageError) {
      console.error("Failed to send welcome message:", messageError);
      // Don't throw error - bot should still remain in group
    }
  } catch (error) {
    console.error("Join event handling error:", error);
    // Don't throw error to prevent bot from appearing broken
  }
}

export async function handleMemberJoined(event: any) {
  try {
    console.log(`Member joined event: group=${maskId(event.source?.groupId)}`);

    const lineGroupId = event.source.groupId;
    if (!lineGroupId) {
      console.warn("No group ID found in member joined event");
      return;
    }

    // ボット以外のメンバーが追加された場合の処理
    if (event.joined?.members?.some((member: any) => member.type === "user")) {
      try {
        // Add small delay to ensure member is properly added
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Use pushMessage instead of replyMessage for better compatibility
        await pushText(lineGroupId, "新しいメンバーがグループに参加しました！\n家計簿ボットで支出を記録・共有できます。\n\n「家計簿」と送信すると使い方を確認できます。");

        console.log(
          `Successfully sent welcome message for new member in group: ${maskId(lineGroupId)}`
        );
      } catch (messageError) {
        console.error("Failed to send member welcome message:", messageError);
        // Don't throw error - this is not critical
      }
    }
  } catch (error) {
    console.error("Member joined event handling error:", error);
    // Don't throw error to prevent bot from appearing broken
  }
}

/**
 * LINE グループからメンバーが退出（または削除）されたときの処理。
 *
 * 退出したユーザーの groupMembers を isActive:false にして、Web（Firestore / Storage
 * ルールの isActive 判定）へのアクセス権を失わせる。memberLeft には replyToken が
 * 無いので返信はしない（push も消費しない）。
 */
export async function handleMemberLeft(event: any) {
  try {
    const lineGroupId = event.source?.groupId;
    if (!lineGroupId) {
      console.warn("No group ID found in member left event");
      return;
    }
    const userIds: string[] = (event.left?.members ?? [])
      .filter((m: any) => m?.type === "user" && typeof m.userId === "string")
      .map((m: any) => m.userId);
    if (userIds.length === 0) return;

    const count = await deactivateLineGroupMembers(lineGroupId, userIds);
    forgetCachedProfiles(lineGroupId, userIds);
    console.log(
      `Member left group ${maskId(lineGroupId)}: ${userIds.length} user(s), ${count} membership(s) deactivated`
    );
  } catch (error) {
    // 失敗しても webhook 全体は成功扱いにする（LINE の再送で二重処理しても冪等）。
    console.error("Member left event handling error:", error);
  }
}

/**
 * bot がグループから退出させられたときの処理。
 *
 * メンバーシップは変更しない。bot が誤って外された場合に世帯全員の Web アクセスまで
 * 失うのを避けるため（個々の退出は memberLeft で扱う）。記録だけ残す。
 */
export function handleLeave(event: any) {
  console.warn(`Bot left group: ${maskId(event.source?.groupId)} (memberships unchanged)`);
}
