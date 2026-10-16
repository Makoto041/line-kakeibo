// 「アプリとして使う」（PWA）: ホーム画面への追加の案内の出し分けと、Service Worker の登録・インストールの合図。
// 案内は設定ページのカード（components/settings/InstallAppCard.tsx）。Service Worker は public/sw.js

/** 案内の種類。null は出さない（追加済み・追加できない環境） */
export type InstallVariant = 'ios' | 'line-ios' | 'line-android' | 'prompt';

export interface InstallEnv {
  userAgent: string;
  /** iPad の Safari は Mac と同じ UA を名乗るため、タッチの有無で見分ける */
  maxTouchPoints: number;
  /** ホーム画面から開いている（display-mode: standalone / iOS の navigator.standalone） */
  standalone: boolean;
  /** beforeinstallprompt を受け取っている（Android / PC の Chrome・Edge） */
  canPrompt: boolean;
}

export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** LINE のアプリ内ブラウザ（LIFF を含む）。ここからはホーム画面に追加できない */
export function isLineInApp(userAgent: string): boolean {
  return /\bLine\//i.test(userAgent);
}

export function installVariant(env: InstallEnv): InstallVariant | null {
  if (env.standalone) return null;
  if (isLineInApp(env.userAgent)) {
    if (isIos(env.userAgent, env.maxTouchPoints)) return 'line-ios';
    return /Android/i.test(env.userAgent) ? 'line-android' : null;
  }
  if (env.canPrompt) return 'prompt';
  if (isIos(env.userAgent, env.maxTouchPoints)) return 'ios';
  return null;
}

/**
 * LINE のアプリ内ブラウザから外部ブラウザ（iPhone は Safari）で開き直す URL。
 * LINE は URL に openExternalBrowser=1 が付いていると外部ブラウザで開く
 */
export function externalBrowserUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set('openExternalBrowser', '1');
  return url.toString();
}

// ---- ブラウザでの状態（beforeinstallprompt / appinstalled） ----

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let started = false;
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

/**
 * アプリの起動時に 1 度だけ呼ぶ。beforeinstallprompt は設定ページを開く前に届くことがあるため、
 * ここで受け取って取っておく（Chrome の自動の案内は出さず、設定のカードのボタンから出す）。
 * Service Worker は本番だけ登録する（開発中に古い JS をつかまないように）
 */
export function startPwa(): void {
  if (typeof window === 'undefined' || started) return;
  started = true;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installed = true;
    emit();
  });

  if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch((error) => {
      console.warn('Service worker registration failed', error);
    });
  }
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

export function wasInstalled(): boolean {
  return installed;
}

/** ブラウザのインストールの確認を出す。同じ合図は 1 度しか使えない */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferredPrompt;
  if (!event) return 'unavailable';
  deferredPrompt = null;
  emit();
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === 'accepted') {
    installed = true;
    emit();
  }
  return outcome;
}

/** ホーム画面から開いているか（ブラウザでだけ呼ぶ） */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
