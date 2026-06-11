'use client';

import React from 'react';

const STEPS: Array<{
  title: string;
  description: React.ReactNode;
}> = [
  {
    title: 'LINEでボットを友だち追加',
    description: 'LINE家計簿ボットを友だち追加すると、トークで支出を記録できるようになります。',
  },
  {
    title: 'トークで支出を送信',
    description: (
      <>
        「<span className="font-semibold text-gray-800">500 ランチ</span>
        」のように金額と内容を送るだけで、カテゴリも自動で分類して記録されます。
        レシート画像の送信にも対応しています。
      </>
    ),
  },
  {
    title: '「家計簿」と送信',
    description: '今月の集計とあなた専用のリンクが届きます。リンクを開くと、このアプリにあなたのデータが表示されます。',
  },
];

const COMMANDS: Array<{ command: string; description: string }> = [
  { command: '家計簿', description: '今月の集計と専用リンクを表示' },
  { command: 'カテゴリー', description: 'カテゴリ一覧の確認' },
  { command: '立替', description: '立替中の支出を一覧表示' },
  { command: '精算', description: '立替の精算を実行' },
];

/**
 * ゲスト（プレビュー）モード時に表示する使い方ガイド。
 * LINEボットの基本的な使い方とコマンドを視覚的に紹介する。
 */
export default function GuestGuide({ className = '' }: { className?: string }) {
  return (
    <div
      className={`bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100 p-5 sm:p-6 ${className}`}
    >
      <h2 className="text-lg font-semibold text-gray-900 mb-1 flex items-center gap-2">
        <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center text-white text-sm">
          💬
        </span>
        LINE家計簿の使い方
      </h2>
      <p className="text-xs text-gray-500 mb-5">
        LINEのトークに送るだけで、自動で家計簿がつけられます
      </p>

      {/* Steps */}
      <ol className="space-y-4 mb-6">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-sm font-bold flex items-center justify-center">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-800">{step.title}</p>
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>

      {/* LINE風トークのイメージ */}
      <div className="rounded-xl bg-[#8cabd8]/20 p-4 mb-6">
        <p className="text-[10px] font-medium text-gray-500 mb-2">トークのイメージ</p>
        <div className="space-y-2">
          <div className="flex justify-end">
            <span className="inline-block max-w-[80%] bg-[#8de055] text-gray-900 text-xs rounded-2xl rounded-tr-sm px-3 py-2 shadow-sm">
              500 ランチ
            </span>
          </div>
          <div className="flex justify-start">
            <span className="inline-block max-w-[80%] bg-white text-gray-700 text-xs rounded-2xl rounded-tl-sm px-3 py-2 shadow-sm">
              ✅ 記録しました
              <br />
              🍽️ 食費 / ¥500 / ランチ
            </span>
          </div>
          <div className="flex justify-end">
            <span className="inline-block max-w-[80%] bg-[#8de055] text-gray-900 text-xs rounded-2xl rounded-tr-sm px-3 py-2 shadow-sm">
              家計簿
            </span>
          </div>
          <div className="flex justify-start">
            <span className="inline-block max-w-[80%] bg-white text-gray-700 text-xs rounded-2xl rounded-tl-sm px-3 py-2 shadow-sm">
              📊 今月の集計と専用リンクをお届けします
            </span>
          </div>
        </div>
      </div>

      {/* Commands */}
      <div>
        <p className="text-xs font-medium text-gray-600 mb-2">便利なコマンド</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {COMMANDS.map((item) => (
            <div
              key={item.command}
              className="flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2"
            >
              <code className="flex-shrink-0 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-100 rounded px-1.5 py-0.5">
                {item.command}
              </code>
              <span className="text-xs text-gray-500 leading-tight">{item.description}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
