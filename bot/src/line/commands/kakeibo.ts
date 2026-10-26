/**
 * 「家計簿」コマンド: 当月の集計カードを返信する
 *
 * LINE グループでは、発言元の LINE グループに紐づく世帯（紐づくグループがちょうど 1 件）の有効メンバーにだけ、
 * 世帯の集計（lineGroupId で引く）を返す（#271）。1 対 1 のトークは送った本人の支出（lineId で引く）だけを集計するので、
 * 所属は確かめない。複数人トーク（room）・未知の種類のトークでは返さない。
 */

import { getFirestore } from "firebase-admin/firestore";
import { getMonthlyBudget, getMonthlyGroupSummary } from "../../firestore";
import { isHouseholdMember } from "../../expenseGroupScope";
import { getCategoryEmoji } from "../../gmail/types";
import { readActiveMember } from "../../householdMembers";
import { errorFields, maskId } from "../../logSafe";
import { dayjs, nowJST } from "../../time";
import { replyMessages, replyText } from "../client";
import {
  buildEmptyExpenseSummaryFlexMessage,
  buildExpenseListUrl,
  buildExpenseSummaryFlexMessage,
  ExpenseSummaryInfo,
} from "../flexMessage";

/** 送った人が世帯のメンバーでない（送った人が分からない、集計を返さないトークを含む）ときの返信 */
const MEMBERS_ONLY_TEXT = `家計簿の集計を表示できるのは、世帯のメンバーだけです。\nWebアプリ: ${buildExpenseListUrl()}`;

/** LINE グループで、世帯のメンバーかを確かめられなかったときの返信 */
const LOOKUP_FAILED_TEXT =
  "世帯のメンバーか確認できなかったため、集計を表示できませんでした。時間をおいてもう一度お試しください。\n" +
  `Webアプリ: ${buildExpenseListUrl()}`;

/** 集計してよいか。よければ集計に使う lineGroupId（1 対 1 のトークは undefined = 本人の lineId で引く） */
type SummaryAccess = { allowed: true; lineGroupId?: string } | { allowed: false; text: string };

/**
 * 集計を返してよいかを決める（失敗は拒否にして返し、投げない）。
 *
 * - 1 対 1 のトーク（type: user）: 本人の支出だけを集計するので、所属は確かめない
 * - LINE グループ: 発言元の LINE グループに紐づくグループ（groups.lineGroupId が一致）が**ちょうど 1 件**で、送った人が
 *   その有効メンバー（groupMembers/{groupId}_{lineId}。firestore.rules と同じ文書）のときだけ返す。2 件以上ならどれが世帯か
 *   決められないので返さない。判定は isHouseholdMember（支出を世帯の支出にする条件。#258）と同じ考え方。
 *   読み取りは groups の問い合わせ（limit 2）とメンバー文書 1 件で、送った人の所属の数によらない。
 *   userId が無い（LINE の規約に同意していない）発言者と、所属の確認に失敗したときは返さない。表示名の更新などの書き込みはしない
 * - 複数人トーク（room）・未知の種類: 返さない（集計が参加者全員に見えるため）
 */
async function resolveSummaryAccess(event: {
  source?: { type?: string; groupId?: string; userId?: string };
}): Promise<SummaryAccess> {
  const source = event.source;
  const userId = source?.userId;

  if (source?.type === "user") {
    if (userId) return { allowed: true, lineGroupId: undefined };
    console.warn("Kakeibo summary refused: the sender is unknown", { sourceType: "user" });
    return { allowed: false, text: MEMBERS_ONLY_TEXT };
  }

  if (source?.type !== "group") {
    console.warn("Kakeibo summary refused: the chat type is not supported", {
      sourceType: String(source?.type ?? "(none)").slice(0, 20),
    });
    return { allowed: false, text: MEMBERS_ONLY_TEXT };
  }

  const lineGroupId = source.groupId;
  if (!lineGroupId || !userId) {
    console.warn("Kakeibo summary refused: the sender is unknown", { sourceType: "group", group: maskId(lineGroupId) });
    return { allowed: false, text: MEMBERS_ONLY_TEXT };
  }

  try {
    const db = getFirestore();
    const linked = await db.collection("groups").where("lineGroupId", "==", lineGroupId).limit(2).get();
    if (linked.size !== 1) {
      console.warn(
        linked.size === 0
          ? "Kakeibo summary refused: no group is linked to the LINE group"
          : "Kakeibo summary refused: more than one group is linked to the LINE group",
        { group: maskId(lineGroupId), user: maskId(userId), linkedGroups: linked.size }
      );
      return { allowed: false, text: MEMBERS_ONLY_TEXT };
    }

    const groupDoc = linked.docs[0];
    const member = await readActiveMember(db, groupDoc.id, userId);
    if (member && isHouseholdMember({ id: groupDoc.id, lineGroupId: groupDoc.get("lineGroupId") }, lineGroupId)) {
      return { allowed: true, lineGroupId };
    }
    console.warn("Kakeibo summary refused: the sender is not a household member", {
      user: maskId(userId),
      group: maskId(lineGroupId),
    });
    return { allowed: false, text: MEMBERS_ONLY_TEXT };
  } catch (error) {
    console.warn("Kakeibo summary refused: household membership lookup failed", {
      user: maskId(userId),
      group: maskId(lineGroupId),
      ...errorFields(error),
    });
    return { allowed: false, text: LOOKUP_FAILED_TEXT };
  }
}

export async function handleKakeiboCommand(event: any, text: string): Promise<boolean> {
  if (text !== "家計簿") return false;

  const isGroupContext = event.source?.type === "group";
  // Web のリンクは ID を含めない（グループのトークに LINE の ID を流さない）
  const webAppUrl = buildExpenseListUrl();

  // 所属の確認と集計の取得を、あわせて 8 秒で打ち切る
  const timeoutPromise = new Promise<never>(
    (_, reject) =>
      setTimeout(() => reject(new Error("Summary fetch timeout")), 8000)
  );

  // 集計を読む前に、返してよいかを確かめる（だめなら支出も予算も読まない）。
  // 拒否の返信は集計の try の外で送る（失敗しても、集計向けのフォールバック文を出さない）
  let access: SummaryAccess;
  try {
    access = await Promise.race([resolveSummaryAccess(event), timeoutPromise]);
  } catch (error) {
    // resolveSummaryAccess は失敗を拒否にして返すので、ここに来るのは打ち切りのときだけ
    console.warn("Kakeibo summary refused: household membership lookup timed out", errorFields(error));
    access = { allowed: false, text: LOOKUP_FAILED_TEXT };
  }
  if (!access.allowed) {
    try {
      await replyText(event.replyToken, access.text);
    } catch (replyError) {
      console.error("Failed to send the kakeibo refusal", errorFields(replyError));
    }
    return true;
  }
  const lineGroupId = access.lineGroupId;

  try {
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
    console.error("Error fetching expenses", errorFields(error));

    // Fallback response (テキストメッセージ。集計を返してよい人にだけ届く。集計は含めず、リンクは ID なし)
    try {
      await replyText(
        event.replyToken,
        `家計簿\n\n現在データを読み込み中です...\n${
          isGroupContext ? "グループ全体の支出が確認できます" : "個人の支出が確認できます"
        }\nWebアプリで詳細を確認してください：\n${webAppUrl}`
      );
    } catch (replyError) {
      console.error("Failed to send fallback reply", errorFields(replyError));
    }
  }
  return true;
}
