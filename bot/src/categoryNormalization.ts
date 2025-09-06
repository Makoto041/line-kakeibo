// Canonical categories used across the app
export const CANONICAL_CATEGORIES = [
  '食費',
  '交通費',
  '日用品',
  '娯楽',
  '衣服',
  '医療・健康',
  '教育',
  '光熱費',
  '住居費',
  '保険',
  '税金',
  '美容',
  '通信費',
  'サブスク',
  'プレゼント',
  '旅行',
  'ペット',
  '貯金',
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

  // 通信費
  '通信費': '通信費',
  'インターネット': '通信費',
  '携帯': '通信費',
  'スマホ': '通信費',
  '電話': '通信費',

  // 住居費
  '住居': '住居費',
  '家賃': '住居費',
  '管理費': '住居費',
  'ローン': '住居費',
  '住宅ローン': '住居費',
  '家具': '住居費',
  '家電': '住居費',

  // 保険
  '保険料': '保険',
  '生命保険': '保険',
  '医療保険': '保険',
  '自動車保険': '保険',
  '火災保険': '保険',

  // 税金
  '税': '税金',
  '所得税': '税金',
  '住民税': '税金',
  '固定資産税': '税金',
  '自動車税': '税金',

  // 美容
  '美容・理容': '美容',
  '理容': '美容',
  '化粧品': '美容',
  'コスメ': '美容',
  '美容院': '美容',
  'ネイル': '美容',
  'エステ': '美容',

  // サブスク
  'サブスクリプション': 'サブスク',
  'Netflix': 'サブスク',
  'Spotify': 'サブスク',
  'Prime': 'サブスク',

  // プレゼント
  'ギフト': 'プレゼント',
  'お祝い': 'プレゼント',
  'お返し': 'プレゼント',

  // 旅行
  'ホテル': '旅行',
  '宿泊': '旅行',
  '観光': '旅行',
  '温泉': '旅行',

  // ペット
  'ペットフード': 'ペット',
  '動物病院': 'ペット',

  // 貯金
  '投資': '貯金',
  '積立': '貯金',
  '定期預金': '貯金',
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
  if (/映画|ゲーム|カラオケ|ボウリング|コンサート|ライブ|遊園地/.test(trimmed)) {
    return pickAvailable('娯楽', safeAvailable);
  }
  if (/薬|病院|クリニック|診療|歯科|整体|マッサージ|ジム/.test(trimmed)) {
    return pickAvailable('医療・健康', safeAvailable);
  }
  if (/電車|バス|タクシー|ガソリン|駐車場|高速|ETC|地下鉄|新幹線/i.test(trimmed)) {
    return pickAvailable('交通費', safeAvailable);
  }
  if (/ユニクロ|服|衣類|アパレル|ファッション|しまむら|靴|帽子|バッグ/.test(trimmed)) {
    return pickAvailable('衣服', safeAvailable);
  }
  if (/本|書籍|教材|学習|教育|参考書|資格|講座|セミナー|文房具/.test(trimmed)) {
    return pickAvailable('教育', safeAvailable);
  }
  if (/電気|ガス|水道/.test(trimmed)) {
    return pickAvailable('光熱費', safeAvailable);
  }
  if (/通信|インターネット|Wi-?Fi|携帯|スマホ|電話|プロバイダ/.test(trimmed)) {
    return pickAvailable('通信費', safeAvailable);
  }
  if (/ランチ|ディナー|朝食|カフェ|コンビニ|スーパー|食|弁当|レストラン|マクドナルド|スターバックス/.test(trimmed)) {
    return pickAvailable('食費', safeAvailable);
  }
  if (/家賃|管理費|住宅ローン|修繕|家具|家電|リフォーム/.test(trimmed)) {
    return pickAvailable('住居費', safeAvailable);
  }
  if (/生命保険|医療保険|自動車保険|火災保険|年金/.test(trimmed)) {
    return pickAvailable('保険', safeAvailable);
  }
  if (/所得税|住民税|固定資産税|自動車税|国民健康保険/.test(trimmed)) {
    return pickAvailable('税金', safeAvailable);
  }
  if (/化粧品|美容院|ネイル|エステ|スキンケア|コスメ/.test(trimmed)) {
    return pickAvailable('美容', safeAvailable);
  }
  if (/Netflix|Amazon Prime|Spotify|YouTube Premium|サブスクリプション/.test(trimmed)) {
    return pickAvailable('サブスク', safeAvailable);
  }
  if (/プレゼント|ギフト|お祝い|お返し|誕生日|クリスマス/.test(trimmed)) {
    return pickAvailable('プレゼント', safeAvailable);
  }
  if (/旅行|ホテル|宿泊|観光|温泉|航空券/.test(trimmed)) {
    return pickAvailable('旅行', safeAvailable);
  }
  if (/ペット|犬|猫|ペットフード|動物病院|トリミング/.test(trimmed)) {
    return pickAvailable('ペット', safeAvailable);
  }
  if (/貯金|投資|積立|定期預金|株式|投資信託/.test(trimmed)) {
    return pickAvailable('貯金', safeAvailable);
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
