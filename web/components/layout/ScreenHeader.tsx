// 画面の大見出し（家計簿 / 明細 / ふたり）と右の操作（ピル・丸ボタン）。
// 上 26px（＋安全領域）、左 24px・右 16px、操作の間隔 12px、見出し 26/700。
import type { ReactNode } from 'react';

export function ScreenHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <header className="pl-6 pr-4" style={{ paddingTop: 'calc(var(--kb-header-top) + var(--kb-safe-top))' }}>
      <div className="flex h-12 items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-kb-title text-ink">{title}</h1>
        {right && <div className="flex shrink-0 items-center gap-3">{right}</div>}
      </div>
    </header>
  );
}
