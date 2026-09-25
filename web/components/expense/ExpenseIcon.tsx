// 明細の行アイコン（単色の紺の線画）。説明のキーワードで上書きし（スーパー → カート など）、
// 当たらなければカテゴリのアイコンを使う。表示だけでデータは変えない。
import { Coffee, ShoppingCart } from 'lucide-react';
import { TrainBoxy } from '@/lib/customIcons';
import { getCategoryVisual } from '@/lib/categoryVisuals';
import { rowIconKey } from '@/lib/expenseIcon';
import { cx } from '@/lib/cx';

export function ExpenseIcon({
  description,
  category,
  size = 22,
  className,
}: {
  description?: string | null;
  category?: string | null;
  size?: number;
  className?: string;
}) {
  const props = { size, strokeWidth: 1.9, 'aria-hidden': true, className: cx('shrink-0 text-ink', className) } as const;
  switch (rowIconKey(description)) {
    case 'cart':
      return <ShoppingCart {...props} />;
    case 'coffee':
      return <Coffee {...props} />;
    case 'train': {
      // 電車は見本どおりカート・カップより一回り大きく描き、外側の幅は変えない
      const big = Math.round(size * 1.12);
      const m = (size - big) / 2;
      return <TrainBoxy {...props} size={big} style={{ margin: `${m}px` }} />;
    }
    default: {
      const visual = getCategoryVisual(category);
      return <visual.icon {...props} />;
    }
  }
}

/** 行の見出し（説明。空ならカテゴリ） */
export function expenseLabel(e: { description?: string | null; category?: string | null }): string {
  return (e.description ?? '').trim() || e.category || '';
}
