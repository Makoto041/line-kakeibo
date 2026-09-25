// 金額（主役の数字）。¥ は半角 U+00A5 で数字と同じ大きさ。数字はプロポーショナル（tabular-nums は使わない）。
// 桁が増えても省略記号は使わず、文字サイズだけを段階的に下げて幅に収める（money.amountTier）。
import { cx } from '@/lib/cx';
import { amountTier, yen } from '@/lib/money';

type Base = 62 | 68 | 44 | 24 | 22;

const LINE_HEIGHT: Record<Base, number> = { 62: 1.1, 68: 1.1, 44: 1.15, 24: 1.2, 22: 1.2 };

interface AmountProps {
  /** 金額。null は計算できない状態（「—」） */
  value: number | null;
  /** 基準の文字サイズ（px） */
  base: Base;
  /** 表示文字を直接渡す（符号付きなど） */
  text?: string;
  className?: string;
  weight?: 600 | 700;
}

export function Amount({ value, base, text, className, weight = 700 }: AmountProps) {
  const shown = text ?? (value == null ? '—' : yen(value));
  const tier = amountTier(shown, base);
  // 予算残りの基準 62 は、段階を下げないときだけ 64 で描く（見本の字幅に合わせる。段階の閾値はそのまま）
  const px = base === 62 && tier === 62 ? 64 : tier;
  return (
    <span
      className={cx('inline-block whitespace-nowrap', className)}
      style={{
        fontSize: `${px}px`,
        lineHeight: LINE_HEIGHT[base],
        fontWeight: weight,
        letterSpacing: base >= 62 ? 0 : '-0.01em',
        fontVariantNumeric: 'normal',
      }}
    >
      {shown}
    </span>
  );
}
