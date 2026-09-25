// 期間の短いラベル（ホームの月ラベル・明細／ふたりの月ピル）。
// 正確な期間の表記は dateSettings.ts の getDisplayTitle をそのまま使う。
import dayjs from 'dayjs';

export interface PeriodRange {
  startDate: string;
  endDate: string;
  mode: 'monthly' | 'custom';
}

/**
 * - 月単位・指定日起算: 期間の開始月「M月」（開始年が今年でなければ「YYYY年M月」）
 * - 期間指定: 「M/D〜M/D」
 */
export function shortPeriodLabel(range: PeriodRange, today: dayjs.ConfigType): string {
  const start = dayjs(range.startDate);
  if (range.mode === 'custom') {
    const end = dayjs(range.endDate);
    return `${start.format('M/D')}〜${end.format('M/D')}`;
  }
  return start.year() === dayjs(today).year() ? start.format('M月') : start.format('YYYY年M月');
}
