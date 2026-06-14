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
