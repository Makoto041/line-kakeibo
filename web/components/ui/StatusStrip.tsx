// 予算への計上の帯。計上中は緑の帯「予算に計上済み」、計上しないときは同じ位置に灰色の帯「予算外」。
import { Check, Minus } from 'lucide-react';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';

export function StatusStrip({ counted, className }: { counted: boolean; className?: string }) {
  return (
    <div
      className={cx(
        'flex h-9 items-center gap-2 rounded-kb-strip px-3 text-kb-strip',
        counted ? 'kb-strip-ok' : 'kb-strip-off',
        className
      )}
    >
      <span
        className={cx(
          'grid h-4 w-4 shrink-0 place-items-center rounded-full text-white',
          counted ? 'bg-ok-fill' : 'bg-off-fill'
        )}
      >
        {counted ? <Check size={10} strokeWidth={3.5} /> : <Minus size={10} strokeWidth={3.5} />}
      </span>
      <span className="truncate">{counted ? T.expenses.counted : T.expenses.uncounted}</span>
    </div>
  );
}
