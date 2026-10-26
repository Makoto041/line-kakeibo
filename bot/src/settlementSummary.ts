/**
 * 期間の精算（折半）のサマリーを LINE グループへ送る（毎日のスケジュール関数から呼ぶ）
 *
 * - いつ: 期間の起算日（集金するメンバーの期間設定。例: 15日起算なら毎月 15 日）に、締まった期間の分を 1 回。
 *   新しいスケジュールは増やさず、毎日の固定費の計上（index.ts の postRecurringExpenses）と同じ実行で判定する
 *   （Cloud Scheduler の無料枠のジョブ数を使い切っているため）。
 * - 何を: Web の「期間の精算（折半）」と同じ計算（periodSplit.ts。立替は全額を加算）の結果。送金する人と受け取る人を
 *   メンションしたテキストと、内訳（立替を含む）・カテゴリ別・要確認をまとめた Flex を 1 回の push で送る。
 * - 対象: LINE グループに紐づき、集金するメンバー（groups.splitSettings.collectFromLineId）が決まっていて、
 *   有効メンバーがちょうど 2 人の世帯。
 * - 冪等: 送る前に system/settlementSummary_{groupId}_{期間末日} を create する（同じ期間は 2 回送らない）。
 *   送信に失敗したら消して、次の実行（関数のリトライ）で送り直す。LINE の X-Line-Retry-Key も付ける。
 *   印はあるのに送った時刻（sentAt）が無い（前の実行が送信の途中で止まった・印を消せなかった）ときは、
 *   同じ X-Line-Retry-Key で送り直す（LINE が受け付け済みなら 409 が返り、二重には届かない）。
 * - 起算日が 29〜31 日で、その日が無い月には送らず、次の回でその分も含める（closedPeriodFor）。
 * - 手動: Web の設定から、締まった期間（自動と同じ内容）か今の期間の途中経過を、日付に関係なく送れる
 *   （sendSettlementSummaryNow。/household/settlement-summary/send）。締まった期間を送ったら印も付け、
 *   起算日の自動の通知と二重にならないようにする。
 */

import { createHash, randomUUID } from 'node:crypto';
import type { messagingApi } from '@line/bot-sdk';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { toCanonicalCategoryName } from './categoryNormalization';
import type { GroupMember } from './firestore';
import { sortActiveMembers, type HouseholdMember } from './householdMembers';
import { errorFields, maskId } from './logSafe';
import { amountOf, computePeriodSplit, isSplitCounted, periodPool, type PeriodSplit, type SplitExpense } from './periodSplit';
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

/** d 以前で、日付が startDay の最も近い日（その日が無い月は飛ばす。closedPeriodFor と同じ数え方） */
function startOnOrBefore(d: dayjs.Dayjs, startDay: number): dayjs.Dayjs {
  let month = d.startOf('month');
  if (d.date() < startDay || month.daysInMonth() < startDay) month = month.subtract(1, 'month');
  while (month.daysInMonth() < startDay) month = month.subtract(1, 'month');
  return month.date(startDay);
}

/**
 * 今日から見た、締まった期間と今の期間（手動の送信用。どの日でも決まる）
 *
 * 締まった期間は、直近の起算日に自動で送る期間（closedPeriodFor）と同じ。今の期間は直近の起算日〜今日。
 * 固定期間（startDay が null）は締めが無いので null。
 */
export function latestPeriods(
  today: string,
  startDay: number | null
): { closed: { startDate: string; endDate: string }; current: { startDate: string; endDate: string } } | null {
  if (startDay === null) return null;
  const d = dayjs.tz(today, 'YYYY-MM-DD', JST);
  if (!d.isValid()) return null;
  const currentStart = startOnOrBefore(d, startDay);
  const closedStart = startOnOrBefore(currentStart.subtract(1, 'day'), startDay);
  return {
    closed: { startDate: closedStart.format('YYYY-MM-DD'), endDate: currentStart.subtract(1, 'day').format('YYYY-MM-DD') },
    current: { startDate: currentStart.format('YYYY-MM-DD'), endDate: d.format('YYYY-MM-DD') },
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

export interface SettlementSummary {
  groupId: string;
  range: { startDate: string; endDate: string };
  /** 今の期間の途中経過（手動の送信）。締まった期間なら false */
  interim: boolean;
  members: HouseholdMember[];
  split: PeriodSplit;
  /** 集金するメンバー以外の支払い（相手・カード・共通口座）の合計 */
  othersPaid: number;
  categories: CategoryTotal[];
  /** 上位に入らなかったカテゴリの合計 */
  otherCategories: { count: number; amount: number };
  /** 要確認（LINE で手入力して未確認。合計に入っていない） */
  pending: { count: number; amount: number };
}

/** 要確認（Web の isPending と同じ。自動で入った支出は確認不要） */
export function isPendingManual(e: Pick<SummaryExpense, 'inputSource' | 'status' | 'confirmed'>): boolean {
  if (e.inputSource === 'gmail_auto' || e.inputSource === 'recurring') return false;
  return (e.status == null || e.status === 'pending') && e.confirmed !== true;
}

export function buildSettlementSummary(input: {
  groupId: string;
  range: { startDate: string; endDate: string };
  interim?: boolean;
  members: HouseholdMember[];
  collectFrom: string;
  expenses: readonly SummaryExpense[];
}): SettlementSummary {
  const split = computePeriodSplit({
    expenses: input.expenses,
    groupId: input.groupId,
    members: input.members,
    targetLineId: input.collectFrom,
    range: input.range,
  });
  const pool = periodPool(input.expenses, input.groupId, input.range);
  const counted = pool.filter(isSplitCounted);

  // 旧名（娯楽費・交際費など）は正準名にまとめる（#243。「家計簿」コマンドの getMonthlyGroupSummary と同じ揃え方）
  const byCategory = new Map<string, number>();
  for (const e of counted) {
    const category = typeof e.category === 'string' && e.category ? toCanonicalCategoryName(e.category) : 'その他';
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
    interim: input.interim === true,
    members: input.members,
    split,
    othersPaid: split.total - split.targetPaid,
    categories: sorted.slice(0, SUMMARY_TOP_CATEGORIES),
    otherCategories: { count: rest.length, amount: rest.reduce((sum, c) => sum + c.amount, 0) },
    pending: { count: pending.length, amount: pending.reduce((sum, e) => sum + amountOf(e), 0) },
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
  members: HouseholdMember[];
}

/** 送れない理由。no_line_group: LINE グループに紐づいていない / no_collect_from: 集金するメンバーが未指定（脱退も含む）/ not_two_members: 有効メンバーが 2 人でない */
export type SummaryUnavailableReason = 'no_line_group' | 'no_collect_from' | 'not_two_members';

/** groups の文書から送り先を決める */
async function targetFromGroup(
  db: Firestore,
  group: FirebaseFirestore.DocumentSnapshot
): Promise<{ target: HouseholdTarget } | { reason: SummaryUnavailableReason }> {
  const lineGroupId = group.get('lineGroupId');
  if (typeof lineGroupId !== 'string' || !lineGroupId) return { reason: 'no_line_group' };
  const collectFrom = group.get('splitSettings.collectFromLineId');
  if (typeof collectFrom !== 'string' || !collectFrom) return { reason: 'no_collect_from' };
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
  if (members.length !== 2) return { reason: 'not_two_members' };
  if (!members.some((m) => m.lineId === collectFrom)) return { reason: 'no_collect_from' };
  return { target: { groupId: group.id, lineGroupId, collectFrom, members } };
}

async function loadTargets(db: Firestore): Promise<HouseholdTarget[]> {
  const groups = await db.collection('groups').get();
  const targets: HouseholdTarget[] = [];
  for (const group of groups.docs) {
    const result = await targetFromGroup(db, group);
    if ('target' in result) targets.push(result.target);
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

function markerRef(db: Firestore, groupId: string, endDate: string): DocumentReference {
  return db.collection('system').doc(`${SETTLEMENT_SUMMARY_MARKER_PREFIX}${groupId}_${endDate}`);
}

/** 世帯・期間のサマリーを組み立てる（期間内の世帯の支出を読む） */
async function buildFor(
  db: Firestore,
  target: HouseholdTarget,
  range: { startDate: string; endDate: string },
  interim: boolean
): Promise<SettlementSummary> {
  const snapshot = await db
    .collection('expenses')
    .where('groupId', '==', target.groupId)
    .where('date', '>=', range.startDate)
    .where('date', '<=', range.endDate)
    .get();
  return buildSettlementSummary({
    groupId: target.groupId,
    range,
    interim,
    members: target.members,
    collectFrom: target.collectFrom,
    expenses: snapshot.docs.map((d) => d.data() as SummaryExpense),
  });
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
    let pendingMarker: DocumentReference | null = null;
    try {
      const range = closedPeriodFor(today, await loadStartDay(db, target));
      if (!range) {
        result.skipped += 1;
        continue;
      }
      const messages = deps.build(await buildFor(db, target, range, false));

      // 同じ期間は 1 回だけ（create は既にあれば失敗する）
      const ref = markerRef(db, target.groupId, range.endDate);
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
      pendingMarker = ref;
      await deps.push(target.lineGroupId, messages, summaryRetryKey(target.groupId, range.endDate));
      pendingMarker = null;
      result.sent += 1;
      console.log('settlement summary: sent', { group: maskId(target.groupId), endDate: range.endDate });
      await ref.update({ sentAt: FieldValue.serverTimestamp() }).catch((error: unknown) => {
        console.warn('settlement summary: failed to record sentAt', { group: maskId(target.groupId), ...errorFields(error) });
      });
    } catch (error) {
      result.failed += 1;
      console.error('settlement summary: failed', { group: maskId(target.groupId), ...errorFields(error) });
      // 送れなかった印を残さない（次の実行で送り直す）
      if (pendingMarker) await pendingMarker.delete().catch(() => undefined);
    }
  }
  return result;
}

// ============================================
// 手動の送信（Web の設定から）
// ============================================

export type SummaryPeriodKind = 'closed' | 'current';

export interface SummaryStatus {
  /** 送れないときの理由（送れるなら null） */
  reason: SummaryUnavailableReason | 'fixed_period' | null;
  /** 期間の起算日（固定期間なら null） */
  startDay: number | null;
  closed: { startDate: string; endDate: string } | null;
  current: { startDate: string; endDate: string } | null;
  /** 締まった期間を送った時刻（自動・手動のどちらでも。ISO 8601）。まだなら null */
  closedSentAt: string | null;
}

async function loadTargetFor(
  db: Firestore,
  groupId: string
): Promise<{ target: HouseholdTarget } | { reason: SummaryUnavailableReason } | null> {
  const group = await db.collection('groups').doc(groupId).get();
  if (!group.exists) return null;
  return targetFromGroup(db, group);
}

function timestampIso(value: unknown): string | null {
  const ts = value as { toDate?: () => Date } | null | undefined;
  return typeof ts?.toDate === 'function' ? ts.toDate().toISOString() : null;
}

/** 設定画面に出す状態（送れるか・どの期間を送るか・締まった期間を送ったか）。世帯が無ければ null */
export async function settlementSummaryStatus(db: Firestore, groupId: string, now: Date = new Date()): Promise<SummaryStatus | null> {
  const loaded = await loadTargetFor(db, groupId);
  if (!loaded) return null;
  if ('reason' in loaded) {
    return { reason: loaded.reason, startDay: null, closed: null, current: null, closedSentAt: null };
  }
  const startDay = await loadStartDay(db, loaded.target);
  const periods = latestPeriods(dayjs(now).tz(JST).format('YYYY-MM-DD'), startDay);
  if (!periods) return { reason: 'fixed_period', startDay, closed: null, current: null, closedSentAt: null };
  const marker = await markerRef(db, groupId, periods.closed.endDate).get();
  return {
    reason: null,
    startDay,
    closed: periods.closed,
    current: periods.current,
    closedSentAt: marker.exists ? timestampIso(marker.get('sentAt')) : null,
  };
}

export type ManualSendResult =
  | { ok: true; range: { startDate: string; endDate: string }; interim: boolean }
  | { ok: false; reason: SummaryUnavailableReason | 'fixed_period' };

/**
 * 精算サマリーを今すぐ LINE グループへ送る（日付・送信済みの印に関係なく送る）
 *
 * 締まった期間を送ったら印（sentAt 付き）を残し、起算日の自動の通知が同じ期間をもう一度送らないようにする。
 * 今の期間（途中経過）は印を付けない（締まったら自動で確定の分が届く）。X-Line-Retry-Key は毎回新しくする
 * （同じ期間を送り直したいときにも送れるように）。世帯が無ければ null。
 */
export async function sendSettlementSummaryNow(
  db: Firestore,
  groupId: string,
  period: SummaryPeriodKind,
  deps: {
    push: PushFn;
    build: (summary: SettlementSummary) => messagingApi.Message[];
    now?: Date;
  }
): Promise<ManualSendResult | null> {
  const loaded = await loadTargetFor(db, groupId);
  if (!loaded) return null;
  if ('reason' in loaded) return { ok: false, reason: loaded.reason };
  const { target } = loaded;
  const periods = latestPeriods(dayjs(deps.now ?? new Date()).tz(JST).format('YYYY-MM-DD'), await loadStartDay(db, target));
  if (!periods) return { ok: false, reason: 'fixed_period' };

  const interim = period === 'current';
  const range = interim ? periods.current : periods.closed;
  const messages = deps.build(await buildFor(db, target, range, interim));
  await deps.push(target.lineGroupId, messages, randomUUID());
  console.log('settlement summary: sent manually', { group: maskId(groupId), endDate: range.endDate, interim });

  if (!interim) {
    // 起算日の自動の通知が同じ期間を送らないよう印を残す。自動で送った時刻（sentAt）があれば上書きしない
    const ref = markerRef(db, groupId, range.endDate);
    await db
      .runTransaction(async (tx) => {
        const marker = await tx.get(ref);
        const now = FieldValue.serverTimestamp();
        if (!marker.exists) {
          tx.create(ref, { groupId, endDate: range.endDate, createdAt: now, sentAt: now, manualSentAt: now });
        } else {
          tx.update(ref, marker.get('sentAt') ? { manualSentAt: now } : { sentAt: now, manualSentAt: now });
        }
      })
      .catch((error: unknown) => {
        console.warn('settlement summary: failed to record a manual send', { group: maskId(groupId), ...errorFields(error) });
      });
  }
  return { ok: true, range, interim };
}
