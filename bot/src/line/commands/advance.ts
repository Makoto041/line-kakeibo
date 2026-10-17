/**
 * 立替コマンド: 「立替一覧」（「立替」）と「精算」
 *
 * 立替の精算は期間の精算（折半）にまとめた。誰が払ったかは支出の「支払った人」で数えるので、
 * 立替を別に精算すると二重に払うことになる。コマンドは残し、精算画面と通知の案内を返す。
 */

import { replyText } from "../client";
import { SETTLEMENT_URL } from "../settlementSummaryMessage";

export const ADVANCE_COMMAND_GUIDE =
  "立替の精算は「期間の精算（折半）」にまとめました。\n\n" +
  "誰が払ったかは、支出カードの「支払った人」で数えます（自分が払ったときは［自分が払った］）。" +
  "精算額は毎月の起算日に、このグループへ通知します。\n\n" +
  `精算を見る: ${SETTLEMENT_URL}`;

export async function handleAdvanceCommand(event: any, text: string): Promise<boolean> {
  if (text !== "立替一覧" && text !== "立替" && text !== "精算") return false;
  await replyText(event.replyToken, ADVANCE_COMMAND_GUIDE);
  return true;
}
