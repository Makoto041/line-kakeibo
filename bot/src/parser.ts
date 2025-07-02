export interface ReceiptItem {
  name: string;
  price: number;
  quantity?: number;
}

export interface ParsedReceipt {
  storeName: string;
  total: number;
  items: ReceiptItem[];
  date?: string;
}

export function parseReceipt(ocrText: string): ParsedReceipt {
  const lines = ocrText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  let storeName = '';
  let total = 0;
  const items: ReceiptItem[] = [];
  let receiptDate = '';

  // Store name (usually first non-empty line)
  if (lines.length > 0) {
    storeName = lines[0];
  }

  // Find total amount
  for (const line of lines) {
    // Look for total patterns
    if (line.match(/合計|総計|計|小計|税込/)) {
      const amounts = extractNumbers(line);
      if (amounts.length > 0) {
        total = Math.max(...amounts);
      }
    }
    
    // Look for item patterns (name + price)
    if (line.match(/¥|円|\d{2,}/)) {
      const amounts = extractNumbers(line);
      if (amounts.length > 0) {
        const price = amounts[amounts.length - 1]; // Last number is usually price
        const name = line.replace(/¥?\d+円?/g, '').trim();
        
        if (name && price > 0 && price < total * 0.8) { // Avoid counting total as item
          items.push({
            name: name || '商品',
            price
          });
        }
      }
    }

    // Find date
    if (line.match(/\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/)) {
      receiptDate = line;
    }
  }

  // If no total found, try to sum items
  if (total === 0 && items.length > 0) {
    total = items.reduce((sum, item) => sum + item.price, 0);
  }

  // If still no total, look for largest number
  if (total === 0) {
    const allNumbers = lines.flatMap(line => extractNumbers(line));
    if (allNumbers.length > 0) {
      total = Math.max(...allNumbers);
    }
  }

  return {
    storeName: storeName || 'レシート',
    total,
    items,
    date: receiptDate
  };
}

function extractNumbers(text: string): number[] {
  const matches = text.match(/\d{1,3}(,\d{3})*|\d+/g);
  if (!matches) return [];
  
  return matches
    .map(match => parseInt(match.replace(/,/g, ''), 10))
    .filter(num => !isNaN(num) && num > 0);
}

export function categorizeItem(itemName: string): string {
  const categories = {
    '食費': ['パン', 'おにぎり', '弁当', '野菜', '肉', '魚', '牛乳', '卵', 'お米', 'パスタ'],
    '日用品': ['洗剤', 'シャンプー', 'ティッシュ', 'トイレットペーパー', '歯ブラシ'],
    '交通費': ['切符', 'ICカード', 'タクシー', 'バス', '電車'],
    '医療費': ['薬', '病院', 'クリニック', 'ドラッグストア']
  };

  for (const [category, keywords] of Object.entries(categories)) {
    if (keywords.some(keyword => itemName.includes(keyword))) {
      return category;
    }
  }

  return 'その他';
}