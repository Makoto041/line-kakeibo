/**
 * Test suite for analytics.ts
 * 固定費・変動費分析ロジックのテスト
 */

import {
  analyzeMonthlyExpenses,
  calculateCategoryBreakdown,
  calculateMonthlyTrend,
  calculateBudgetComparison,
  detectAnomalies,
  analyzeSeasonality,
  analyzeSpendingPatterns,
  isFixedExpense,
  performOptimizedAnalysis,
  AnalyticsCache,
} from '../lib/analytics';
import { Expense } from '../lib/hooks';

// テスト用のモックデータ
const mockExpenses: Expense[] = [
  // 2024年8月のデータ
  {
    id: '1',
    lineId: 'user1',
    amount: 3000,
    description: 'ランチ',
    date: '2024-08-01',
    category: '食費',
    confirmed: true,
  },
  {
    id: '2',
    lineId: 'user1',
    amount: 50000,
    description: '光熱費支払い',
    date: '2024-08-05',
    category: '光熱費',
    confirmed: true,
  },
  {
    id: '3',
    lineId: 'user1',
    amount: 15000,
    description: '通信費',
    date: '2024-08-10',
    category: '通信費',
    confirmed: true,
  },
  {
    id: '4',
    lineId: 'user1',
    amount: 5000,
    description: '娯楽',
    date: '2024-08-15',
    category: '娯楽',
    confirmed: true,
  },
  {
    id: '5',
    lineId: 'user1',
    amount: 8000,
    description: '日用品',
    date: '2024-08-20',
    category: '日用品',
    confirmed: true,
  },
  // 2024年9月のデータ
  {
    id: '6',
    lineId: 'user1',
    amount: 3500,
    description: 'ランチ',
    date: '2024-09-01',
    category: '食費',
    confirmed: true,
  },
  {
    id: '7',
    lineId: 'user1',
    amount: 52000,
    description: '光熱費支払い',
    date: '2024-09-05',
    category: '光熱費',
    confirmed: true,
  },
  {
    id: '8',
    lineId: 'user1',
    amount: 15000,
    description: '通信費',
    date: '2024-09-10',
    category: '通信費',
    confirmed: true,
  },
  {
    id: '9',
    lineId: 'user1',
    amount: 10000,
    description: '娯楽',
    date: '2024-09-15',
    category: '娯楽',
    confirmed: true,
  },
  {
    id: '10',
    lineId: 'user1',
    amount: 200000, // 異常値として検出されるべき高額支出
    description: '特別な買い物',
    date: '2024-09-20',
    category: 'その他',
    confirmed: true,
  },
];

// テストヘルパー関数
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Test failed: ${message}`);
  }
}

function assertClose(actual: number, expected: number, tolerance: number = 0.01, message: string = ''): void {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${message} - Expected ${expected}, got ${actual} (diff: ${diff})`);
}

// テストケース
export async function runTests() {
  console.log('🧪 Starting analytics tests...\n');

  try {
    // Test 1: isFixedExpense
    console.log('Test 1: isFixedExpense function');
    assert(isFixedExpense('通信費') === true, 'Should identify 通信費 as fixed expense');
    assert(isFixedExpense('光熱費') === true, 'Should identify 光熱費 as fixed expense');
    assert(isFixedExpense('食費') === false, 'Should identify 食費 as variable expense');
    assert(isFixedExpense('娯楽') === false, 'Should identify 娯楽 as variable expense');
    console.log('✅ isFixedExpense tests passed\n');

    // Test 2: calculateCategoryBreakdown
    console.log('Test 2: calculateCategoryBreakdown function');
    const augustExpenses = mockExpenses.filter(e => e.date.startsWith('2024-08'));
    const breakdown = calculateCategoryBreakdown(augustExpenses);
    
    assert(breakdown.length === 5, 'Should have 5 categories');
    assert(breakdown[0].category === '光熱費', 'First category should be 光熱費 (highest amount)');
    assert(breakdown[0].amount === 50000, 'Light bill amount should be 50000');
    assert(breakdown[0].isFixed === true, 'Light bill should be marked as fixed');
    
    const totalPercentage = breakdown.reduce((sum, cat) => sum + cat.percentage, 0);
    assertClose(totalPercentage, 100, 0.1, 'Total percentage should be 100%');
    console.log('✅ calculateCategoryBreakdown tests passed\n');

    // Test 3: calculateBudgetComparison
    console.log('Test 3: calculateBudgetComparison function');
    const budget = calculateBudgetComparison(81000, 100000);
    
    assert(budget.budgetAmount === 100000, 'Budget amount should be 100000');
    assert(budget.actualAmount === 81000, 'Actual amount should be 81000');
    assert(budget.variance === -19000, 'Variance should be -19000');
    assert(budget.isOverBudget === false, 'Should not be over budget');
    assertClose(budget.variancePercentage, -19, 0.1, 'Variance percentage');
    
    const overBudget = calculateBudgetComparison(120000, 100000);
    assert(overBudget.isOverBudget === true, 'Should be over budget');
    assert(overBudget.variance === 20000, 'Variance should be 20000');
    console.log('✅ calculateBudgetComparison tests passed\n');

    // Test 4: calculateMonthlyTrend
    console.log('Test 4: calculateMonthlyTrend function');
    const trend = calculateMonthlyTrend(mockExpenses, '2024-09', 2);
    
    assert(trend.length === 2, 'Should have 2 months of data');
    assert(trend[0].month === '2024-08', 'First month should be 2024-08');
    assert(trend[1].month === '2024-09', 'Second month should be 2024-09');
    assert(trend[0].totalExpense === 81000, 'August total should be 81000');
    assert(trend[1].totalExpense === 280500, 'September total should be 280500');
    
    // 固定費・変動費の分離チェック
    assert(trend[0].fixedExpense === 65000, 'August fixed expenses should be 65000');
    assert(trend[0].variableExpense === 16000, 'August variable expenses should be 16000');
    console.log('✅ calculateMonthlyTrend tests passed\n');

    // Test 5: detectAnomalies
    console.log('Test 5: detectAnomalies function');
    const septemberExpenses = mockExpenses.filter(e => e.date.startsWith('2024-09'));
    const anomalies = detectAnomalies(septemberExpenses, mockExpenses);
    
    assert(anomalies.length > 0, 'Should detect anomalies');
    const highValueAnomaly = anomalies.find(a => a.amount === 200000);
    assert(highValueAnomaly !== undefined, 'Should detect the 200000 expense as anomaly');
    assert(highValueAnomaly?.severity === 'high', 'High value anomaly should have high severity');
    console.log('✅ detectAnomalies tests passed\n');

    // Test 6: analyzeMonthlyExpenses (統合テスト)
    console.log('Test 6: analyzeMonthlyExpenses function (integration test)');
    const monthlyAnalysis = await analyzeMonthlyExpenses(mockExpenses, '2024-09', 100000);
    
    assert(monthlyAnalysis.totalExpense === 280500, 'Total expense should be 280500');
    assert(monthlyAnalysis.fixedExpense === 67000, 'Fixed expense should be 67000');
    assert(monthlyAnalysis.variableExpense === 213500, 'Variable expense should be 213500');
    assert(monthlyAnalysis.categoryBreakdown.length > 0, 'Should have category breakdown');
    assert(monthlyAnalysis.monthlyTrend.length > 0, 'Should have monthly trend');
    assert(monthlyAnalysis.budgetComparison !== null, 'Should have budget comparison');
    assert(monthlyAnalysis.budgetComparison?.isOverBudget === true, 'Should be over budget');
    assert(monthlyAnalysis.anomalies.length > 0, 'Should detect anomalies');
    
    // 前月比成長率のチェック
    const expectedGrowth = ((280500 - 81000) / 81000) * 100;
    assertClose(monthlyAnalysis.monthOverMonthGrowth, expectedGrowth, 0.1, 'Month-over-month growth');
    
    // 平均日次支出のチェック
    const expectedDailyAvg = 280500 / 30; // 9月は30日
    assertClose(monthlyAnalysis.averageDailyExpense, expectedDailyAvg, 0.1, 'Average daily expense');
    console.log('✅ analyzeMonthlyExpenses tests passed\n');

    // Test 7: analyzeSeasonality
    console.log('Test 7: analyzeSeasonality function');
    const seasonalData = analyzeSeasonality(mockExpenses);
    
    assert(seasonalData.length === 12, 'Should have data for all 12 months');
    const august = seasonalData.find(s => s.month === 8);
    const september = seasonalData.find(s => s.month === 9);
    assert(august !== undefined, 'Should have August data');
    assert(september !== undefined, 'Should have September data');
    console.log('✅ analyzeSeasonality tests passed\n');

    // Test 8: analyzeSpendingPatterns
    console.log('Test 8: analyzeSpendingPatterns function');
    const patterns = analyzeSpendingPatterns(mockExpenses);
    
    assert(patterns.length === 7, 'Should have patterns for all 7 days of week');
    patterns.forEach((pattern, index) => {
      assert(pattern.dayOfWeek === index, `Day of week should be ${index}`);
      assert(pattern.averageAmount >= 0, 'Average amount should be non-negative');
      assert(pattern.frequency >= 0, 'Frequency should be non-negative');
      assert(Array.isArray(pattern.peakCategories), 'Peak categories should be an array');
    });
    console.log('✅ analyzeSpendingPatterns tests passed\n');

    // Test 9: AnalyticsCache
    console.log('Test 9: AnalyticsCache class');
    const cache = new AnalyticsCache();
    
    const testData = { test: 'data' };
    cache.set('test-key', testData);
    
    const retrieved = cache.get('test-key');
    assert(retrieved !== null, 'Should retrieve cached data');
    assert(retrieved.test === 'data', 'Cached data should match');
    
    cache.clear();
    const afterClear = cache.get('test-key');
    assert(afterClear === null, 'Cache should be empty after clear');
    console.log('✅ AnalyticsCache tests passed\n');

    // Test 10: performOptimizedAnalysis
    console.log('Test 10: performOptimizedAnalysis function');
    const startTime = performance.now();
    const optimizedResult = await performOptimizedAnalysis(mockExpenses, '2024-09', 100000, true);
    const firstRunTime = performance.now() - startTime;
    
    assert(optimizedResult.totalExpense === 280500, 'Optimized analysis should return correct total');
    
    // キャッシュからの取得テスト
    const cacheStartTime = performance.now();
    const cachedResult = await performOptimizedAnalysis(mockExpenses, '2024-09', 100000, true);
    const cacheRunTime = performance.now() - cacheStartTime;
    
    assert(cachedResult.totalExpense === 280500, 'Cached result should match');
    console.log(`  First run: ${firstRunTime.toFixed(2)}ms, Cached run: ${cacheRunTime.toFixed(2)}ms`);
    assert(cacheRunTime < firstRunTime, 'Cached run should be faster');
    console.log('✅ performOptimizedAnalysis tests passed\n');

    console.log('🎉 All tests passed successfully!');
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

// テストランナー
if (typeof require !== 'undefined' && require.main === module) {
  runTests().then(success => {
    process.exit(success ? 0 : 1);
  });
}
