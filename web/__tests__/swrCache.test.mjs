// swrCache の localStorage への保存（開き直したときに前回の内容をすぐ出す）のテスト。
// 保存は少し遅らせてまとめて行うため、書いたあとは待ってから確かめる。
// モジュールはクエリ付きで読み込み直し、「ページを開き直した」状態を作る。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const KEY = 'kakeibo:swr:v1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let loads = 0;

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

async function openPage(storage) {
  globalThis.window = { localStorage: storage };
  loads += 1;
  return import(`../lib/swrCache.ts?load=${loads}`);
}

test('保存するのは支出・集計・世帯・精算・設定のキーだけで、開き直すと戻る', async () => {
  const storage = fakeStorage();
  const first = await openPage(storage);
  const expenses = [{ id: 'e1', amount: 100, createdAt: { seconds: 10, nanoseconds: 0 } }];
  first.setCached('expenses:U1:0:500:2026-09-15', expenses);
  first.setCached('advances:g1', { items: [], asOf: 'x' });
  first.setCached('scratch:other', 1);
  await sleep(500);

  const saved = JSON.parse(storage.getItem(KEY));
  assert.deepEqual(Object.keys(saved).sort(), ['advances:g1', 'expenses:U1:0:500:2026-09-15']);

  const reopened = await openPage(storage);
  assert.deepEqual(reopened.getCached('expenses:U1:0:500:2026-09-15'), expenses);
  assert.equal(reopened.hasCached('advances:g1'), true);
  assert.equal(reopened.hasCached('scratch:other'), false);
});

test('古い保存分（14 日より前）と壊れた保存分は使わない', async () => {
  const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
  const storage = fakeStorage({
    [KEY]: JSON.stringify({
      'stats:U1:a': { t: old, v: { totalAmount: 1 } },
      'stats:U1:b': { t: Date.now(), v: { totalAmount: 2 } },
      'unknown:U1': { t: Date.now(), v: 3 },
    }),
  });
  const page = await openPage(storage);
  assert.equal(page.hasCached('stats:U1:a'), false);
  assert.deepEqual(page.getCached('stats:U1:b'), { totalAmount: 2 });
  assert.equal(page.hasCached('unknown:U1'), false);

  const broken = fakeStorage({ [KEY]: '{not json' });
  const page2 = await openPage(broken);
  assert.equal(page2.hasCached('stats:U1:b'), false);
  assert.equal(broken.getItem(KEY), null);
});

test('clearCached / updateCachedByPrefix の結果も保存される', async () => {
  const storage = fakeStorage();
  const page = await openPage(storage);
  page.setCached('expenses:U1:a', [{ id: 'e1', status: 'pending' }]);
  page.setCached('stats:U1:a', { totalAmount: 1 });
  page.updateCachedByPrefix('expenses:', (list) => list.map((e) => ({ ...e, status: 'shared' })));
  page.clearCached('stats:');
  await sleep(500);

  const reopened = await openPage(storage);
  assert.deepEqual(reopened.getCached('expenses:U1:a'), [{ id: 'e1', status: 'shared' }]);
  assert.equal(reopened.hasCached('stats:U1:a'), false);
});

test('localStorage が使えない環境でもメモリのキャッシュとして動く', async () => {
  const throwing = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
  const page = await openPage(throwing);
  page.setCached('expenses:U1:a', [1]);
  assert.deepEqual(page.getCached('expenses:U1:a'), [1]);
  await sleep(500);
});

test('userId がまだ分からないときのキー（:null:）は保存しない', async () => {
  const storage = fakeStorage();
  const page = await openPage(storage);
  page.setCached('expenses:null:0:500:', [1]);
  page.setCached('household:null', { a: 1 });
  page.setCached('expenses:U1:0:500:', [2]);
  await sleep(500);
  const saved = JSON.parse(storage.getItem(KEY));
  assert.deepEqual(Object.keys(saved), ['expenses:U1:0:500:']);
});
