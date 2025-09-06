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


/**
 * Gemini APIを使って支出説明からカテゴリを自動分類
 */
export async function classifyExpenseWithGemini(
  lineId: string, 
  description: string
): Promise<GeminiClassificationResult> {
  try {
    const client = getGeminiClient();
    if (!client) {
      return { category: null, confidence: 0 };
    }

    // ユーザーの利用可能なカテゴリを取得（フォールバック付き）
    let categoryNames: string[] = [];
    try {
      const availableCategories = await getAllUserCategories(lineId);
      categoryNames = availableCategories.map((cat: CategoryMaster | UserCustomCategory) => cat.name);
      console.log(`Retrieved ${categoryNames.length} categories from Firestore for user ${lineId}`);
    } catch (firestoreError) {
      console.warn('Failed to get categories from Firestore, using default categories:', firestoreError);
      categoryNames = DEFAULT_CATEGORIES;
    }
    
    if (categoryNames.length === 0) {
      console.warn('No categories available, using default categories');
      categoryNames = DEFAULT_CATEGORIES;
    }
    
    // Geminiモデルを取得
    const model = client.getGenerativeModel({ model: "gemini-1.5-flash" });

    // プロンプトを構築
    const prompt = `
あなたは家計簿のカテゴリ分類の専門家です。以下の支出説明を最も適切なカテゴリに分類してください。

支出説明: "${description}"

利用可能なカテゴリ:
${categoryNames.map((name: string) => `- ${name}`).join('\n')}

以下のJSON形式で回答してください（JSON以外の文字は含めないでください）:
{
  "category": "最適なカテゴリ名",
  "confidence": 0.85,
  "reasoning": "分類の理由を簡潔に"
}

分類のガイドライン:
- 説明文から最も関連性の高いカテゴリを選択
- どのカテゴリにも該当しない場合は "その他" を選択
- confidence は 0.0 から 1.0 の値で、分類の確信度を表す
- 曖昧な場合は confidence を低くする
`;

    // Gemini APIを呼び出し
    const result = await model.generateContent(prompt);
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
