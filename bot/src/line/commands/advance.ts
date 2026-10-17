/**
 * 立替コマンド: 「立替一覧」（「立替」）と「精算」
 *
 * 立替は期間の精算（折半）に全額を加算して返す（支出の日付の期間）。精算の記録は要らないので、
 * コマンドでは一覧・記録はせず、精算画面と通知の案内を返す。
 */

import { replyText } from "../client";
import { SETTLEMENT_URL } from "../settlementSummaryMessage";

export const ADVANCE_COMMAND_GUIDE =
  "精算は「期間の精算（折半）」にまとめています。\n\n" +
  "相手の分を立て替えたときは、支出カードの［自分が立替］を押してください。その支出の日付の期間の精算に、全額を加算して返してもらいます。" +
  "精算額は毎月の起算日に、世帯のLINEグループへ通知します（精算画面で送金する人を選んでいるとき）。\n\n" +
  `精算を見る: ${SETTLEMENT_URL}`;

export async function handleAdvanceCommand(event: any, text: string): Promise<boolean> {
  if (text !== "立替一覧" && text !== "立替" && text !== "精算") return false;
  await replyText(event.replyToken, ADVANCE_COMMAND_GUIDE);
  return true;
}
