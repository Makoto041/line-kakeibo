/**
 * フィードバック（要望・改善・不具合報告）コマンド: GitHub Issue を自動起票する
 *
 * 本文は全文を Gemini（分類の退避先と同じ鍵）に渡して整理し、公開リポジトリに Issue を作る。
 * 誰でも友だち追加できる公式アカウントから無料枠を使い切られたり、公開 Issue を作られたりしないよう、
 * 次をすべて満たすときだけ受け付ける（#260）。
 * - 送った人が世帯のメンバー（isHouseholdMember。カテゴリ分類でモデルを呼ぶ条件と同じ）。
 *   所属は毎回読み直す（キャッシュしない）。読み取りに失敗したら受け付けない（分類と違い、拒否側に倒す）
 * - 本文が FEEDBACK_MAX_LENGTH 文字以内（超えたら切らずに受け付けない）
 * - 同じ人が FEEDBACK_RATE_WINDOW_MS の間に受け付けた件数が FEEDBACK_RATE_LIMIT 未満
 */

import { isHouseholdMember } from "../../expenseGroupScope";
import { getUserGroups } from "../../firestore";
import {
  createIssueFromFeedback,
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_TOO_LONG_MESSAGE,
  feedbackLength,
} from "../../issueCreator";
import { errorMessage, maskId } from "../../logSafe";
import { replyText } from "../client";

const FEEDBACK_PREFIXES = ["要望", "改善", "不具合", "フィードバック"];

/** 同じ人が FEEDBACK_RATE_WINDOW_MS の間に送れる件数 */
export const FEEDBACK_RATE_LIMIT = 3;
/** 件数を数える期間（ミリ秒。10 分） */
export const FEEDBACK_RATE_WINDOW_MS = 10 * 60 * 1000;

/** 世帯のメンバーでない人への返信 */
export const FEEDBACK_MEMBERS_ONLY_MESSAGE = "このコマンドを使えるのは、世帯のメンバーだけです。";

/** 送った人の userId が無い（LINE グループで、Bot を友だち追加していない人）ときの返信 */
const SENDER_UNKNOWN_MESSAGE =
  "送った人を確認できなかったため、受け付けられませんでした。この Bot を友だち追加すると、使えるようになります。";

/** 世帯の確認（Firestore の読み取り）に失敗したときの返信 */
const MEMBERSHIP_LOOKUP_FAILED_MESSAGE = "メンバーの確認に失敗しました。\n時間をおいてもう一度お試しください。";

/** 件数の上限に達したときの返信 */
const RATE_LIMITED_MESSAGE = `要望・不具合などを送れるのは、${FEEDBACK_RATE_WINDOW_MS / 60000} 分に ${FEEDBACK_RATE_LIMIT} 件までです。\nしばらくしてから、もう一度送ってください。`;

/**
 * 受け付けた時刻（利用者の userId ごと。古い順）
 *
 * 関数のインスタンスのメモリに置く（インスタンスをまたいでは数えない。再起動・デプロイで消える）。
 * 数えるのは世帯のメンバーの分だけなので、件数は増えない。
 */
const acceptedAtByUser = new Map<string, number[]>();

/** 期間内に受け付けた件数が上限未満なら 1 件分を使って true、上限に達していれば false */
function takeFeedbackSlot(userId: string, now: number): boolean {
  const recent = (acceptedAtByUser.get(userId) ?? []).filter((at) => now - at < FEEDBACK_RATE_WINDOW_MS);
  if (recent.length >= FEEDBACK_RATE_LIMIT) {
    acceptedAtByUser.set(userId, recent);
    return false;
  }
  recent.push(now);
  acceptedAtByUser.set(userId, recent);
  return true;
}

/**
 * 送った人が世帯のメンバーか（所属グループのどれかが isHouseholdMember を満たすか）。
 *
 * line/expenseFlow.ts の判定（pickActiveGroup で選んだグループを isHouseholdMember に渡す）と同じ結果になる:
 * LINE グループでの発言は、発言元の LINE グループに紐づくグループの有効メンバー。個人チャットは、
 * lineGroupId を持つどれかのグループの有効メンバー。読み取りに失敗したら投げる。
 */
async function isSenderHouseholdMember(userId: string, lineGroupId: string | null): Promise<boolean> {
  const groups = await getUserGroups(userId);
  return groups.some((group) => isHouseholdMember(group, lineGroupId));
}

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
    await replyText(event.replyToken, "フィードバック内容を入力してください。\n例: 「要望 月別のグラフが見たい」\n「不具合 金額が合わない」");
    return true;
  }

  // 本文は利用者の入力なのでログに出さない（ID は伏せる）
  const userId: string | undefined = event.source?.userId;
  if (!userId) {
    console.warn("Feedback rejected: the sender's userId is missing", { sourceType: event.source?.type });
    await replyText(event.replyToken, SENDER_UNKNOWN_MESSAGE);
    return true;
  }
  const user = maskId(userId);
  const lineGroupId: string | null = event.source.type === "group" ? event.source.groupId || null : null;

  let member: boolean;
  try {
    member = await isSenderHouseholdMember(userId, lineGroupId);
  } catch (error) {
    console.warn("Feedback rejected: household membership lookup failed", { user, error: errorMessage(error) });
    await replyText(event.replyToken, MEMBERSHIP_LOOKUP_FAILED_MESSAGE);
    return true;
  }
  if (!member) {
    console.log("Feedback rejected: the sender is not a household member", { user });
    await replyText(event.replyToken, FEEDBACK_MEMBERS_ONLY_MESSAGE);
    return true;
  }

  const length = feedbackLength(feedbackText);
  if (length > FEEDBACK_MAX_LENGTH) {
    console.log("Feedback rejected: too long", { user, length, max: FEEDBACK_MAX_LENGTH });
    await replyText(event.replyToken, FEEDBACK_TOO_LONG_MESSAGE);
    return true;
  }

  // Gemini・GitHub を呼ぶ前に 1 件分を使う（失敗しても戻さない。Gemini はすでに呼んでいることがあるため）
  if (!takeFeedbackSlot(userId, Date.now())) {
    console.log("Feedback rejected: rate limited", { user, limit: FEEDBACK_RATE_LIMIT, windowMs: FEEDBACK_RATE_WINDOW_MS });
    await replyText(event.replyToken, RATE_LIMITED_MESSAGE);
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
