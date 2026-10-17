// 精算タブの「以前の立替が残っています」のお知らせ用の純関数（node --test から直接読める。型以外の import なし）。
// 立替は期間の精算に全額を加算して返すようにした。それより前の立替（advanceFull の無い advance_pending）は
// これまでどおり支払った人の分として折半されているので、精算が済んでいれば精算済みにする。
import type { AdvanceItem } from './householdContract';

/** YYYY-MM-DD → 「8月15日」（年が違うものが混ざるときは「2025年8月15日」） */
function dayLabel(ymd: string, withYear: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return '';
  const md = `${Number(m[2])}月${Number(m[3])}日`;
  return withYear ? `${m[1]}年${md}` : md;
}

/**
 * 残っている立替の日付の範囲（「3月27日〜8月15日」。1 日だけなら「8月15日」）。
 * 今年以外の日付があれば年も付ける。日付が無ければ空文字
 */
export function advanceDateSpan(items: readonly Pick<AdvanceItem, 'date'>[], thisYear: number): string {
  const dates = items
    .map((it) => it.date)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (dates.length === 0) return '';
  const first = dates[0];
  const last = dates[dates.length - 1];
  const withYear = dates.some((d) => Number(d.slice(0, 4)) !== thisYear);
  if (first === last) return dayLabel(first, withYear);
  return `${dayLabel(first, withYear)}〜${dayLabel(last, withYear)}`;
}

/** 一覧の 2 行目（「8月15日・岩渕 誠が立替」）。名前が分からなければ日付だけ */
export function advanceItemMeta(item: Pick<AdvanceItem, 'date' | 'advanceBy' | 'advanceByName'>, names: Readonly<Record<string, string>>, thisYear: number): string {
  const date = dayLabel(item.date, Number(item.date.slice(0, 4)) !== thisYear);
  const fromMembers = item.advanceBy && Object.prototype.hasOwnProperty.call(names, item.advanceBy) ? names[item.advanceBy] : '';
  const name = (fromMembers || item.advanceByName).trim();
  return [date, name ? `${name}が立替` : ''].filter(Boolean).join('・');
}
