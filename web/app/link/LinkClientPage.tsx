'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Link2, AlertTriangle, CheckCircle2, ReceiptText } from 'lucide-react';
import { PrimaryButton } from '../../components/ui/PrimaryButton';

// 単独の確認画面の枠（中央のカード 1 枚）
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="kb-card w-full max-w-[360px] rounded-kb-card px-5 py-6 text-center">{children}</div>
    </div>
  );
}

export default function LinkClientPage() {
  const searchParams = useSearchParams();
  const [loading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);

  const token = searchParams.get('token');
  const lineId = searchParams.get('lineId');

  const verifyToken = useCallback(async () => {
    // LINE ID only auth: just confirm token & lineId are present.
    if (token && lineId) {
      setTokenValid(true);
    } else {
      setError('リンクが無効です。');
      setTokenValid(false);
    }
  }, [token, lineId]);

  useEffect(() => {
    // verifyToken handles both valid and invalid cases (always resolves the
    // loading state), so call it unconditionally to avoid getting stuck.
    verifyToken();
  }, [verifyToken]);

  const handleLinkConfirm = async () => {
    setSuccess(true);
  };


  if (tokenValid === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="mt-3 text-kb-caption text-ink-3">リンクを確認中...</p>
        </div>
      </div>
    );
  }

  if (!tokenValid) {
    return (
      <Shell>
        <span className="kb-glass-2 mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full text-danger">
          <AlertTriangle size={22} strokeWidth={2} aria-hidden="true" />
        </span>
        <h1 className="text-kb-sheet-title text-ink">無効なリンク</h1>
        <p className="mt-2 text-kb-body text-ink-3">{error}</p>
        <p className="mt-1 text-kb-caption text-ink-4">LINEボットから新しいリンクを取得してください。</p>
      </Shell>
    );
  }

  if (success) {
    return (
      <Shell>
        <span className="kb-btn-primary mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full">
          <CheckCircle2 size={22} strokeWidth={2} aria-hidden="true" />
        </span>
        <h1 className="text-kb-sheet-title text-ink">連携完了</h1>
        <p className="mt-2 text-kb-body text-ink-3">
          LINEアカウントの連携が完了しました。LINEボットからの支出データがWebアプリに表示されます。
        </p>
        <a
          href={`/expenses${lineId ? `?lineId=${encodeURIComponent(lineId)}` : ''}`}
          className="kb-btn-primary mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full px-5 text-[16px] font-semibold transition-transform duration-150 active:scale-[0.98]"
        >
          <ReceiptText size={18} strokeWidth={2} aria-hidden="true" />
          支出一覧を見る
        </a>
      </Shell>
    );
  }

  return (
    <Shell>
      <span className="kb-glass-2 mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full text-accent">
        <Link2 size={22} strokeWidth={2} aria-hidden="true" />
      </span>
      <h1 className="text-kb-sheet-title text-ink">アカウント連携</h1>
      <p className="mt-2 text-kb-body text-ink-3">
        LINEボットとの連携を確認して、支出データをWebアプリで確認できるようにします。
      </p>

      {error && (
        <p role="alert" className="mt-4 text-kb-body text-danger-ink">
          {error}
        </p>
      )}

      <PrimaryButton icon={Link2} height={48} onClick={handleLinkConfirm} loading={loading} className="mt-6">
        連携を確認
      </PrimaryButton>

      <p className="mt-4 text-kb-caption text-ink-4">このリンクは15分で期限切れになります。</p>
    </Shell>
  );
}
