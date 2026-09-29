/**
 * フィードバック（要望・改善・不具合報告）コマンド: GitHub Issue を自動起票する
 */

import { createIssueFromFeedback } from "../../issueCreator";
import { replyText } from "../client";

const FEEDBACK_PREFIXES = ["要望", "改善", "不具合", "フィードバック"];

/** 「要望 ○○」の本文を取り出す（フィードバックでなければ null） */
function parseFeedbackText(text: string): string | null {
  for (const prefix of FEEDBACK_PREFIXES) {
    // 半角スペース・全角スペースの両方に対応
    if (text.startsWith(`${prefix} `) || text.startsWith(`${prefix}　`)) {
      return text.slice(prefix.length + 1).trim();
    }
  }
  return null;
}

export async function handleFeedbackCommand(event: any, text: string): Promise<boolean> {
  const feedbackText = parseFeedbackText(text);
  if (feedbackText === null) return false;

  if (!feedbackText) {
    await replyText(event.replyToken, "フィードバック内容を入力してください。\n例: 「要望 月別のグラフが見たい」\n「不具合 レシートが読み取れない」");
    return true;
  }
  try {
    const result = await createIssueFromFeedback(feedbackText);
    await replyText(event.replyToken, result.message);
  } catch (error) {
    console.error("Error creating issue from feedback:", error);
    try {
      await replyText(event.replyToken, "Issueの作成に失敗しました。\n時間をおいてもう一度お試しください。");
    } catch (replyError) {
      console.error("Failed to send feedback error reply:", replyError);
    }
  }
  return true;
}
