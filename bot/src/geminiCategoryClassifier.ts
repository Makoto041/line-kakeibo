import { getAllUserCategories, CategoryMaster, UserCustomCategory } from './firestore';
import { CANONICAL_CATEGORIES, normalizeCategoryName } from './categoryNormalization';
import { generateJson, isGeminiConfigured, Type, type Schema } from './geminiClient';
import { maskId } from './logSafe';

export interface GeminiClassificationResult {
  category: string | null;
  confidence: number; // 0-1の信頼度
  reasoning?: string; // 分類の理由（デバッグ用）
}

// デフォルトカテゴリリスト（Firestoreからの取得に失敗した場合のフォールバック）
const DEFAULT_CATEGORIES = CANONICAL_CATEGORIES;

// カテゴリキャッシュ（メモリ内、30分TTL）
const categoryCache = new Map<string, { categories: string[]; timestamp: number }>();
const CATEGORY_CACHE_TTL = 30 * 60 * 1000; // 30分

// カテゴリ分類結果キャッシュ（15分TTL）
const classificationCache = new Map<string, { result: GeminiClassificationResult; timestamp: number }>();
const CLASSIFICATION_CACHE_TTL = 15 * 60 * 1000; // 15分

// 高速ローカル分類のためのキーワードマップ
// 注: 上から順に部分一致(includes)で評価され、最初に一致したカテゴリを採用する。
// 取り違えやすい語は、より具体的なカテゴリを上に置いて優先させている。
const FAST_KEYWORD_MAP: Record<string, string[]> = {
  '食費': [
    '食', 'レストラン', 'カフェ', '喫茶', 'ランチ', 'ディナー', '弁当', '惣菜', 'コンビニ',
    'セブン', 'ローソン', 'ファミマ', 'ファミリーマート', 'スーパー', 'イオン', '業務スーパー',
    'マクドナルド', 'マック', 'スタバ', 'スターバックス', 'ドトール', '居酒屋', 'ラーメン',
    '寿司', 'すし', '焼肉', '牛丼', '吉野家', 'すき家', '松屋', 'ケンタッキー', 'モスバーガー',
    'ピザ', 'パン', 'ベーカリー', 'ケーキ', 'スイーツ', 'お菓子', 'おやつ', 'ジュース',
    'ビール', '酒', 'ワイン', '居酒', 'そば', 'うどん', 'カレー', '定食', 'テイクアウト',
    'デリバリー', 'ウーバー', 'uber', '出前', '食料品', '食品', '夕食', '朝食', '昼食',
    '食事', '飲食', '肉', '野菜', '果物', '米', '飲み物',
  ],
  '旅行': [
    '旅行', '旅費', 'ホテル', '宿泊', '宿', '旅館', '民宿', 'ゲストハウス', 'ツアー', '観光',
    '温泉', '海外旅行', '国内旅行', 'パッケージツアー', 'airbnb', 'じゃらん', '楽天トラベル',
  ],
  '交通費': [
    '電車', 'バス', 'タクシー', '地下鉄', '新幹線', '特急', '高速', '高速代', 'ガソリン', '給油',
    'jr', '私鉄', '運賃', '切符', '定期', '定期券', '駐車', 'パーキング', 'etc', 'suica', 'スイカ',
    'pasmo', 'パスモ', 'icoca', 'レンタカー', '航空券', '飛行機', 'フライト', '空港', 'モノレール',
  ],
  '美容': [
    '美容院', '美容室', '床屋', '理容', 'カット', 'カラーリング', 'パーマ', 'ネイル', 'まつげ',
    'まつ毛', 'エステ', '脱毛', '化粧品', 'コスメ', '化粧水', '乳液', '口紅', 'リップ',
    'ファンデ', 'マニキュア', 'スキンケア', '香水', '日焼け止め', '美容液',
  ],
  '日用品': [
    'ティッシュ', '洗剤', 'シャンプー', 'リンス', 'コンディショナー', '歯ブラシ', 'タオル', '石鹸',
    'せっけん', 'トイレットペーパー', '掃除', '洗濯', 'ボディソープ', '歯磨き粉', 'ハンドソープ',
    'キッチンペーパー', 'ラップ', 'ゴミ袋', '電池', '乾電池', 'マスク', '綿棒', '生理用品',
    '消耗品', '日用品', 'ドラッグストア', 'マツキヨ', 'マツモトキヨシ', 'ウエルシア', '100均',
    'ダイソー', 'セリア', '柔軟剤', '芳香剤',
  ],
  '衣服': [
    '服', '靴', '帽子', 'バッグ', 'アクセサリー', 'ユニクロ', 'gu', 'しまむら', 'zara', 'h&m',
    'tシャツ', 'シャツ', 'ジーンズ', 'パンツ', 'スカート', 'ワンピース', 'コート', 'ジャケット',
    'ニット', 'セーター', '洋服', 'スニーカー', '下着', '靴下', 'ベルト', '財布', '古着',
    'スーツ', 'ネクタイ', 'クリーニング',
  ],
  '医療・健康': [
    '病院', '薬', '歯医者', '歯科', 'サプリ', 'サプリメント', '整体', 'マッサージ', 'ジム',
    '健康診断', '処方', '処方箋', '医療', '診察', '通院', '入院', '内科', '外科', '皮膚科',
    '眼科', '風邪薬', '鎮痛剤', '絆創膏', 'プロテイン', '接骨院', '鍼', 'コンタクト', '人間ドック',
  ],
  '教育': [
    '塾', '予備校', '授業料', '受講', '講座', 'セミナー', '受験', '資格', '参考書', '教材',
    '教科書', '問題集', '文房具', 'ノート', '学費', '入学金', '習い事', '英会話', 'スクール',
    '辞書', '受講料', '月謝',
  ],
  'ペット': [
    'ペット', 'ドッグフード', 'キャットフード', 'ペットフード', '猫砂', 'トリミング', '動物病院',
    'ペット用品', '餌', 'えさ',
  ],
  '娯楽': [
    '映画', 'ゲーム', 'カラオケ', 'ボウリング', '遊園地', 'テーマパーク', 'ディズニー', 'usj',
    '水族館', '動物園', 'コンサート', 'ライブ', 'フェス', '本', 'dvd', 'ぬいぐるみ', 'おもちゃ',
    '漫画', 'マンガ', '雑誌', '趣味', '娯楽', 'チケット', '入場料', '釣り', 'ゴルフ', 'パチンコ',
    '課金', 'ガチャ', '飲み会', '二次会', 'ボードゲーム',
  ],
  'サブスク': [
    'サブスク', 'netflix', 'ネトフリ', 'spotify', 'スポティファイ', 'amazonプライム', 'プライム',
    'youtube premium', 'hulu', 'disney+', 'ディズニープラス', 'icloud', 'apple music',
    '月額', '定額', '月会費', '会費', 'adobe', 'chatgpt', 'dazn', 'u-next',
  ],
  '通信費': [
    '携帯', '携帯代', 'インターネット', 'wi-fi', 'wifi', 'スマホ代', 'スマホ', '電話代', 'データ',
    '通信', '光回線', 'プロバイダ', 'docomo', 'ドコモ', 'au', 'ソフトバンク', '楽天モバイル',
    '格安sim', 'sim', 'ワイモバイル', 'uqモバイル',
  ],
  '光熱費': ['電気', '電気代', 'ガス', 'ガス代', '水道', '水道代', '光熱'],
  '住居費': [
    '家賃', '管理費', '共益費', '住宅ローン', '敷金', '礼金', '更新料', '引越', '引っ越し',
    '不動産', '家具', '家電', 'ソファ', 'ベッド', 'カーテン', '冷蔵庫', '洗濯機', '電子レンジ',
    'エアコン', 'ニトリ', 'ikea', 'イケア', '修繕', 'リフォーム',
  ],
  '保険': [
    '保険', '生命保険', '医療保険', '自動車保険', '火災保険', '地震保険', '保険料', 'がん保険', '共済',
  ],
  '税金': [
    '税金', '住民税', '所得税', '固定資産税', '自動車税', '年金', '国民年金', 'ふるさと納税', '納税',
  ],
  'プレゼント': [
    'プレゼント', 'ギフト', '贈り物', 'お祝い', '誕生日', 'クリスマス', 'バレンタイン', 'お年玉',
    '香典', 'ご祝儀', '花束', 'お土産', 'おみやげ',
  ],
  '貯金': [
    '貯金', '積立', 'つみたて', '投資', '預金', 'nisa', 'ideco', '投信', '投資信託',
  ],
};

/**
 * 高速ローカルカテゴリ判定（キーワードベース）
 */
function fastLocalClassification(description: string): { category: string | null; confidence: number } {
  const desc = description.toLowerCase();
  
  for (const [category, keywords] of Object.entries(FAST_KEYWORD_MAP)) {
    for (const keyword of keywords) {
      if (desc.includes(keyword.toLowerCase())) {
        return { category, confidence: 0.8 }; // 高い信頼度
      }
    }
  }
  
  return { category: null, confidence: 0 };
}

/**
 * 分類する文字列の種類。
 * - text: LINE で利用者が打った内容（「500 ランチ」の「ランチ」）。短い日本語が多く、キーワード辞書がよく当たる
 * - merchant: カード利用通知の店名（「ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ」「AMAZON.CO.JP」など）。半角カナ・ローマ字・略称が多く、
 *   部分一致のキーワード辞書は取り違えやすい（例: "au" "gu" "etc" "sim" "パン" が店名の一部に一致する）
 */
export type ClassificationSource = 'text' | 'merchant';

export interface ClassifyOptions {
  source?: ClassificationSource;
}

const GEMINI_TIMEOUT_MS = 8000;

/** 各カテゴリの判断基準（プロンプト用）。CANONICAL_CATEGORIES にあるものは全て説明する */
const CATEGORY_GUIDE: Record<string, string> = {
  '食費': '食材、外食、カフェ、コンビニ・スーパーでの買い物、飲み物、デリバリー',
  '交通費': '電車、バス、タクシー、新幹線、ガソリン、駐車場、高速料金(ETC)、レンタカー',
  '日用品': '洗剤、ティッシュ、シャンプーなどの消耗品、ドラッグストア・100円ショップ・ホームセンターの買い物',
  '娯楽': '映画、ゲーム、書籍、漫画、おもちゃ、カラオケ、ライブ、趣味用品',
  '衣服': '服、靴、バッグ、アクセサリー、クリーニング',
  '医療・健康': '病院、歯科、薬、サプリ、ジム、整体',
  '教育': '学費、塾、習い事、参考書、講座、資格試験',
  '光熱費': '電気、ガス、水道',
  '住居費': '家賃、管理費、家具、家電、修繕',
  '保険': '生命保険、医療保険、自動車保険、火災保険',
  '税金': '住民税、所得税、自動車税、年金、ふるさと納税',
  '美容': '美容院、ネイル、化粧品、エステ、脱毛',
  '通信費': '携帯電話料金、インターネット回線、プロバイダ',
  'サブスク': '月額の動画・音楽配信やクラウドサービス（Netflix、Spotify、Amazon プライム会費、iCloud など）',
  'プレゼント': '贈り物、お祝い、お土産、ご祝儀',
  '旅行': 'ホテル・旅館などの宿泊、ツアー、旅行予約サイト',
  'ペット': 'ペットフード、ペット用品、動物病院、トリミング',
  '貯金': '貯金、積立、投資',
  'その他': 'どれにも当てはまらない、または店名だけでは判断できないもの',
};

const TEXT_EXAMPLES = `入力: "ランチ" → {"category":"食費","confidence":0.95}
入力: "洗剤" → {"category":"日用品","confidence":0.95}
入力: "電車賃" → {"category":"交通費","confidence":0.95}
入力: "ぬいぐるみ" → {"category":"娯楽","confidence":0.9}
入力: "風邪薬" → {"category":"医療・健康","confidence":0.95}
入力: "電気代" → {"category":"光熱費","confidence":0.95}`;

const MERCHANT_EXAMPLES = `入力: "ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ" → {"category":"食費","confidence":0.85}
入力: "ｲｵﾝﾓｰﾙ" → {"category":"食費","confidence":0.6}
入力: "AMAZON.CO.JP" → {"category":"その他","confidence":0.4}
入力: "AMAZON PRIME ｶｲﾋ" → {"category":"サブスク","confidence":0.9}
入力: "NETFLIX.COM" → {"category":"サブスク","confidence":0.95}
入力: "ETC ﾘﾖｳ" → {"category":"交通費","confidence":0.9}
入力: "ENEOS" → {"category":"交通費","confidence":0.85}
入力: "ﾕﾆｸﾛ" → {"category":"衣服","confidence":0.9}
入力: "ﾏﾂﾓﾄｷﾖｼ" → {"category":"日用品","confidence":0.8}
入力: "東京電力ｴﾅｼﾞｰﾊﾟｰﾄﾅｰ" → {"category":"光熱費","confidence":0.95}
入力: "ｿﾌﾄﾊﾞﾝｸ" → {"category":"通信費","confidence":0.9}`;

/** Gemini に渡すプロンプトを組み立てる（テスト用に公開） */
export function buildClassificationPrompt(
  description: string,
  categoryNames: string[],
  source: ClassificationSource
): string {
  const guide = categoryNames
    .map((name) => `- ${name}${CATEGORY_GUIDE[name] ? `: ${CATEGORY_GUIDE[name]}` : ''}`)
    .join('\n');
  const subject =
    source === 'merchant'
      ? 'クレジットカードの利用明細に載った「店名・加盟店名」です。半角カナ、ローマ字、略称、支店名が混ざることがあります。店の業態から、この家計で一番ありそうな支出カテゴリを選んでください。総合通販・百貨店など店名だけで中身が決まらないものは「その他」にし、confidence を低くしてください。'
      : '家計簿アプリに利用者が入力した支出の内容です。';
  return `あなたは家計簿の支出分類の専門家です。次の文字列は${subject}

## カテゴリ（この中から 1 つだけ選ぶ）
${guide}

## 例
${source === 'merchant' ? MERCHANT_EXAMPLES : TEXT_EXAMPLES}

## 分類する文字列
${JSON.stringify(description)}

category はカテゴリ一覧の名前と完全に一致させてください。confidence は 0〜1 の数値です。`;
}

function classificationSchema(categoryNames: string[]): Schema {
  return {
    type: Type.OBJECT,
    properties: {
      category: { type: Type.STRING, enum: categoryNames },
      confidence: { type: Type.NUMBER },
    },
    required: ['category', 'confidence'],
    propertyOrdering: ['category', 'confidence'],
  };
}

async function categoriesFor(lineId: string): Promise<string[]> {
  const cached = categoryCache.get(lineId);
  if (cached && Date.now() - cached.timestamp < CATEGORY_CACHE_TTL) {
    return cached.categories;
  }
  let names: string[] = [];
  try {
    const available = await getAllUserCategories(lineId);
    names = available.map((cat: CategoryMaster | UserCustomCategory) => cat.name);
  } catch (error) {
    console.warn('Failed to get categories from Firestore, using default categories', {
      user: maskId(lineId),
      error: (error as Error)?.message,
    });
  }
  if (names.length === 0) names = [...DEFAULT_CATEGORIES];
  const unique = [...new Set(names)];
  categoryCache.set(lineId, { categories: unique, timestamp: Date.now() });
  return unique;
}

/** Gemini で分類する。使えない・失敗・一覧に無いカテゴリを返したときは null */
async function classifyWithGemini(
  lineId: string,
  description: string,
  source: ClassificationSource
): Promise<GeminiClassificationResult | null> {
  if (!isGeminiConfigured()) return null;
  const categoryNames = await categoriesFor(lineId);
  const parsed = await generateJson<{ category?: unknown; confidence?: unknown }>(
    buildClassificationPrompt(description, categoryNames, source),
    { schema: classificationSchema(categoryNames), timeoutMs: GEMINI_TIMEOUT_MS }
  );
  if (!parsed || typeof parsed.category !== 'string') return null;
  // スキーマで一覧に限定しているが、万一一覧外が返ったときは採用せずキャッシュもしない
  // （normalizeCategoryName は一覧外を「その他」に寄せてしまうため、その前に弾く）
  if (!categoryNames.includes(parsed.category)) {
    console.warn('Gemini suggested a category outside the list');
    return null;
  }
  const normalized = normalizeCategoryName(parsed.category, categoryNames);
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
  return {
    category: normalized,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning: 'Gemini classification',
  };
}

/**
 * 支出のカテゴリを判定する（キャッシュ + キーワード辞書 + Gemini）。
 *
 * - source='text'（LINE の入力）: キャッシュ → キーワード辞書 → Gemini の順。辞書で決まれば API を呼ばない
 * - source='merchant'（カード利用通知の店名）: キャッシュ → Gemini → キーワード辞書の順。
 *   店名は辞書の部分一致で取り違えやすいため Gemini を優先し、Gemini が使えないときだけ辞書に頼る
 *
 * どれでも決まらなければ { category: null }（呼び出し側で「その他」にする）。
 */
export async function classifyExpenseWithGemini(
  lineId: string,
  description: string,
  options: ClassifyOptions = {}
): Promise<GeminiClassificationResult> {
  const source: ClassificationSource = options.source ?? 'text';
  const cacheKey = `${source}_${lineId}_${description.toLowerCase().trim()}`;

  const cached = classificationCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CLASSIFICATION_CACHE_TTL) {
    return cached.result;
  }

  const remember = (result: GeminiClassificationResult) => {
    classificationCache.set(cacheKey, { result, timestamp: Date.now() });
    return result;
  };
  const byKeyword = (): GeminiClassificationResult | null => {
    const local = fastLocalClassification(description);
    return local.category
      ? { category: local.category, confidence: local.confidence, reasoning: 'Fast local keyword matching' }
      : null;
  };

  if (source === 'merchant') {
    const gemini = await classifyWithGemini(lineId, description, source);
    if (gemini) return remember(gemini);
    const local = byKeyword();
    // Gemini が使えなかった結果はキャッシュしない（復旧後に Gemini で判定し直せるように）
    return local ?? { category: null, confidence: 0 };
  }

  const local = byKeyword();
  if (local) return remember(local);
  const gemini = await classifyWithGemini(lineId, description, source);
  return gemini ? remember(gemini) : { category: null, confidence: 0 };
}

/**
 * Geminiの利用可能性をチェック
 */
export function isGeminiAvailable(): boolean {
  return isGeminiConfigured();
}
