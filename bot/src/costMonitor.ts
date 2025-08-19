/**
 * コスト監視とメトリクス収集
 * Vision API呼び出し・処理時間・成功率を追跡
 * 
 * 期待効果: リアルタイムコスト監視により30-40%のコスト削減
 */

export interface CostMetrics {
  timestamp: Date;
  visionApiCalls: number;
  processingTimeMs: number;
  imageSizeKB: number;
  optimizedSizeKB: number;
  compressionRatio: number;
  ocrSuccess: boolean;
  confidenceScore: number;
  errorType?: string;
}

export interface DailyCostSummary {
  date: string;
  totalApiCalls: number;
  totalProcessingTime: number;
  averageCompressionRatio: number;
  successRate: number;
  estimatedCostUSD: number;
  costSavingsUSD: number;
}

/**
 * コストメトリクスの記録
 * Google Cloud Monitoringに送信
 */
export function recordCostMetrics(metrics: CostMetrics): void {
  try {
    // Cloud Functionsの場合、console.logが自動的にCloud Loggingに送信される
    console.log('COST_METRICS', JSON.stringify({
      timestamp: metrics.timestamp.toISOString(),
      vision_api_calls: metrics.visionApiCalls,
      processing_time_ms: metrics.processingTimeMs,
      image_size_kb: metrics.imageSizeKB,
      optimized_size_kb: metrics.optimizedSizeKB,
      compression_ratio: metrics.compressionRatio,
      ocr_success: metrics.ocrSuccess,
      confidence_score: metrics.confidenceScore,
      error_type: metrics.errorType,
      
      // 計算済みメトリクス
      cost_savings_ratio: (1 - metrics.optimizedSizeKB / metrics.imageSizeKB),
      estimated_cost_usd: calculateVisionAPICost(metrics.optimizedSizeKB),
      original_cost_usd: calculateVisionAPICost(metrics.imageSizeKB)
    }));
    
    // 将来的にはOpenTelemetryやCloud Monitoringの直接APIも使用可能
  } catch (error) {
    console.error('Failed to record cost metrics:', error);
  }
}

/**
 * Vision APIのコスト計算
 * 2024年8月現在の料金: $1.50 per 1000 units
 */
function calculateVisionAPICost(imageSizeKB: number): number {
  // Vision APIは1MB以下は1 unit、それ以上は追加料金
  const units = Math.max(1, Math.ceil(imageSizeKB / 1024));
  return (units * 1.50) / 1000; // USD
}

/**
 * 処理時間の測定
 */
export class ProcessingTimer {
  private startTime: number;
  
  constructor() {
    this.startTime = Date.now();
  }
  
  elapsed(): number {
    return Date.now() - this.startTime;
  }
  
  reset(): void {
    this.startTime = Date.now();
  }
}

/**
 * 週次レポートの生成
 * 運営チーム向けの包括的な分析
 */
export function generateWeeklyReport(weeklyMetrics: CostMetrics[]): string {
  const summary = generateDailyCostSummary(weeklyMetrics);
  const alerts = checkCostAlerts(weeklyMetrics);
  const errorAnalysis = analyzeErrorPatterns(weeklyMetrics);
  
  return `
📊 LINE家計簿 週次運用レポート
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💰 コスト効率
• 総API呼び出し: ${summary.totalApiCalls.toLocaleString()}回
• 実際のコスト: $${summary.estimatedCostUSD.toFixed(4)}
• 削減コスト: $${summary.costSavingsUSD.toFixed(4)} (${((summary.costSavingsUSD / (summary.estimatedCostUSD + summary.costSavingsUSD)) * 100).toFixed(1)}%削減)
• 平均圧縮率: ${summary.averageCompressionRatio.toFixed(1)}%

🎯 品質指標
• OCR成功率: ${summary.successRate.toFixed(1)}%
• 平均処理時間: ${(summary.totalProcessingTime / summary.totalApiCalls / 1000).toFixed(1)}秒

${alerts.alerts.length > 0 ? `🚨 アラート
${alerts.alerts.map(alert => `• ${alert}`).join('\n')}

💡 推奨事項
${alerts.recommendations.map(rec => `• ${rec}`).join('\n')}` : '✅ 全システム正常動作中'}

${errorAnalysis.mostCommonError ? `🔍 エラー分析
• 最多エラー: ${errorAnalysis.mostCommonError}
• エラー率: ${errorAnalysis.errorRate.toFixed(1)}%` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

詳細ログ: Google Cloud Console > Logging
監視ダッシュボード: Cloud Monitoring > LINE-Kakeibo
  `.trim();
}

/**
 * 日次コストサマリーの生成
 * 管理者向けの詳細レポート
 */
export function generateDailyCostSummary(metrics: CostMetrics[]): DailyCostSummary {
  if (metrics.length === 0) {
    return {
      date: new Date().toISOString().split('T')[0],
      totalApiCalls: 0,
      totalProcessingTime: 0,
      averageCompressionRatio: 0,
      successRate: 0,
      estimatedCostUSD: 0,
      costSavingsUSD: 0
    };
  }
  
  const successCount = metrics.filter(m => m.ocrSuccess).length;
  const totalOriginalCost = metrics.reduce((sum, m) => 
    sum + calculateVisionAPICost(m.imageSizeKB), 0);
  const totalOptimizedCost = metrics.reduce((sum, m) => 
    sum + calculateVisionAPICost(m.optimizedSizeKB), 0);
  
  return {
    date: metrics[0].timestamp.toISOString().split('T')[0],
    totalApiCalls: metrics.length,
    totalProcessingTime: metrics.reduce((sum, m) => sum + m.processingTimeMs, 0),
    averageCompressionRatio: metrics.reduce((sum, m) => sum + m.compressionRatio, 0) / metrics.length,
    successRate: (successCount / metrics.length) * 100,
    estimatedCostUSD: totalOptimizedCost,
    costSavingsUSD: totalOriginalCost - totalOptimizedCost
  };
}

/**
 * アラート条件のチェック
 * 異常なコスト増加やエラー率上昇を検知
 */
export function checkCostAlerts(metrics: CostMetrics[]): {
  alerts: string[];
  recommendations: string[];
} {
  const alerts: string[] = [];
  const recommendations: string[] = [];
  
  if (metrics.length === 0) return { alerts, recommendations };
  
  // 成功率が85%を下回る場合
  const successRate = metrics.filter(m => m.ocrSuccess).length / metrics.length;
  if (successRate < 0.85) {
    alerts.push(`OCR成功率が低下: ${(successRate * 100).toFixed(1)}%`);
    recommendations.push('画像品質ガイダンスの改善を検討してください');
  }
  
  // 平均処理時間が30秒を超える場合
  const avgProcessingTime = metrics.reduce((sum, m) => sum + m.processingTimeMs, 0) / metrics.length;
  if (avgProcessingTime > 30000) {
    alerts.push(`処理時間が長すぎます: ${(avgProcessingTime / 1000).toFixed(1)}秒`);
    recommendations.push('Cloud Functionsのメモリ割り当て増加を検討してください');
  }
  
  // 圧縮率が50%を下回る場合
  const avgCompressionRatio = metrics.reduce((sum, m) => sum + m.compressionRatio, 0) / metrics.length;
  if (avgCompressionRatio < 50) {
    alerts.push(`画像圧縮効率が低下: ${avgCompressionRatio.toFixed(1)}%`);
    recommendations.push('画像最適化設定の見直しを検討してください');
  }
  
  return { alerts, recommendations };
}

/**
 * エラー分類の統計
 * 問題の根本原因を特定
 */
export function analyzeErrorPatterns(metrics: CostMetrics[]): {
  errorTypes: Record<string, number>;
  mostCommonError: string | null;
  errorRate: number;
} {
  const errorMetrics = metrics.filter(m => !m.ocrSuccess && m.errorType);
  const errorTypes: Record<string, number> = {};
  
  errorMetrics.forEach(m => {
    if (m.errorType) {
      errorTypes[m.errorType] = (errorTypes[m.errorType] || 0) + 1;
    }
  });
  
  const mostCommonError = Object.entries(errorTypes)
    .sort(([,a], [,b]) => b - a)[0]?.[0] || null;
  
  return {
    errorTypes,
    mostCommonError,
    errorRate: (errorMetrics.length / metrics.length) * 100
  };
}
