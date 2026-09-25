/**
 * 固定費（家賃・光熱費など、引き落としで LINE に記録されない毎月の支出）
 *
 * - 項目は `recurringExpenses/{id}` に世帯（groupId）ごとに保存する。クライアントからは読み書きできず
 *   （firestore.rules の既定の拒否）、Web は `/household/recurring` を通して Admin SDK で扱う。
 * - 毎日のスケジュール関数（index.ts の postRecurringExpenses）が、引き落とし日を迎えた項目を明細に計上する。
 *   金額は設定した見込み額。請求が確定したら明細の金額を直す（光熱費など）。
 * - 計上は冪等: 明細の文書 ID を `recurring_{項目ID}_{YYYYMM}` に固定し、create で作る（同じ月に 2 回は入らない）。
 * - 判定は「今月分」だけを見る。月をまたいで何日も止まった場合、前月分は遡って入らない（毎日のリトライで通常は起きない）。
 * - カード利用通知メールで自動登録される支出（Gmail 自動取得）は、ここに登録すると二重になる（画面で案内する）。
 * - 支払い元
 *   - shared: 共通のカード・口座から引き落とし（Gmail 自動取得の共同費と同じ扱い）
 *   - advance: メンバーの個人口座から引き落とし（その人の立替。精算で相手が半分を払う）
 */

import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { CANONICAL_CATEGORIES } from './categoryNormalization';
import { errorMessage, maskId } from './logSafe';
import { CREATOR_PLACEHOLDER_NAME, fallbackDisplayName } from './householdSettlement';
import { dayjs, JST } from './time';

export const RECURRING_COLLECTION = 'recurringExpenses';
/** 固定費の明細の lineId / payerId（共通のカード・口座から引き落とす項目） */
export const RECURRING_SYSTEM_LINE_ID = 'recurring-system';
/** 1 世帯あたりの項目数の上限 */
export const MAX_RECURRING_PER_GROUP = 30;
export const MAX_RECURRING_NAME_LENGTH = 40;
export const MAX_RECURRING_AMOUNT = 10_000_000;

export type RecurringPayment = 'shared' | 'advance';

export interface RecurringItem {
  id: string;
  groupId: string;
  name: string;
  amount: number;
  category: string;
  /** 引き落とし日（1〜31。月の日数を超える日はその月の末日） */
  dayOfMonth: number;
  payment: RecurringPayment;
  /** advance のときの立替者（shared では null） */
  payerLineId: string | null;
  active: boolean;
  /** 最後に計上した月（YYYY-MM）。未計上は null */
  lastPostedMonth: string | null;
  /** 作成日（JST の YYYY-MM-DD）。作成日より前の引き落とし日の分は計上しない */
  startDate: string;
}

export interface RecurringInput {
  name: string;
  amount: number;
  category: string;
  dayOfMonth: number;
  payment: RecurringPayment;
  payerLineId: string | null;
  active: boolean;
}

// ============================================
// 入力の検証
// ============================================

const CATEGORY_SET: ReadonlySet<string> = new Set(CANONICAL_CATEGORIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 制御文字を除いて前後の空白を落とす */
function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0 || Array.from(name).length > MAX_RECURRING_NAME_LENGTH) return null;
  return name;
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_RECURRING_AMOUNT;
}

function isDay(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31;
}

/**
 * 作成・更新の本文を検証する。`partial` のときは渡されたキーだけを検証して返す（更新用）。
 * 不正なら null。`payerLineId` の所属（世帯の有効メンバーか）は呼び出し側で確かめる。
 */
export function parseRecurringInput(body: unknown, partial: false): RecurringInput | null;
export function parseRecurringInput(body: unknown, partial: true): Partial<RecurringInput> | null;
export function parseRecurringInput(body: unknown, partial: boolean): Partial<RecurringInput> | null {
  if (!isRecord(body)) return null;
  const allowed = new Set(['name', 'amount', 'category', 'dayOfMonth', 'payment', 'payerLineId', 'active']);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;

  const out: Partial<RecurringInput> = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (has('name') || !partial) {
    const name = cleanName(body.name);
    if (name === null) return null;
    out.name = name;
  }
  if (has('amount') || !partial) {
    if (!isAmount(body.amount)) return null;
    out.amount = body.amount;
  }
  if (has('category') || !partial) {
    if (typeof body.category !== 'string' || !CATEGORY_SET.has(body.category)) return null;
    out.category = body.category;
  }
  if (has('dayOfMonth') || !partial) {
    if (!isDay(body.dayOfMonth)) return null;
    out.dayOfMonth = body.dayOfMonth;
  }
  if (has('payment') || !partial) {
    if (body.payment !== 'shared' && body.payment !== 'advance') return null;
    out.payment = body.payment;
  }
  if (has('payerLineId') || !partial) {
    const payer = body.payerLineId;
    if (payer !== null && payer !== undefined && (typeof payer !== 'string' || payer.length === 0 || payer.length > 128)) {
      return null;
    }
    out.payerLineId = typeof payer === 'string' ? payer : null;
  }
  if (has('active') || !partial) {
    if (body.active === undefined && !partial) {
      out.active = true;
    } else if (typeof body.active !== 'boolean') {
      return null;
    } else {
      out.active = body.active;
    }
  }

  // 支払い元と立替者の組み合わせ（完全な形でだけ確かめる。更新では保存済みの値と合わせてから確かめる）
  if (!partial && !isConsistentPayment(out as RecurringInput)) return null;
  return out;
}

/** advance は立替者が必須、shared は立替者なし */
export function isConsistentPayment(item: Pick<RecurringInput, 'payment' | 'payerLineId'>): boolean {
  return item.payment === 'advance' ? typeof item.payerLineId === 'string' : item.payerLineId === null;
}

// ============================================
// 保存形式との変換
// ============================================

function monthOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) ? value : null;
}

/** Firestore の文書を項目にする（壊れた文書は null） */
export function toRecurringItem(id: string, data: DocumentData | undefined): RecurringItem | null {
  if (!data) return null;
  const name = cleanName(data.name);
  if (
    typeof data.groupId !== 'string' ||
    name === null ||
    !isAmount(data.amount) ||
    typeof data.category !== 'string' ||
    !isDay(data.dayOfMonth) ||
    (data.payment !== 'shared' && data.payment !== 'advance') ||
    typeof data.startDate !== 'string'
  ) {
    return null;
  }
  const item: RecurringItem = {
    id,
    groupId: data.groupId,
    name,
    amount: data.amount,
    category: data.category,
    dayOfMonth: data.dayOfMonth,
    payment: data.payment,
    payerLineId: typeof data.payerLineId === 'string' ? data.payerLineId : null,
    active: data.active !== false,
    lastPostedMonth: monthOrNull(data.lastPostedMonth),
    startDate: data.startDate,
  };
  return isConsistentPayment(item) ? item : null;
}

/** Web に返す形 */
export function toRecurringView(item: RecurringItem) {
  return {
    id: item.id,
    name: item.name,
    amount: item.amount,
    category: item.category,
    dayOfMonth: item.dayOfMonth,
    payment: item.payment,
    payerLineId: item.payerLineId,
    active: item.active,
    lastPostedMonth: item.lastPostedMonth,
  };
}

// ============================================
// 計上の判定
// ============================================

/** その月の引き落とし日（YYYY-MM-DD）。月の日数を超える日は末日 */
export function dueDateFor(month: string, dayOfMonth: number): string {
  const first = dayjs.tz(`${month}-01`, JST);
  const day = Math.min(dayOfMonth, first.daysInMonth());
  return first.date(day).format('YYYY-MM-DD');
}

/**
 * 今日（JST の YYYY-MM-DD）の時点で、今月分を計上するか
 *
 * - 有効で、今月分が未計上
 * - 今月の引き落とし日を迎えている（実行が遅れた日でも、その月のうちなら計上する）
 * - 引き落とし日が作成日以降（作成した月に、すでに過ぎた引き落とし日の分は遡って入れない）
 */
export function shouldPost(item: RecurringItem, today: string): { month: string; date: string } | null {
  if (!item.active) return null;
  const month = today.slice(0, 7);
  if (item.lastPostedMonth !== null && item.lastPostedMonth >= month) return null;
  const date = dueDateFor(month, item.dayOfMonth);
  if (date > today || date < item.startDate) return null;
  return { month, date };
}

export function recurringExpenseId(itemId: string, month: string): string {
  return `recurring_${itemId}_${month.replace('-', '')}`;
}

export interface GroupContext {
  lineGroupId: string | null;
  /** lineId → 表示名 */
  names: ReadonlyMap<string, string>;
}

/** 計上する明細の中身 */
export function buildRecurringExpense(item: RecurringItem, date: string, group: GroupContext, now: Date) {
  const base = {
    amount: item.amount,
    description: item.name,
    date,
    category: item.category,
    confirmed: true,
    includeInTotal: true,
    groupId: item.groupId,
    ...(group.lineGroupId ? { lineGroupId: group.lineGroupId } : {}),
    inputSource: 'recurring' as const,
    recurringId: item.id,
    createdAt: now,
    updatedAt: now,
  };
  if (item.payment === 'advance' && item.payerLineId) {
    // 表示名が分からない（仮名「作成者」のまま等）ときは LINE の立替一覧と同じ代わりの名前
    const name = group.names.get(item.payerLineId) || fallbackDisplayName(item.payerLineId);
    return {
      ...base,
      lineId: item.payerLineId,
      payerId: item.payerLineId,
      userDisplayName: name,
      payerDisplayName: name,
      status: 'advance_pending' as const,
      advanceBy: item.payerLineId,
    };
  }
  // Gmail 自動取得と同じく表示名は持たせない（Web の支払い者の候補に「人」として混ざらないように）
  return {
    ...base,
    lineId: RECURRING_SYSTEM_LINE_ID,
    payerId: RECURRING_SYSTEM_LINE_ID,
    status: 'shared' as const,
  };
}

// ============================================
// 世帯の情報
// ============================================

/** 世帯の lineGroupId と、有効メンバーの表示名 */
export async function loadGroupContext(db: Firestore, groupId: string): Promise<GroupContext | null> {
  const group = await db.collection('groups').doc(groupId).get();
  if (!group.exists) return null;
  const lineGroupId = group.get('lineGroupId');
  const members = await db
    .collection('groupMembers')
    .where('groupId', '==', groupId)
    .where('isActive', '==', true)
    .get();
  const names = new Map<string, string>();
  for (const doc of members.docs) {
    const lineId = doc.get('lineId');
    const name = doc.get('displayName');
    if (typeof lineId === 'string') {
      names.set(lineId, typeof name === 'string' && name !== CREATOR_PLACEHOLDER_NAME ? name : '');
    }
  }
  return { lineGroupId: typeof lineGroupId === 'string' && lineGroupId.length > 0 ? lineGroupId : null, names };
}

// ============================================
// 毎日の計上
// ============================================

export interface PostSummary {
  checked: number;
  posted: number;
  skipped: number;
  failed: number;
}

/**
 * 引き落とし日を迎えた固定費を明細に計上する（毎日のスケジュール関数から呼ぶ）
 *
 * 項目ごとにトランザクションで「今月分が未計上か」を確かめ、明細の作成と lastPostedMonth の更新を同時に行う。
 * 明細の ID が固定なので、同時に 2 回動いても 1 件しか入らない。
 */
export async function postDueRecurringExpenses(db: Firestore, now: Date = new Date()): Promise<PostSummary> {
  const today = dayjs(now).tz(JST).format('YYYY-MM-DD');
  const snapshot = await db.collection(RECURRING_COLLECTION).where('active', '==', true).get();
  const summary: PostSummary = { checked: snapshot.size, posted: 0, skipped: 0, failed: 0 };
  const groups = new Map<string, GroupContext | null>();

  for (const doc of snapshot.docs) {
    const item = toRecurringItem(doc.id, doc.data());
    const due = item ? shouldPost(item, today) : null;
    if (!item || !due) {
      summary.skipped += 1;
      continue;
    }
    try {
      if (!groups.has(item.groupId)) groups.set(item.groupId, await loadGroupContext(db, item.groupId));
      const group = groups.get(item.groupId);
      if (!group) {
        console.warn('recurring: group not found', { item: maskId(item.id), group: maskId(item.groupId) });
        summary.skipped += 1;
        continue;
      }
      // 立替者が世帯を抜けていたら計上しない（相手が分からない立替を作らない）
      if (item.payment === 'advance' && (!item.payerLineId || !group.names.has(item.payerLineId))) {
        console.warn('recurring: payer is not an active member', { item: maskId(item.id) });
        summary.skipped += 1;
        continue;
      }

      const expenseRef = db.collection('expenses').doc(recurringExpenseId(item.id, due.month));
      const posted = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        const current = toRecurringItem(doc.id, fresh.data());
        if (!current || !shouldPost(current, today)) return false;
        const existing = await tx.get(expenseRef);
        tx.update(doc.ref, { lastPostedMonth: due.month, updatedAt: FieldValue.serverTimestamp() });
        if (existing.exists) return false;
        tx.create(expenseRef, buildRecurringExpense(current, due.date, group, now));
        return true;
      });
      if (posted) {
        summary.posted += 1;
        console.log('recurring: posted', { item: maskId(item.id), month: due.month });
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      summary.failed += 1;
      console.error('recurring: failed to post', { item: maskId(item.id), error: errorMessage(error) });
    }
  }
  return summary;
}
