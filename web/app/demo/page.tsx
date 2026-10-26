import Link from 'next/link';
import { ChevronRight, Info } from 'lucide-react';
import { demoScenes } from '@/lib/demo/demoScenes';
import { sceneIcon } from '@/components/demo/sceneIcons';

// デモの目次。場面は lib/demo/demoScenes.ts の順に並べる
export default function DemoIndexPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="glass animate-fade-up rounded-2xl p-6 shadow-glass md:p-8">
        <h1 className="text-xl font-semibold tracking-tight text-fg md:text-2xl">ぶちこむ家計簿のデモ</h1>
        <p className="mt-2 text-sm text-muted">
          ふたり暮らしの家計簿を、架空のデータで見られます。ログインは不要で、この画面での操作はどこにも保存されません（テーマの設定を除く）。
        </p>
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          登場するふたり（Aさん・Bさん）、お店、金額はすべて架空です。基準の月は 2026年10月です。
        </p>
      </div>

      <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {demoScenes.map((scene, i) => {
          const Icon = sceneIcon(scene.key);
          return (
            <li key={scene.key}>
              <Link
                href={scene.href}
                className="glass flex h-full items-start gap-3 rounded-2xl p-4 shadow-glass transition-shadow hover:shadow-glass-lg"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium tabular-nums text-muted">{i + 1}</span>
                  <span className="block text-base font-semibold text-fg">{scene.label}</span>
                  <span className="mt-0.5 block text-xs text-muted">{scene.description}</span>
                </span>
                <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-muted" />
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
