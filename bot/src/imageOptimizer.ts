import sharp from 'sharp';

export interface ImageOptimizationOptions {
  maxWidth: number;
  maxHeight: number;
  quality: number;
  format: 'jpeg' | 'png' | 'webp';
}

export interface OptimizedImage {
  buffer: Buffer;
  originalSize: number;
  optimizedSize: number;
  compressionRatio: number;
}

/**
 * コスト最適化のための画像処理
 * - リサイズ: 最大1920x1080 (OCRに十分な解像度)
 * - 圧縮: 85%品質 (テキスト読取りに影響しない範囲)
 * - フォーマット: JPEG変換 (ファイルサイズ削減)
 * 
 * 期待効果: Vision API コスト 60-70% 削減
 */
export async function optimizeImageForOCR(
  inputBuffer: Buffer,
  options: Partial<ImageOptimizationOptions> = {}
): Promise<OptimizedImage> {
  const defaultOptions: ImageOptimizationOptions = {
    maxWidth: 1920,
    maxHeight: 1080,
    quality: 85,
    format: 'jpeg'
  };

  const opts = { ...defaultOptions, ...options };
  const originalSize = inputBuffer.length;

  try {
    console.log(`=== IMAGE OPTIMIZATION START ===`);
    console.log(`Original size: ${(originalSize / 1024 / 1024).toFixed(2)}MB`);

    // Sharp の可用性チェック
    if (!sharp) {
      console.warn('Sharp library not available, using original image');
      return {
        buffer: inputBuffer,
        originalSize,
        optimizedSize: originalSize,
        compressionRatio: 0
      };
    }

    // メモリ使用量をチェック
    const maxImageSize = 50 * 1024 * 1024; // 50MB制限
    if (originalSize > maxImageSize) {
      console.warn(`Image too large (${(originalSize / 1024 / 1024).toFixed(2)}MB), using original`);
      return {
        buffer: inputBuffer,
        originalSize,
        optimizedSize: originalSize,
        compressionRatio: 0
      };
    }

    // Sharp pipeline for OCR optimization with error handling
    let sharpPipeline;
    try {
      sharpPipeline = sharp(inputBuffer);
      
      // メタデータを取得してバリデーション
      const metadata = await sharpPipeline.metadata();
      console.log(`Image metadata: ${metadata.width}x${metadata.height}, format: ${metadata.format}`);
      
      // サポートされていないフォーマットのチェック
      if (!metadata.width || !metadata.height) {
        throw new Error('Invalid image dimensions');
      }

    } catch (sharpError) {
      console.error('Sharp initialization failed:', sharpError);
      return {
        buffer: inputBuffer,
        originalSize,
        optimizedSize: originalSize,
        compressionRatio: 0
      };
    }

    try {
      // リサイズ処理
      sharpPipeline = sharpPipeline.resize(opts.maxWidth, opts.maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      });

      // OCR特化の前処理 (Cloud Functions で安全な設定)
      sharpPipeline = sharpPipeline
        .greyscale() // グレースケール変換
        .normalize() // コントラスト正規化
        .sharpen(); // エッジ強化

      // フォーマット変換と圧縮 (より安全な設定)
      let outputBuffer: Buffer;
      switch (opts.format) {
        case 'jpeg':
          outputBuffer = await sharpPipeline
            .jpeg({ 
              quality: opts.quality,
              progressive: false, // Cloud Functions でより安全
              mozjpeg: false // デフォルトエンコーダーを使用
            })
            .toBuffer();
          break;
        case 'png':
          outputBuffer = await sharpPipeline
            .png({ 
              compressionLevel: 6 // より軽い圧縮レベル
            })
            .toBuffer();
          break;
        case 'webp':
          outputBuffer = await sharpPipeline
            .webp({ 
              quality: opts.quality,
              effort: 3 // より軽いエフォート
            })
            .toBuffer();
          break;
        default:
          // サポートされていないフォーマットの場合は JPEG にフォールバック
          console.warn(`Unsupported format ${opts.format}, using JPEG`);
          outputBuffer = await sharpPipeline
            .jpeg({ quality: opts.quality })
            .toBuffer();
      }

      const optimizedSize = outputBuffer.length;
      const compressionRatio = (1 - optimizedSize / originalSize) * 100;

      console.log(`Optimized size: ${(optimizedSize / 1024 / 1024).toFixed(2)}MB`);
      console.log(`Compression ratio: ${compressionRatio.toFixed(1)}%`);
      console.log(`=== IMAGE OPTIMIZATION END ===`);

      return {
        buffer: outputBuffer,
        originalSize,
        optimizedSize,
        compressionRatio
      };

    } catch (processingError) {
      console.error('Image processing failed:', processingError);
      
      // 処理エラーの場合、基本的なリサイズのみ試行
      try {
        console.log('Attempting basic resize only');
        const basicBuffer = await sharp(inputBuffer)
          .resize(1600, 900, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
          
        const basicSize = basicBuffer.length;
        const basicRatio = (1 - basicSize / originalSize) * 100;
        
        console.log(`Basic optimization successful: ${basicRatio.toFixed(1)}% reduction`);
        return {
          buffer: basicBuffer,
          originalSize,
          optimizedSize: basicSize,
          compressionRatio: basicRatio
        };
        
      } catch (basicError) {
        console.error('Basic resize also failed:', basicError);
        // 最終フォールバック
        return {
          buffer: inputBuffer,
          originalSize,
          optimizedSize: originalSize,
          compressionRatio: 0
        };
      }
    }

  } catch (error) {
    console.error('Image optimization failed:', error);
    
    // フォールバック: 元の画像をそのまま返す
    console.log('Falling back to original image');
    return {
      buffer: inputBuffer,
      originalSize,
      optimizedSize: originalSize,
      compressionRatio: 0
    };
  }
}

/**
 * OCR精度向上のための高度な画像前処理
 * - ノイズ除去
 * - コントラスト強化  
 * - 文字エッジ強調
 * - 傾き補正 (将来実装)
 * 
 * 期待効果: OCR認識精度 15-20% 向上
 */
export async function enhanceImageForOCR(inputBuffer: Buffer): Promise<Buffer> {
  try {
    console.log(`=== OCR ENHANCEMENT START ===`);

    // Sharp の可用性チェック
    if (!sharp) {
      console.warn('Sharp library not available for enhancement, using original image');
      return inputBuffer;
    }

    // より安全な設定での画像処理
    try {
      const enhancedBuffer = await sharp(inputBuffer)
        // 1. 軽いノイズ除去
        .blur(0.1)
        .sharpen(0.8, 0.8)
        
        // 2. 基本的なコントラスト強化
        .normalize()
        
        // 3. 軽いガンマ補正
        .gamma(1.1)
        
        // 4. 軽いエッジ強調  
        .sharpen(0.8, 0.8, 1)
        
        .toBuffer();

      console.log(`=== OCR ENHANCEMENT END ===`);
      return enhancedBuffer;

    } catch (processingError) {
      console.error('Enhanced processing failed, trying basic enhancement:', processingError);
      
      // より基本的な処理のみ
      try {
        const basicEnhanced = await sharp(inputBuffer)
          .normalize()
          .sharpen()
          .toBuffer();
        
        console.log('Basic enhancement successful');
        return basicEnhanced;
        
      } catch (basicError) {
        console.error('Basic enhancement also failed:', basicError);
        return inputBuffer; // 最終フォールバック
      }
    }

  } catch (error) {
    console.error('OCR enhancement failed:', error);
    return inputBuffer; // フォールバック
  }
}

/**
 * レシート画像の品質チェック
 * 低品質な画像を事前に検出してユーザーにフィードバック
 */
export async function assessImageQuality(inputBuffer: Buffer): Promise<{
  isGoodQuality: boolean;
  issues: string[];
  recommendations: string[];
}> {
  try {
    // Sharp の可用性チェック
    if (!sharp) {
      console.warn('Sharp library not available for quality assessment');
      return {
        isGoodQuality: true, // エラー時は処理を続行
        issues: [],
        recommendations: []
      };
    }

    const metadata = await sharp(inputBuffer).metadata();
    
    const issues: string[] = [];
    const recommendations: string[] = [];

    // 基本的な解像度チェック
    if (metadata.width && metadata.height) {
      const pixels = metadata.width * metadata.height;
      if (pixels < 300000) { // 300K pixels未満
        issues.push('解像度が低すぎます');
        recommendations.push('より高解像度で撮影してください');
      }
    }

    // より安全な統計情報取得
    try {
      const stats = await sharp(inputBuffer).stats();
      
      // 明度チェック (最初のチャンネルのみ)
      if (stats.channels && stats.channels.length > 0) {
        const avgBrightness = stats.channels[0].mean;
        if (avgBrightness < 50) {
          issues.push('画像が暗すぎます');
          recommendations.push('明るい場所で撮影してください');
        } else if (avgBrightness > 200) {
          issues.push('画像が明るすぎます');
          recommendations.push('光の反射を避けて撮影してください');
        }
      }
    } catch (statsError) {
      console.warn('Could not analyze image statistics:', statsError);
      // 統計情報が取得できない場合はスキップ
    }

    return {
      isGoodQuality: issues.length === 0,
      issues,
      recommendations
    };

  } catch (error) {
    console.error('Image quality assessment failed:', error);
    return {
      isGoodQuality: true, // エラー時は処理を続行
      issues: [],
      recommendations: []
    };
  }
}

/**
 * Vision API用の最適な画像設定を返す
 */
export function getOptimalSettings(): ImageOptimizationOptions {
  return {
    maxWidth: 1920,    // 1920x1080で十分なOCR精度
    maxHeight: 1080,   
    quality: 85,       // テキストに影響しない品質
    format: 'jpeg'     // 最高の圧縮率
  };
}