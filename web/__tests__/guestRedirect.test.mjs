// ログインしていない人をデモへ送る画面の判定（lib/guestRedirect.ts）のテスト。node --test で実行する。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GUEST_DEMO_HREF, isGuestDemoRoute, shouldStartLineLogin } from '../lib/guestRedirect.ts';
import { DEMO_LOGIN_HREF } from '../lib/demo/demoScenes.ts';

test('アプリの本体の画面は対象（末尾のスラッシュ・下位パスも）', () => {
  for (const p of ['/', '/expenses', '/expenses/', '/settlement/', '/settings', '/settings/x', '/dashboard/']) {
    assert.equal(isGuestDemoRoute(p), true, p);
  }
});

test('規約・LINE から開く画面は対象外', () => {
  for (const p of ['/terms/', '/privacy/', '/attach/', '/link/', '/expensesx', '/not-found']) {
    assert.equal(isGuestDemoRoute(p), false, p);
  }
});

test('送り先はデモの目次', () => {
  assert.equal(GUEST_DEMO_HREF, '/demo/');
});

test('LINE ログインへ自動で進めるのは、LINE の中・ホーム画面のアプリ・?login=1・外部ブラウザへの開き直し・入口以外の画面だけ', () => {
  const base = { pathname: '/', search: '', inLine: false, standalone: false };
  assert.equal(shouldStartLineLogin(base), false); // 外部ブラウザの初めての人が入口を開く → デモ
  assert.equal(shouldStartLineLogin({ ...base, pathname: '/dashboard/' }), false);
  assert.equal(shouldStartLineLogin({ ...base, pathname: '/terms/' }), false);
  assert.equal(shouldStartLineLogin({ ...base, pathname: '/privacy/' }), false);
  assert.equal(shouldStartLineLogin({ ...base, inLine: true }), true);
  assert.equal(shouldStartLineLogin({ ...base, standalone: true }), true);
  assert.equal(shouldStartLineLogin({ ...base, search: '?login=1' }), true);
  assert.equal(shouldStartLineLogin({ ...base, search: '?login=0' }), false);
  assert.equal(shouldStartLineLogin({ ...base, search: '?login=' }), false);
  assert.equal(shouldStartLineLogin({ ...base, pathname: '/settings/', search: '?openExternalBrowser=1' }), true);
  // LINE のカードのリンクやブックマーク（行き先とデータが目的）
  for (const p of ['/expenses/', '/settlement/', '/settings/', '/attach/', '/link/']) {
    assert.equal(shouldStartLineLogin({ ...base, pathname: p }), true, p);
  }
});

test('デモの「LINE でログイン」は ?login=1 で入口へ戻る（隔離テストが許す唯一の外へのリンク）', () => {
  assert.equal(DEMO_LOGIN_HREF, '/?login=1');
});
