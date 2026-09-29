// 金額の書式（半角の円記号 U+00A5 ＋ 3 桁区切り）。

/**
 * 例: yen(1234) → "¥1,234"。
 * locale を省くとブラウザの既定ロケールで区切る（Number.prototype.toLocaleString と同じ）。
 */
export function yen(value: number, locale?: string): string {
  return `¥${Number(value).toLocaleString(locale)}`;
}
