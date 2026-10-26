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

// 入れる（LINE・カード利用の取込）→ 見る（ホーム・支出一覧）→ 精算する（精算・LINE に届く精算サマリー）の順
export const demoScenes: readonly DemoScene[] = [
  { key: 'line', href: '/demo/line/', label: 'LINE', description: 'LINE に「ランチ 850」と送ると、分類して確認カードが返る' },
  { key: 'gmail', href: '/demo/gmail/', label: 'Gmail', description: 'カード利用のメールを取り込み、分類してグループに知らせる' },
  { key: 'home', href: '/demo/home/', label: 'ホーム', description: '月の支出と予算。カテゴリから中項目、明細まで潜れる' },
  { key: 'expenses', href: '/demo/expenses/', label: '支出一覧', description: '検索・絞り込み・並び替えと、支払った人ごとの合計' },
  { key: 'settlement', href: '/demo/settlement/', label: '精算', description: 'ふたりで折半したときに、どちらがいくら送るか' },
  {
    key: 'settlement-summary',
    href: '/demo/settlement-summary/',
    label: '精算サマリー',
    description: '毎月の起算日に、送金額と内訳が LINE に届く',
  },
];

/** key の場面。無ければ投げる（場面の中からほかの場面へリンクするときに使う。リンクは scene.href の形で書く） */
export function sceneOf(key: string): DemoScene {
  const scene = demoScenes.find((s) => s.key === key);
  if (!scene) throw new Error(`デモの場面が無い: ${key}`);
  return scene;
}

function stripSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** 今の URL の場面の位置（末尾スラッシュをそろえて完全一致）。目次・場面の外（/demo/home/xyz/ などの 404）は -1 */
export function sceneIndexOf(pathname: string | null | undefined): number {
  const path = stripSlash(pathname || '');
  return demoScenes.findIndex((s) => path === stripSlash(s.href));
}
