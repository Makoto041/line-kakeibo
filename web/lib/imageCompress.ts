// レシート画像をアップロード前にクライアント側でリサイズ＋再エンコードする。
// 文字が読める品質を保ちつつ、Storage 容量・転送帯域を長期的に削減する目的。
//
// 方針:
// - 長辺を maxEdge までに縮小（拡大はしない）
// - JPEG で再エンコード（quality 既定 0.72）
// - 元が十分小さい/画像でない/デコード不能な場合は元ファイルをそのまま返す
// - EXIF の回転は createImageBitmap の imageOrientation で吸収する

export interface CompressOptions {
  /** 長辺の最大ピクセル（既定 1600） */
  maxEdge?: number;
  /** JPEG 画質 0〜1（既定 0.72） */
  quality?: number;
  /** これ以下のサイズ(byte)は圧縮しない（既定 300KB） */
  skipUnderBytes?: number;
}

export interface CompressResult {
  /** アップロードするファイル（圧縮できなければ元ファイル） */
  file: File;
  /** 圧縮されたか */
  compressed: boolean;
  /** 元サイズ(byte) */
  originalSize: number;
  /** 出力サイズ(byte) */
  outputSize: number;
}

async function decodeImage(file: File): Promise<ImageBitmap | null> {
  // createImageBitmap が使える環境では EXIF 回転も吸収できる
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    } catch {
      // 一部フォーマット(HEIC等)で失敗することがある → フォールバックへ
    }
  }
  // フォールバック: <img> でデコード
  return await new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // ImageBitmap 互換の最低限のプロパティだけ使うため as でキャスト
      resolve(img as unknown as ImageBitmap);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export async function compressImage(
  file: File,
  opts: CompressOptions = {}
): Promise<CompressResult> {
  // レシートは文字の可読性が重要なので長辺2000px・画質0.75を既定にする
  const maxEdge = opts.maxEdge ?? 2000;
  const quality = opts.quality ?? 0.75;
  const skipUnderBytes = opts.skipUnderBytes ?? 300 * 1024;

  const original: CompressResult = {
    file,
    compressed: false,
    originalSize: file.size,
    outputSize: file.size,
  };

  // 画像以外・GIF(アニメ劣化回避)・十分小さいものは触らない
  if (
    typeof document === 'undefined' ||
    !file.type.startsWith('image/') ||
    file.type === 'image/gif' ||
    file.size <= skipUnderBytes
  ) {
    return original;
  }

  try {
    const source = await decodeImage(file);
    if (!source) return original;

    const srcW = (source as ImageBitmap).width;
    const srcH = (source as ImageBitmap).height;
    if (!srcW || !srcH) return original;

    const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return original;
    ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
    if ('close' in source && typeof (source as ImageBitmap).close === 'function') {
      (source as ImageBitmap).close();
    }

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
    );
    if (!blob || blob.size === 0) return original;

    // 圧縮しても小さくならないなら元を使う
    if (blob.size >= file.size) return original;

    const baseName = file.name.replace(/\.[^./\\]+$/, '') || 'receipt';
    const outFile = new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });

    return {
      file: outFile,
      compressed: true,
      originalSize: file.size,
      outputSize: outFile.size,
    };
  } catch {
    return original;
  }
}
