import dotenv from 'dotenv';
import { classifyExpenseWithGemini, isGeminiAvailable } from './src/geminiCategoryClassifier';

// 環境変数を読み込み
dotenv.config({ path: '../.env' });

async function testGeminiClassification() {
  console.log('=== Gemini分類機能テスト ===');
  
  // Geminiが利用可能かチェック
  const available = isGeminiAvailable();
  console.log(`Gemini利用可能: ${available}`);
  
  if (!available) {
    console.warn('GEMINI_API_KEYが設定されていません。.envファイルでGEMINI_API_KEYを設定してください。');
    return;
  }
  
  // テスト用のlineId
  const testLineId = 'test-user-12345';
  
  // テストケース
  const testCases = [
    'スーパーで食材を購入',
    'ガソリンスタンドで給油',
    '美容院でカット',
    'コンビニで昼食',
    '電車の定期券購入',
    'Netflix月額料金',
    'マクドナルドでハンバーガー'
  ];
  
  console.log('\n=== テストケース実行 ===');
  
  for (const testCase of testCases) {
    try {
      console.log(`\n入力: "${testCase}"`);
      const result = await classifyExpenseWithGemini(testLineId, testCase);
      
      console.log(`結果: ${result.category || 'なし'}`);
      console.log(`信頼度: ${result.confidence}`);
      if (result.reasoning) {
        console.log(`理由: ${result.reasoning}`);
      }
      
      // 短い間隔を設ける（APIレート制限対策）
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.error(`エラー: ${error}`);
    }
  }
}

// テスト実行
testGeminiClassification().catch(console.error);
