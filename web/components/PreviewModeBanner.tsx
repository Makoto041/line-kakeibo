'use client';

import React from 'react';

/**
 * ゲスト（プレビュー）モード時に全ページ共通で表示するバナー。
 * LINEボットから送られるリンクで開くと本人のデータが表示されることを案内する。
 */
export default function PreviewModeBanner() {
  return (
    <div className="bg-gradient-to-r from-amber-50 via-orange-50 to-amber-50 border-b border-amber-200">
      <div className="max-w-4xl mx-auto px-4 py-2.5">
        <p className="flex items-start justify-center gap-2 text-xs sm:text-sm text-amber-800 leading-relaxed">
          <span className="text-base leading-none mt-0.5" aria-hidden="true">
            👀
          </span>
          <span>
            <span className="font-semibold">プレビューモードで表示中</span>
            <span className="hidden sm:inline"> — </span>
            <br className="sm:hidden" />
            LINEボットから送られるリンクで開くと、あなたの家計簿データが表示されます
          </span>
        </p>
      </div>
    </div>
  );
}
