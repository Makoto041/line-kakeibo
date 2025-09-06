import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAllUserCategories, CategoryMaster, UserCustomCategory } from './firestore';
import { normalizeCategoryName } from './categoryNormalization';

// Gemini APIクライアントの初期化
let genAI: GoogleGenerativeAI | null = null;

function getGeminiClient(): GoogleGenerativeAI | null {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('GEMINI_API_KEY not found in environment variables');
      return null;
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

interface GeminiClassificationResult {
  category: string | null;
  confidence: number; // 0-1の信頼度
  reasoning?: string; // 分類の理由（デバッグ用）
}

// デフォルトカテゴリリスト（Firestoreからの取得に失敗した場合のフォールバック）
const DEFAULT_CATEGORIES = [
  '食費',
  '交通費',
  '日用品',
  '娯楽',
  '衣服',
  '医療・健康',
  '教育',
  '光熱費',
  '住居費',
  '保険',
  '税金',
  '美容',
  '通信費',
  'サブスク',
  'プレゼント',
  '旅行',
  'ペット',
  '貯金',
  'その他',
];

// カテゴリキャッシュ（メモリ内、30分TTL）
const categoryCache = new Map<string, { categories: string[]; timestamp: number }>();
const CATEGORY_CACHE_TTL = 30 * 60 * 1000; // 30分

// カテゴリ分類結果キャッシュ（15分TTL）
const classificationCache = new Map<string, { result: GeminiClassificationResult; timestamp: number }>();
const CLASSIFICATION_CACHE_TTL = 15 * 60 * 1000; // 15分

// 高速ローカル分類のためのキーワードマップ
const FAST_KEYWORD_MAP: Record<string, string[]> = {
  '食費': ['食', 'レストラン', 'カフェ', 'ランチ', 'ディナー', '弁当', 'コンビニ', 'マクドナルド', 'スターバックス', '居酒屋', 'ラーメン', '寿司'],
  '交通費': ['電車', 'バス', 'タクシー', '地下鉄', '新幹線', '高速', 'ガソリン', 'JR', '運賃', '切符'],
  '日用品': ['ティッシュ', '洗剤', 'シャンプー', '歯ブラシ', 'タオル', '石鹸', 'トイレットペーパー', '掃除', '洗濯'],
  '娯楽': ['映画', 'ゲーム', 'カラオケ', 'ボウリング', '遊園地', 'コンサート', 'ライブ', '本', 'DVD'],
  '衣服': ['服', '靴', '帽子', 'バッグ', 'アクセサリー', 'ユニクロ', 'しまむら', 'Tシャツ', 'ジーンズ'],
  '医療・健康': ['病院', '薬', '歯医者', 'サプリメント', '整体', 'マッサージ', 'ジム', '健康診断'],
  '通信費': ['携帯', 'インターネット', 'Wi-Fi', 'スマホ', '電話代', 'データ'],
  '光熱費': ['電気', 'ガス', '水道'],
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
 * 最適化されたカテゴリ分類（ローカル判定 + キャッシュ + Gemini）
 */
export async function classifyExpenseWithGemini(
  lineId: string, 
  description: string
): Promise<GeminiClassificationResult> {
  // キャッシュキー
  const cacheKey = `${lineId}_${description.toLowerCase().trim()}`;
  
  // 分類結果キャッシュをチェック
  const cached = classificationCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CLASSIFICATION_CACHE_TTL)) {
    console.log(`Cache hit for classification: "${description}" -> ${cached.result.category}`);
    return cached.result;
  }
  
  // 1. 高速ローカル分類を最初に試行
  const localResult = fastLocalClassification(description);
  if (localResult.category) {
    const result = {
      category: localResult.category,
      confidence: localResult.confidence,
      reasoning: 'Fast local keyword matching'
    };
    
    // 結果をキャッシュ
    classificationCache.set(cacheKey, { result, timestamp: Date.now() });
    console.log(`Fast local classification: "${description}" -> ${result.category} (confidence: ${result.confidence})`);
    return result;
  }

  // 2. Gemini APIでの詳細分類（ローカルで分類できない場合のみ）
  try {
    const client = getGeminiClient();
    if (!client) {
      return { category: null, confidence: 0 };
    }

    // カテゴリキャッシュをチェック
    let categoryNames: string[] = [];
    const categoryCached = categoryCache.get(lineId);
    if (categoryCached && (Date.now() - categoryCached.timestamp < CATEGORY_CACHE_TTL)) {
      categoryNames = categoryCached.categories;
      console.log(`Using cached categories for user ${lineId} (${categoryNames.length} categories)`);
    } else {
      // カテゴリを取得してキャッシュ
      try {
        const availableCategories = await getAllUserCategories(lineId);
        categoryNames = availableCategories.map((cat: CategoryMaster | UserCustomCategory) => cat.name);
        
        // キャッシュに保存
        categoryCache.set(lineId, { categories: categoryNames, timestamp: Date.now() });
        console.log(`Fetched and cached ${categoryNames.length} categories for user ${lineId}`);
      } catch (firestoreError) {
        console.warn('Failed to get categories from Firestore, using default categories:', firestoreError);
        categoryNames = DEFAULT_CATEGORIES;
      }
      
      if (categoryNames.length === 0) {
        console.warn('No categories available, using default categories');
        categoryNames = DEFAULT_CATEGORIES;
      }
    }
    
    // Geminiモデルを取得
    const model = client.getGenerativeModel({ model: "gemini-1.5-flash" });

    // 短縮化されたプロンプト（レスポンス時間短縮のため）
    const prompt = `分類: "${description}"
カテゴリ: ${categoryNames.slice(0, 10).join(', ')}...
JSON形式で回答: {"category":"カテゴリ名","confidence":0.8}`;

    // Gemini APIを呼び出し（タイムアウト付き）
    const geminiPromise = model.generateContent(prompt);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Gemini API timeout')), 3000) // 3秒タイムアウト
    );

    const result = await Promise.race([geminiPromise, timeoutPromise]) as any;
    const response = result.response;
    const text = response.text().trim();

    console.log(`Gemini Classification - Input: "${description}", Response: ${text}`);

    // JSONレスポンスをパース（Markdownコードブロック形式の場合も対応）
    try {
      let jsonText = text;
      
      // Markdownコードブロック形式の場合（```json ... ```）を処理
      if (text.startsWith('```json') && text.endsWith('```')) {
        jsonText = text.replace(/^```json\s*\n/, '').replace(/\n\s*```$/, '').trim();
        console.log(`Extracted JSON from markdown: ${jsonText}`);
      } else if (text.startsWith('```') && text.endsWith('```')) {
        // 一般的なコードブロック形式も処理
        jsonText = text.replace(/^```\s*\n/, '').replace(/\n\s*```$/, '').trim();
        console.log(`Extracted JSON from code block: ${jsonText}`);
      }
      
      const parsed = JSON.parse(jsonText);
      
      // 正規化してから、利用可能なカテゴリに合わせる
      const normalized = normalizeCategoryName(parsed.category, categoryNames);
      if (normalized) {
        const result = {
          category: normalized,
          confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
          reasoning: parsed.reasoning || 'Gemini AI classification'
        };
        
        // 結果をキャッシュ
        classificationCache.set(cacheKey, { result, timestamp: Date.now() });
        console.log(`Gemini classification cached: "${description}" -> ${result.category}`);
        
        updateClassificationStats(true, result.confidence);
        return result;
      }
      console.warn(`Gemini suggested invalid category: ${parsed.category}`);
      updateClassificationStats(false, 0);
      return { category: null, confidence: 0 };
    } catch (parseError) {
      console.error('Failed to parse Gemini response as JSON:', parseError);
      console.error('Raw response:', text);
      updateClassificationStats(false, 0);
      return { category: null, confidence: 0 };
    }

  } catch (error) {
    console.error('Gemini API classification error:', error);
    updateClassificationStats(false, 0);
    
    // タイムアウトまたはAPI障害の場合、フォールバックとしてユーザーデフォルトを返す
    if (error instanceof Error && error.message?.includes('timeout')) {
      console.log('Gemini timeout, falling back to default category');
    }
    
    return { category: null, confidence: 0 };
  }
}

/**
 * Gemini APIベースの高度なカテゴリ検出（フォールバック付き）
 */
export async function findCategoryWithGemini(
  lineId: string, 
  description: string
): Promise<CategoryMaster | UserCustomCategory | null> {
  try {
    // Gemini APIで分類を試行
    const geminiResult = await classifyExpenseWithGemini(lineId, description);
    
    // 信頼度が十分高い場合はGeminiの結果を使用
    if (geminiResult.category && geminiResult.confidence >= 0.6) {
      console.log(`Gemini classification success: ${geminiResult.category} (confidence: ${geminiResult.confidence})`);
      
      // カテゴリ名から実際のカテゴリオブジェクトを取得
      const availableCategories = await getAllUserCategories(lineId);
      const matchedCategory = availableCategories.find((cat: CategoryMaster | UserCustomCategory) => cat.name === geminiResult.category);
      
      if (matchedCategory) {
        return matchedCategory;
      }
    }
    
    console.log(`Gemini classification failed or low confidence: ${geminiResult.confidence}, falling back to keywords`);
    return null;
    
  } catch (error) {
    console.error('Error in Gemini category classification:', error);
    return null;
  }
}

/**
 * 分類の統計情報を取得（デバッグ・分析用）
 */
export interface ClassificationStats {
  totalAttempts: number;
  geminiSuccessCount: number;
  fallbackCount: number;
  averageConfidence: number;
}

// 簡単な統計トラッキング（メモリ内）
let classificationStats: ClassificationStats = {
  totalAttempts: 0,
  geminiSuccessCount: 0,
  fallbackCount: 0,
  averageConfidence: 0
};

export function updateClassificationStats(success: boolean, confidence: number) {
  classificationStats.totalAttempts++;
  if (success) {
    classificationStats.geminiSuccessCount++;
    const totalConf = classificationStats.averageConfidence * (classificationStats.geminiSuccessCount - 1) + confidence;
    classificationStats.averageConfidence = totalConf / classificationStats.geminiSuccessCount;
  } else {
    classificationStats.fallbackCount++;
  }
}

export function getClassificationStats(): ClassificationStats {
  return { ...classificationStats };
}

/**
 * Geminiの利用可能性をチェック
 */
export function isGeminiAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY;
}
