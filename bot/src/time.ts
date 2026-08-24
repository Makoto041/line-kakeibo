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
