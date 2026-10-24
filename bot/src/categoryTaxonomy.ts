// カテゴリの中項目（大項目の下の 2 階層目。#235）
//
// PROVISIONAL（仮）の一覧。#235 の決定で差し替える。本番のコードからはまだ使わない
// （いまは評価データに中項目の正解を付ける bot/scripts/eval/review-golden.js --sub と、
//  階層化の評価 bot/scripts/eval/eval-classifier.js --scheme stage2|flat だけが使う）。
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
 * 中項目の説明（PROVISIONAL・仮）。階層化の評価（eval-classifier.js --sub-desc on）で、Jev の中項目の選択肢に付けるだけ。
 * 中項目の一覧と一緒に #235 の決定で差し替える。評価データの説明文・店名は使っていない（中項目の名前から書いた一般的な説明）。
 * 説明の無い中項目は、説明なし（null）で送る。キーは SUB_CATEGORIES の大項目・中項目（smoke-taxonomy.js で確かめる）。
 */
export const SUB_CATEGORY_DESCRIPTIONS: Record<string, Readonly<Record<string, string>>> = {
  食費: {
    '食料品（スーパー）': 'スーパー・八百屋・精肉店などで買う、家で食べる食材や飲み物',
    外食: '飲食店での食事（レストラン・定食屋・ラーメン・牛丼・寿司・ファストフード・居酒屋・飲み会）',
    コンビニ: 'コンビニエンスストアでの食べ物・飲み物の買い物',
    カフェ: 'カフェ・喫茶店・コーヒーショップでの飲食',
    自販機: '自動販売機で買う飲み物・食べ物',
    'デリバリー・テイクアウト': '出前・フードデリバリー、持ち帰りの弁当・惣菜',
    その他の食費: 'ほかの中項目のどれにも当てはまらない食費',
  },
  娯楽: {
    映画: '映画館のチケット・映画の鑑賞',
    '銭湯・サウナ': '銭湯・サウナ・スーパー銭湯などの温浴施設',
    'ゲーム・課金': 'ゲームソフト・ゲーム機、ゲームやアプリへの課金、ゲームセンター',
    '本・漫画': '本・雑誌・漫画（電子書籍を含む）',
    '音楽・ライブ': '音楽の購入・配信、ライブ・コンサートのチケット',
    'レジャー・テーマパーク': 'テーマパーク・遊園地・動物園・水族館などのレジャー施設',
    その他の娯楽: 'ほかの中項目のどれにも当てはまらない娯楽・趣味',
  },
};

/**
 * 大項目の中項目の一覧。大項目名は normalizeCategoryName で正準名に揃えてから引く（例: 「外食」→ 食費）。
 * 中項目が無い大項目は空配列（一覧に無い名前は normalizeCategoryName が「その他」にするので、これも空配列）。
 */
export function subCategoriesOf(major: string): readonly string[] {
  const canonical = normalizeCategoryName(major);
  return Object.prototype.hasOwnProperty.call(SUB_CATEGORIES, canonical) ? SUB_CATEGORIES[canonical] : [];
}
