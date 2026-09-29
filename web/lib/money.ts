// 金額の書式（既存の yen と同じ: 半角の円記号 U+00A5 ＋ 3 桁区切り）

export function yen(value: number): string {
  const n = Number(value);
  return `¥${(Number.isFinite(n) ? n : 0).toLocaleString('ja-JP')}`;
}
