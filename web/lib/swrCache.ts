// 画面間遷移を「SPAっぽく」するための軽量キャッシュ。
// 一度取得したデータをキー単位で保持し、再訪時はキャッシュを即表示しつつ
// 裏で再取得（stale-while-revalidate）してスピナーの点滅をなくす。
//
// 一部のキー（支出・集計・世帯・以前の立替・設定）は localStorage にも保存し、ページを開き直したとき
// （LINE のボタンから開く・再読み込み）にも前回の内容をすぐ出す。取得し直した結果で置き換わる。
// 端末に残るのは、同じ端末の Firebase のログイン状態（IndexedDB）で読める内容と同じ範囲。
//
// 注意:
// - 値は浅い参照で保持する。呼び出し側は更新時に新しいオブジェクトを渡すこと。
// - 保存した値は JSON を通るため、Firestore の Timestamp は { seconds, nanoseconds }、
//   Date は ISO 文字列になって戻る（timestampToMillis はどちらも扱える）。
// - サーバーの描画（Next の事前描画）では保存分を読まない。キーは LINE の userId を含み、
//   userId はサインイン後にしか分からないため、初回の描画（ハイドレーション）とは食い違わない。

const store = new Map<string, unknown>();
/** 最後に書いた時刻（保存の上限を超えたとき新しいものを残す） */
const touchedAt = new Map<string, number>();

const PERSIST_KEY = 'kakeibo:swr:v1';
const PERSIST_PREFIXES = ['expenses:', 'stats:', 'household:', 'advances:', 'dateSettings:', 'budget:', 'settingsBudget:'];
/** これより古い保存分は使わない（期間・世帯が変わっている可能性が高い） */
const PERSIST_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** 保存する大きさの上限（localStorage は 5MB 前後。ほかの用途の分を残す） */
const PERSIST_MAX_CHARS = 1_500_000;
const PERSIST_DELAY_MS = 400;

interface PersistedEntry {
  /** 書いた時刻（ms） */
  t: number;
  v: unknown;
}

function isPersistable(key: string): boolean {
  // userId がまだ分からないときのキー（expenses:null:… など）は保存しない。次に開いたときの初回の描画
  // （サーバーの描画と同じでなければならない）でキャッシュありと判定されないように
  return PERSIST_PREFIXES.some((p) => key.startsWith(p)) && !key.includes(':null:') && !key.endsWith(':null');
}

function hydrate(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, PersistedEntry> | null;
    if (!parsed || typeof parsed !== 'object') return;
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object' || typeof entry.t !== 'number') continue;
      if (now - entry.t > PERSIST_MAX_AGE_MS || !isPersistable(key)) continue;
      store.set(key, entry.v);
      touchedAt.set(key, entry.t);
    }
  } catch {
    // 壊れた保存分は捨てる（次の保存で上書きされる）
    try {
      window.localStorage.removeItem(PERSIST_KEY);
    } catch {
      // 保存できない環境（プライベートブラウズ等）はメモリだけで動く
    }
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistNow(): void {
  persistTimer = null;
  if (typeof window === 'undefined') return;
  // 新しく書いたものから、上限に収まるだけ保存する
  const keys = Array.from(store.keys())
    .filter(isPersistable)
    .sort((a, b) => (touchedAt.get(b) ?? 0) - (touchedAt.get(a) ?? 0));
  const parts: string[] = [];
  let size = 2;
  for (const key of keys) {
    let part: string;
    try {
      const entry: PersistedEntry = { t: touchedAt.get(key) ?? Date.now(), v: store.get(key) };
      part = `${JSON.stringify(key)}:${JSON.stringify(entry)}`;
    } catch {
      continue;
    }
    if (size + part.length + 1 > PERSIST_MAX_CHARS) continue;
    size += part.length + 1;
    parts.push(part);
  }
  try {
    if (parts.length === 0) window.localStorage.removeItem(PERSIST_KEY);
    else window.localStorage.setItem(PERSIST_KEY, `{${parts.join(',')}}`);
  } catch {
    // 容量超過・保存不可。メモリのキャッシュはそのまま使える
  }
}

function schedulePersist(): void {
  if (typeof window === 'undefined' || persistTimer) return;
  persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS);
}

hydrate();

// LINE のブラウザを閉じる・別のアプリへ切り替える直前に、まだ書いていない分を保存する
// （精算を記録した直後に閉じると、次に開いたとき記録前の内容が出てしまうため）
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const flush = () => {
    if (!persistTimer) return;
    clearTimeout(persistTimer);
    persistNow();
  };
  window.addEventListener('pagehide', flush);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
}

export function hasCached(key: string): boolean {
  return store.has(key);
}

export function getCached<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function setCached<T>(key: string, value: T): void {
  store.set(key, value);
  touchedAt.set(key, Date.now());
  if (isPersistable(key)) schedulePersist();
}

export function clearCached(prefix?: string): void {
  for (const key of Array.from(store.keys())) {
    if (prefix && !key.startsWith(prefix)) continue;
    store.delete(key);
    touchedAt.delete(key);
  }
  schedulePersist();
}

/**
 * prefix で始まるキーの値をまとめて書き換える（別の画面が持つキャッシュの同期用）。
 * fn が同じ参照を返したキーは変更しない。
 */
export function updateCachedByPrefix<T>(prefix: string, fn: (value: T, key: string) => T): void {
  let changed = false;
  for (const [key, value] of store) {
    if (!key.startsWith(prefix)) continue;
    const next = fn(value as T, key);
    if (next !== value) {
      store.set(key, next);
      touchedAt.set(key, Date.now());
      changed = true;
    }
  }
  if (changed) schedulePersist();
}
