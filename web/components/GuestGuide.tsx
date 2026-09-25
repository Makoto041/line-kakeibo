'use client';

import React from 'react';
import { MessageCircle, Check } from 'lucide-react';

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
        「<span className="font-semibold text-fg">500 ランチ</span>
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
    <div className={`glass rounded-2xl p-5 shadow-glass sm:p-6 ${className}`}>
      <h2 className="mb-1 flex items-center gap-2 text-[15px] font-semibold text-fg">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-accent text-accent-fg">
          <MessageCircle className="h-[18px] w-[18px]" strokeWidth={2.2} />
        </span>
        LINE家計簿の使い方
      </h2>
      <p className="mb-5 text-xs text-muted">
        LINEのトークに送るだけで、自動で家計簿がつけられます
      </p>

      {/* Steps */}
      <ol className="mb-6 space-y-4">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/12 text-sm font-bold text-accent">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-fg">{step.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>

      {/* トークのイメージ */}
      <div className="mb-6 rounded-xl bg-fg/[0.03] p-4">
        <p className="mb-2 text-[10px] font-medium text-muted">トークのイメージ</p>
        <div className="space-y-2">
          <div className="flex justify-end">
            <span className="inline-block max-w-[80%] rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-xs text-accent-fg shadow-sm">
              500 ランチ
            </span>
          </div>
          <div className="flex justify-start">
            <span className="inline-flex max-w-[80%] items-center gap-1.5 rounded-2xl rounded-tl-sm bg-card px-3 py-2 text-xs text-fg shadow-sm">
              <Check className="h-3.5 w-3.5 text-accent" />
              記録しました：食費 / ¥500 / ランチ
            </span>
          </div>
          <div className="flex justify-end">
            <span className="inline-block max-w-[80%] rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-xs text-accent-fg shadow-sm">
              家計簿
            </span>
          </div>
          <div className="flex justify-start">
            <span className="inline-block max-w-[80%] rounded-2xl rounded-tl-sm bg-card px-3 py-2 text-xs text-fg shadow-sm">
              今月の集計と専用リンクをお届けします
            </span>
          </div>
        </div>
      </div>

      {/* Commands */}
      <div>
        <p className="mb-2 text-xs font-medium text-muted">便利なコマンド</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {COMMANDS.map((item) => (
            <div
              key={item.command}
              className="flex items-center gap-2 rounded-lg border border-line bg-fg/[0.02] px-3 py-2"
            >
              <code className="shrink-0 rounded border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-xs font-semibold text-accent">
                {item.command}
              </code>
              <span className="text-xs leading-tight text-muted">{item.description}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
