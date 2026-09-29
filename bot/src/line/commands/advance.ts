/**
 * 立替コマンド: 「立替一覧」（「立替」）と「精算」。どちらも LINE グループ内でのみ使える
 */

import {
  getAdvanceSummaryByUser,
  getPendingAdvances,
  settleAdvances,
} from "../../firestore";
import { computeLineGroupSettlement, isSettlementComputable } from "../../householdSettlement";
import { getLineClient, replyText } from "../client";

export async function handleAdvanceCommand(event: any, text: string): Promise<boolean> {
  if (text === "立替一覧" || text === "立替") {
    await advanceListCommand(event);
    return true;
  }
  if (text === "精算") {
    await settleCommand(event);
    return true;
  }
  return false;
}

/** 表示名の解決（householdSettlement に渡す） */
function groupMemberDisplayName(lineGroupId: string) {
  return (userId: string) =>
    getLineClient().getGroupMemberProfile(lineGroupId, userId).then((p) => p.displayName);
}

async function advanceListCommand(event: any): Promise<void> {
  try {
    // グループコンテキストが必要
    if (event.source.type !== "group") {
      await replyText(event.replyToken, "立替一覧はグループ内でのみ利用できます。\n\nLINEグループで「立替一覧」と送信してください。");
      return;
    }

    const lineGroupId = event.source.groupId;
    const summaries = await getAdvanceSummaryByUser(lineGroupId, true);

    if (summaries.length === 0) {
      await replyText(event.replyToken, "未精算の立替はありません。\n\n支出登録時に「立替」ボタンを押すと、立替として記録できます。");
      return;
    }

    // サマリーを表示
    let message = "未精算の立替一覧:\n\n";

    for (const summary of summaries) {
      message += `${summary.userDisplayName}\n`;
      message += `   立替合計: ¥${summary.totalAdvanced.toLocaleString()}\n`;
      // 最近の3件のみ表示
      const recentExpenses = summary.expenses.slice(0, 3);
      for (const expense of recentExpenses) {
        message += `   • ${expense.description} ¥${expense.amount.toLocaleString()}\n`;
      }
      if (summary.expenses.length > 3) {
        message += `   ...他${summary.expenses.length - 3}件\n`;
      }
      message += "\n";
    }

    // 精算額を計算（立替者が2人、または1人だけ立替で有効メンバーが2人の場合。householdSettlement.ts の共有関数）
    const household = await computeLineGroupSettlement(lineGroupId, summaries, groupMemberDisplayName(lineGroupId));
    if (isSettlementComputable(household.basis)) {
      const settlement = household.settlement;
      if (settlement) {
        message += `\n精算額:\n`;
        message += `${settlement.fromUserName} ${settlement.toUserName}\n`;
        message += `¥${settlement.amount.toLocaleString()}\n\n`;
        message += `「精算」と送信すると精算を完了できます。`;
      } else {
        message += `\n精算不要（差額なし）`;
      }
    }

    await replyText(event.replyToken, message);
  } catch (error) {
    console.error("Error getting advance list:", error);
    await replyText(event.replyToken, "立替一覧の取得に失敗しました。");
  }
}

async function settleCommand(event: any): Promise<void> {
  try {
    // グループコンテキストが必要
    if (event.source.type !== "group") {
      await replyText(event.replyToken, "精算はグループ内でのみ利用できます。\n\nLINEグループで「精算」と送信してください。");
      return;
    }

    const lineGroupId = event.source.groupId;
    const pendingAdvances = await getPendingAdvances(lineGroupId, true);

    if (pendingAdvances.length === 0) {
      await replyText(event.replyToken, "精算する立替がありません。");
      return;
    }

    const summaries = await getAdvanceSummaryByUser(lineGroupId, true);

    // 精算額を計算（立替者が2人、または1人だけ立替で有効メンバーが2人の場合。householdSettlement.ts の共有関数）
    let settlementText = "";
    const household = await computeLineGroupSettlement(lineGroupId, summaries, groupMemberDisplayName(lineGroupId));
    if (isSettlementComputable(household.basis)) {
      const settlement = household.settlement;
      if (settlement) {
        settlementText = `\n\n精算内容:\n${settlement.fromUserName} ${settlement.toUserName}\n¥${settlement.amount.toLocaleString()}`;
      }
    }

    // 立替を精算済みにする（グループ検証付き）
    const expenseIds = pendingAdvances.map((e) => e.id!);
    const settleResult = await settleAdvances(expenseIds, lineGroupId, true);

    if (settleResult.settled === 0) {
      await replyText(event.replyToken, "精算処理でエラーが発生しました。対象の立替が見つかりませんでした。");
      return;
    }

    let resultText = `精算が完了しました！\n\n精算件数: ${settleResult.settled}件${settlementText}`;
    if (settleResult.skipped > 0) {
      resultText += `\n${settleResult.skipped}件はスキップされました`;
    }
    resultText += "\n\n次の立替からまた集計を開始します。";

    await replyText(event.replyToken, resultText);
  } catch (error) {
    console.error("Error settling advances:", error);
    await replyText(event.replyToken, "精算処理に失敗しました。");
  }
}
