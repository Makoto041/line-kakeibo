// 内訳（合計 → カテゴリ → 中項目 / 支払い者 → 明細）の純関数。
// ホームのカテゴリ別カード・精算の金額タイルから開く内訳シート（components/drilldown/DrillSheet.tsx）が使う。
// 読み込み済みの明細から計算するだけで、Firestore を追加で読まない。
// node --test から直接読めるよう、他のモジュールからは型だけを import する
// （中項目の一覧〔categoryTaxonomy.ts の subCategoriesOf〕も、toDrillItems の引数で受ける）。
import type { Expense } from './hooks';

/** 中項目の一覧がある大項目（食費・娯楽）で、中項目が付いていないもの */
export const NO_SUB_CATEGORY = '中項目なし';

/**
 * 内訳でまとめる中項目。list はその大項目の中項目の一覧（categoryTaxonomy.ts の subCategoriesOf(大項目)）。
 * 一覧の無い大項目（list が空）は undefined（中項目の段を出さない）。
 * 一覧にある値はそのまま、一覧にない値（Web で入れた値など）は「その他の…」（一覧の最後）、空・文字列でないものは「中項目なし」。
 * Firestore の値は信用せず、画面には一覧の名前か「中項目なし」だけを出す
 */
export function subCategoryKey(list: readonly string[], subCategory: unknown): string | undefined {
  if (list.length === 0) return undefined;
  const value = typeof subCategory === 'string' ? subCategory.trim() : '';
  if (!value) return NO_SUB_CATEGORY;
  return list.includes(value) ? value : list[list.length - 1];
}

/** 内訳に並べる明細（画面ごとに合計の数え方・支払い者の決め方を変えられるよう、呼び出し側で作る） */
export interface DrillItem {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  description: string;
  category: string;
  /** 中項目（subCategoryKey の結果。中項目の一覧の無い大項目は無し） */
  subCategory?: string;
  amount: number;
  /** 支払い者の識別（絞り込みのキー） */
  payerKey: string;
  payerName: string;
  /** 合計に含む（含まないものは明細の下に件数だけ出す） */
  included: boolean;
  /** 要確認（手入力で未確認） */
  pending: boolean;
  inputSource?: Expense['inputSource'];
  status?: Expense['status'];
}

/**
 * 明細から内訳の行を作る。期間（range）外のものは除く。
 * 合計に含むかどうか・支払い者の決め方は画面ごとに違う（ホームは支払い者名、精算は lineId）ので渡してもらう。
 * 要確認の判定は expenseState の isPending、中項目の一覧は categoryTaxonomy の subCategoriesOf を渡す
 */
export function toDrillItems(
  expenses: readonly Expense[],
  opts: {
    range?: DrillRange;
    included: (e: Expense) => boolean;
    payer: (e: Expense) => { key: string; name: string };
    pending: (e: Expense) => boolean;
    subCategoriesOf: (category: string) => readonly string[];
  }
): DrillItem[] {
  const out: DrillItem[] = [];
  for (const e of expenses) {
    if (opts.range && (typeof e.date !== 'string' || e.date < opts.range.startDate || e.date > opts.range.endDate)) continue;
    const payer = opts.payer(e);
    const amount = Number(e.amount);
    const category = e.category || 'その他';
    out.push({
      id: e.id,
      date: e.date,
      description: e.description || '',
      category,
      subCategory: subCategoryKey(opts.subCategoriesOf(category), e.subCategory),
      amount: Number.isFinite(amount) ? amount : 0,
      payerKey: payer.key,
      payerName: payer.name,
      included: opts.included(e),
      pending: opts.pending(e),
      inputSource: e.inputSource,
      status: e.status,
    });
  }
  return out;
}

export type DrillDim = 'category' | 'subCategory' | 'payer';

export interface DrillFilter {
  category?: string;
  /** 中項目（subCategoryKey の結果。「中項目なし」も含む）。category と一緒に使う */
  subCategory?: string;
  /** 支払い者のキー（どれかに当たるもの） */
  payers?: string[];
}

export interface DrillGroup {
  key: string;
  label: string;
  total: number;
  count: number;
}

export interface DrillRange {
  startDate: string;
  endDate: string;
}

export function matchesDrill(item: Pick<DrillItem, 'category' | 'subCategory' | 'payerKey'>, filter: DrillFilter): boolean {
  if (filter.category !== undefined && item.category !== filter.category) return false;
  if (filter.subCategory !== undefined && (item.subCategory ?? NO_SUB_CATEGORY) !== filter.subCategory) return false;
  if (filter.payers && !filter.payers.includes(item.payerKey)) return false;
  return true;
}

export function sumAmount(items: ReadonlyArray<Pick<DrillItem, 'amount'>>): number {
  let total = 0;
  for (const item of items) total += Number.isFinite(item.amount) ? item.amount : 0;
  return total;
}

/**
 * カテゴリ別・中項目別・支払い者別の小計（金額の多い順。同じ金額は件数の多い順、次に名前順）。
 * 中項目別では「中項目なし」を金額にかかわらず最後にする
 */
export function groupDrill(items: readonly DrillItem[], dim: DrillDim): DrillGroup[] {
  const groups = new Map<string, DrillGroup>();
  for (const item of items) {
    const key =
      dim === 'category' ? item.category || 'その他' : dim === 'subCategory' ? item.subCategory ?? NO_SUB_CATEGORY : item.payerKey;
    const label = dim === 'payer' ? item.payerName || '不明' : key;
    const group = groups.get(key) ?? { key, label, total: 0, count: 0 };
    group.total += Number.isFinite(item.amount) ? item.amount : 0;
    group.count += 1;
    groups.set(key, group);
  }
  const last = (g: DrillGroup) => (dim === 'subCategory' && g.key === NO_SUB_CATEGORY ? 1 : 0);
  return Array.from(groups.values()).sort(
    (a, b) =>
      last(a) - last(b) || b.total - a.total || b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
  );
}

/** 割合（小数 1 桁）。全体が 0 なら 0 */
export function sharePct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/** 前の期間との増減（%。整数）。前の期間が無い・0 なら null */
export function deltaPct(now: number, prev: number | null | undefined): number | null {
  if (!prev || prev <= 0) return null;
  return Math.round(((now - prev) / prev) * 100);
}

/**
 * 内訳の切り替え（カテゴリ / 中項目 / 支払い者）が意味を持つか: 絞り込み済みの軸や、1 つしか無い軸は出さない。
 * 中項目は、カテゴリで絞った階層で、中項目の一覧がある大項目（食費・娯楽）に中項目の付いた明細が 1 件でもあるときだけ
 * （全部が「中項目なし」なら出さない）
 */
export function availableDims(items: readonly DrillItem[], filter: DrillFilter): Record<DrillDim, boolean> {
  return {
    category: filter.category === undefined && groupDrill(items, 'category').length > 1,
    subCategory:
      filter.category !== undefined &&
      filter.subCategory === undefined &&
      items.some((i) => i.subCategory !== undefined && i.subCategory !== NO_SUB_CATEGORY),
    payer: !(filter.payers && filter.payers.length === 1) && groupDrill(items, 'payer').length > 1,
  };
}

/** 表示する内訳の軸（希望が使えなければ カテゴリ → 中項目 → 支払い者 の順で使えるもの。どれも使えなければ null） */
export function resolveDim(
  items: readonly DrillItem[],
  filter: DrillFilter,
  preferred?: DrillDim
): DrillDim | null {
  const dims = availableDims(items, filter);
  if (preferred && dims[preferred]) return preferred;
  if (dims.category) return 'category';
  if (dims.subCategory) return 'subCategory';
  if (dims.payer) return 'payer';
  return null;
}

export type DrillSort = 'date' | 'amount';

/** 明細の並び（日付の新しい順 / 金額の多い順。同じものは元の順） */
export function sortDrillItems<T extends Pick<DrillItem, 'date' | 'amount'>>(items: readonly T[], sort: DrillSort): T[] {
  return [...items].sort((a, b) =>
    sort === 'amount' ? b.amount - a.amount : a.date < b.date ? 1 : a.date > b.date ? -1 : 0
  );
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** 期間を開始日から 7 日ずつに分けた週ごとの合計（最後の週は期間末で切る） */
export function weeklyTotals(
  items: ReadonlyArray<Pick<DrillItem, 'date' | 'amount'>>,
  range: DrillRange
): Array<{ start: string; end: string; total: number }> {
  if (!range.startDate || !range.endDate || range.startDate > range.endDate) return [];
  const weeks: Array<{ start: string; end: string; total: number }> = [];
  for (let start = range.startDate; start <= range.endDate && weeks.length < 8; start = addDays(start, 7)) {
    const end = addDays(start, 6) < range.endDate ? addDays(start, 6) : range.endDate;
    weeks.push({ start, end, total: 0 });
  }
  for (const item of items) {
    const week = weeks.find((w) => item.date >= w.start && item.date <= w.end);
    if (week) week.total += Number.isFinite(item.amount) ? item.amount : 0;
  }
  return weeks;
}

/** カードの共通口座・カード取込は決まった色、メンバーは並び順の色 */
const PERSON_COLORS = ['#10b981', '#8b5cf6', '#f59e0b', '#ec4899'];
export const CARD_PAYER_NAME = 'クレジットカード';
export const SHARED_PAYER_NAME = '共通口座';

export function payerColor(name: string, index: number): string {
  if (name === CARD_PAYER_NAME) return '#0ea5e9';
  if (name === SHARED_PAYER_NAME) return '#14b8a6';
  return PERSON_COLORS[index % PERSON_COLORS.length];
}

/** 入力元の表記 */
export function inputSourceLabel(source: Expense['inputSource'] | undefined): string {
  switch (source) {
    case 'gmail_auto':
      return 'カード取込（メール）';
    case 'recurring':
      return '固定費の自動計上';
    case 'line_ocr':
      return 'LINE（レシート）';
    default:
      return 'LINE で手入力';
  }
}
