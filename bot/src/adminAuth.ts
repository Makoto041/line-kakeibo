/**
 * 管理 API の認証ヘルパー
 *
 * Express や Firebase に依存しない純粋関数だけを置く（スモークテストから直接読むため）。
 */
import { createHash, timingSafeEqual } from "crypto";

/**
 * 秘密値の比較（定数時間）
 *
 * 両辺を SHA-256 にかけて同じ長さ（32バイト）にそろえてから timingSafeEqual で比べる。
 * 長さの違いで早期に false を返すと、比較時間から秘密値の長さが漏れるため。
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * `Authorization` ヘッダーの値から Bearer トークンを取り出す。
 * スキーム名は大文字小文字を区別しない。前後の空白は落とす。取り出せなければ空文字。
 */
export function parseBearerToken(headerValue: unknown): string {
  if (typeof headerValue !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(headerValue);
  return match ? match[1].trim() : "";
}

/**
 * `Authorization` ヘッダーの Bearer トークンが管理用の秘密値と一致するか。
 * 秘密値が未設定（空）の場合は常に false。
 */
export function isAdminAuthorized(headerValue: unknown, adminSecret: string | undefined): boolean {
  const expected = adminSecret?.trim();
  if (!expected) return false;
  const provided = parseBearerToken(headerValue);
  return provided !== "" && secretsMatch(provided, expected);
}
