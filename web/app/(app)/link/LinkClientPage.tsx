"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Link2, AlertTriangle, CheckCircle2 } from "lucide-react";

export default function LinkClientPage() {
  const searchParams = useSearchParams();
  const [loading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);

  const token = searchParams.get("token");
  const lineId = searchParams.get("lineId");

  const verifyToken = useCallback(async () => {
    // LINE ID only auth: just confirm token & lineId are present.
    if (token && lineId) {
      setTokenValid(true);
    } else {
      setError("リンクが無効です。");
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

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass w-full max-w-md rounded-2xl p-8 text-center shadow-glass">{children}</div>
    </div>
  );

  if (tokenValid === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="mt-3 text-sm text-muted">リンクを確認中...</p>
        </div>
      </div>
    );
  }

  if (!tokenValid) {
    return (
      <Shell>
        <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/12 text-rose-500">
          <AlertTriangle className="h-7 w-7" />
        </span>
        <h1 className="text-lg font-semibold text-fg">無効なリンク</h1>
        <p className="mt-2 text-sm text-muted">{error}</p>
        <p className="mt-1 text-xs text-muted">LINEボットから新しいリンクを取得してください。</p>
      </Shell>
    );
  }

  if (success) {
    return (
      <Shell>
        <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-accent/12 text-accent">
          <CheckCircle2 className="h-7 w-7" />
        </span>
        <h1 className="text-lg font-semibold text-fg">連携完了</h1>
        <p className="mt-2 text-sm text-muted">
          LINEアカウントの連携が完了しました。LINEボットからの支出データがWebアプリに表示されます。
        </p>
        <a
          href={`/expenses${lineId ? `?lineId=${encodeURIComponent(lineId)}` : ""}`}
          className="mt-5 inline-flex items-center rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:opacity-90"
        >
          支出一覧を見る
        </a>
      </Shell>
    );
  }

  return (
    <Shell>
      <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-accent/12 text-accent">
        <Link2 className="h-7 w-7" strokeWidth={2.1} />
      </span>
      <h1 className="text-lg font-semibold text-fg">アカウント連携</h1>
      <p className="mt-2 text-sm text-muted">
        LINEボットとの連携を確認して、支出データをWebアプリで確認できるようにします。
      </p>

      {error && (
        <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] p-3">
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        </div>
      )}

      <button
        onClick={handleLinkConfirm}
        disabled={loading}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-medium text-accent-fg transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Link2 className="h-5 w-5" strokeWidth={2.1} />
        連携を確認
      </button>

      <p className="mt-4 text-xs text-muted">このリンクは15分で期限切れになります。</p>
    </Shell>
  );
}
