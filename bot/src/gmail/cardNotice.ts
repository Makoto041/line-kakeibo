/**
 * カード利用通知（LINE の確認カード）の送信待ちの印
 *
 * Gmail 取込は支出を保存してからカードを push する。以前は push が失敗した・保存と push の間で関数が止まったときに、
 * 再処理では「登録済み」として飛ばされ、カードが永久に届かなかった（個人費・立替・支払った人を直す機会がなくなる）。
 *
 * - 支出を新規に保存するのと同じトランザクションで、印 `system/gmailCardNotice_{messageId}` を作る
 *   （saveGmailExpenseAtomic の notice。LINE グループが決まっているときだけ）。中身は送るはずだったカード（保存時点の内容）。
 * - 送れたら印を消す。送れなければ残し、同じメッセージの再処理（Pub/Sub の再送・/gmail/force-process）で送り直す。
 * - 送り直しても二重に届かないよう、メッセージごとに決まる X-Line-Retry-Key を付ける（LINE が受け付け済みなら 409）。
 *   この key は 24 時間しか効かないため、23 時間を過ぎた印は送らずに消す（二重に届くより、届かない方を選ぶ）。
 * - 印の無い既存の支出には送らない（この仕組みより前の支出のカードが一斉に送り直されないように）。
 */

import { createHash } from 'node:crypto';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type { DocumentReference } from 'firebase-admin/firestore';
import { sendCardUsageNotification } from '../line/flexMessage';
import type { CardUsageInfo } from '../line/flexMessage';
import { errorMessage, maskId } from '../logSafe';

export const CARD_NOTICE_PREFIX = 'gmailCardNotice_';

/** これより古い印は送らない（X-Line-Retry-Key が効くのは 24 時間。settlementSummary.ts の summaryRetryKey と同じ前提） */
export const CARD_NOTICE_MAX_AGE_MS = 23 * 60 * 60 * 1000;

/** 印に持つ値 */
export interface CardNotice {
  expenseId: string;
  lineGroupId: string;
  /** 送るはずだったカード（undefined の項目は持たない） */
  card: CardUsageInfo;
  createdAt: Timestamp;
}

/**
 * 印を見た結果。none: 印が無い / expired: 古すぎて送らずに消した / deleted: 支出が消されていたので送らずに消した /
 * sent: 送った（LINE が受け付け済みの 409 も含む）
 */
export type CardNoticeDelivery = 'none' | 'expired' | 'deleted' | 'sent';

export function cardNoticeRef(messageId: string): DocumentReference {
  return getFirestore().collection('system').doc(`${CARD_NOTICE_PREFIX}${messageId}`);
}

/** 同じメッセージなら同じ値になる UUID（LINE の X-Line-Retry-Key。導き方は settlementSummary.ts の summaryRetryKey と同じ） */
export function cardNoticeRetryKey(messageId: string): string {
  const h = createHash('sha256').update(`gmail-card:${messageId}`).digest('hex');
  // UUID v4 の形（version / variant のビットを立てる）
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * saveGmailExpenseAtomic に渡す印（新規に保存したときだけ、同じトランザクションで書かれる）
 *
 * @param card 送るカード。expenseId は保存で決まるので、build で入れる
 */
export function cardNoticeFor(
  messageId: string,
  lineGroupId: string,
  card: Omit<CardUsageInfo, 'expenseId'>
): { ref: DocumentReference; build: (expenseId: string) => CardNotice } {
  return {
    ref: cardNoticeRef(messageId),
    build: (expenseId) => ({
      expenseId,
      lineGroupId,
      // Firestore は undefined の値を書けない（categoryOrigin などは無いことがある）
      card: Object.fromEntries(
        Object.entries({ ...card, expenseId }).filter(([, value]) => value !== undefined)
      ) as unknown as CardUsageInfo,
      createdAt: Timestamp.now(),
    }),
  };
}

function millisOf(value: unknown): number {
  const ts = value as { toMillis?: () => number } | null | undefined;
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : NaN;
}

async function removeNotice(ref: DocumentReference, log: Record<string, string>): Promise<void> {
  // 消せなくても次の処理で同じ key で送り直すだけ（LINE が 409 を返す）なので、警告にとどめる
  await ref.delete().catch((error: unknown) => {
    console.warn('Gmail card notice: failed to remove the marker', { ...log, error: errorMessage(error) });
  });
}

/**
 * 送信待ちの印があれば、カードを送って印を消す
 *
 * push の失敗（409 以外）は投げる。呼び出し側はそのメッセージを失敗として数え、historyId を進めずに再処理させる。
 */
export async function deliverPendingCardNotice(messageId: string, now: Date = new Date()): Promise<CardNoticeDelivery> {
  const ref = cardNoticeRef(messageId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return 'none';

  const notice = snapshot.data() as CardNotice;
  const log = { message: maskId(messageId), expense: maskId(notice.expenseId) };

  // 作った時刻が読めないものも、key が効いているか分からないので送らない
  const ageMs = now.getTime() - millisOf(notice.createdAt);
  if (!(ageMs <= CARD_NOTICE_MAX_AGE_MS)) {
    console.warn('Gmail card notice expired; not resending', log);
    await removeNotice(ref, log);
    return 'expired';
  }

  const expense = await getFirestore().collection('expenses').doc(notice.expenseId).get();
  if (!expense.exists) {
    console.log('Gmail card notice dropped; the expense was deleted', log);
    await removeNotice(ref, log);
    return 'deleted';
  }

  try {
    await sendCardUsageNotification(
      notice.lineGroupId,
      { ...notice.card, expenseId: notice.expenseId },
      cardNoticeRetryKey(messageId)
    );
  } catch (error) {
    // 409: 同じ X-Line-Retry-Key で受け付け済み（前の処理で届いている）
    if ((error as { status?: unknown }).status !== 409) throw error;
    console.log('Gmail card notice already accepted by LINE', log);
  }
  await removeNotice(ref, log);
  return 'sent';
}
