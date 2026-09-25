'use client';

// レシートシート（詳細シートのレシート行から開く）。画像・差し替え（/attach へ）・新しいタブで開く。
// URL は https / blob だけを通す（toSafeImageUrl）。
import { useState } from 'react';
import { ExternalLink, ImageOff, RefreshCw } from 'lucide-react';
import type { Expense } from '@/lib/hooks';
import { toSafeImageUrl } from '@/lib/imageUrl';
import { T } from '@/lib/uiText';
import { Sheet } from '@/components/ui/Sheet';

const ACTION =
  'kb-glass-2 inline-flex h-[52px] flex-1 items-center justify-center gap-2.5 rounded-full px-4 text-[17px] font-semibold text-ink transition-[transform,opacity] duration-150 active:scale-[0.98]';

interface ReceiptSheetProps {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  expense: Expense | null;
  /** ゲストは差し替えを出さない */
  readOnly?: boolean;
}

export function ReceiptSheet({ open, onClose, onBack, expense, readOnly = false }: ReceiptSheetProps) {
  const [kept, setKept] = useState<Expense | null>(expense);
  if (expense && expense !== kept) setKept(expense);
  const shown = expense ?? kept;
  const safeUrl = toSafeImageUrl(shown?.receiptUrl);
  // 読み込めなかった画像（期限切れの URL など）は、壊れた画像ではなくアイコンを出す
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = !!safeUrl && failedUrl !== safeUrl;

  return (
    <Sheet open={open && !!shown} onClose={onClose} onBack={onBack} title={T.receipt.title}>
      {shown && (
        <div className="pb-1">
          <div className="grid min-h-[200px] place-items-center overflow-hidden rounded-2xl bg-skeleton p-2">
            {showImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={safeUrl}
                alt={T.receipt.title}
                onError={() => setFailedUrl(safeUrl)}
                className="max-h-[56dvh] w-auto rounded-xl object-contain"
              />
            ) : (
              <ImageOff size={36} strokeWidth={1.8} aria-hidden="true" className="text-ink-4" />
            )}
          </div>
          <div className="mt-4 flex gap-3">
            {!readOnly && (
              <a href={`/attach/?expenseId=${encodeURIComponent(shown.id)}`} className={ACTION}>
                <RefreshCw size={20} strokeWidth={2} aria-hidden="true" />
                {T.receipt.replace}
              </a>
            )}
            {safeUrl && (
              <a href={safeUrl} target="_blank" rel="noopener noreferrer" className={ACTION}>
                <ExternalLink size={20} strokeWidth={2} aria-hidden="true" />
                {T.receipt.open}
              </a>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
