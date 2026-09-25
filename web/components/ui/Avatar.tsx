// 頭文字の丸（ふたりの精算・世帯のメンバー）。a は薄い青、b は薄い紫。
import { cx } from '@/lib/cx';

type Tone = 'a' | 'b' | 'neutral';

const SIZE_CLASS = {
  56: 'h-14 w-14 text-kb-avatar',
  32: 'h-8 w-8 text-[13px] font-semibold',
};

export function Avatar({
  initial,
  tone = 'a',
  size = 56,
  dim = false,
  className,
}: {
  initial: string;
  tone?: Tone;
  size?: 56 | 32;
  /** 精算なしのとき受け取る側を薄くする */
  dim?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'grid shrink-0 place-items-center overflow-hidden rounded-full whitespace-nowrap text-ink',
        SIZE_CLASS[size],
        tone === 'a' && 'kb-avatar-a',
        tone === 'b' && 'kb-avatar-b',
        tone === 'neutral' && 'kb-chip',
        dim && 'opacity-40',
        className
      )}
    >
      {initial}
    </span>
  );
}
