'use client';

// 失敗を短い語で知らせるトースト（成功は画面の状態の変化で示す）。
// 語は uiText の T.toast に限る（8 字以内。説明文にしない）。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { T, type ToastKey } from '@/lib/uiText';

const TOAST_MS = 2500;

interface ToastContextValue {
  show: (key: ToastKey) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<{ id: number; key: ToastKey } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((key: ToastKey) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast((prev) => ({ id: (prev?.id ?? 0) + 1, key }));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setToast(null);
    }, TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* 読み上げのため、領域は常に置いておき中身だけを差し替える */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-4"
        style={{ bottom: 'var(--kb-content-bottom)' }}
      >
        {toast && (
          <div
            key={toast.id}
            className="rounded-full bg-fg/90 px-5 py-2.5 text-[15px] font-semibold text-bg shadow-lg"
          >
            {T.toast[toast.key]}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

/** Provider の外（単独ページなど）では何もしない */
export function useToast(): ToastContextValue {
  return useContext(ToastContext) ?? NOOP_TOAST;
}

const NOOP_TOAST: ToastContextValue = { show: () => {} };
