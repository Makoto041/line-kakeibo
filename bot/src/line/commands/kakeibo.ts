/**
 * 「家計簿」コマンド: 当月の集計カードを返信する
 */

import { getMonthlyBudget, getMonthlyGroupSummary } from "../../firestore";
import { getCategoryEmoji } from "../../gmail/types";
import { dayjs, nowJST } from "../../time";
import { replyMessages, replyText } from "../client";
import {
  buildEmptyExpenseSummaryFlexMessage,
  buildExpenseListUrl,
  buildExpenseSummaryFlexMessage,
  ExpenseSummaryInfo,
} from "../flexMessage";

export async function handleKakeiboCommand(event: any, text: string): Promise<boolean> {
  if (text !== "家計簿") return false;

  try {
    const isGroupContext = event.source.type === "group";
    const lineGroupId = isGroupContext ? event.source.groupId : undefined;

    // Generate appropriate URL based on context
    const webAppUrl = buildExpenseListUrl();

    // 当月の集計データを取得（コンテナは UTC 動作のため JST で当月を決める）
    const now = nowJST();
    const summaryPromise = getMonthlyGroupSummary(
      lineGroupId,
      event.source.userId,
      now.year(),
      now.month() + 1,
      5
    );
    const timeoutPromise = new Promise(
      (_, reject) =>
        setTimeout(() => reject(new Error("Summary fetch timeout")), 8000)
    );

    const summary = (await Promise.race([
      summaryPromise,
      timeoutPromise,
    ])) as Awaited<ReturnType<typeof getMonthlyGroupSummary>>;

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
