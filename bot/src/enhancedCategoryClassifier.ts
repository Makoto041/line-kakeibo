import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAllUserCategories, CategoryMaster, UserCustomCategory, getUserCategoryFeedback, CategoryFeedback, recordCategoryFeedback } from './firestore';
import dayjs from 'dayjs';

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

// 強化された分類コンテキスト
export interface EnhancedClassificationContext {
  description: string;
  amount: number;
  storeName?: string;
  timestamp?: Date;
  location?: string;
  previousCategories?: string[];
  ocrText?: string;
}

// 分類結果の詳細
export interface ClassificationResult {
  category: string | null;
  confidence: number;
  reasoning?: string;
  suggestedCategories?: Array<{
    name: string;
    confidence: number;
  }>;
}

// 店舗名パターンとカテゴリのマッピング
const STORE_CATEGORY_PATTERNS: Record<string, string> = {
  // 食費関連
  'スーパー|マーケット|イオン|セブンイレブン|ローソン|ファミリーマート|コンビニ': '食費',
  'マクドナルド|ケンタッキー|モスバーガー|吉野家|すき家|松屋': '食費',
  'スタバ|ドトール|タリーズ|コメダ|星乃珈琲': '食費',
  // 交通費関連
  'JR|私鉄|地下鉄|バス|タクシー|UBER': '交通費',
  'ガソリン|エネオス|コスモ|出光': '交通費',
  // 日用品関連
  'ドラッグ|薬局|マツキヨ|ウエルシア|ツルハ': '日用品',
  '100均|ダイソー|セリア|キャンドゥ': '日用品',
  'ホームセンター|カインズ|コメリ': '日用品',
  // 衣服関連
  'ユニクロ|GU|しまむら|ZARA|H&M': '衣服',
  // 美容関連
  '美容院|理容室|ヘアサロン|ネイル|エステ': '美容・理容',
  // 医療関連
  '病院|クリニック|診療所|歯科|薬局（処方箋）': '医療費',
  // 娯楽関連
  '映画|シネマ|カラオケ|ゲーム|ボウリング': '娯楽費',
  'Amazon|楽天|メルカリ': '娯楽費',
};

// 金額帯によるカテゴリ推定のヒント
const AMOUNT_HINTS: Array<{ min: number; max: number; likelyCategories: string[] }> = [
  { min: 100, max: 500, likelyCategories: ['食費', '日用品'] },
  { min: 500, max: 2000, likelyCategories: ['食費', '日用品', '交通費'] },
  { min: 2000, max: 5000, likelyCategories: ['食費', '衣服', '娯楽費'] },
  { min: 5000, max: 10000, likelyCategories: ['衣服', '美容・理容', '医療費'] },
  { min: 10000, max: 50000, likelyCategories: ['医療費', '教育費', '住居費'] },
  { min: 50000, max: 999999, likelyCategories: ['住居費', '保険', '教育費'] },
];

// 時間帯によるカテゴリ推定のヒント
const TIME_HINTS: Array<{ startHour: number; endHour: number; likelyCategories: string[] }> = [
  { startHour: 6, endHour: 9, likelyCategories: ['食費', '交通費'] },
  { startHour: 11, endHour: 14, likelyCategories: ['食費'] },
  { startHour: 17, endHour: 21, likelyCategories: ['食費', '日用品'] },
  { startHour: 21, endHour: 24, likelyCategories: ['娯楽費', '食費'] },
];

/**
 * コンテキストを考慮した強化されたカテゴリ分類
 */
export async function classifyWithContext(
  lineId: string,
  context: EnhancedClassificationContext
): Promise<ClassificationResult> {
  try {
    const client = getGeminiClient();
    if (!client) {
      return fallbackClassification(context);
    }

    const availableCategories = await getAllUserCategories(lineId);
    const categoryNames = availableCategories.map(cat => cat.name);
    const userFeedbackHistory = await getUserCategoryFeedback(lineId, 10);
    
    const learningPatterns = buildLearningPatterns(userFeedbackHistory);
    const contextHints = buildContextHints(context);
    
    const model = client.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
あなたは日本の家計簿のカテゴリ分類の専門家です。以下の支出情報を最も適切なカテゴリに分類してください。

## 支出情報
- 説明: "${context.description}"
- 金額: ¥${context.amount.toLocaleString()}
${context.storeName ? `- 店舗名: "${context.storeName}"` : ''}
${context.ocrText ? `- OCR抽出テキスト: "${context.ocrText}"` : ''}
${context.timestamp ? `- 購入時刻: ${dayjs(context.timestamp).format('HH:mm')}` : ''}

## 利用可能なカテゴリ
${categoryNames.map(name => `- ${name}`).join('\n')}

## 分類のヒント
${contextHints}

${learningPatterns ? `## ユーザーの分類傾向\n${learningPatterns}` : ''}

## 分類ガイドライン
1. 店舗名が分かる場合は、その業態から最も適切なカテゴリを推定
2. 金額帯から妥当性を検証
3. 時間帯のコンテキストも考慮
4. 複数の候補がある場合は、代替案も提供
5. 確信度が低い場合は正直に低い confidence 値を設定

以下のJSON形式で回答してください：
{
  "category": "最適なカテゴリ名",
  "confidence": 0.85,
  "reasoning": "分類の理由を日本語で簡潔に説明",
  "suggestedCategories": [
    {"name": "代替カテゴリ1", "confidence": 0.60},
    {"name": "代替カテゴリ2", "confidence": 0.40}
  ]
}
`;

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text().trim();

    console.log(`Enhanced Classification - Input: "${context.description}", Amount: ${context.amount}, Response: ${text}`);

    try {
      const parsed = JSON.parse(text);
      
      if (parsed.category && categoryNames.includes(parsed.category)) {
        return {
          category: parsed.category,
          confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
          reasoning: parsed.reasoning || 'AI による自動分類',
          suggestedCategories: parsed.suggestedCategories?.filter(
            (cat: any) => categoryNames.includes(cat.name)
          )
        };
      } else {
        console.warn(`Gemini suggested invalid category: ${parsed.category}`);
        return fallbackClassification(context);
      }
    } catch (parseError) {
      console.error('Failed to parse Gemini response as JSON:', parseError);
      return fallbackClassification(context);
    }

  } catch (error) {
    console.error('Enhanced classification error:', error);
    return fallbackClassification(context);
  }
}

/**
 * コンテキストヒントの構築
 */
function buildContextHints(context: EnhancedClassificationContext): string {
  const hints: string[] = [];
  
  const amountHint = AMOUNT_HINTS.find(h => context.amount >= h.min && context.amount <= h.max);
  if (amountHint) {
    hints.push(`- 金額¥${context.amount}は通常「${amountHint.likelyCategories.join('、')}」に多い金額帯`);
  }
  
  if (context.timestamp) {
    const hour = context.timestamp.getHours();
    const timeHint = TIME_HINTS.find(h => hour >= h.startHour && hour < h.endHour);
    if (timeHint) {
      hints.push(`- ${hour}時台の購入は「${timeHint.likelyCategories.join('、')}」の可能性が高い`);
    }
  }
  
  if (context.storeName) {
    for (const [pattern, category] of Object.entries(STORE_CATEGORY_PATTERNS)) {
      if (new RegExp(pattern, 'i').test(context.storeName)) {
        hints.push(`- 店舗名「${context.storeName}」は通常「${category}」カテゴリ`);
        break;
      }
    }
  }
  
  return hints.join('\n');
}

/**
 * ユーザーのフィードバック履歴から学習パターンを構築
 */
function buildLearningPatterns(feedbackHistory?: CategoryFeedback[]): string | null {
  if (!feedbackHistory || feedbackHistory.length === 0) {
    return null;
  }
  
  const recentFeedback = feedbackHistory.slice(0, 10);
  const patterns: string[] = [];
  
  const corrections: Record<string, string[]> = {};
  recentFeedback.forEach(fb => {
    if (!corrections[fb.originalCategory]) {
      corrections[fb.originalCategory] = [];
    }
    corrections[fb.originalCategory].push(fb.correctedCategory);
  });
  
  for (const [original, corrected] of Object.entries(corrections)) {
    const mostCommon = getMostCommonElement(corrected);
    if (mostCommon && mostCommon !== original) {
      patterns.push(`- 「${original}」は「${mostCommon}」に修正されることが多い`);
    }
  }
  
  return patterns.length > 0 ? patterns.join('\n') : null;
}

/**
 * フォールバック分類（Gemini APIが使えない場合）
 */
function fallbackClassification(
  context: EnhancedClassificationContext
): ClassificationResult {
  if (context.storeName) {
    for (const [pattern, categoryName] of Object.entries(STORE_CATEGORY_PATTERNS)) {
      if (new RegExp(pattern, 'i').test(context.storeName)) {
        return {
          category: categoryName,
          confidence: 0.7,
          reasoning: `店舗名「${context.storeName}」から推定`
        };
      }
    }
  }
  
  const description = context.description.toLowerCase();
  const keywordMap: Record<string, string> = {
    '食': '食費',
    'ランチ': '食費',
    'ディナー': '食費',
    '弁当': '食費',
    '電車': '交通費',
    'バス': '交通費',
    'タクシー': '交通費',
    '服': '衣服',
    '洋服': '衣服',
    '薬': '医療費',
    '病院': '医療費',
    '本': '教育費',
    '書籍': '教育費'
  };
  
  for (const [keyword, categoryName] of Object.entries(keywordMap)) {
    if (description.includes(keyword)) {
      return {
        category: categoryName,
        confidence: 0.5,
        reasoning: `キーワード「${keyword}」から推定`
      };
    }
  }
  
  return {
    category: 'その他',
    confidence: 0.3,
    reasoning: '明確な手がかりがないためデフォルトカテゴリを使用'
  };
}

/**
 * 配列から最も頻出する要素を取得
 */
function getMostCommonElement(arr: string[]): string | null {
  if (arr.length === 0) return null;
  
  const counts: Record<string, number> = {};
  arr.forEach(item => {
    counts[item] = (counts[item] || 0) + 1;
  });
  
  let maxCount = 0;
  let mostCommon = null;
  for (const [item, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = item;
    }
  }
  
  return mostCommon;
}

/**
 * バッチ分類（複数の支出を効率的に分類）
 */
export async function batchClassify(
  lineId: string,
  expenses: Array<EnhancedClassificationContext>
): Promise<ClassificationResult[]> {
  const client = getGeminiClient();
  if (!client) {
    return expenses.map(expense => fallbackClassification(expense));
  }
  
  try {
    const availableCategories = await getAllUserCategories(lineId);
    const categoryNames = availableCategories.map(cat => cat.name);
    const model = client.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `
以下の複数の支出を適切なカテゴリに分類してください。

## 利用可能なカテゴリ
${categoryNames.map(name => `- ${name}`).join('\n')}

## 支出リスト
${expenses.map((expense, index) => `
### 支出 ${index + 1}
- 説明: "${expense.description}"
- 金額: ¥${expense.amount.toLocaleString()}
${expense.storeName ? `- 店舗名: "${expense.storeName}"` : ''}
`).join('\n')}

各支出について、以下の形式のJSON配列で回答してください:
[
  {
    "category": "カテゴリ名",
    "confidence": 0.85,
    "reasoning": "分類理由"
  },
  ...
]
`;
    
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text().trim();
    
    try {
      const parsed = JSON.parse(text) as Array<any>;
      return parsed.map((item, index) => ({
        category: categoryNames.includes(item.category) ? item.category : 'その他',
        confidence: Math.max(0, Math.min(1, item.confidence || 0.5)),
        reasoning: item.reasoning || 'バッチ処理による分類'
      }));
    } catch (parseError) {
      console.error('Failed to parse batch response:', parseError);
      return expenses.map(expense => fallbackClassification(expense));
    }
  } catch (error) {
    console.error('Batch classification error:', error);
    return expenses.map(expense => fallbackClassification(expense));
  }
}

/**
 * カテゴリ修正時のフィードバック記録
 */
export async function recordUserFeedback(
  lineId: string,
  originalCategory: string,
  correctedCategory: string,
  context: EnhancedClassificationContext,
  confidence: number
): Promise<void> {
  try {
    await recordCategoryFeedback({
      lineId,
      originalCategory,
      correctedCategory,
      description: context.description,
      amount: context.amount
    });
    console.log(`Feedback recorded: ${originalCategory} -> ${correctedCategory}`);
  } catch (error) {
    console.error('Failed to record feedback:', error);
  }
}

/**
 * Geminiの利用可能性をチェック
 */
export function isGeminiAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY;
}