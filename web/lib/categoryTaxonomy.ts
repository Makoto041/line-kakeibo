// カテゴリの中項目（大項目の下の 2 階層目。#235）。
//
// bot/src/categoryTaxonomy.ts の SUB_CATEGORIES のコピー。web は bot のモジュールを読めない
// （別のワークスペースで、bot は CommonJS）ため複製している。一覧を変えるときは両方を変える
// （web/__tests__/categoryTaxonomy.test.mjs が、bot の一覧と名前・並び順まで一致することを確かめる）。
// - 中項目を持つのは食費・娯楽だけで、他の大項目は中項目なし。
// - 並び順は、編集画面の選択肢の並び順になる。
// node --test から直接読めるよう、他のモジュールを import しない。

export const SUB_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  食費: [
    '食料品（スーパー）',
    '外食',
    '朝ご飯',
    '昼ご飯',
    '夜ご飯',
    'カフェ',
    'コンビニ',
    '自販機',
    'デリバリー・テイクアウト',
    'その他の食費',
  ],
  娯楽: [
    '映画',
    '銭湯・サウナ',
    'スポーツ・アウトドア',
    'ゲーム・課金',
    '本・漫画',
    '音楽・ライブ',
    'レジャー・テーマパーク',
    'その他の娯楽',
  ],
};

/**
 * 大項目の中項目の一覧。中項目が無い大項目は空配列。
 * 大項目は正準名の完全一致で引く（bot の subCategoriesOf と違い、別名は正準名に揃えない。
 * 編集画面で大項目を変えると、保存時に正準名に揃えられる）。
 */
export function subCategoriesOf(category: string): readonly string[] {
  if (typeof category !== 'string') return [];
  return Object.prototype.hasOwnProperty.call(SUB_CATEGORIES, category) ? SUB_CATEGORIES[category] : [];
}
