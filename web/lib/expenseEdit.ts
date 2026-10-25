// 支出の編集（フォーム・入力チェック・送る差分・支払い者とカテゴリの候補）の純関数。
// 入力チェックの文言・判定順は firestore.rules の更新条件（PR #172）に合わせる。
// node --test から直接読めるよう、他のモジュールからは型だけを import する。
import type { Expense, GroupMember } from './hooks';

export interface EditForm {
  amount: number;
  description: string;
  date: string;
  category: string;
  /** 中項目。'' は「中項目なし」（保存すると subCategory を消す。shouldClearSubCategory） */
  subCategory: string;
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
  'subCategory',
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
  Partial<Pick<Expense, 'subCategory' | 'payerId' | 'payerDisplayName' | 'userDisplayName' | 'status'>>;

/** 編集フォームの初期値（既存の編集ドロワーと同じ既定: 支払い者は入力者） */
export function formFromExpense(e: EditSource): EditForm {
  return {
    amount: e.amount,
    description: e.description ?? '',
    date: e.date ?? '',
    category: e.category ?? '',
    subCategory: e.subCategory ?? '',
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
  // 選択肢は固定の一覧（50 文字以内）なので通常は起きない。ルールと同じ上限を念のため確かめる
  if (form.subCategory !== base.subCategory && form.subCategory.length > 50) {
    return { field: 'subCategory', message: '中項目は 50 文字以内で選んでください' };
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
 * - 中項目を「中項目なし」にしたときは subCategory: '' を送る（buildExpenseUpdate が削除に置き換える）
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

// ---- 中項目（編集画面の選択肢・大項目を変えたとき・保存） ---------------------------

/** 「中項目なし」の選択肢の値（EditForm.subCategory の '' と同じ） */
export const NO_SUB_CATEGORY = '';

export interface SubCategoryOption {
  value: string;
  label: string;
}

/**
 * 中項目の選択肢: 先頭に「中項目なし」→ 大項目の中項目の一覧 → 一覧に無い今の値。
 * 一覧に無い今の値（自由入力など）は最後に残す（開いただけで選択中の値が消えて、
 * 保存で別の値に変わるのを防ぐ）。
 * 一覧が空の大項目（日用品など）は、中項目の欄を出さないので空配列を返す。
 * list は categoryTaxonomy.ts の subCategoriesOf(大項目) を渡す。
 */
export function buildSubCategoryOptions(list: readonly string[], current: string): SubCategoryOption[] {
  if (list.length === 0) return [];
  const options: SubCategoryOption[] = [{ value: NO_SUB_CATEGORY, label: '中項目なし' }];
  list.forEach((name) => options.push({ value: name, label: name }));
  if (current && !list.includes(current)) options.push({ value: current, label: current });
  return options;
}

/**
 * 編集画面で大項目を選び直したときの次のフォーム。
 * 大項目が変わったら、中項目は「中項目なし」に戻す（古い中項目が新しい大項目と食い違わないように）。
 * reset は「中項目を戻した」（大項目が変わり、それまで中項目が選ばれていた）とき true。
 * 画面は reset を覚えておき、利用者が中項目を選び直すまで注記を出す。
 */
export function changeEditCategory(form: EditForm, category: string): { form: EditForm; reset: boolean } {
  if (category === form.category) return { form, reset: false };
  return {
    form: { ...form, category, subCategory: NO_SUB_CATEGORY },
    reset: form.subCategory !== NO_SUB_CATEGORY,
  };
}

type SubCategoryFields = Partial<Pick<Expense, 'category' | 'subCategory'>>;

/**
 * この更新で、中項目（subCategory）を消すか。
 * - 更新の中項目が ''（編集画面で「中項目なし」にした）なら消す（'' のまま保存しない）
 * - 大項目（category）を変える更新では、古い中項目が新しい大項目と食い違わないよう、常に消す。
 *   元の支出が中項目を持つかは見ない: Web の一覧は 1 回きりの読み込みなので、読み込んだ後に
 *   bot が中項目を書いた支出では、手元の一覧が「中項目なし」のままになっている。
 *   中項目を持たない支出への削除は、保存される結果が変わらない（ルールでも許可される）。
 * - 大項目は、正規化した後の値で比べる（別名が同じ大項目になる入力では消さない）
 * - 更新が中項目（'' 以外）を自分で指定しているときは、それに任せる
 * - 元の支出が渡されない更新（合計に含めるトグルなど）では、大項目を理由には消さない
 */
export function shouldClearSubCategory(
  update: SubCategoryFields,
  original: SubCategoryFields | null | undefined
): boolean {
  if (update.subCategory === NO_SUB_CATEGORY) return true;
  if (!original) return false;
  if (update.subCategory !== undefined) return false;
  return update.category !== undefined && update.category !== original.category;
}

/**
 * Firestore に送る更新内容。shouldClearSubCategory のときだけ、subCategory を削除にする
 * （無ければ足し、'' なら置き換える）。
 * deleteField は firebase/firestore の deleteField（node --test から差し替えられるよう引数で受ける）。
 * 消さないときは update をそのまま返す。
 */
export function buildExpenseUpdate<T extends SubCategoryFields, D>(
  update: T,
  original: SubCategoryFields | null | undefined,
  deleteField: () => D
): T | (Omit<T, 'subCategory'> & { subCategory: D }) {
  if (!shouldClearSubCategory(update, original)) return update;
  return { ...update, subCategory: deleteField() };
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
