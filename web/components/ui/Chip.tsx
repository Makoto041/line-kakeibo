// チップ（カテゴリ・負担区分）。[アイコン 18][短い語 14/500]、高さ 42。
import { cx } from '@/lib/cx';
import type { AnyIcon } from './icons';

export function Chip({ icon: Icon, label, className }: { icon: AnyIcon; label: string; className?: string }) {
  return (
    <span
      className={cx(
        'kb-chip inline-flex h-7 max-w-full items-center gap-1.5 rounded-full pl-2.5 pr-3 text-kb-chip',
        className
      )}
    >
      <Icon size={14} strokeWidth={2} className="shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}
