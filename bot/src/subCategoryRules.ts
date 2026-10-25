// 中項目を辞書と時刻のルールで決める（#235 の方式 C。モデルは呼ばない）
//
// 呼ぶのは 2 か所: 登録時の保存（LINE の入力は line/expenseFlow.ts の textSubCategoryOf、Gmail のカード利用通知は
// gmail/handler.ts の merchantSubCategoryOf）と、LINE で大項目を変えたときの決め直し（postback の set_category。expenseActions.ts の decideSetCategory）。
// - 辞書: 大項目ごとに順番つきのグループ。説明文・店名を normalizeForMatch で揃えてから照合し、最初に当たったグループの中項目を採る。
//   keywords は部分一致（String.includes）、exact は揃えた入力の全体と一致したときだけ当てる。入力から正規表現は作らない。
// - 時刻: Gmail の店名（source: 'merchant'）で、時刻の分かる usedAt が渡され、飲食店のグループ（mealTime）に当たったときだけ、
//   JST の時刻で朝ご飯・昼ご飯・夜ご飯に置き換える。LINE の説明文（source: 'text'）には当てない
//   （入力した時刻は食べた時刻とは限らない）。飲み会・カフェ・コンビニ・自販機・デリバリーにも当てない。
// - 「その他の食費」「その他の娯楽」は返さない（手で選ぶためだけ。「判定できない」（null）と「利用者がその他にした」を分ける）。
// - 辞書は一般的な語と広く知られたチェーン名だけ。部分一致の語の決まり（smoke-subcategory.js で確かめる）:
//   1 文字の語は持たない／英数字だけの語は 4 文字以上／「マック」「バー」「スパ」は持たない（別の店・語に当たりやすい）。
//   短い語・別の語の一部になりやすい語（本・マック・スキー・釣り・イオンなど）は exact（全体の一致）にだけ置く
//   （例: 「ウイスキー」「お釣り」「銀座ライオン」に当てない）。
import { toCanonicalCategoryName } from './categoryNormalization';
import { SUB_CATEGORIES } from './categoryTaxonomy';
import { formatJST } from './time';

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
  /** 部分一致で照合する語（SUB_CATEGORY_RULES では normalizeForMatch 済み） */
  readonly keywords: readonly string[];
  /** 揃えた入力の全体と一致したときだけ当てる語（SUB_CATEGORY_RULES では normalizeForMatch 済み） */
  readonly exact?: readonly string[];
  /** 飲食店のグループ。Gmail の店名で時刻が分かれば、朝ご飯・昼ご飯・夜ご飯に置き換える */
  readonly mealTime?: true;
}

// 上から順に照合し、最初に当たったグループを採る（例: 「コンビニ ランチ」は昼ご飯、「コンビニ弁当」はコンビニ、
// 「ドライブ」は「ライブ」より先のレジャー・テーマパーク）。ローマ字は、カード会社の通知の店名がローマ字の大文字になる場合のため。
const RAW_RULES: Record<string, readonly SubCategoryRule[]> = {
  食費: [
    { sub: '朝ご飯', keywords: ['朝食', '朝ご飯', '朝ごはん', '朝飯', 'モーニング'] },
    { sub: '昼ご飯', keywords: ['ランチ', '昼食', '昼ご飯', '昼ごはん', '昼飯', 'お昼'] },
    {
      sub: '夜ご飯',
      keywords: ['夕食', '夕飯', '夕ご飯', '夕ごはん', '夜ご飯', '夜ごはん', '晩ご飯', '晩ごはん', '晩飯', 'ディナー'],
    },
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
        'seveneleven',
        'ローソン',
        'lawson',
        'ファミリーマート',
        'ファミマ',
        'familymart',
        'ミニストップ',
        'ministop',
        'デイリーヤマザキ',
        'dailyyamazaki',
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
        'ウーバー',
        'ウーバーイーツ',
        'ubereats',
        '出前館',
        'demaecan',
        'wolt',
        'テイクアウト',
        '持ち帰り',
        '弁当',
        '惣菜',
        'ピザーラ',
        'pizzala',
        'ドミノピザ',
        'dominos',
      ],
    },
    // 飲食店（Gmail の店名で時刻が分かれば、朝ご飯・昼ご飯・夜ご飯に置き換える）
    {
      sub: '外食',
      mealTime: true,
      keywords: [
        '外食',
        'レストラン',
        'restaurant',
        '食堂',
        '定食',
        'フードコート',
        '食べ放題',
        'ラーメン',
        'ramen',
        '製麺',
        'うどん',
        'そば',
        '蕎麦',
        '寿司',
        'すし',
        'スシ',
        'sushi',
        '焼肉',
        'yakiniku',
        '焼き鳥',
        '焼鳥',
        'とんかつ',
        'ステーキ',
        'ハンバーグ',
        'パスタ',
        'イタリアン',
        'カレー',
        '中華',
        '牛丼',
        '吉野家',
        'yoshinoya',
        'すき家',
        'sukiya',
        '松屋',
        'matsuya',
        'ファミレス',
        'ガスト',
        'gusto',
        'サイゼリヤ',
        'saizeriya',
        'マクドナルド',
        'mcdonald',
        'モスバーガー',
        'mosburger',
        'ケンタッキー',
        'kentucky',
        'バーガー',
        'burger',
      ],
      exact: ['マック', 'モス', 'kfc'],
    },
    {
      sub: '食料品（スーパー）',
      keywords: [
        'スーパー',
        'aeon',
        '西友',
        'seiyu',
        'イトーヨーカドー',
        'itoyokado',
        'まいばすけっと',
        '成城石井',
        'seijoishii',
        'マックスバリュ',
        'maxvalu',
        '生協',
        'コープ',
        '八百屋',
        '精肉',
        '鮮魚',
        'ベーカリー',
        'パン屋',
        '食料品',
        '食材',
        '食品',
        '野菜',
        '果物',
      ],
      exact: ['イオン'],
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
        'スポーツ',
        'アウトドア',
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
        'スノボ',
        'キャンプ',
        '登山',
        'プール',
        '観戦',
      ],
      exact: ['スキー', '釣り'],
    },
    {
      sub: 'レジャー・テーマパーク',
      // 「ディズニー」「disney」だけだと、動画配信の定期課金（ディズニープラスなど）にも当たるので、パークの名前にする
      keywords: [
        'テーマパーク',
        '遊園地',
        'ディズニーランド',
        'ディズニーシー',
        'tokyodisney',
        'ユニバーサル',
        '水族館',
        '動物園',
        '博物館',
        '美術館',
        'ドライブ',
      ],
    },
    {
      sub: 'ゲーム・課金',
      keywords: ['ゲーム', 'game', '課金', 'ガチャ', 'ゲーセン', 'nintendo', 'プレステ', 'playstation', 'steam'],
    },
    {
      sub: '本・漫画',
      keywords: ['書店', '本屋', '漫画', 'マンガ', 'コミック', '雑誌', '小説', '文庫', 'kindle', '電子書籍', '紀伊國屋', 'ブックオフ'],
      exact: ['本'],
    },
    {
      sub: '音楽・ライブ',
      keywords: ['ライブ', 'コンサート', 'フェス', 'カラオケ', 'karaoke', 'ビッグエコー', 'ジャンカラ', '音楽'],
    },
  ],
};

function prepareWords(words: readonly string[], where: string): readonly string[] {
  const normalized = words.map(normalizeForMatch);
  // 空の語は "".includes で何にでも当たるため、読み込みの時点で止める
  if (normalized.some((w) => w === '')) {
    throw new Error(`中項目の辞書に、揃えると空になる語がある: ${where}`);
  }
  return Object.freeze(normalized);
}

function prepareRules(raw: Record<string, readonly SubCategoryRule[]>): Readonly<Record<string, readonly SubCategoryRule[]>> {
  const out: Record<string, readonly SubCategoryRule[]> = {};
  for (const [major, groups] of Object.entries(raw)) {
    out[major] = Object.freeze(
      groups.map((group) => {
        const where = `${major}/${group.sub}`;
        const prepared: SubCategoryRule = {
          ...group,
          keywords: prepareWords(group.keywords, where),
          ...(group.exact ? { exact: prepareWords(group.exact, where) } : {}),
        };
        return Object.freeze(prepared);
      })
    );
  }
  return Object.freeze(out);
}

/** 中項目の辞書（大項目 → 順番つきのグループ。keywords・exact は normalizeForMatch 済み） */
export const SUB_CATEGORY_RULES = prepareRules(RAW_RULES);

export type MealSubCategory = '朝ご飯' | '昼ご飯' | '夜ご飯';

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * JST の時刻で、朝ご飯（05:00〜10:59）・昼ご飯（11:00〜16:59）・夜ご飯（17:00〜翌 04:59。深夜 0〜4 時は夜）を返す。
 * Date だけを受ける（タイムゾーンの無い文字列は、コンテナの TZ で読まれてずれるため受けない）。有効な Date でなければ null。
 */
export function mealOfJst(usedAt: Date): MealSubCategory | null {
  if (!isValidDate(usedAt)) return null;
  const hour = Number(formatJST(usedAt, 'H'));
  if (!Number.isInteger(hour)) return null;
  if (hour >= 5 && hour <= 10) return '朝ご飯';
  if (hour >= 11 && hour <= 16) return '昼ご飯';
  return '夜ご飯';
}

/**
 * 保存済みの利用日時に時刻があるか。保存済みのレコードしかない決め直し（LINE で大項目を変えたとき。expenseActions.ts の decideSetCategory）専用のフォールバック。
 * Gmail の取込は、メールに時刻が無いと JST の 00:00 にする（gmail/parser.ts）ので、JST の 00:00:00.000 ちょうどは時刻なしとみなす。
 * 日付の無いメールは処理した時刻が入るため、時刻なしと見分けられない（true になる）。取込の時点では、メールから時刻の有無を直接取って使う。
 * Date だけを受け、有効な Date でなければ false。
 */
export function usedAtHasClockTime(usedAt: Date): boolean {
  if (!isValidDate(usedAt)) return false;
  return formatJST(usedAt, 'HH:mm:ss.SSS') !== '00:00:00.000';
}

export interface ResolveSubCategoryInput {
  /** 大項目（toCanonicalCategoryName の完全一致で正準名にしてから見る） */
  major: string;
  /** LINE の説明文、または Gmail の店名 */
  text: string;
  source: 'text' | 'merchant';
  /**
   * 利用日時。**時刻が分かるときだけ渡す**（Gmail で時刻が取れたとき、または保存済みのレコードの再判定で
   * usedAtHasClockTime が true のとき）。時刻の無い日付（00:00 にしたもの）は渡さない。
   * Date だけを受ける（タイムゾーンの無い文字列は受けない。Firestore の Timestamp は toDate() してから渡す）。
   * Date でないもの・無効な Date は、時刻なしとして扱う。
   */
  usedAt?: Date | null;
}

/** 説明が「支出」だけ（LINE で説明もカテゴリも無いときの既定の説明。textParser.ts）なら判定しない */
const NO_INFO_TEXT = normalizeForMatch('支出');

function matches(group: SubCategoryRule, normalized: string): boolean {
  return (group.exact?.includes(normalized) ?? false) || group.keywords.some((k) => normalized.includes(k));
}

/**
 * 辞書と時刻のルールで中項目を決める。決められなければ null。投げない（引数が無い・null でも null を返す）。
 * - 大項目は toCanonicalCategoryName の完全一致だけを見る（別名は正準名にする。例: 「ランチ」→ 食費）。
 *   中項目の一覧に無い大項目（日用品・利用者のカスタム名など）は null。
 * - 説明が空・正準のカテゴリ名だけ（例: 「食費」）・「支出」だけなら null。
 * - 時刻のルールは、source が 'merchant' で、usedAt が有効な Date で、飲食店のグループに当たったときだけ当てる。
 * - 「その他の食費」「その他の娯楽」は返さない。
 */
export function resolveSubCategory(input?: ResolveSubCategoryInput | null): string | null {
  const { major, text, source, usedAt }: Partial<ResolveSubCategoryInput> = input ?? {};
  if (typeof major !== 'string') return null;
  const canonical = toCanonicalCategoryName(major);
  if (typeof canonical !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(SUB_CATEGORIES, canonical)) return null;
  if (!Object.prototype.hasOwnProperty.call(SUB_CATEGORY_RULES, canonical)) return null;

  const normalized = normalizeForMatch(text ?? '');
  if (normalized === '' || normalized === NO_INFO_TEXT || normalized === normalizeForMatch(canonical)) {
    return null;
  }

  const group = SUB_CATEGORY_RULES[canonical].find((g) => matches(g, normalized));
  if (!group) return null;

  let sub: string = group.sub;
  if (group.mealTime === true && source === 'merchant' && isValidDate(usedAt)) {
    sub = mealOfJst(usedAt) ?? sub;
  }
  return SUB_CATEGORIES[canonical].includes(sub) ? sub : null;
}
