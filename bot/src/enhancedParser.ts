import { ReceiptItem, ParsedReceipt } from './parser';

/**
 * 日本の主要チェーン店のレシートフォーマット定義
 * 各店舗の特徴的なパターンを定義してOCR精度を向上
 */
const STORE_FORMATS = {
  'セブン-イレブン': {
    keywords: ['セブン-イレブン', 'セブンイレブン', '7-Eleven', '7-ELEVEn'],
    totalPatterns: [/合計\s*¥?(\d{1,3}(?:,\d{3})*)/i, /計\s*¥?(\d{1,3}(?:,\d{3})*)/i],
    taxPatterns: [/税込\s*¥?(\d{1,3}(?:,\d{3})*)/i],
    itemPattern: /^(.+?)\s+¥?(\d{1,3}(?:,\d{3})*)$/,
  },
  'ファミリーマート': {
    keywords: ['ファミリーマート', 'FamilyMart', 'ファミマ'],
    totalPatterns: [/合計\s*¥?(\d{1,3}(?:,\d{3})*)/i, /計\s*¥?(\d{1,3}(?:,\d{3})*)/i],
    taxPatterns: [/税込み\s*¥?(\d{1,3}(?:,\d{3})*)/i],
    itemPattern: /^(.+?)\s+¥?(\d{1,3}(?:,\d{3})*)$/,
  },
  'ローソン': {
    keywords: ['ローソン', 'LAWSON', 'Lawson'],
    totalPatterns: [/合計\s*¥?(\d{1,3}(?:,\d{3})*)/i, /計\s*¥?(\d{1,3}(?:,\d{3})*)/i],
    taxPatterns: [/税込\s*¥?(\d{1,3}(?:,\d{3})*)/i],
    itemPattern: /^(.+?)\s+¥?(\d{1,3}(?:,\d{3})*)$/,
  },
  'イオン': {
    keywords: ['イオン', 'AEON', 'aeon'],
    totalPatterns: [/合計金額\s*¥?(\d{1,3}(?:,\d{3})*)/i, /お買上金額\s*¥?(\d{1,3}(?:,\d{3})*)/i],
    taxPatterns: [/税込\s*¥?(\d{1,3}(?:,\d{3})*)/i],
    itemPattern: /^(.+?)\s+¥?(\d{1,3}(?:,\d{3})*)$/,
  },
  'ヨドバシカメラ': {
    keywords: ['ヨドバシカメラ', 'ヨドバシ', 'YODOBASHI'],
    totalPatterns: [/合計\s*¥?(\d{1,3}(?:,\d{3})*)/i, /小計\s*¥?(\d{1,3}(?:,\d{3})*)/i],
    taxPatterns: [/税込\s*¥?(\d{1,3}(?:,\d{3})*)/i],
    itemPattern: /^(.+?)\s+¥?(\d{1,3}(?:,\d{3})*)$/,
  }
};

/**
 * 商品カテゴリーの自動分類辞書
 * 商品名キーワードから適切なカテゴリーを推定
 */
const CATEGORY_KEYWORDS = {
  '食費': [
    // 基本食材
    'パン', 'ご飯', 'おにぎり', '弁当', '惣菜', 'サラダ', 'サンドイッチ',
    '野菜', '肉', '魚', '卵', '牛乳', 'チーズ', 'ヨーグルト', 'バター',
    '米', 'パスタ', 'うどん', 'そば', 'ラーメン', '醤油', '味噌', '砂糖', '塩',
    // 飲み物
    'コーヒー', '茶', 'ジュース', '水', 'ビール', 'ワイン', '日本酒', 'ウイスキー',
    // デザート・菓子
     'ケーキ', 'アイス', 'チョコ', 'お菓子', 'クッキー', 'プリン', 'ゼリー',
    // レストラン
    '定食', 'ランチ', 'ディナー', 'モーニング', 'セット', 'コース'
  ],
  '日用品': [
    '洗剤', 'シャンプー', 'コンディショナー', 'ボディソープ', '歯磨き粉', '歯ブラシ',
    'ティッシュ', 'トイレットペーパー', 'キッチンペーパー', 'ラップ', 'アルミホイル',
    '電池', '電球', 'ゴミ袋', 'スポンジ', 'ブラシ', 'タオル', '石鹸', '柔軟剤',
    'マスク', '絆創膏', '綿棒', 'コットン', 'ハンドクリーム', '日焼け止め'
  ],
  '交通費': [
    '切符', 'ICカード', 'チャージ', 'タクシー', 'バス', '電車', '地下鉄', '新幹線',
    'ガソリン', '駐車場', '高速', '通行料', 'ETC', '回数券', '定期券'
  ],
  '医療費': [
    '薬', '病院', 'クリニック', '診察', '検査', 'レントゲン', 'MRI', 'CT',
    'マッサージ', '整体', '鍼灸', '歯科', '眼科', '内科', '外科', '皮膚科',
    'サプリメント', 'ビタミン', '風邪薬', '胃薬', '目薬', '湿布'
  ],
  '娯楽費': [
    '映画', 'ゲーム', 'カラオケ', 'ボウリング', 'パチンコ', '競馬', '宝くじ',
    '本', '雑誌', 'DVD', 'CD', 'コンサート', 'ライブ', '美術館', '博物館',
    'スポーツ', 'ジム', 'プール', 'ゴルフ', 'テニス', 'フィットネス'
  ],
  '衣服費': [
    'シャツ', 'パンツ', 'スカート', 'ワンピース', 'ジャケット', 'コート',
    '靴', 'スニーカー', 'ブーツ', 'サンダル', 'バッグ', '財布', 'ベルト',
    '下着', '靴下', 'ストッキング', 'マフラー', '手袋', '帽子', 'アクセサリー'
  ],
  '教育費': [
    '授業料', '教材', '参考書', 'ノート', '文房具', 'ペン', '鉛筆', '消しゴム',
    '塾', '予備校', '習い事', 'レッスン', 'セミナー', '研修', '資格', '検定'
  ],
  '通信費': [
    '携帯', 'スマホ', '電話', 'インターネット', 'プロバイダ', 'WiFi',
    '通信料', '通話料', 'データ', 'プリペイド', 'チャージ'
  ]
};

/**
 * 高度なレシート解析エンジン
 * 日本のレシートフォーマットに特化した解析を実行
 * 期待効果: 抽出精度 25-30% 向上
 */
export function enhancedParseReceipt(ocrText: string): ParsedReceipt {
  console.log('=== ENHANCED RECEIPT PARSING START ===');
  
  const lines = preprocessOCRText(ocrText);
  console.log(`Preprocessed lines: ${lines.length}`);
  
  // 店舗識別
  const storeInfo = identifyStore(lines);
  console.log(`Identified store: ${storeInfo.name || 'Unknown'}`);
  
  // 金額抽出 (複数手法で精度向上)
  const totalAmount = extractTotalAmount(lines, storeInfo.format);
  console.log(`Extracted total: ¥${totalAmount}`);
  
  // 商品抽出
  const items = extractItems(lines, storeInfo.format);
  console.log(`Extracted items: ${items.length}`);
  
  // 日付抽出
  const receiptDate = extractDate(lines);
  console.log(`Extracted date: ${receiptDate || 'Not found'}`);

  console.log('=== ENHANCED RECEIPT PARSING END ===');

  return {
    storeName: storeInfo.name || 'レシート',
    total: totalAmount,
    items,
    date: receiptDate
  };
}

/**
 * OCRテキストの前処理
 * ノイズ除去・正規化・構造化
 */
function preprocessOCRText(ocrText: string): string[] {
  return ocrText
    .split('\\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    // 全角数字を半角に統一
    .map(line => line.replace(/[０-９]/g, (char) => 
      String.fromCharCode(char.charCodeAt(0) - 0xFEE0)))
    // 全角記号を半角に統一
    .map(line => line.replace(/[￥，]/g, (char) => 
      char === '￥' ? '¥' : ','))
    // 余分な空白を除去
    .map(line => line.replace(/\\s+/g, ' '));
}

/**
 * 店舗識別
 * 主要チェーン店のパターンマッチング
 */
function identifyStore(lines: string[]): { name: string | null, format: any } {
  for (const [storeName, format] of Object.entries(STORE_FORMATS)) {
    for (const line of lines.slice(0, 10)) { // 上位10行で店舗名を探す
      if (format.keywords.some(keyword => 
        line.toLowerCase().includes(keyword.toLowerCase()))) {
        return { name: storeName, format };
      }
    }
  }
  
  // 一般的なフォーマットをフォールバック
  return { 
    name: null, 
    format: {
      totalPatterns: [
        /合計\s*¥?(\d{1,3}(?:,\d{3})*)/i,
        /総計\s*¥?(\d{1,3}(?:,\d{3})*)/i,
        /計\s*¥?(\d{1,3}(?:,\d{3})*)/i,
        /小計\s*¥?(\d{1,3}(?:,\d{3})*)/i
      ],
      itemPattern: /^(.+?)\s+¥?(\d{1,3}(?:,\d{3})*)$/
    }
  };
}

/**
 * 高精度金額抽出
 * 複数パターンでの抽出 + 検証
 */
function extractTotalAmount(lines: string[], storeFormat: any): number {
  const candidates: number[] = [];
  
  // 1. 店舗特化パターンで抽出
  if (storeFormat.totalPatterns) {
    for (const pattern of storeFormat.totalPatterns) {
      for (const line of lines) {
        const match = line.match(pattern);
        if (match) {
          const amount = parseInt(match[1].replace(/,/g, ''), 10);
          if (!isNaN(amount) && amount > 0) {
            candidates.push(amount);
          }
        }
      }
    }
  }
  
  // 2. 一般的な金額パターンで抽出
  const generalPatterns = [
    /(?:合計|総計|計|小計|税込)[^\\d]*¥?(\d{1,3}(?:,\d{3})*)/gi,
    /¥\\s*(\d{1,3}(?:,\d{3})*)[^\\d]*(?:合計|総計|計|小計)/gi,
    /(\d{1,3}(?:,\d{3})*)[^\\d]*円[^\\d]*(?:合計|総計|計)/gi
  ];
  
  for (const pattern of generalPatterns) {
    for (const line of lines) {
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const amount = parseInt(match[1].replace(/,/g, ''), 10);
        if (!isNaN(amount) && amount > 0) {
          candidates.push(amount);
        }
      }
    }
  }
  
  // 3. 最大値を抽出（通常、合計金額が最大）
  if (candidates.length > 0) {
    return Math.max(...candidates);
  }
  
  // 4. フォールバック: 行内最大数値
  const allNumbers = lines.flatMap(line => {
    const matches = line.match(/\\d{1,3}(?:,\\d{3})*/g) || [];
    return matches.map(m => parseInt(m.replace(/,/g, ''), 10))
      .filter(n => n >= 100 && n <= 100000); // 現実的な金額範囲
  });
  
  return allNumbers.length > 0 ? Math.max(...allNumbers) : 0;
}

/**
 * 商品抽出の改善
 * 店舗フォーマット対応 + カテゴリー推定
 */
function extractItems(lines: string[], storeFormat: any): ReceiptItem[] {
  const items: ReceiptItem[] = [];
  const pattern = storeFormat.itemPattern || /^(.+?)\\s+¥?(\\d{1,3}(?:,\\d{3})*)$/;
  
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      const name = cleanItemName(match[1]);
      const price = parseInt(match[2].replace(/,/g, ''), 10);
      
      if (name && !isNaN(price) && price > 0 && price < 50000) {
        items.push({
          name,
          price,
          quantity: 1 // 将来的に数量も抽出
        });
      }
    }
    
    // 別パターン: 商品名と価格が別行
    if (line.match(/^[^\\d¥]*$/)) { // 商品名らしい行
      const nextLineIndex = lines.indexOf(line) + 1;
      if (nextLineIndex < lines.length) {
        const nextLine = lines[nextLineIndex];
        const priceMatch = nextLine.match(/¥?(\\d{1,3}(?:,\\d{3})*)円?$/);
        if (priceMatch) {
          const price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
          if (!isNaN(price) && price > 0 && price < 50000) {
            items.push({
              name: cleanItemName(line),
              price,
              quantity: 1
            });
          }
        }
      }
    }
  }
  
  return deduplicateItems(items);
}

/**
 * 商品名のクリーニング
 */
function cleanItemName(rawName: string): string {
  return rawName
    .replace(/[¥\\d,円]/g, '') // 数字・通貨記号を除去
    .replace(/\\s+/g, ' ')      // 連続空白を単一に
    .replace(/[*＊]/g, '')      // アスタリスクを除去
    .trim();
}

/**
 * 重複商品の除去
 */
function deduplicateItems(items: ReceiptItem[]): ReceiptItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.name}-${item.price}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * 日付抽出の改善
 */
function extractDate(lines: string[]): string | undefined {
  const datePatterns = [
    /(\d{4})[/\\-年](\d{1,2})[/\\-月](\d{1,2})[日]?/,  // 2024/01/15, 2024年1月15日
    /(\d{1,2})[/\\-](\d{1,2})[/\\-](\d{4})/,           // 01/15/2024
    /(\d{2})[/\\-](\d{1,2})[/\\-](\d{1,2})/,          // 24/01/15
    /(令和|平成|昭和)(\\d{1,2})年(\\d{1,2})月(\\d{1,2})日/, // 令和6年1月15日
  ];
  
  for (const line of lines) {
    for (const pattern of datePatterns) {
      const match = line.match(pattern);
      if (match) {
        // 日付フォーマットを統一 (YYYY-MM-DD)
        try {
          let year, month, day;
          
          if (pattern.source.includes('令和|平成|昭和')) {
            // 和暦の処理
            const era = match[1];
            const eraYear = parseInt(match[2], 10);
            year = era === '令和' ? 2018 + eraYear : 
                   era === '平成' ? 1988 + eraYear : 
                   1925 + eraYear;
            month = parseInt(match[3], 10);
            day = parseInt(match[4], 10);
          } else if (match[1].length === 4) {
            // YYYY/MM/DD フォーマット
            year = parseInt(match[1], 10);
            month = parseInt(match[2], 10);
            day = parseInt(match[3], 10);
          } else if (match[3].length === 4) {
            // MM/DD/YYYY フォーマット
            month = parseInt(match[1], 10);
            day = parseInt(match[2], 10);
            year = parseInt(match[3], 10);
          } else {
            // YY/MM/DD フォーマット
            year = 2000 + parseInt(match[1], 10);
            month = parseInt(match[2], 10);
            day = parseInt(match[3], 10);
          }
          
          // 妥当性チェック
          if (year >= 2020 && year <= 2030 && 
              month >= 1 && month <= 12 && 
              day >= 1 && day <= 31) {
            return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
          }
        } catch (error) {
          console.warn('Date parsing error:', error);
        }
      }
    }
  }
  
  return undefined;
}

/**
 * 商品名から自動カテゴリー推定
 * 期待効果: 手動分類の手間を大幅削減
 */
export function autoClassifyCategory(itemName: string, storeName?: string): string {
  const normalizedName = itemName.toLowerCase();
  
  // 店舗による優先カテゴリー
  if (storeName) {
    if (storeName.includes('ドラッグ') || storeName.includes('薬局')) {
      if (normalizedName.includes('薬') || normalizedName.includes('サプリ')) {
        return '医療費';
      }
      return '日用品';
    }
    if (storeName.includes('ガソリン') || storeName.includes('ENEOS') || storeName.includes('昭和シェル')) {
      return '交通費';
    }
  }
  
  // キーワードマッチング
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(keyword => normalizedName.includes(keyword.toLowerCase()))) {
      return category;
    }
  }
  
  return 'その他';
}

/**
 * OCR結果の信頼度評価
 * 低信頼度の場合は手動確認を促す
 */
export function assessOCRConfidence(originalText: string, parsedResult: ParsedReceipt): {
  confidence: number;
  issues: string[];
  suggestions: string[];
} {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let confidence = 100;
  
  // 金額の妥当性チェック
  if (parsedResult.total === 0) {
    confidence -= 30;
    issues.push('合計金額が検出されませんでした');
    suggestions.push('画像を明るく撮り直してください');
  } else if (parsedResult.total > 100000) {
    confidence -= 20;
    issues.push('金額が高額すぎる可能性があります');
    suggestions.push('金額を手動で確認してください');
  }
  
  // 店舗名の妥当性チェック
  if (!parsedResult.storeName || parsedResult.storeName === 'レシート') {
    confidence -= 15;
    issues.push('店舗名が検出されませんでした');
    suggestions.push('レシート上部を含む全体を撮影してください');
  }
  
  // 商品情報の妥当性チェック
  if (parsedResult.items.length === 0) {
    confidence -= 20;
    issues.push('商品情報が検出されませんでした');
    suggestions.push('文字がはっきり見える角度で撮影してください');
  }
  
  // OCRテキストの品質チェック
  const textLength = originalText.length;
  if (textLength < 50) {
    confidence -= 25;
    issues.push('読み取り文字数が少なすぎます');
    suggestions.push('より高解像度で撮影してください');
  }
  
  return {
    confidence: Math.max(0, confidence),
    issues,
    suggestions
  };
}