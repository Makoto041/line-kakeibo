"use client";

import { Paperclip, X, RefreshCw, ExternalLink } from "lucide-react";
import { isSafeImageUrl } from "../../lib/imageUrl";

/** レシートのインラインプレビュー（新規タブで開かず、その場で表示＋差し替え） */
export default function ReceiptModal({ url, expenseId, onClose }: { url: string; expenseId: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="レシートプレビュー"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="glass-strong relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl shadow-glass">
        <div className="flex items-center justify-between border-b border-line/60 px-4 py-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Paperclip className="h-4 w-4 text-amber-500" />
            レシート
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-fg/5"
            aria-label="閉じる"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto bg-fg/[0.03] p-3">
          {isSafeImageUrl(url) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt="レシート"
              className="mx-auto max-h-[60vh] w-auto rounded-lg object-contain"
            />
          ) : (
            <p className="py-10 text-center text-sm text-muted">画像を表示できません</p>
          )}
        </div>
        <div className="flex gap-2 border-t border-line/60 p-3">
          <a
            href={`/attach?expenseId=${encodeURIComponent(expenseId)}`}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent/12 px-4 py-2.5 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
          >
            <RefreshCw className="h-4 w-4" />
            差し替え
          </a>
          {isSafeImageUrl(url) && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-fg/5"
            >
              <ExternalLink className="h-4 w-4" />
              新しいタブ
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
