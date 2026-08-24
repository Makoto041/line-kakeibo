/**
 * 日付の基準タイムゾーン
 *
 * Cloud Functions（Cloud Run）のコンテナは TZ が UTC で動く。`dayjs()` をそのまま
 * 使うと JST の 00:00〜08:59 に入力された支出が「前日」として保存され、月初・月末では
 * 前月に落ちて当月の一覧・合計から消える。日付は必ず JST で決める。
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';

// dayjs のプラグインはプロセスで一度拡張すれば全体に効く（既存の単一引数パースの挙動は変わらない）。
// タイムゾーンや書式指定パースが要るモジュールは、このファイル経由で dayjs を使う。
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export const JST = 'Asia/Tokyo';

/** JST の現在時刻 */
export function nowJST(): dayjs.Dayjs {
  return dayjs().tz(JST);
}

/** JST の今日（YYYY-MM-DD） */
export function todayJST(): string {
  return nowJST().format('YYYY-MM-DD');
}

export { dayjs };

/** 任意の日時を JST の YYYY-MM-DD にする */
export function toJSTDateString(value: Date | string): string {
  return dayjs(value).tz(JST).format('YYYY-MM-DD');
}

/** 任意の日時を JST で書式化する */
export function formatJST(value: Date | string, template: string): string {
  return dayjs(value).tz(JST).format(template);
}

/**
 * 「2026/3/14 19:20」のような JST の壁時計表記を Date にする
 *
 * `new Date('2026-03-14 19:20')` はコンテナのTZ（本番は UTC）で解釈されるため、
 * JST の表記をそのまま渡すと実時刻より9時間ずれた瞬間になる。
 */
export function parseJSTWallClock(dateStr: string, timeStr: string): Date {
  const parsed = dayjs.tz(`${dateStr} ${timeStr}`, 'YYYY-M-D H:mm', JST);
  return parsed.isValid() ? parsed.toDate() : new Date();
}
