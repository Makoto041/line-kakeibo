// Canonical categories used across the app
export const CANONICAL_CATEGORIES = [
  '食費',
  '交通費',
  '日用品',
  '娯楽',
  '衣服',
  '医療・健康',
  '教育',
  '通信費',
  '光熱費',
  '美容・理容',
  'その他',
];

// Alias mapping from various labels/keywords to canonical categories
const ALIAS_TO_CANONICAL: Record<string, string> = {
  // 食費
  '外食': '食費',
  '飲食': '食費',
  'ランチ': '食費',
  'ディナー': '食費',
  '朝食': '食費',
  'カフェ': '食費',
  'コンビニ': '食費',
  'スーパー': '食費',

  // 交通費
  '交通': '交通費',
  'ガソリン': '交通費',
  '駐車場': '交通費',
  '高速': '交通費',
  'ETC': '交通費',

  // 日用品
  '生活用品': '日用品',
  '消耗品': '日用品',
  'ドラッグストア': '日用品',
  '衛生用品': '日用品',
  // 美容・理容は独立カテゴリに保持
  '美容': '美容・理容',
  '理容': '美容・理容',
  '美容・理容': '美容・理容',

  // 娯楽
  '娯楽費': '娯楽',
  'エンタメ': '娯楽',
  '遊び': '娯楽',
  'レジャー': '娯楽',
  '交友費': '娯楽',
  '交際費': '娯楽',
  '飲み会': '娯楽',

  // 衣服
  '衣服費': '衣服',
  '衣類': '衣服',
  'ファッション': '衣服',
  'アパレル': '衣服',

  // 医療・健康
  '医療': '医療・健康',
  '医療費': '医療・健康',
  '健康': '医療・健康',
  '病院': '医療・健康',
  '薬': '医療・健康',
  '調剤': '医療・健康',
  'クリニック': '医療・健康',
  '整体': '医療・健康',
  'マッサージ': '医療・健康',
  '歯科': '医療・健康',
  '眼科': '医療・健康',

  // 教育
  '教育費': '教育',
  '学習': '教育',
  '参考書': '教育',
  '教材': '教育',
  '書籍': '教育',
  '本': '教育',

  // 光熱費
  '公共料金': '光熱費',

  // 通信費（独立カテゴリ）
  '通信費': '通信費',
  'インターネット': '通信費',
  '携帯': '通信費',
  'スマホ': '通信費',
  '電話': '通信費',
};

function normalizeString(s?: string): string {
  return (s || '')
    .replace(/\s+/g, '') // remove spaces
    .replace(/費$/, '') // drop trailing 「費」 if present
    .toLowerCase();
}

/**
 * Normalize a category name to one of the canonical categories.
 * If availableNames is provided, ensure the result is within that set; otherwise
 * return the best canonical match, or 'その他' as a safe fallback.
 */
export function normalizeCategoryName(
  input: string | null | undefined,
  availableNames?: string[]
): string {
  const safeAvailable = Array.isArray(availableNames) ? availableNames : undefined;
  const trimmed = (input || '').trim();
  if (!trimmed) {
    return pickAvailable('その他', safeAvailable);
  }

  // Exact match to available set takes precedence
  if (safeAvailable && safeAvailable.includes(trimmed)) return trimmed;

  // Exact match to canonical set
  if (CANONICAL_CATEGORIES.includes(trimmed)) {
    return pickAvailable(trimmed, safeAvailable);
  }

  const norm = normalizeString(trimmed);

  // Keyword/alias mapping
  for (const [alias, canonical] of Object.entries(ALIAS_TO_CANONICAL)) {
    const aliasNorm = normalizeString(alias);
    if (norm.includes(aliasNorm)) {
      return pickAvailable(canonical, safeAvailable);
    }
  }

  // Heuristic fallbacks by substring keywords
  if (/映画|ゲーム|カラオケ|ボウリング|コンサート|ライブ/.test(trimmed)) {
    return pickAvailable('娯楽', safeAvailable);
  }
  if (/薬|病院|クリニック|診療|歯科|整体/.test(trimmed)) {
    return pickAvailable('医療・健康', safeAvailable);
  }
  if (/電車|バス|タクシー|ガソリン|駐車場|高速|ETC/i.test(trimmed)) {
    return pickAvailable('交通費', safeAvailable);
  }
  if (/ユニクロ|服|衣類|アパレル|ファッション/.test(trimmed)) {
    return pickAvailable('衣服', safeAvailable);
  }
  if (/本|書籍|教材|学習|教育/.test(trimmed)) {
    return pickAvailable('教育', safeAvailable);
  }
  if (/電気|ガス|水道|通信|インターネット|Wi-?Fi|携帯/.test(trimmed)) {
    return pickAvailable('光熱費', safeAvailable);
  }
  if (/ランチ|ディナー|朝食|カフェ|コンビニ|スーパー|食|弁当/.test(trimmed)) {
    return pickAvailable('食費', safeAvailable);
  }

  return pickAvailable('その他', safeAvailable);
}

function pickAvailable(target: string, available?: string[]): string {
  if (!available || available.length === 0) return target;
  if (available.includes(target)) return target;

  // Prefer canonical categories that are present
  const firstCanonical = CANONICAL_CATEGORIES.find((c) => available.includes(c));
  if (firstCanonical) return firstCanonical;

  // Otherwise, pick 'その他' if available
  if (available.includes('その他')) return 'その他';

  // As a last resort, return the first available entry
  return available[0];
}
