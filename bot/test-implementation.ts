import dotenv from 'dotenv';
import { 
  classifyExpenseWithGemini, 
  isGeminiAvailable, 
  getClassificationStats 
} from './src/geminiCategoryClassifier';
import { parseTextExpense } from './src/textParser';

// 環境変数を読み込み
dotenv.config({ path: '../.env' });

async function testCurrentImplementation() {
  console.log('🚀 === line-kakeibo Gemini分類機能の実装テスト ===\n');
  
  // 1. Geminiの利用可能性をチェック
  const available = isGeminiAvailable();
  console.log(`📊 Gemini利用可能性: ${available}`);
  console.log(`📊 GEMINI_API_KEY設定状況: ${process.env.GEMINI_API_KEY?.slice(0, 20)}...`);
  
  if (!available) {
    console.warn('⚠️  GEMINI_API_KEYが設定されていません。');
    console.log('   実際のAPIキーを設定するには:');
    console.log('   1. https://aistudio.google.com/app/apikey でAPIキーを取得');
    console.log('   2. .envファイルのGEMINI_API_KEYを実際の値に更新');
    console.log('');
  }
  
  // 2. 分類統計を確認
  const stats = getClassificationStats();
  console.log('📈 現在の分類統計:');
  console.log(`   総試行回数: ${stats.totalAttempts}`);
  console.log(`   Gemini成功: ${stats.geminiSuccessCount}`);
  console.log(`   フォールバック: ${stats.fallbackCount}`);
  console.log(`   平均信頼度: ${stats.averageConfidence.toFixed(2)}`);
  console.log('');
  
  // 3. テスト用のlineIdとテストケース
  const testLineId = 'test-user-12345';
  const testCases = [
    '500 スーパーで食材購入',
    '3000 ガソリンスタンドで給油', 
    '2500 美容院でカット',
    '800 コンビニで昼食'
  ];
  
  console.log('🧪 === テストケース実行（エラーハンドリング確認）===\n');
  
  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    
    try {
      console.log(`${i + 1}. 入力: "${testCase}"`);
      
      // テキスト解析（カテゴリ分類を含む）をテスト
      const parseResult = await parseTextExpense(testCase, testLineId);
      
      if (parseResult) {
        console.log(`   💰 金額: ${parseResult.amount}円`);
        console.log(`   📅 日付: ${parseResult.date}`);
        console.log(`   📝 説明: ${parseResult.description}`);
        console.log(`   🏷️  カテゴリ: ${parseResult.category || 'なし（未分類）'}`);
      } else {
        console.log('   ❌ 解析失敗');
      }
      
      // 直接Gemini分類もテスト
      if (parseResult?.description) {
        const geminiResult = await classifyExpenseWithGemini(testLineId, parseResult.description);
        console.log(`   🤖 Gemini分類: ${geminiResult.category || 'null'}`);
        console.log(`   📊 信頼度: ${geminiResult.confidence}`);
        console.log(`   💭 理由: ${geminiResult.reasoning || 'なし'}`);
      }
      
      console.log('');
      
      // APIレート制限対策で少し待つ
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.error(`   ❌ エラー: ${error}`);
      console.log('');
    }
  }
  
  // 4. 最終統計を表示
  const finalStats = getClassificationStats();
  console.log('📊 === テスト完了後の統計 ===');
  console.log(`   総試行回数: ${finalStats.totalAttempts}`);
  console.log(`   Gemini成功: ${finalStats.geminiSuccessCount}`);
  console.log(`   フォールバック: ${finalStats.fallbackCount}`);
  console.log(`   成功率: ${finalStats.totalAttempts > 0 ? 
    Math.round((finalStats.geminiSuccessCount / finalStats.totalAttempts) * 100) : 0}%`);
  
  console.log('\n✅ テスト完了！');
  console.log('💡 実際のGemini APIキーを設定すると、AI分類機能が利用できます。');
}

// テスト実行
testCurrentImplementation().catch(console.error);
