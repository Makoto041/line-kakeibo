// デモの場面（上部のタブ・目次・前へ / 次へ の順番）。場面を足すときは、ここに 1 行足して app/demo/<key>/page.tsx を置く。
// リンクは /demo 以下だけ（__tests__/demoData.test.mjs で確かめる）。アイコンは components/demo/sceneIcons.ts。
// node --test から直接読めるよう、何も import しない。

export interface DemoScene {
  key: string;
  /** 末尾スラッシュ付き（next.config.ts の trailingSlash） */
  href: string;
  label: string;
  /** 目次に出す一言 */
  description: string;
}

export const DEMO_INDEX_HREF = '/demo/';

export const demoScenes: readonly DemoScene[] = [
  { key: 'home', href: '/demo/home/', label: 'ホーム', description: '月の支出と予算。カテゴリから中項目、明細まで潜れる' },
  { key: 'expenses', href: '/demo/expenses/', label: '支出一覧', description: '検索・絞り込み・並び替えと、支払った人ごとの合計' },
  { key: 'settlement', href: '/demo/settlement/', label: '精算', description: 'ふたりで折半したときに、どちらがいくら送るか' },
];

function stripSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** 今の URL の場面の位置（末尾スラッシュをそろえて完全一致）。目次・場面の外（/demo/home/xyz/ などの 404）は -1 */
export function sceneIndexOf(pathname: string | null | undefined): number {
  const path = stripSlash(pathname || '');
  return demoScenes.findIndex((s) => path === stripSlash(s.href));
}
