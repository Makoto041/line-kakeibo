/**
 * 「家計簿」コマンド: 当月の集計カードを返信する
 *
 * LINE グループでは、発言元の LINE グループに紐づく世帯の有効メンバーにだけ、世帯の集計（lineGroupId で引く）を返す（#271）。
 * 個人チャットは送った本人の支出（lineId で引く）だけを集計するので、所属は確かめない。
 */

import { getMonthlyBudget, getMonthlyGroupSummary, getUserGroups } from "../../firestore";
import { isHouseholdMember } from "../../expenseGroupScope";
import { getCategoryEmoji } from "../../gmail/types";
import { errorMessage, maskId } from "../../logSafe";
import { dayjs, nowJST } from "../../time";
import { replyMessages, replyText } from "../client";
import {
  buildEmptyExpenseSummaryFlexMessage,
  buildExpenseListUrl,
  buildExpenseSummaryFlexMessage,
  ExpenseSummaryInfo,
} from "../flexMessage";

/** LINE グループで、送った人が世帯のメンバーでない（または送った人が分からない）ときの返信 */
const MEMBERS_ONLY_TEXT = `家計簿の集計を表示できるのは、世帯のメンバーだけです。\nWebアプリ: ${buildExpenseListUrl()}`;

/** LINE グループで、世帯のメンバーかを確かめられなかったときの返信 */
const LOOKUP_FAILED_TEXT =
  "世帯のメンバーか確認できなかったため、集計を表示できませんでした。時間をおいてもう一度お試しください。\n" +
  `Webアプリ: ${buildExpenseListUrl()}`;

/** 集計してよいか。よければ集計に使う lineGroupId（個人チャットは undefined = 本人の lineId で引く） */
type SummaryAccess = { allowed: true; lineGroupId?: string } | { allowed: false; text: string };

/**
 * 集計を返してよいかを決める。
 *
 * LINE グループでは、発言元の LINE グループに紐づく世帯の有効メンバーに限る（expenseGroupScope.ts の isHouseholdMember。
 * 支出を世帯の支出にする条件と同じ）。userId が無い（LINE の規約に同意していない）発言者と、所属の確認に失敗したときは返さない。
 * 確認では表示名の更新などの書き込みをしない（findLineGroupId は使わない）。
 */
async function resolveSummaryAccess(event: {
  source?: { type?: string; groupId?: string; userId?: string };
}): Promise<SummaryAccess> {
  if (event.source?.type !== "group") return { allowed: true, lineGroupId: undefined };

  const lineGroupId = event.source.groupId;
  const userId = event.source.userId;
  if (!lineGroupId || !userId) {
    console.warn("Kakeibo summary refused: the sender is unknown", { group: maskId(lineGroupId) });
    return { allowed: false, text: MEMBERS_ONLY_TEXT };
  }

  try {
    const groups = await getUserGroups(userId);
    const activeGroup = groups.find((g) => g?.lineGroupId === lineGroupId) || null;
    if (isHouseholdMember(activeGroup, lineGroupId)) return { allowed: true, lineGroupId };
    console.warn("Kakeibo summary refused: the sender is not a household member", {
      user: maskId(userId),
      group: maskId(lineGroupId),
    });
    return { allowed: false, text: MEMBERS_ONLY_TEXT };
  } catch (error) {
    console.warn("Kakeibo summary refused: household membership lookup failed", {
      user: maskId(userId),
      group: maskId(lineGroupId),
      error: errorMessage(error),
    });
    return { allowed: false, text: LOOKUP_FAILED_TEXT };
  }
}

export async function handleKakeiboCommand(event: any, text: string): Promise<boolean> {
  if (text !== "家計簿") return false;

  try {
    const isGroupContext = event.source.type === "group";

    // Generate appropriate URL based on context
    const webAppUrl = buildExpenseListUrl();

    // 所属の確認と集計の取得を、あわせて 8 秒で打ち切る（超えたら下のテキストにフォールバック。集計は出さない）
    const timeoutPromise = new Promise<never>(
      (_, reject) =>
        setTimeout(() => reject(new Error("Summary fetch timeout")), 8000)
    );

    // 集計を読む前に、返してよいかを確かめる（だめなら支出も予算も読まない）
    const access = await Promise.race([resolveSummaryAccess(event), timeoutPromise]);
    if (!access.allowed) {
      await replyText(event.replyToken, access.text);
      return true;
    }
    const lineGroupId = access.lineGroupId;

    // 当月の集計データを取得（コンテナは UTC 動作のため JST で当月を決める）
    const now = nowJST();
    const summaryPromise = getMonthlyGroupSummary(
      lineGroupId,
      event.source.userId,
      now.year(),
      now.month() + 1,
      5
    );

    const summary = await Promise.race([summaryPromise, timeoutPromise]);

    if (summary.expenseCount === 0) {
      // データなしの場合
      const emptyMessage = buildEmptyExpenseSummaryFlexMessage(isGroupContext, webAppUrl);
      await replyMessages(event.replyToken, [emptyMessage]);
    } else {
      // カテゴリ別データの整形
      const totalIncluded = summary.includedTotalAmount || 1; // ゼロ除算防止
      const categoryTotals = summary.categoryTotals.slice(0, 5).map(cat => ({
        category: cat.category,
        emoji: getCategoryEmoji(cat.category),
        amount: cat.amount,
        percentage: Math.round((cat.amount / totalIncluded) * 100),
      }));

      // 直近の支出データの整形
      const recentExpenses = summary.recentExpenses.map(exp => ({
        description: exp.description || '不明',
        amount: exp.amount,
        category: exp.category || 'その他',
        categoryEmoji: getCategoryEmoji(exp.category || 'その他'),
        date: exp.date ? dayjs(exp.date).format('M/D') : '',
        includeInTotal: exp.includeInTotal !== false,
      }));

      // 設定された月次予算を取得（Web設定: budgetSettings/{lineId|groupId}）
      const monthlyBudget = await getMonthlyBudget(
        event.source.userId,
        lineGroupId
      );

      const summaryInfo: ExpenseSummaryInfo = {
        isGroupContext,
        webAppUrl,
        monthlyTotal: summary.totalAmount,
        monthlyIncludedTotal: summary.includedTotalAmount,
        monthlyCount: summary.expenseCount,
        monthlyIncludedCount: summary.includedExpenseCount,
        monthLabel: `${now.month() + 1}月`,
        recentExpenses,
        categoryTotals,
        monthlyBudget,
      };

      const flexMessage = buildExpenseSummaryFlexMessage(summaryInfo);
      await replyMessages(event.replyToken, [flexMessage]);
    }
  } catch (error) {
    console.error("Error fetching expenses:", error);

    // Fallback response (テキストメッセージ)
    try {
      await replyText(
        event.replyToken,
        `家計簿\n\n現在データを読み込み中です...\n${
          event.source.type === "group"
            ? "グループ全体の支出が確認できます"
            : "個人の支出が確認できます"
        }\nWebアプリで詳細を確認してください：\nhttps://line-kakeibo.vercel.app?lineId=` +
          encodeURIComponent(event.source.userId) +
          (event.source.type === "group" && event.source.groupId
            ? `&lineGroupId=${encodeURIComponent(event.source.groupId)}`
            : "")
      );
    } catch (replyError) {
      console.error("Failed to send fallback reply:", replyError);
    }
  }
  return true;
}
