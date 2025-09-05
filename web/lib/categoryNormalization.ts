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
  '衛生用品': '日用品',
  'ドラッグストア': '日用品',

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
};

function normalizeString(s?: string): string {
  return (s || '')
    .replace(/\s+/g, '')
    .replace(/費$/, '')
    .toLowerCase();
}

export function normalizeCategoryName(
  input: string | null | undefined,
  available?: string[]
): string {
  const trimmed = (input || '').trim();
  if (!trimmed) return pickAvailable('その他', available);

  if (available && available.includes(trimmed)) return trimmed;
  if (CANONICAL_CATEGORIES.includes(trimmed)) return pickAvailable(trimmed, available);

  const norm = normalizeString(trimmed);
  for (const [alias, canonical] of Object.entries(ALIAS_TO_CANONICAL)) {
    const a = normalizeString(alias);
    if (norm.includes(a)) return pickAvailable(canonical, available);
  }

  // heuristics
  if (/映画|ゲーム|カラオケ|ボウリング|コンサート|ライブ/.test(trimmed)) return pickAvailable('娯楽', available);
  if (/薬|病院|クリニック|診療|歯科|整体/.test(trimmed)) return pickAvailable('医療・健康', available);
  if (/電車|バス|タクシー|ガソリン|駐車場|高速|ETC/i.test(trimmed)) return pickAvailable('交通費', available);
  if (/ユニクロ|服|衣類|アパレル|ファッション/.test(trimmed)) return pickAvailable('衣服', available);
  if (/本|書籍|教材|学習|教育/.test(trimmed)) return pickAvailable('教育', available);
  if (/電気|ガス|水道/.test(trimmed)) return pickAvailable('光熱費', available);
  if (/通信|インターネット|Wi-?Fi|携帯|スマホ|電話/.test(trimmed)) return pickAvailable('通信費', available);
  if (/ランチ|ディナー|朝食|カフェ|コンビニ|スーパー|食|弁当/.test(trimmed)) return pickAvailable('食費', available);

  return pickAvailable('その他', available);
}

function pickAvailable(target: string, available?: string[]): string {
  if (!available || available.length === 0) return target;
  if (available.includes(target)) return target;
  if (available.includes('その他')) return 'その他';
  return available[0];
}

