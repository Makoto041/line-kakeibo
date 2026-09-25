'use client';

// セグメント（明細の すべて / 要確認 n / 立替、設定のタブなど）。
// 各項目はボタン＋aria-pressed。件数は 0 のときだけ消す（ラベルは残す）。
import { cx } from '@/lib/cx';

export interface SegmentItem<K extends string> {
  key: K;
  label: string;
  count?: number;
}

interface SegmentedControlProps<K extends string> {
  items: ReadonlyArray<SegmentItem<K>>;
  value: K;
  onChange: (key: K) => void;
  /** グループのアクセシブルネーム（画面には出さない） */
  ariaLabel?: string;
  className?: string;
  /** 高さ（既定 36。シートの中は 32） */
  height?: 36 | 32;
}

export function SegmentedControl<K extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className,
  height = 36,
}: SegmentedControlProps<K>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cx('kb-seg grid rounded-full p-[2px]', height === 36 ? 'h-9' : 'h-8', className)}
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.key)}
            className={cx(
              'flex h-full min-w-0 items-center justify-center rounded-full px-2 text-kb-seg whitespace-nowrap transition-colors duration-150',
              active ? 'kb-seg-on font-semibold' : 'text-ink'
            )}
          >
            <span className="truncate">{item.label}</span>
            {item.count ? <span className="ml-1.5 tabular-nums">{item.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
