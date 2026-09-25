'use client';

// 下から出るシート（詳細・設定などをまとめる場所）。
// - role="dialog" / aria-modal / aria-labelledby（見出し）
// - 背面の幕のタップと Esc で閉じる。Tab はシートの中で循環し、閉じたら開いたボタンへフォーカスを戻す
// - 開いている間は背面のスクロールを止める。中身だけがスクロールする（overscroll-behavior: contain）
// - 動き: 下から 280ms で出て 200ms で下がる。動きを減らす設定では動かさない
// - ページは「今開いているシート」を 1 つの state で持つ（シートの中で別のシートを重ねない）
import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode, type Ref, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'framer-motion';
import { ChevronLeft, X } from 'lucide-react';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import { IconButton } from './IconButton';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const EASE_OUT: [number, number, number, number] = [0.2, 0.8, 0.2, 1];

// ---- 背面のスクロール停止（シートが重なった瞬間も壊れないよう参照数で管理） ----
let lockCount = 0;
let savedStyles: { htmlOverflow: string; bodyOverflow: string; bodyPaddingRight: string } | null = null;

function lockScroll() {
  lockCount += 1;
  if (lockCount > 1) return;
  const html = document.documentElement;
  const body = document.body;
  const scrollbar = window.innerWidth - html.clientWidth;
  savedStyles = {
    htmlOverflow: html.style.overflow,
    bodyOverflow: body.style.overflow,
    bodyPaddingRight: body.style.paddingRight,
  };
  html.style.overflow = 'hidden';
  body.style.overflow = 'hidden';
  // PC のスクロールバーが消えて横にずれるのを防ぐ
  if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
}

function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount > 0 || !savedStyles) return;
  document.documentElement.style.overflow = savedStyles.htmlOverflow;
  document.body.style.overflow = savedStyles.bodyOverflow;
  document.body.style.paddingRight = savedStyles.bodyPaddingRight;
  savedStyles = null;
}

const noopSubscribe = () => () => {};
const noopClose = () => {};
/** サーバー描画・ハイドレーション中は false（portal 先の document.body がまだ無い） */
function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** 見出し（短い語） */
  title: string;
  /** 別のシートから来たときの戻る（見出しの左に丸ボタン） */
  onBack?: () => void;
  children: ReactNode;
  /** 中身の下に固定する操作（保存など） */
  footer?: ReactNode;
  /** 開いたときにフォーカスを置く要素（無ければシート自体） */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 閉じられない間（送信中など）。閉じるボタンを無効にし、Esc と背面のタップも無視する */
  closeDisabled?: boolean;
  className?: string;
}

export function Sheet({
  open,
  onClose,
  title,
  onBack,
  children,
  footer,
  initialFocusRef,
  closeDisabled = false,
  className,
}: SheetProps) {
  const isClient = useIsClient();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const handleClose = closeDisabled ? noopClose : onClose;
  const onCloseRef = useRef(handleClose);

  useEffect(() => {
    onCloseRef.current = handleClose;
  });

  useEffect(() => {
    if (!open || !isClient) return;
    const panel = panelRef.current;
    if (!panel) return;

    // 開いた要素（閉じたらここへ戻す）
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lockScroll();

    const focusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);

    const initial = initialFocusRef?.current;
    (initial && panel.contains(initial) ? initial : panel).focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 入力のある検索欄では、まずブラウザ標準の「消去」に任せる（もう一度押すと閉じる）
        const t = document.activeElement;
        if (t instanceof HTMLInputElement && t.type === 'search' && t.value !== '') return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!active || active === panel || !panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      unlockScroll();
      if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, [open, isClient, initialFocusRef]);

  if (!isClient) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <SheetLayer
          key="sheet"
          panelRef={panelRef}
          titleId={titleId}
          title={title}
          onClose={handleClose}
          closeDisabled={closeDisabled}
          onBack={onBack}
          footer={footer}
          className={className}
        >
          {children}
        </SheetLayer>
      )}
    </AnimatePresence>,
    document.body
  );
}

interface SheetLayerProps {
  panelRef: Ref<HTMLDivElement>;
  titleId: string;
  title: string;
  onClose: () => void;
  closeDisabled: boolean;
  onBack?: () => void;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

function SheetLayer({
  panelRef,
  titleId,
  title,
  onClose,
  closeDisabled,
  onBack,
  footer,
  className,
  children,
}: SheetLayerProps) {
  const reduceMotion = useReducedMotion();
  // 閉じる動きの間は背面の操作を妨げない
  const isPresent = useIsPresent();

  // 動きを減らす設定では動かさない（CSS 側の全体ルールと同じ扱い）
  const panelMotion = reduceMotion
    ? { initial: false as const, exit: { opacity: 0, transition: { duration: 0 } } }
    : {
        initial: { y: '100%' },
        animate: { y: 0, transition: { duration: 0.28, ease: EASE_OUT } },
        exit: { y: '100%', transition: { duration: 0.2, ease: EASE_OUT } },
      };
  const fade = reduceMotion ? 0 : 0.2;

  // iOS Safari は overflow: hidden だけでは背面のページが引っぱりで動くので、幕の上の指の動きを止める
  // （React の onTouchMove は passive で preventDefault が効かないため、直接登録する）
  const backdropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = backdropRef.current;
    if (!el) return;
    const stop = (e: TouchEvent) => e.preventDefault();
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, []);

  return (
    <div className="fixed inset-0 z-[60]" style={{ pointerEvents: isPresent ? 'auto' : 'none' }}>
      <motion.div
        ref={backdropRef}
        aria-hidden="true"
        className="kb-backdrop absolute inset-0 touch-none"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: fade } }}
        exit={{ opacity: 0, transition: { duration: fade } }}
        onClick={onClose}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="kb-sheet absolute inset-x-0 bottom-0 mx-auto flex max-h-[88dvh] w-full max-w-[440px] flex-col rounded-t-kb-xl outline-none"
        {...panelMotion}
      >
        <div aria-hidden="true" className="mx-auto mt-2 h-[5px] w-9 shrink-0 rounded-[3px] bg-[var(--kb-grabber)]" />
        <div className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-3">
          {onBack && <IconButton label={T.aria.back} icon={ChevronLeft} size={44} iconSize={22} onClick={onBack} />}
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-kb-sheet-title text-ink">
            {title}
          </h2>
          <IconButton label={T.aria.close} icon={X} size={44} iconSize={20} disabled={closeDisabled} onClick={onClose} />
        </div>
        <div
          className={cx(
            'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4',
            footer ? 'pb-2' : 'pb-[calc(16px+env(safe-area-inset-bottom,0px))]',
            className
          )}
        >
          {children}
        </div>
        {footer && (
          <div className="shrink-0 border-t border-divider px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))] pt-3">
            {footer}
          </div>
        )}
      </motion.div>
    </div>
  );
}
