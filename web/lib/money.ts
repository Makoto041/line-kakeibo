// 金額の書式（既存の yen と同じ: 半角の円記号 U+00A5 ＋ 3 桁区切り）

export function yen(value: number): string {
  const n = Number(value);
  return `¥${(Number.isFinite(n) ? n : 0).toLocaleString('ja-JP')}`;
}

// 大きい金額の文字サイズ段階。桁が増えても省略記号は使わず、字の大きさだけを下げる。
// キーは基準サイズ（px）、値は [字数の閾値, 超えたときのサイズ] を大きい順に。
const TIERS: Record<number, ReadonlyArray<readonly [number, number]>> = {
  40: [
    [11, 28],
    [9, 34],
  ],
  44: [
    [10, 30],
    [8, 36],
  ],
  30: [[10, 24]],
};

/** 表示する文字列（例 "¥1,234,567"）の字数から文字サイズ（px）を決める */
export function amountTier(text: string, base: number): number {
  const length = Array.from(text).length;
  const tiers = TIERS[base];
  if (!tiers) return base;
  for (const [limit, size] of tiers) {
    if (length > limit) return size;
  }
  return base;
}
