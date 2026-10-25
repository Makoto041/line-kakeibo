// 中項目を辞書と時刻のルールで決める（#235 の方式 C。モデルは呼ばない）
//
// まだどこからも呼ばない（LINE・Gmail の保存への組み込みは後続の PR）。
// - 辞書: 大項目ごとに順番つきのグループ。説明文・店名を normalizeForMatch で揃えてから String.includes で照合し、
//   最初に当たったグループの中項目を採る。入力から正規表現は作らない。
// - 時刻: Gmail の店名（source: 'merchant'）で、メールに時刻があり、飲食店のグループ（mealTime）に当たったときだけ、
//   JST の時刻で朝ご飯・昼ご飯・夜ご飯に置き換える。LINE の説明文（source: 'text'）には当てない
//   （入力した時刻は食べた時刻とは限らない）。飲み会・カフェ・コンビニ・自販機・デリバリーにも当てない。
// - 「その他の食費」「その他の娯楽」は返さない（手で選ぶためだけ。「判定できない」（null）と「利用者がその他にした」を分ける）。
// - 辞書は一般的な語と広く知られたチェーン名だけ。キーワードの決まり（smoke-subcategory.js で確かめる）:
//   1 文字の語は持たない／英数字だけの語は 4 文字以上／「マック」「バー」「スパ」は持たない（別の店・語に当たりやすい）。
import { toCanonicalCategoryName } from './categoryNormalization';
import { SUB_CATEGORIES } from './categoryTaxonomy';
import { dayjs, formatJST } from './time';

/** 照合に使う入力の長さの上限（文字） */
const MATCH_INPUT_MAX = 100;

/**
 * 照合用に揃える: 100 文字に切る → NFKC（半角カナ・全角英数を揃える）→ もう一度 100 文字に切る（NFKC で伸びる文字がある）
 * → 小文字 → 文字と数字以外（空白・記号）を除く。文字列でなければ空文字。
 */
export function normalizeForMatch(s: string): string {
  if (typeof s !== 'string') return '';
  return s
    .slice(0, MATCH_INPUT_MAX)
    .normalize('NFKC')
    .slice(0, MATCH_INPUT_MAX)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export interface SubCategoryRule {
  /** 返す中項目（SUB_CATEGORIES のその大項目の一覧にある名前） */
  readonly sub: string;
  /** 照合する語（SUB_CATEGORY_RULES では normalizeForMatch 済み） */
  readonly keywords: readonly string[];
  /** 飲食店のグループ。Gmail の店名で時刻があれば、朝ご飯・昼ご飯・夜ご飯に置き換える */
  readonly mealTime?: true;
}

// 上から順に照合し、最初に当たったグループを採る（例: 「コンビニ ランチ」は昼ご飯、「コンビニ弁当」はコンビニ、
// 「ドライブ」は「ライブ」より先のレジャー・テーマパーク）。
const RAW_RULES: Record<string, readonly SubCategoryRule[]> = {
  食費: [
    { sub: '朝ご飯', keywords: ['朝食', '朝ご飯', '朝ごはん', 'モーニング'] },
    { sub: '昼ご飯', keywords: ['ランチ', '昼食', '昼ご飯', '昼ごはん', 'お昼'] },
    { sub: '夜ご飯', keywords: ['夕食', '夕飯', '夜ご飯', '晩ご飯', '晩飯', 'ディナー'] },
    // 飲み会（時刻のルールは当てない）
    {
      sub: '外食',
      keywords: ['飲み会', '二次会', '居酒屋', '宴会', '打ち上げ', '歓迎会', '送別会', '忘年会', '新年会'],
    },
    { sub: '自販機', keywords: ['自販機', '自動販売機'] },
    {
      sub: 'コンビニ',
      keywords: [
        'コンビニ',
        'セブンイレブン',
        'セブン',
        '7eleven',
        'ローソン',
        'lawson',
        'ファミリーマート',
        'ファミマ',
        'familymart',
        'ミニストップ',
        'ministop',
        'デイリーヤマザキ',
      ],
    },
    {
      sub: 'カフェ',
      keywords: [
        'カフェ',
        'cafe',
        '喫茶',
        '珈琲',
        'コーヒー',
        'スタバ',
        'スターバックス',
        'starbucks',
        'ドトール',
        'doutor',
        'タリーズ',
        'tullys',
        'コメダ',
        'komeda',
      ],
    },
    {
      sub: 'デリバリー・テイクアウト',
      keywords: [
        'デリバリー',
        'delivery',
        '出前',
        'ウーバーイーツ',
        'ubereats',
        '出前館',
        'wolt',
        'テイクアウト',
        '持ち帰り',
        '弁当',
        '惣菜',
        'ピザーラ',
        'ドミノピザ',
      ],
    },
    // 飲食店（Gmail の店名で時刻があれば、朝ご飯・昼ご飯・夜ご飯に置き換える）
    {
      sub: '外食',
      mealTime: true,
      keywords: [
        '外食',
        'レストラン',
        'restaurant',
        '食堂',
        '定食',
        'ラーメン',
        'ramen',
        'うどん',
        'そば',
        '蕎麦',
        '寿司',
        'すし',
        'sushi',
        '焼肉',
        'yakiniku',
        '牛丼',
        '吉野家',
        'すき家',
        '松屋',
        'ファミレス',
        'ガスト',
        'サイゼリヤ',
        'マクドナルド',
        'mcdonald',
        'モスバーガー',
        'ケンタッキー',
        'kentucky',
        'バーガー',
        'burger',
        'カレー',
        '中華',
        '焼き鳥',
        'とんかつ',
      ],
    },
    {
      sub: '食料品（スーパー）',
      keywords: [
        'スーパー',
        'イオン',
        'aeon',
        '西友',
        'seiyu',
        'イトーヨーカドー',
        'まいばすけっと',
        '成城石井',
        'マックスバリュ',
        '生協',
        '八百屋',
        '精肉',
        '鮮魚',
        '食料品',
        '食材',
        '食品',
        '野菜',
        '果物',
      ],
    },
  ],
  娯楽: [
    { sub: '映画', keywords: ['映画', 'シネマ', 'cinema', 'movie'] },
    {
      sub: '銭湯・サウナ',
      keywords: ['銭湯', 'スーパー銭湯', 'サウナ', 'sauna', '岩盤浴', '健康ランド', '温浴', '温泉'],
    },
    {
      sub: 'スポーツ・アウトドア',
      keywords: [
        'ボルダリング',
        'クライミング',
        'ボウリング',
        'bowling',
        'ゴルフ',
        'golf',
        '打ちっぱなし',
        'バッティングセンター',
        'テニス',
        'フットサル',
        'スキー',
        'スノボ',
        'キャンプ',
        '釣り',
        '登山',
        'プール',
        '観戦',
      ],
    },
    {
      sub: 'レジャー・テーマパーク',
      keywords: ['テーマパーク', '遊園地', 'ディズニー', 'disney', 'ユニバーサル', '水族館', '動物園', '博物館', '美術館', 'ドライブ'],
    },
    {
      sub: 'ゲーム・課金',
      keywords: ['ゲーム', 'game', '課金', 'ガチャ', 'ゲーセン', 'nintendo', 'プレステ', 'playstation', 'steam'],
    },
    {
      sub: '本・漫画',
      keywords: ['書店', '本屋', '漫画', 'マンガ', 'コミック', '雑誌', '小説', '文庫', 'kindle', '電子書籍', '紀伊國屋', 'ブックオフ'],
    },
    {
      sub: '音楽・ライブ',
      keywords: ['ライブ', 'コンサート', 'フェス', 'カラオケ', 'karaoke', 'ビッグエコー', 'ジャンカラ', '音楽'],
    },
  ],
};

function prepareRules(raw: Record<string, readonly SubCategoryRule[]>): Readonly<Record<string, readonly SubCategoryRule[]>> {
  const out: Record<string, readonly SubCategoryRule[]> = {};
  for (const [major, groups] of Object.entries(raw)) {
    out[major] = Object.freeze(
      groups.map((group) => {
        const keywords = group.keywords.map(normalizeForMatch);
        // 空の語は "".includes で何にでも当たるため、読み込みの時点で止める
        if (keywords.some((k) => k === '')) {
          throw new Error(`中項目の辞書に、揃えると空になる語がある: ${major}/${group.sub}`);
        }
        return Object.freeze({ ...group, keywords: Object.freeze(keywords) });
      })
    );
  }
  return Object.freeze(out);
}

/** 中項目の辞書（大項目 → 順番つきのグループ。キーワードは normalizeForMatch 済み） */
export const SUB_CATEGORY_RULES = prepareRules(RAW_RULES);

export type MealSubCategory = '朝ご飯' | '昼ご飯' | '夜ご飯';

function isValidTime(value: unknown): value is Date | string {
  return (value instanceof Date || typeof value === 'string') && dayjs(value).isValid();
}

/**
 * JST の時刻で、朝ご飯（05:00〜10:59）・昼ご飯（11:00〜16:59）・夜ご飯（17:00〜翌 04:59。深夜 0〜4 時は夜）を返す。
 * 日時として読めなければ null。
 */
export function mealOfJst(usedAt: Date | string): MealSubCategory | null {
  if (!isValidTime(usedAt)) return null;
  const hour = Number(formatJST(usedAt, 'H'));
  if (!Number.isInteger(hour)) return null;
  if (hour >= 5 && hour <= 10) return '朝ご飯';
  if (hour >= 11 && hour <= 16) return '昼ご飯';
  return '夜ご飯';
}

/**
 * 利用日時に時刻があるか。Gmail の取込は、メールに時刻が無いと JST の 00:00 にする（gmail/parser.ts）ため、
 * JST の 00:00:00.000 ちょうどなら false（時刻なしとみなす）。日時として読めなければ false。
 */
export function usedAtHasClockTime(usedAt: Date | string): boolean {
  if (!isValidTime(usedAt)) return false;
  return formatJST(usedAt, 'HH:mm:ss.SSS') !== '00:00:00.000';
}

export interface ResolveSubCategoryInput {
  /** 大項目（toCanonicalCategoryName の完全一致で正準名にしてから見る） */
  major: string;
  /** LINE の説明文、または Gmail の店名 */
  text: string;
  source: 'text' | 'merchant';
  /** 利用日時（Gmail の取込） */
  usedAt?: Date | string | null;
  /** usedAt に時刻があるか（usedAtHasClockTime） */
  hasTime?: boolean;
}

/** 説明が「支出」だけ（LINE で説明もカテゴリも無いときの既定の説明。textParser.ts）なら判定しない */
const NO_INFO_TEXT = normalizeForMatch('支出');

/**
 * 辞書と時刻のルールで中項目を決める。決められなければ null。
 * - 大項目は toCanonicalCategoryName の完全一致だけを見る。中項目の一覧に無い大項目（日用品・利用者のカスタム名など）は null。
 * - 説明が空・カテゴリ名そのもの（例: 「娯楽費」）・「支出」だけなら null。
 * - 「その他の食費」「その他の娯楽」は返さない。
 */
export function resolveSubCategory({ major, text, source, usedAt, hasTime }: ResolveSubCategoryInput): string | null {
  if (typeof major !== 'string') return null;
  const canonical = toCanonicalCategoryName(major);
  if (typeof canonical !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(SUB_CATEGORIES, canonical)) return null;
  if (!Object.prototype.hasOwnProperty.call(SUB_CATEGORY_RULES, canonical)) return null;

  const normalized = normalizeForMatch(text);
  if (
    normalized === '' ||
    normalized === NO_INFO_TEXT ||
    normalized === normalizeForMatch(major) ||
    normalized === normalizeForMatch(canonical)
  ) {
    return null;
  }

  const group = SUB_CATEGORY_RULES[canonical].find((g) => g.keywords.some((k) => normalized.includes(k)));
  if (!group) return null;

  let sub: string = group.sub;
  if (group.mealTime === true && source === 'merchant' && hasTime === true && usedAt != null) {
    sub = mealOfJst(usedAt) ?? sub;
  }
  return SUB_CATEGORIES[canonical].includes(sub) ? sub : null;
}
