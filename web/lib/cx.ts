/** クラス名をつなぐ（偽の値は捨てる） */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
