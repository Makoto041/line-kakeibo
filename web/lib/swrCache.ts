// 画面間遷移を「SPAっぽく」するための超軽量メモリキャッシュ。
// 一度取得したデータをキー単位で保持し、再訪時はキャッシュを即表示しつつ
// 裏で再取得（stale-while-revalidate）してスピナーの点滅をなくす。
//
// 注意:
// - プロセス内メモリのみ（タブを閉じると消える）。永続化はしない。
// - 値は浅い参照で保持する。呼び出し側は更新時に新しいオブジェクトを渡すこと。

const store = new Map<string, unknown>();

export function hasCached(key: string): boolean {
  return store.has(key);
}

export function getCached<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function setCached<T>(key: string, value: T): void {
  store.set(key, value);
}

export function clearCached(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
