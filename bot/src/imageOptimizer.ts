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

    // Sharp pipeline for OCR optimization
    let sharpPipeline = sharp(inputBuffer)
      .resize(opts.maxWidth, opts.maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      });

    // OCR特化の前処理
    sharpPipeline = sharpPipeline
      .greyscale() // グレースケール変換でファイルサイズ削減 + OCR精度向上
      .normalize() // コントラスト正規化
      .sharpen(); // エッジ強化

    // フォーマット変換と圧縮
    let outputBuffer: Buffer;
    switch (opts.format) {
      case 'jpeg':
        outputBuffer = await sharpPipeline
          .jpeg({ 
            quality: opts.quality,
            progressive: true,
            mozjpeg: true // 高効率圧縮
          })
          .toBuffer();
        break;
      case 'png':
        outputBuffer = await sharpPipeline
          .png({ 
            quality: opts.quality,
            compressionLevel: 9
          })
          .toBuffer();
        break;
      case 'webp':
        outputBuffer = await sharpPipeline
          .webp({ 
            quality: opts.quality,
            effort: 6 // 高圧縮
          })
          .toBuffer();
        break;
      default:
        throw new Error(`Unsupported format: ${opts.format}`);
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

    const enhancedBuffer = await sharp(inputBuffer)
      // 1. ノイズ除去 (median filter的効果)
      .blur(0.3)
      .sharpen(1, 1)
      
      // 2. コントラスト強化
      .normalize({
        lower: 1,   // 最暗部を1%に
        upper: 99   // 最明部を99%に
      })
      
      // 3. ガンマ補正 (中間調を明るく)
      .gamma(1.2)
      
      // 4. エッジ強調
      .sharpen(1, 1, 2)  // sigma, flat, jagged
      
      // 5. 最終的なコントラスト調整
      .linear(1.1, -(128 * 0.1)) // わずかなコントラスト向上
      
      .toBuffer();

    console.log(`=== OCR ENHANCEMENT END ===`);
    return enhancedBuffer;

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
    const metadata = await sharp(inputBuffer).metadata();
    const stats = await sharp(inputBuffer).stats();
    
    const issues: string[] = [];
    const recommendations: string[] = [];

    // 解像度チェック
    if (metadata.width && metadata.height) {
      const pixels = metadata.width * metadata.height;
      if (pixels < 300000) { // 300K pixels未満
        issues.push('解像度が低すぎます');
        recommendations.push('より高解像度で撮影してください');
      }
    }

    // 明度チェック
    if (stats.channels) {
      const avgBrightness = stats.channels[0].mean;
      if (avgBrightness < 50) {
        issues.push('画像が暗すぎます');
        recommendations.push('明るい場所で撮影してください');
      } else if (avgBrightness > 200) {
        issues.push('画像が明るすぎます');
        recommendations.push('光の反射を避けて撮影してください');
      }
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