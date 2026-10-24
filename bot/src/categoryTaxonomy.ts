// カテゴリの中項目（大項目の下の 2 階層目。#235）
//
// PROVISIONAL（仮）の一覧。#235 の決定で差し替える。本番のコードからはまだ使わない
// （いまは評価データに中項目の正解を付ける bot/scripts/eval/review-golden.js --sub だけが使う）。
//
// - 食費・娯楽は、#235 の本文の「中項目の叩き台」のとおり。他の大項目は空（中項目なし）。
// - #235 で採用を決めた食費の「朝ご飯・昼ご飯・夜ご飯」は、まだ入れていない。時間帯の境目と振り分け方が未決で、
//   評価データには利用時刻が無く、説明文・店名だけでは付けられないため。
// - 中項目名は、大項目の中で一意・空でない・50 文字以内（smoke-taxonomy.js で確かめる）。
import { normalizeCategoryName } from './categoryNormalization';

export const SUB_CATEGORIES: Record<string, readonly string[]> = {
  食費: ['食料品（スーパー）', '外食', 'コンビニ', 'カフェ', '自販機', 'デリバリー・テイクアウト', 'その他の食費'],
  娯楽: ['映画', '銭湯・サウナ', 'ゲーム・課金', '本・漫画', '音楽・ライブ', 'レジャー・テーマパーク', 'その他の娯楽'],
};

/**
 * 大項目の中項目の一覧。大項目名は normalizeCategoryName で正準名に揃えてから引く（例: 「外食」→ 食費）。
 * 中項目が無い大項目は空配列（一覧に無い名前は normalizeCategoryName が「その他」にするので、これも空配列）。
 */
export function subCategoriesOf(major: string): readonly string[] {
  const canonical = normalizeCategoryName(major);
  return Object.prototype.hasOwnProperty.call(SUB_CATEGORIES, canonical) ? SUB_CATEGORIES[canonical] : [];
}
