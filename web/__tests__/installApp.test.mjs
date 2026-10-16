// 「アプリとして使う」の案内の出し分け（lib/installApp.ts）のテスト。node --test で実行する（型除去で .ts を直接読む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { externalBrowserUrl, installVariant, isIos, isLineInApp } from '../lib/installApp.ts';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneLine:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.10.0',
  ipadSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidLine:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 Line/15.10.0/IAB',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
};

const env = (userAgent, extra = {}) => ({ userAgent, maxTouchPoints: 0, standalone: false, canPrompt: false, ...extra });

test('iPhone / iPad の Safari は手順の案内', () => {
  assert.equal(installVariant(env(UA.iphoneSafari, { maxTouchPoints: 5 })), 'ios');
  // iPad は Mac と同じ UA なので、タッチの有無で見分ける
  assert.equal(installVariant(env(UA.ipadSafari, { maxTouchPoints: 5 })), 'ios');
  assert.equal(installVariant(env(UA.ipadSafari)), null);
});

test('LINE のアプリ内ブラウザは外部ブラウザで開き直す案内（OS ごと）', () => {
  assert.equal(installVariant(env(UA.iphoneLine, { maxTouchPoints: 5 })), 'line-ios');
  assert.equal(installVariant(env(UA.androidLine, { maxTouchPoints: 5 })), 'line-android');
  // LINE の中ではインストールの合図が来ても使えないので、開き直しを優先する
  assert.equal(installVariant(env(UA.androidLine, { canPrompt: true })), 'line-android');
});

test('インストールの合図があればボタン、無ければ出さない（Android / PC）', () => {
  assert.equal(installVariant(env(UA.androidChrome, { canPrompt: true })), 'prompt');
  assert.equal(installVariant(env(UA.macChrome, { canPrompt: true })), 'prompt');
  assert.equal(installVariant(env(UA.androidChrome)), null);
  assert.equal(installVariant(env(UA.linuxFirefox)), null);
});

test('ホーム画面から開いているときは出さない', () => {
  assert.equal(installVariant(env(UA.iphoneSafari, { standalone: true })), null);
  assert.equal(installVariant(env(UA.androidChrome, { standalone: true, canPrompt: true })), null);
});

test('isIos / isLineInApp', () => {
  assert.equal(isIos(UA.iphoneSafari, 5), true);
  assert.equal(isIos(UA.macChrome, 0), false);
  assert.equal(isLineInApp(UA.iphoneLine), true);
  assert.equal(isLineInApp(UA.linuxFirefox), false);
  assert.equal(isLineInApp(UA.androidChrome), false);
});

test('externalBrowserUrl は openExternalBrowser=1 を付ける（既存のパラメータは残す）', () => {
  assert.equal(
    externalBrowserUrl('https://line-kakeibo.vercel.app/settings/'),
    'https://line-kakeibo.vercel.app/settings/?openExternalBrowser=1'
  );
  assert.equal(
    externalBrowserUrl('https://line-kakeibo.vercel.app/settings/?tab=period#x'),
    'https://line-kakeibo.vercel.app/settings/?tab=period&openExternalBrowser=1#x'
  );
});
