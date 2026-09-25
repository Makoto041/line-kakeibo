// ホームの琥珀の行「要確認 n ›」。件数が 0 のときは出さない（呼び出し側で判断）。押すと明細の要確認へ。
// 高さ 52・角丸 16・左右 16（design.md §3.4）。
import Link from 'next/link';
import { ChevronRight, Clock } from 'lucide-react';
import { T } from '@/lib/uiText';

export function ReviewBanner({ count }: { count: number }) {
  return (
    <Link
      href="/expenses/?filter=pending"
      className="kb-warn-row mx-4 mt-6 flex h-[52px] items-center rounded-kb-banner pl-[17px] pr-2 transition-opacity active:opacity-80"
    >
      <Clock size={28} strokeWidth={2} aria-hidden="true" className="shrink-0 text-warn-icon" />
      <span className="ml-[19px] text-kb-banner">{T.home.review}</span>
      <span className="ml-[14px] text-kb-banner">{count}</span>
      <span className="flex-1" />
      <ChevronRight size={24} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-warn-icon" />
    </Link>
  );
}
