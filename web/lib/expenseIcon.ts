// 明細の行アイコンを説明のキーワードで決める（表示だけ。データは変えない）。
// 当たらなければ null を返し、呼び出し側でカテゴリのアイコンを使う。

export type RowIconKey = 'cart' | 'coffee' | 'train';

// 上から順に判定する。キーワードは NFKC・小文字化した説明との部分一致。
const RULES: ReadonlyArray<readonly [RowIconKey, readonly string[]]> = [
  ['cart', ['スーパー', 'マート', 'ストア', 'イオン', '西友', 'まいばすけっと']],
  ['coffee', ['カフェ', 'コーヒー', '珈琲', '喫茶', 'スタバ', 'スターバックス', 'ドトール', 'タリーズ']],
  ['train', ['電車', 'jr', 'suica', 'pasmo', '地下鉄', 'メトロ', '新幹線', '交通費']],
];

export function rowIconKey(description: string | null | undefined): RowIconKey | null {
  if (!description) return null;
  const text = description.normalize('NFKC').toLowerCase();
  for (const [key, words] of RULES) {
    if (words.some((word) => text.includes(word))) return key;
  }
  return null;
}
