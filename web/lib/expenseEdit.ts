// 支出の編集（フォーム・入力チェック・送る差分・支払い者とカテゴリの候補）の純関数。
// 入力チェックの文言・判定順は firestore.rules の更新条件（PR #172）に合わせる。
// node --test から直接読めるよう、他のモジュールからは型だけを import する。
import type { Expense, GroupMember } from './hooks';

export interface EditForm {
  amount: number;
  description: string;
  date: string;
  category: string;
  includeInTotal: boolean;
  payerId: string;
  payerDisplayName: string;
}

export type EditKey = keyof EditForm;

const EDIT_KEYS: readonly EditKey[] = [
  'amount',
  'description',
  'date',
  'category',
  'includeInTotal',
  'payerId',
  'payerDisplayName',
];

/** 精算済みの支出で変更できない項目（ルールで固定されている） */
export const SETTLED_LOCKED_KEYS: readonly EditKey[] = ['amount', 'date', 'payerId', 'payerDisplayName'];

type EditSource = Pick<
  Expense,
  'amount' | 'description' | 'date' | 'category' | 'includeInTotal' | 'lineId'
> &
  Partial<Pick<Expense, 'payerId' | 'payerDisplayName' | 'userDisplayName' | 'status'>>;

/** 編集フォームの初期値（既存の編集ドロワーと同じ既定: 支払い者は入力者） */
export function formFromExpense(e: EditSource): EditForm {
  return {
    amount: e.amount,
    description: e.description ?? '',
    date: e.date ?? '',
    category: e.category ?? '',
    includeInTotal: !!e.includeInTotal,
    payerId: e.payerId || e.lineId,
    payerDisplayName: e.payerDisplayName || e.userDisplayName || '',
  };
}

export interface EditValidationError {
  field: EditKey;
  message: string;
}

/**
 * 保存前の入力チェック。ルールは変更したフィールドだけを検証するので、ここでも
 * 変更した値だけを確かめる（既存データが上限を超えていても、触れない編集は保存できる）。
 */
export function validateEditForm(form: EditForm, original: EditSource): EditValidationError | null {
  const base = formFromExpense(original);
  if (form.date !== base.date && !/^\d{4}-\d{2}-\d{2}$/.test(form.date)) {
    return { field: 'date', message: '日付を入力してください' };
  }
  if (
    form.amount !== base.amount &&
    (!Number.isFinite(form.amount) || form.amount < 0 || form.amount > 10_000_000)
  ) {
    return { field: 'amount', message: '金額は 0〜10,000,000 円の範囲で入力してください' };
  }
  if (form.description !== base.description && form.description.length > 500) {
    return { field: 'description', message: '説明は 500 文字以内で入力してください' };
  }
  if (form.category !== base.category && form.category.length > 50) {
    return { field: 'category', message: 'カテゴリは 50 文字以内で入力してください' };
  }
  if (original.status === 'advance_settled') {
    const locked = (['amount', 'date', 'payerId'] as const).find((key) => form[key] !== base[key]);
    if (locked) return { field: locked, message: '精算済みの支出は金額・日付・支払者を変更できません' };
  }
  return null;
}

/**
 * 送る差分（変更した項目だけ）。
 * - 支払い者を変えたときは表示名も一緒に送る
 * - 精算済みの支出は金額・日付・支払者を送らない
 * updatedAt は updateExpense が付ける。
 */
export function buildEditUpdate(form: EditForm, original: EditSource): Partial<EditForm> {
  const base = formFromExpense(original);
  const update: Partial<EditForm> = {};
  const assign = <K extends EditKey>(key: K) => {
    update[key] = form[key];
  };
  for (const key of EDIT_KEYS) {
    if (form[key] !== base[key]) assign(key);
  }
  if ('payerId' in update) update.payerDisplayName = form.payerDisplayName;
  if (original.status === 'advance_settled') {
    for (const key of SETTLED_LOCKED_KEYS) delete update[key];
  }
  return update;
}

export function hasEditChanges(update: Partial<EditForm>): boolean {
  return Object.keys(update).length > 0;
}

// ---- 支払い者の候補・表示名 ---------------------------------------------------

export interface KnownUser {
  lineId: string;
  displayName: string;
}

export type MemberSource = 'group' | 'group-history' | 'all-history';

export interface AvailableMember extends KnownUser {
  source: MemberSource;
}

type HistoryFields = Pick<Expense, 'lineId'> &
  Partial<Pick<Expense, 'userDisplayName' | 'payerId' | 'payerDisplayName' | 'groupId' | 'lineGroupId'>>;

function addUsersFrom(expense: HistoryFields, usersMap: Map<string, KnownUser>) {
  // 入力者
  if (expense.lineId && expense.userDisplayName && expense.userDisplayName !== '個人') {
    usersMap.set(expense.lineId, { lineId: expense.lineId, displayName: expense.userDisplayName });
  }
  // 支払い者（入力者と異なる場合）
  if (
    expense.payerId &&
    expense.payerDisplayName &&
    expense.payerDisplayName !== '個人' &&
    expense.payerId !== expense.lineId
  ) {
    usersMap.set(expense.payerId, { lineId: expense.payerId, displayName: expense.payerDisplayName });
  }
}

/** 読み込み済みの支出に現れる入力者・支払い者（全グループ） */
export function collectHistoricalUsers(expenses: readonly HistoryFields[]): KnownUser[] {
  const usersMap = new Map<string, KnownUser>();
  expenses.forEach((e) => addUsersFrom(e, usersMap));
  return Array.from(usersMap.values());
}

/** 編集中の支出と同じグループの支出に現れる入力者・支払い者 */
export function collectGroupExpenseUsers(
  expenses: readonly HistoryFields[],
  target: Pick<HistoryFields, 'groupId' | 'lineGroupId'> | null | undefined
): KnownUser[] {
  if (!target) return [];
  const inGroup = target.groupId
    ? (e: HistoryFields) => e.groupId === target.groupId
    : target.lineGroupId
      ? (e: HistoryFields) => e.lineGroupId === target.lineGroupId
      : () => false;
  const usersMap = new Map<string, KnownUser>();
  expenses.filter(inGroup).forEach((e) => addUsersFrom(e, usersMap));
  return Array.from(usersMap.values());
}

/**
 * 支払い者の候補（既存の編集ドロワーと同じ優先順位）。
 * 1. グループの正式メンバー
 * 2. このグループの支出履歴（表示名は履歴を優先）
 * 3. 全体の支出履歴（既存の表示名が「メンバー」「Unknown_…」のときだけ上書き）
 */
export function mergeAvailableMembers(
  groupMembers: ReadonlyArray<Pick<GroupMember, 'lineId' | 'displayName'>>,
  groupExpenseUsers: readonly KnownUser[],
  historicalUsers: readonly KnownUser[]
): AvailableMember[] {
  const combined = new Map<string, AvailableMember>();
  groupMembers.forEach((m) => {
    combined.set(m.lineId, { lineId: m.lineId, displayName: m.displayName, source: 'group' });
  });
  groupExpenseUsers.forEach((u) => {
    const existing = combined.get(u.lineId);
    if (existing) {
      combined.set(u.lineId, { ...existing, displayName: u.displayName, source: 'group' });
    } else {
      combined.set(u.lineId, { lineId: u.lineId, displayName: u.displayName, source: 'group-history' });
    }
  });
  historicalUsers.forEach((u) => {
    const existing = combined.get(u.lineId);
    if (existing) {
      if (existing.displayName === 'メンバー' || existing.displayName.startsWith('Unknown_')) {
        combined.set(u.lineId, { ...existing, displayName: u.displayName });
      }
    } else {
      combined.set(u.lineId, { lineId: u.lineId, displayName: u.displayName, source: 'all-history' });
    }
  });
  return Array.from(combined.values());
}

export interface PayerOption {
  value: string;
  label: string;
}

const SOURCE_SUFFIX: Record<MemberSource, string> = {
  group: '（グループメンバー）',
  'group-history': '（このグループ）',
  'all-history': '（他グループ）',
};

/**
 * 支払い者の選択肢。現在の支払い者と入力者を必ず含める
 * （選択中の値の option が消えて、意図しない支払い者に変わるのを防ぐ）。
 */
export function buildPayerOptions(
  target: Pick<HistoryFields, 'lineId' | 'userDisplayName'> | null | undefined,
  availableMembers: readonly AvailableMember[],
  expenses: readonly HistoryFields[],
  form: Pick<EditForm, 'payerId' | 'payerDisplayName'>
): PayerOption[] {
  const map = new Map<string, string>();
  if (target?.lineId) {
    map.set(target.lineId, `${target.userDisplayName || '入力者'}（入力者）`);
  }
  if (availableMembers.length > 0) {
    availableMembers.forEach((m) => {
      if (!map.has(m.lineId)) map.set(m.lineId, `${m.displayName}${SOURCE_SUFFIX[m.source] ?? ''}`);
    });
  } else {
    expenses.forEach((e) => {
      if (e.userDisplayName && e.userDisplayName !== '個人' && !map.has(e.lineId)) {
        map.set(e.lineId, `${e.userDisplayName}（支出履歴から）`);
      }
    });
  }
  if (form.payerId && !map.has(form.payerId)) {
    map.set(form.payerId, form.payerDisplayName || '不明なユーザー');
  }
  return Array.from(map, ([value, label]) => ({ value, label }));
}

/** 支払い者を選び直したときの表示名（既存と同じ: 候補 → 支出履歴の入力者名 → ID） */
export function payerDisplayNameFor(
  lineId: string,
  availableMembers: readonly AvailableMember[],
  expenses: readonly HistoryFields[]
): string {
  const member = availableMembers.find((m) => m.lineId === lineId);
  const fromHistory = expenses.find((e) => e.lineId === lineId);
  return member?.displayName || fromHistory?.userDisplayName || lineId;
}

/**
 * 支払い者名（一覧・詳細・集計で共通）。
 * - Gmail 自動取込は「クレジットカード」にまとめる
 * - payerDisplayName を最優先し、不明系の名前は支出履歴から補う
 */
export function resolvePayerName(
  expense: Pick<Expense, 'lineId'> &
    Partial<Pick<Expense, 'inputSource' | 'payerId' | 'payerDisplayName' | 'userDisplayName'>>,
  historicalUsers: readonly KnownUser[]
): string {
  if (expense.inputSource === 'gmail_auto') return 'クレジットカード';
  const payerId = expense.payerId || expense.lineId;
  let payerName = expense.payerDisplayName || expense.userDisplayName || '個人';
  if (
    payerName === 'メンバー' ||
    payerName === '個人' ||
    payerName.startsWith('Unknown_') ||
    payerName.startsWith('User_')
  ) {
    const historical = historicalUsers.find((u) => u.lineId === payerId);
    if (historical) payerName = historical.displayName;
  }
  return payerName;
}

/**
 * カテゴリの選択肢: 正準カテゴリ → データ内の既存カテゴリ → 編集中の現在値。
 * 未知のカテゴリでも先頭（食費）に勝手に落ちないようにする。
 */
export function buildCategoryOptions(
  canonical: readonly string[],
  expenses: ReadonlyArray<Pick<Expense, 'category'>>,
  current?: string | null
): string[] {
  const set = new Set<string>(canonical);
  expenses.forEach((e) => {
    if (e.category) set.add(e.category);
  });
  if (current) set.add(current);
  return Array.from(set);
}
