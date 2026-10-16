'use client';

// 設定ページの「アプリとして使う」カード。ホーム画面への追加を、環境ごとに案内する（lib/installApp.ts）。
// - iPhone の Safari: 共有 →「ホーム画面に追加」の手順（自動のインストール案内が無いため）
// - LINE のアプリ内ブラウザ: ここからは追加できないので、Safari / ブラウザで開き直すボタン
// - Android / PC の Chrome・Edge: ブラウザのインストールの確認を出すボタン
// ホーム画面から開いているとき・追加できない環境・閉じたあとは出さない。
import React, { useState, useSyncExternalStore } from 'react';
import Image from 'next/image';
import { ExternalLink, Info, Share, SquarePlus, X } from 'lucide-react';
import {
  canPromptInstall,
  externalBrowserUrl,
  installVariant,
  isStandalone,
  promptInstall,
  subscribeInstall,
  wasInstalled,
} from '../../lib/installApp';

const DISMISS_KEY = 'installAppCardDismissed';
const noopSubscribe = () => () => {};

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // 保存できない環境では、この表示の間だけ閉じる
  }
}

const LOGIN_NOTE = '追加したアプリを初めて開いたときだけ、LINE ログインが出ます';

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 rounded-xl bg-fg/[0.04] px-2.5 py-2 text-[11.5px] leading-relaxed text-muted">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13.5px] leading-relaxed text-fg">
      <span className="mt-px grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-accent/12 text-xs font-bold text-emerald-700 dark:text-emerald-300">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

export default function InstallAppCard({ className = '' }: { className?: string }) {
  // ブラウザでだけ判定する（サーバーの描画とハイドレーションの間は出さない）
  const client = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const canPrompt = useSyncExternalStore(subscribeInstall, canPromptInstall, () => false);
  const installed = useSyncExternalStore(subscribeInstall, wasInstalled, () => false);
  const [dismissed, setDismissed] = useState(false);
  const [prompting, setPrompting] = useState(false);

  if (!client || installed || dismissed || readDismissed()) return null;
  const userAgent = navigator.userAgent;
  const variant = installVariant({
    userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone: isStandalone(),
    canPrompt,
  });
  if (!variant) return null;

  const dismiss = () => {
    writeDismissed();
    setDismissed(true);
  };

  const install = async () => {
    setPrompting(true);
    try {
      await promptInstall();
    } finally {
      setPrompting(false);
    }
  };

  const android = /Android/i.test(userAgent);

  return (
    <section aria-labelledby="install-app-title" className={`glass space-y-3.5 rounded-2xl p-4 shadow-glass ${className}`}>
      <div className="flex items-start gap-3">
        <Image src="/pwa/icon-192.png" alt="" width={44} height={44} className="h-11 w-11 shrink-0 rounded-[10px]" />
        <div className="min-w-0 flex-1">
          <h2 id="install-app-title" className="text-[15px] font-bold text-fg">
            アプリとして使う
          </h2>
          <p className="mt-0.5 text-xs leading-normal text-muted">ホーム画面のアイコンから、全画面で開けます</p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="閉じる"
          className="-mr-1.5 -mt-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-fg/5 hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {variant === 'ios' && (
        <>
          <ol className="space-y-2.5">
            <Step n={1}>
              アドレスバーの{' '}
              <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md bg-blue-500/10 align-[-5px] text-blue-600 dark:text-blue-400">
                <Share className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden="true" />
              </span>{' '}
              共有ボタンをタップ
              <span className="block text-xs text-muted">見当たらないときは「…」の中にあります</span>
            </Step>
            <Step n={2}>
              「<SquarePlus className="inline h-4 w-4 align-[-3px]" aria-hidden="true" /> ホーム画面に追加」を選ぶ
            </Step>
            <Step n={3}>「Web アプリとして開く」はオンのまま、右上の「追加」をタップ</Step>
          </ol>
          <Note>{LOGIN_NOTE}</Note>
        </>
      )}

      {(variant === 'line-ios' || variant === 'line-android') && (
        <>
          <p className="text-[13.5px] leading-relaxed text-fg/80">
            LINE の中で開いているため、ここからは追加できません。
            {variant === 'line-ios' ? 'Safari ' : 'ブラウザ'}で開いてから、この画面でもう一度追加してください。
          </p>
          <a
            href={externalBrowserUrl(window.location.href)}
            className="flex h-[46px] items-center justify-center gap-2 rounded-xl bg-accent text-sm font-semibold text-accent-fg transition-opacity hover:opacity-90"
          >
            <ExternalLink className="h-4 w-4" strokeWidth={2.2} />
            {variant === 'line-ios' ? 'Safari で開く' : 'ブラウザで開く'}
          </a>
          {variant === 'line-ios' && <Note>{LOGIN_NOTE}</Note>}
        </>
      )}

      {variant === 'prompt' && (
        <>
          <p className="text-[13.5px] leading-relaxed text-fg/80">
            {android ? 'ボタンを押すと、ホーム画面にアイコンを置けます。' : 'ボタンを押すと、PC にアプリとしてインストールできます。'}
          </p>
          <button
            type="button"
            onClick={install}
            disabled={prompting}
            className="flex h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-accent text-sm font-semibold text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <SquarePlus className="h-4 w-4" strokeWidth={2.2} />
            {android ? 'ホーム画面に追加' : 'インストール'}
          </button>
        </>
      )}
    </section>
  );
}
