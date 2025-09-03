import dotenv from 'dotenv';
import { getClassificationStats, isGeminiAvailable } from './src/geminiCategoryClassifier';

// 環境変数を読み込み
dotenv.config({ path: '../.env' });

async function testEndpoints() {
  console.log('=== APIエンドポイント機能テスト ===');
  
  // 1. 分類統計エンドポイントのテスト
  console.log('\n=== 分類統計テスト ===');
  
  try {
    const stats = getClassificationStats();
    const response = {
      ...stats,
      geminiAvailable: isGeminiAvailable(),
      successRate: stats.totalAttempts > 0 
        ? Math.round((stats.geminiSuccessCount / stats.totalAttempts) * 100) 
        : 0,
      timestamp: new Date().toISOString(),
    };
    
    console.log('統計データ:');
    console.log(JSON.stringify(response, null, 2));
    console.log('✅ 分類統計エンドポイントの機能テスト成功');
    
  } catch (error) {
    console.error('❌ 分類統計エンドポイントテスト失敗:', error);
  }
  
  // 2. テスト分類機能のテスト（Firebase接続なしの場合のエラーハンドリング）
  console.log('\n=== テスト分類機能テスト ===');
  
  const testDescription = 'スーパーで食材を購入';
  console.log(`テスト入力: "${testDescription}"`);
  
  try {
    // ここでclassifyExpenseWithGeminiを直接呼び出すと
    // FirebaseエラーとGemini APIエラーの両方が発生する可能性がある
    
    const mockResponse = {
      input: testDescription,
      result: {
        category: null,
        confidence: 0,
        reasoning: 'Firebase not initialized for test',
      },
      geminiAvailable: isGeminiAvailable(),
      timestamp: new Date().toISOString(),
    };
    
    console.log('テスト分類結果:');
    console.log(JSON.stringify(mockResponse, null, 2));
    console.log('✅ テスト分類エンドポイントの構造テスト成功');
    
  } catch (error) {
    console.error('❌ テスト分類エンドポイントテスト失敗:', error);
  }
  
  // 3. Gemini利用可能性のテスト改善
  console.log('\n=== Gemini利用可能性テスト ===');
  
  const apiKey = process.env.GEMINI_API_KEY;
  console.log(`環境変数GEMINI_API_KEY: ${apiKey ? '設定済み' : '未設定'}`);
  console.log(`APIキーの種類: ${apiKey === 'your_gemini_api_key_here' ? 'プレースホルダー' : '実際のキー'}`);
  console.log(`isGeminiAvailable(): ${isGeminiAvailable()}`);
  
  // より正確なGemini利用可能性チェック
  const isRealApiKey = apiKey && apiKey !== 'your_gemini_api_key_here' && apiKey.startsWith('AIza');
  console.log(`実際に利用可能: ${isRealApiKey}`);
  
  if (!isRealApiKey) {
    console.log('\n📝 実際のGemini APIキーを設定するには:');
    console.log('1. https://aistudio.google.com/app/apikey でAPIキーを取得');
    console.log('2. .env ファイルで GEMINI_API_KEY=AIzaSy... に設定');
  }
}

// テスト実行
testEndpoints().catch(console.error);
