'use client';

// デモ（/demo 以下）の枠: 「架空のデータです」の帯、場面のタブ（前へ / 次へ）、テーマの切り替え、背景。
// 本番のナビ（AppShell）は使わない（LINE ログイン・Firebase を読み込まないため）。リンクは /demo 以下だけ。
// 場面の中身は各ページが DemoClientOnly で包み、マウントしてから描く（枠と目次はサーバーで描く。404 の本文はブラウザ側で描かれる）。
import { useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, Info, Wallet } from 'lucide-react';
import { ThemeToggle } from '../ThemeToggle';
import { DEMO_INDEX_HREF, DEMO_LOGIN_HREF, demoScenes, sceneIndexOf, type DemoScene } from '../../lib/demo/demoScenes';
import { sceneIcon } from './sceneIcons';

function StepLink({ scene, dir }: { scene: DemoScene | null; dir: 'prev' | 'next' }) {
  const Icon = dir === 'prev' ? ChevronLeft : ChevronRight;
  const label = dir === 'prev' ? '前の場面' : '次の場面';
  const className = 'grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-line bg-card/70 text-muted';
  if (!scene) {
    return (
      <span aria-hidden className={`${className} opacity-35`}>
        <Icon className="h-4 w-4" />
      </span>
    );
  }
  return (
    <Link
      href={scene.href}
      aria-label={`${label}: ${scene.label}`}
      title={`${label}: ${scene.label}`}
      className={`${className} transition-colors hover:bg-fg/5 hover:text-fg`}
    >
      <Icon className="h-4 w-4" />
    </Link>
  );
}

export default function DemoShell({ children }: { children: ReactNode }) {
  const current = sceneIndexOf(usePathname());
  // 目次では「次へ」が最初の場面
  const prev = current > 0 ? demoScenes[current - 1] : null;
  const next = current < 0 ? demoScenes[0] ?? null : demoScenes[current + 1] ?? null;

  // 狭い画面ではタブが横にあふれるので、今の場面のタブを帯の中央へ寄せる（帯の中だけを動かし、ページは動かさない）
  const tabsRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = tabsRef.current;
    const active = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !active) return;
    list.scrollLeft = active.offsetLeft - (list.clientWidth - active.offsetWidth) / 2;
  }, [current]);

  return (
    <div className="min-h-dvh pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <div className="app-bg-blob" aria-hidden />

      <header className="sticky top-0 z-30 glass-bar border-b border-line/60">
        <p className="flex items-center justify-center gap-1.5 bg-amber-500/15 px-4 py-1.5 text-center text-xs font-medium text-amber-800 dark:text-amber-200">
          <Info className="h-3.5 w-3.5 shrink-0" />
          架空のデータで動くデモです<span className="hidden sm:inline">（人物・お店・金額はすべて架空です）</span>
        </p>
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 pt-3 md:px-8">
          <Link href={DEMO_INDEX_HREF} className="flex min-w-0 items-center gap-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent text-accent-fg">
              <Wallet className="h-[18px] w-[18px]" strokeWidth={2.2} />
            </span>
            <span className="truncate text-[15px] font-semibold tracking-tight text-fg">ぶちこむ家計簿</span>
            <span className="shrink-0 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-semibold text-accent">デモ</span>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            {/* 本番へ出る唯一のリンク。ページごと読み込み直して、LINE ログインを始める */}
            <a
              href={DEMO_LOGIN_HREF}
              className="rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg transition-opacity hover:opacity-90"
            >
              LINE でログイン
            </a>
            <ThemeToggle size="sm" />
          </div>
        </div>
        <nav aria-label="デモの場面" className="mx-auto flex w-full max-w-5xl items-center gap-2 px-4 py-3 md:px-8">
          <StepLink scene={prev} dir="prev" />
          <ol ref={tabsRef} className="relative flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-xl bg-fg/[0.04] p-1">
            {demoScenes.map((scene, i) => {
              const Icon = sceneIcon(scene.key);
              const active = i === current;
              return (
                <li key={scene.key} className="flex-1">
                  <Link
                    href={scene.href}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                      active ? 'bg-accent text-accent-fg shadow-sm' : 'text-muted hover:bg-fg/5 hover:text-fg'
                    }`}
                  >
                    <span className="tabular-nums opacity-70">{i + 1}</span>
                    <Icon className="hidden h-4 w-4 sm:block" />
                    {scene.label}
                  </Link>
                </li>
              );
            })}
          </ol>
          <StepLink scene={next} dir="next" />
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 py-5 md:px-8 md:py-7">{children}</main>
    </div>
  );
}
