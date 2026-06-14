// 画像URLの安全性チェック（img src / プレビュー用）。
// blob: と https: のみ許可し、javascript: 等のスキームを弾く。
export function isSafeImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ['blob:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// 安全な場合に URL を再シリアライズして返す（不正なら null）。
// new URL().href を通すことで href/src へ渡す値をサニタイズする。
export function toSafeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'blob:') {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}
