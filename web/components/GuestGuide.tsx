'use client';

import React from 'react';
import { MessageCircle, Check } from 'lucide-react';
import { cx } from '@/lib/cx';

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
        「<span className="font-semibold text-ink">500 ランチ</span>
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
 * ゲスト（プレビュー）モード時の使い方ガイド（ゲストシートの中身）。
 * LINEボットの基本的な使い方とコマンドを紹介する。
 */
export default function GuestGuide({ className = '' }: { className?: string }) {
  return (
    <div className={cx('text-ink', className)}>
      <h3 className="mb-1 flex items-center gap-2.5 text-[16px] font-semibold">
        <span className="grid h-9 w-9 place-items-center rounded-full kb-btn-primary">
          <MessageCircle size={18} strokeWidth={2.2} />
        </span>
        LINE家計簿の使い方
      </h3>
      <p className="mb-5 text-[13px] text-ink-3">LINEのトークに送るだけで、自動で家計簿がつけられます</p>

      {/* Steps */}
      <ol className="mb-6 space-y-4">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span className="kb-chip flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-accent">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-[15px] font-semibold">{step.title}</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>

      {/* トークのイメージ */}
      <div className="kb-card-2 mb-6 rounded-kb-row p-4">
        <p className="mb-2 text-[11px] font-medium text-ink-4">トークのイメージ</p>
        <div className="space-y-2 text-[13px]">
          <div className="flex justify-end">
            <span className="inline-block max-w-[80%] rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-white">
              500 ランチ
            </span>
          </div>
          <div className="flex justify-start">
            <span className="kb-chip inline-flex max-w-[80%] items-center gap-1.5 rounded-2xl rounded-tl-sm px-3 py-2">
              <Check size={14} className="shrink-0 text-accent" />
              記録しました：食費 / ¥500 / ランチ
            </span>
          </div>
          <div className="flex justify-end">
            <span className="inline-block max-w-[80%] rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-white">
              家計簿
            </span>
          </div>
          <div className="flex justify-start">
            <span className="kb-chip inline-block max-w-[80%] rounded-2xl rounded-tl-sm px-3 py-2">
              今月の集計と専用リンクをお届けします
            </span>
          </div>
        </div>
      </div>

      {/* Commands */}
      <div>
        <p className="mb-2 text-[13px] font-semibold text-ink-3">便利なコマンド</p>
        <div className="grid grid-cols-1 gap-2">
          {COMMANDS.map((item) => (
            <div key={item.command} className="kb-chip flex items-center gap-3 rounded-xl px-3 py-2.5">
              <code className="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-[13px] font-semibold text-accent">
                {item.command}
              </code>
              <span className="text-[13px] leading-tight text-ink-3">{item.description}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
