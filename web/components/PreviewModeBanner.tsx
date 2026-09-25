'use client';

import { Eye } from 'lucide-react';

/**
 * ゲスト（プレビュー）モードの案内。ゲストシートの先頭に置く。
 * LINEボットから送られるリンクで開くと本人のデータが表示されることを案内する。
 */
export default function PreviewModeBanner() {
  return (
    <div className="kb-warn-row flex items-start gap-3 rounded-kb-banner px-4 py-3">
      <Eye className="mt-0.5 shrink-0 text-warn-icon" size={20} strokeWidth={2} />
      <p className="text-[14px] leading-relaxed">
        <span className="block font-semibold">プレビューモードで表示中</span>
        LINEボットから送られるリンクで開くと、あなたの家計簿データが表示されます。
      </p>
    </div>
  );
}
