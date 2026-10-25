// カテゴリの中項目（大項目の下の 2 階層目。#235）
//
// #235 で確定した一覧。中項目を持つのは食費・娯楽だけで、他の大項目は空（中項目なし）。
// - 中項目は辞書と時刻のルール（subCategoryRules.ts の resolveSubCategory。モデルは呼ばない）で決める。
//   resolveSubCategory は、登録時の保存（LINE の入力・Gmail のカード利用通知）と、LINE で大項目を変えたとき（decideSetCategory）に呼ぶ。
// - 評価データに中項目の正解を付ける bot/scripts/eval/review-golden.js --sub と、
//   階層化の評価 bot/scripts/eval/eval-classifier.js --scheme stage2|flat も、この一覧を使う。
// - 「その他の食費」「その他の娯楽」は、利用者が手で選ぶためだけにある。resolveSubCategory は返さない
//   （「判定できない」と「利用者がその他にした」を分けるため）。
// - #250 の仮の一覧の名前はすべて残している（評価データに付けた中項目のラベルが無効にならないように）。
// - 中項目名は、大項目の中で一意・空でない・50 文字以内（smoke-taxonomy.js で確かめる）。
import { toCanonicalCategoryName } from './categoryNormalization';

export const SUB_CATEGORIES: Record<string, readonly string[]> = {
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
 * 中項目の説明。階層化の評価（eval-classifier.js --sub-desc on）で、Jev の中項目の選択肢に付ける。
 * 方式 C を採ったため本番では使わない。所感発表での方式 B との比較のために残す。
 * 評価データの説明文・店名は使っていない（中項目の名前から書いた一般的な説明）。
 * 説明の無い中項目は、説明なし（null）で送る。キーは SUB_CATEGORIES の大項目・中項目（smoke-taxonomy.js で確かめる）。
 */
export const SUB_CATEGORY_DESCRIPTIONS: Record<string, Readonly<Record<string, string>>> = {
  食費: {
    '食料品（スーパー）': 'スーパー・八百屋・精肉店などで買う、家で食べる食材や飲み物',
    外食: '飲み会・居酒屋などの飲食と、朝・昼・夜のどの食事か分からない飲食店での食事',
    朝ご飯: '朝の食事（朝食・モーニング）。飲食店で朝（5 時〜10 時台）に食べたものを含む',
    昼ご飯: '昼の食事（ランチ・昼食）。飲食店で昼（11 時〜16 時台）に食べたものを含む',
    夜ご飯: '夜の食事（夕食・ディナー）。飲食店で夜（17 時〜翌 4 時台）に食べたものを含む',
    カフェ: 'カフェ・喫茶店・コーヒーショップでの飲食',
    コンビニ: 'コンビニエンスストアでの食べ物・飲み物の買い物',
    自販機: '自動販売機で買う飲み物・食べ物',
    'デリバリー・テイクアウト': '出前・フードデリバリー、持ち帰りの弁当・惣菜',
    その他の食費: 'ほかの中項目のどれにも当てはまらない食費',
  },
  娯楽: {
    映画: '映画館のチケット・映画の鑑賞',
    '銭湯・サウナ': '銭湯・サウナ・スーパー銭湯などの温浴施設',
    'スポーツ・アウトドア': 'スポーツをする施設の利用料・スポーツ観戦、キャンプ・釣り・登山などのアウトドア',
    'ゲーム・課金': 'ゲームソフト・ゲーム機、ゲームやアプリへの課金、ゲームセンター',
    '本・漫画': '本・雑誌・漫画（電子書籍を含む）',
    '音楽・ライブ': '音楽の購入・配信、ライブ・コンサートのチケット',
    'レジャー・テーマパーク': 'テーマパーク・遊園地・動物園・水族館などのレジャー施設',
    その他の娯楽: 'ほかの中項目のどれにも当てはまらない娯楽・趣味',
  },
};

/**
 * 大項目の中項目の一覧。大項目名は toCanonicalCategoryName の完全一致で正準名に揃えてから引く（例: 「外食」→ 食費）。
 * 中項目が無い大項目と、正準名にも別名にも無い名前（利用者のカスタム名「飲食代」など）は空配列
 * （部分一致・キーワードでは寄せない。resolveSubCategory と同じ見方）。
 */
export function subCategoriesOf(major: string): readonly string[] {
  if (typeof major !== 'string') return [];
  const canonical = toCanonicalCategoryName(major);
  return Object.prototype.hasOwnProperty.call(SUB_CATEGORIES, canonical) ? SUB_CATEGORIES[canonical] : [];
}
