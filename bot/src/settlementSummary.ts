/**
 * 期間の精算（折半）のサマリーを LINE グループへ送る（毎日のスケジュール関数から呼ぶ）
 *
 * - いつ: 期間の起算日（集金するメンバーの期間設定。例: 15日起算なら毎月 15 日）に、締まった期間の分を 1 回。
 *   新しいスケジュールは増やさず、毎日の固定費の計上（index.ts の postRecurringExpenses）と同じ実行で判定する
 *   （Cloud Scheduler の無料枠のジョブ数を使い切っているため）。
 * - 何を: Web の「期間の精算（折半）」と同じ計算（periodSplit.ts）の結果。送金する人と受け取る人をメンションした
 *   テキストと、内訳・カテゴリ別・要確認・未精算の立替をまとめた Flex を 1 回の push で送る。
 * - 対象: LINE グループに紐づき、集金するメンバー（groups.splitSettings.collectFromLineId）が決まっていて、
 *   有効メンバーがちょうど 2 人の世帯。
 * - 冪等: 送る前に system/settlementSummary_{groupId}_{期間末日} を create する（同じ期間は 2 回送らない）。
 *   送信に失敗したら消して、次の実行（関数のリトライ）で送り直す。LINE の X-Line-Retry-Key も付ける。
 *   印はあるのに送った時刻（sentAt）が無い（前の実行が送信の途中で止まった・印を消せなかった）ときは、
 *   同じ X-Line-Retry-Key で送り直す（LINE が受け付け済みなら 409 が返り、二重には届かない）。
 * - 起算日が 29〜31 日で、その日が無い月には送らず、次の回でその分も含める（closedPeriodFor）。
 */

import { createHash } from 'node:crypto';
import type { messagingApi } from '@line/bot-sdk';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdvanceSummaryByUser, type GroupMember } from './firestore';
import { computeHouseholdSettlement, sortActiveMembers, type SettlementMember } from './householdSettlement';
import { errorMessage, maskId } from './logSafe';
import { amountOf, computePeriodSplit, periodPool, type PeriodSplit, type SplitExpense } from './periodSplit';
import { dayjs, JST } from './time';

export const SETTLEMENT_SUMMARY_MARKER_PREFIX = 'settlementSummary_';
/** Flex に並べるカテゴリの数（残りは「ほか」にまとめる） */
export const SUMMARY_TOP_CATEGORIES = 5;

// ============================================
// 期間
// ============================================

interface DateSettingsLike {
  mode?: unknown;
  customStartDay?: unknown;
  startDate?: unknown;
  endDate?: unknown;
}

/**
 * 期間の起算日（Web の getEffectiveDateRange と同じ解釈）。固定期間（custom）は締めが無いので null
 */
export function periodStartDay(settings: DateSettingsLike | null | undefined): number | null {
  if (settings?.mode === 'custom' && settings.startDate && settings.endDate) return null;
  const day = Number(settings?.customStartDay);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1;
}

/**
 * 今日が起算日なら、締まった期間（前回の起算日〜昨日）。それ以外の日は null
 *
 * 例: 15日起算で 10/15 → 9/15〜10/14、1日起算で 10/1 → 9/1〜9/30（Web の期間と同じ）。
 * 起算日 29〜31 は、その日が無い月には送らず、次の回でその分も含める
 * （31日起算なら 3/31 → 1/31〜3/30。2 月には 31 日が無いため）
 */
export function closedPeriodFor(today: string, startDay: number | null): { startDate: string; endDate: string } | null {
  if (startDay === null) return null;
  const d = dayjs.tz(today, 'YYYY-MM-DD', JST);
  if (!d.isValid() || d.date() !== startDay) return null;
  // 前回の起算日: 起算日がある月までさかのぼる（29〜31 日でなければ前の月）
  let month = d.startOf('month').subtract(1, 'month');
  while (month.daysInMonth() < startDay) month = month.subtract(1, 'month');
  return {
    startDate: month.date(startDay).format('YYYY-MM-DD'),
    endDate: d.subtract(1, 'day').format('YYYY-MM-DD'),
  };
}

// ============================================
// サマリーの中身（純関数）
// ============================================

export interface SummaryExpense extends SplitExpense {
  category?: unknown;
  confirmed?: unknown;
  inputSource?: unknown;
}

export interface CategoryTotal {
  category: string;
  amount: number;
  /** 合計に占める割合（0〜100） */
  percentage: number;
}

export interface AdvanceDigest {
  count: number;
  total: number;
  transfer: { fromLineId: string; toLineId: string; amount: number } | null;
}

export interface SettlementSummary {
  groupId: string;
  range: { startDate: string; endDate: string };
  members: SettlementMember[];
  split: PeriodSplit;
  /** 集金するメンバー以外の支払い（相手・カード・共通口座）の合計 */
  othersPaid: number;
  categories: CategoryTotal[];
  /** 上位に入らなかったカテゴリの合計 */
  otherCategories: { count: number; amount: number };
  /** 要確認（LINE で手入力して未確認。合計に入っていない） */
  pending: { count: number; amount: number };
  advances: AdvanceDigest | null;
}

/** 要確認（Web の isPending と同じ。自動で入った支出は確認不要） */
export function isPendingManual(e: Pick<SummaryExpense, 'inputSource' | 'status' | 'confirmed'>): boolean {
  if (e.inputSource === 'gmail_auto' || e.inputSource === 'recurring') return false;
  return (e.status == null || e.status === 'pending') && e.confirmed !== true;
}

export function buildSettlementSummary(input: {
  groupId: string;
  range: { startDate: string; endDate: string };
  members: SettlementMember[];
  collectFrom: string;
  expenses: readonly SummaryExpense[];
  advances: AdvanceDigest | null;
}): SettlementSummary {
  const split = computePeriodSplit({
    expenses: input.expenses,
    groupId: input.groupId,
    members: input.members,
    targetLineId: input.collectFrom,
    range: input.range,
  });
  const pool = periodPool(input.expenses, input.groupId, input.range);
  const counted = pool.filter((e) => e.includeInTotal && e.status !== 'advance_settled');

  const byCategory = new Map<string, number>();
  for (const e of counted) {
    const category = typeof e.category === 'string' && e.category ? e.category : 'その他';
    byCategory.set(category, (byCategory.get(category) ?? 0) + amountOf(e));
  }
  const sorted = Array.from(byCategory, ([category, amount]) => ({
    category,
    amount,
    percentage: split.total > 0 ? Math.round((amount / split.total) * 1000) / 10 : 0,
  })).sort((a, b) => b.amount - a.amount);
  const rest = sorted.slice(SUMMARY_TOP_CATEGORIES);

  const pending = pool.filter(isPendingManual);
  return {
    groupId: input.groupId,
    range: input.range,
    members: input.members,
    split,
    othersPaid: split.total - split.targetPaid,
    categories: sorted.slice(0, SUMMARY_TOP_CATEGORIES),
    otherCategories: { count: rest.length, amount: rest.reduce((sum, c) => sum + c.amount, 0) },
    pending: { count: pending.length, amount: pending.reduce((sum, e) => sum + amountOf(e), 0) },
    advances: input.advances,
  };
}

// ============================================
// 送信
// ============================================

export type PushFn = (to: string, messages: messagingApi.Message[], retryKey: string) => Promise<void>;

export interface SummaryRunResult {
  checked: number;
  sent: number;
  skipped: number;
  failed: number;
}

/** 同じ世帯・期間なら同じ値になる UUID（LINE の X-Line-Retry-Key。24 時間以内の重複送信を LINE 側でも防ぐ） */
export function summaryRetryKey(groupId: string, endDate: string): string {
  const h = createHash('sha256').update(`settlement-summary:${groupId}:${endDate}`).digest('hex');
  // UUID v4 の形（version / variant のビットを立てる）
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface HouseholdTarget {
  groupId: string;
  lineGroupId: string;
  collectFrom: string;
  members: SettlementMember[];
}

async function loadTargets(db: Firestore): Promise<HouseholdTarget[]> {
  const groups = await db.collection('groups').get();
  const targets: HouseholdTarget[] = [];
  for (const group of groups.docs) {
    const lineGroupId = group.get('lineGroupId');
    const collectFrom = group.get('splitSettings.collectFromLineId');
    if (typeof lineGroupId !== 'string' || !lineGroupId || typeof collectFrom !== 'string' || !collectFrom) continue;
    const memberDocs = await db
      .collection('groupMembers')
      .where('groupId', '==', group.id)
      .where('isActive', '==', true)
      .get();
    const createdBy = group.get('createdBy');
    const members = sortActiveMembers(
      memberDocs.docs.map((d) => d.data() as GroupMember),
      typeof createdBy === 'string' ? createdBy : null
    );
    // 精算は 2 人で折半する。集金するメンバーが脱退していたら送らない（Web も未指定として扱う）
    if (members.length !== 2 || !members.some((m) => m.lineId === collectFrom)) continue;
    targets.push({ groupId: group.id, lineGroupId, collectFrom, members });
  }
  return targets;
}

/** 起算日: 集金するメンバーの期間設定（無ければ相手の設定、どちらも無ければ 1 日） */
async function loadStartDay(db: Firestore, target: HouseholdTarget): Promise<number | null> {
  const order = [target.collectFrom, ...target.members.map((m) => m.lineId).filter((id) => id !== target.collectFrom)];
  for (const lineId of order) {
    const doc = await db.collection('userSettings').doc(lineId).get();
    const settings = doc.exists ? (doc.get('dateSettings') as DateSettingsLike | undefined) : undefined;
    if (settings && typeof settings === 'object') return periodStartDay(settings);
  }
  return periodStartDay(null);
}

/** 未精算の立替（LINE の「立替一覧」・Web の精算と同じ集計）。読めなくてもサマリーは送る */
async function loadAdvanceDigest(target: HouseholdTarget): Promise<AdvanceDigest | null> {
  try {
    const summaries = await getAdvanceSummaryByUser(target.lineGroupId, true);
    const count = summaries.reduce((sum, s) => sum + s.expenses.length, 0);
    if (count === 0) return { count: 0, total: 0, transfer: null };
    const result = computeHouseholdSettlement(summaries, target.members);
    return {
      count,
      total: summaries.reduce((sum, s) => sum + s.totalAdvanced, 0),
      transfer: result.settlement
        ? { fromLineId: result.settlement.fromUserId, toLineId: result.settlement.toUserId, amount: result.settlement.amount }
        : null,
    };
  } catch (error) {
    console.warn('settlement summary: failed to load advances', { group: maskId(target.groupId), error: errorMessage(error) });
    return null;
  }
}

/**
 * 起算日を迎えた世帯へ、締まった期間の精算サマリーを送る
 *
 * @param build メッセージの組み立て（line/settlementSummaryMessage.ts）。テストで差し替えられるよう引数にする
 */
export async function sendDueSettlementSummaries(
  db: Firestore,
  deps: {
    push: PushFn;
    build: (summary: SettlementSummary) => messagingApi.Message[];
    now?: Date;
  }
): Promise<SummaryRunResult> {
  const today = dayjs(deps.now ?? new Date()).tz(JST).format('YYYY-MM-DD');
  const targets = await loadTargets(db);
  const result: SummaryRunResult = { checked: targets.length, sent: 0, skipped: 0, failed: 0 };

  for (const target of targets) {
    let markerRef: DocumentReference | null = null;
    try {
      const range = closedPeriodFor(today, await loadStartDay(db, target));
      if (!range) {
        result.skipped += 1;
        continue;
      }
      const snapshot = await db
        .collection('expenses')
        .where('groupId', '==', target.groupId)
        .where('date', '>=', range.startDate)
        .where('date', '<=', range.endDate)
        .get();
      const summary = buildSettlementSummary({
        groupId: target.groupId,
        range,
        members: target.members,
        collectFrom: target.collectFrom,
        expenses: snapshot.docs.map((d) => d.data() as SummaryExpense),
        advances: await loadAdvanceDigest(target),
      });
      const messages = deps.build(summary);

      // 同じ期間は 1 回だけ（create は既にあれば失敗する）
      const ref = db.collection('system').doc(`${SETTLEMENT_SUMMARY_MARKER_PREFIX}${target.groupId}_${range.endDate}`);
      try {
        await ref.create({ groupId: target.groupId, endDate: range.endDate, createdAt: FieldValue.serverTimestamp() });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code !== 6 && code !== 'already-exists') throw error;
        const existing = await ref.get();
        if (existing.get('sentAt')) {
          result.skipped += 1;
          continue;
        }
        // 前の実行が送信の途中で止まった。同じ X-Line-Retry-Key で送り直す（届いていれば 409 で送信済み扱い）
        console.warn('settlement summary: resuming an unfinished send', { group: maskId(target.groupId), endDate: range.endDate });
      }
      markerRef = ref;
      await deps.push(target.lineGroupId, messages, summaryRetryKey(target.groupId, range.endDate));
      markerRef = null;
      result.sent += 1;
      console.log('settlement summary: sent', { group: maskId(target.groupId), endDate: range.endDate });
      await ref.update({ sentAt: FieldValue.serverTimestamp() }).catch((error: unknown) => {
        console.warn('settlement summary: failed to record sentAt', { group: maskId(target.groupId), error: errorMessage(error) });
      });
    } catch (error) {
      result.failed += 1;
      console.error('settlement summary: failed', { group: maskId(target.groupId), error: errorMessage(error) });
      // 送れなかった印を残さない（次の実行で送り直す）
      if (markerRef) await markerRef.delete().catch(() => undefined);
    }
  }
  return result;
}
