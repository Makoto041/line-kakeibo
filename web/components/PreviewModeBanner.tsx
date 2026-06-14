'use client';

import { Eye } from 'lucide-react';

/**
 * ゲスト（プレビュー）モード時に表示するバナー。
 * LINEボットから送られるリンクで開くと本人のデータが表示されることを案内する。
 */
export default function PreviewModeBanner() {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-amber-500/20 bg-amber-500/[0.08] px-4 py-3 text-amber-700 dark:text-amber-300">
      <Eye className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.1} aria-hidden />
      <p className="text-xs leading-relaxed sm:text-sm">
        <span className="font-semibold">プレビューモードで表示中</span>
        <span className="hidden sm:inline"> — </span>
        <br className="sm:hidden" />
        LINEボットから送られるリンクで開くと、あなたの家計簿データが表示されます。
      </p>
    </div>
  );
}
