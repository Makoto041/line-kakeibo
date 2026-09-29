/**
 * LINE のテキストメッセージの処理
 *
 * コマンド（line/commands）に一致すればそれを処理し、そうでなければ「500 ランチ」の
 * ような支出の入力として解析して登録する（line/expenseFlow）。
 */

import { parseTextExpense } from "../textParser";
import { pushText } from "./client";
import { handleCommand } from "./commands";
import { processExpenseInBackground } from "./expenseFlow";

export async function handleTextMessage(event: any) {
  try {
    // 本文は個人情報を含みうるためログに出さない
    const text = event.message.text.trim();

    if (await handleCommand(event, text)) {
      return;
    }

    // テキスト登録
    const parsed = parseTextExpense(text);
    if (!parsed) {
      // 金額が見つからない場合は無視（コマンドでもない一般的なテキスト）
      // replyMessageを送らないことで、エラーを防ぐ
      return;
    }

    // 注: 中間メッセージ（「登録中です...」）は送信しない。
    // replyTokenを最終のFlex Message通知に温存し、replyMessage（無料）で
    // 送信することでpushMessage（月200通制限）の消費を1通節約する
    const targetId = event.source.type === "group"
      ? event.source.groupId
      : event.source.userId;

    // Process expense registration
    try {
      await processExpenseInBackground(event, parsed, event.replyToken);
    } catch (error) {
      console.error("Background expense processing failed:", error);
      // Send error notification
      await pushText(
        targetId,
        "支出の保存で問題が発生しました。データが正しく記録されていない可能性があります。"
      ).catch((pushError) =>
        console.error("Failed to send error notification:", pushError)
      );
    }
  } catch (error) {
    console.error("Text message handling error:", error);
    // エラーが発生した場合、可能であればユーザーに通知
    try {
      const targetId = event.source.type === "group"
        ? event.source.groupId
        : event.source.userId;
      await pushText(targetId, "メッセージの処理中にエラーが発生しました。もう一度お試しください。");
    } catch (notifyError) {
      console.error("Failed to send error notification:", notifyError);
    }
  }
}
