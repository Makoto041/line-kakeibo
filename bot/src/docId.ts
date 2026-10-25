/**
 * Firestore のドキュメント ID の入力検証（Web 向けの /household API と LINE の postback で共用）
 */

/**
 * Firestore のドキュメント ID として安全な文字列か
 *
 * 1〜128 文字、`/` を含まない、`.` `..` ではない、`__…__`（予約 ID。Firestore が拒否して 500 になる）ではない。
 * 予約 ID の判定は改行を含む値（`__a\nb__`）も対象にするため、正規表現の `.` ではなく前後の一致で見る。
 */
export function isValidDocId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    !value.includes('/') &&
    value !== '.' &&
    value !== '..' &&
    !(value.length >= 4 && value.startsWith('__') && value.endsWith('__'))
  );
}
