// 検索エンジンに出すのはトップ（/）だけ、ということのテスト。ほかのページ（支出・精算・設定・/demo など）は巡回も検索も止める。
// - public/robots.txt: Google の解釈（先頭からの一致・* は任意の文字列・末尾の $ は URL の終わり・一致した規則のうち最も長いもの）で
//   トップと検索結果のアイコン・Search Console の確認用ファイルだけを許可していること
// - next.config.ts の X-Robots-Tag（noindex）: トップとアイコンには付かず、ほかのページには付くこと（ヘッダーの noindex は
//   metadata の index より優先されるため、トップに付くとトップも検索に出ない）。Next がビルド時に作る正規表現（routes-manifest）で照合する
// - metadata: ルートのレイアウトの既定は noindex、トップのページだけ index: true（.tsx は node の型除去で読めないのでソースの文字列で照合）
// - トップの JSON-LD（lib/site.ts）のサイト名・URL と、アイコンの画像の大きさ
// node --test で実行する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE_NAME, SITE_URL, WEBSITE_JSON_LD, jsonLdScriptContent } from '../lib/site.ts';

// CI は web/ を作業ディレクトリにして実行するので、このファイルからの相対で読む
const WEB_DIR = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(path.join(WEB_DIR, rel), 'utf8');
const require = createRequire(import.meta.url);

/** 巡回・検索を許可するもの（クエリ付きは HTML の link が付けるキャッシュ用の値） */
const CRAWLABLE = [
  '/',
  '/favicon.ico',
  '/favicon.ico?favicon.0abc123.ico',
  '/apple-icon.png',
  '/apple-icon.png?apple-icon.0abc123.png',
  '/pwa/icon-192.png',
  '/pwa/icon-512.png',
];
/** 巡回・検索を止めるページ（トップ以外の画面・デモ・オフライン画面・Next の資源など） */
const BLOCKED = [
  '/?code=x&state=y',
  '/expenses/',
  '/expenses/?edit=abc',
  '/settlement/',
  '/settings/',
  '/attach/',
  '/link/',
  '/dashboard/',
  '/terms/',
  '/privacy/',
  '/demo',
  '/demo/',
  '/demo/home/',
  '/demo/expenses/',
  '/offline.html',
  '/manifest.webmanifest',
  '/index.txt',
  '/_next/static/chunks/app.js',
  '/_next/image?url=x',
];
const VERIFICATION_FILE = '/google87fb942043bd85e4.html';

// ---- robots.txt -----------------------------------------------------------------

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** robots.txt を { userAgents, rules: [{ allow, value, re }] } に読む（グループは 1 つの前提。複数あれば失敗にする） */
function parseRobots(text) {
  const userAgents = [];
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const at = line.indexOf(':');
    assert.ok(at > 0, `読めない行「${raw}」`);
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === 'user-agent') {
      assert.equal(rules.length, 0, '規則の後に User-agent がある（グループが複数ある）');
      userAgents.push(value);
    } else if (key === 'allow' || key === 'disallow') {
      const anchored = value.endsWith('$');
      const body = (anchored ? value.slice(0, -1) : value).split('*').map(esc).join('.*');
      rules.push({ allow: key === 'allow', value, re: new RegExp(`^${body}${anchored ? '$' : ''}`) });
    } else {
      assert.fail(`想定していない項目「${raw}」`);
    }
  }
  return { userAgents, rules };
}

/** Google と同じ選び方: 一致した規則のうち最も長いもの。長さが同じなら Allow。どれにも一致しなければ許可 */
function robotsAllows(rules, url) {
  let best = null;
  for (const r of rules) {
    if (!r.re.test(url)) continue;
    if (!best || r.value.length > best.value.length || (r.value.length === best.value.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

const ROBOTS = parseRobots(read('public/robots.txt'));

test('robots.txt: すべてのクローラーに同じ規則で、Disallow: / と Allow: /$ がある', () => {
  assert.deepEqual(ROBOTS.userAgents, ['*']);
  assert.ok(ROBOTS.rules.some((r) => !r.allow && r.value === '/'), 'Disallow: / が無い');
  assert.ok(ROBOTS.rules.some((r) => r.allow && r.value === '/$'), 'Allow: /$ が無い');
  // 許可はトップ・アイコン・確認用ファイルだけ（/demo やログイン後のページを許可する行を足さない）
  assert.deepEqual(
    ROBOTS.rules.filter((r) => r.allow).map((r) => r.value).sort(),
    ['/$', '/apple-icon.png', '/favicon.ico', `${VERIFICATION_FILE}$`, '/pwa/'].sort()
  );
});

test('robots.txt: トップとアイコン・確認用ファイルは巡回でき、ほかのページは巡回できない', () => {
  for (const url of [...CRAWLABLE, VERIFICATION_FILE]) assert.equal(robotsAllows(ROBOTS.rules, url), true, `${url} を巡回できない`);
  for (const url of BLOCKED) assert.equal(robotsAllows(ROBOTS.rules, url), false, `${url} を巡回できる`);
});

test('robots.txt の読み方の確かめ: 最も長い規則が勝ち、$ は URL の終わりにだけ一致する', () => {
  const { rules } = parseRobots('User-agent: *\nAllow: /$\nAllow: /a*/x\nDisallow: /\nDisallow: /a/x/y\n');
  assert.equal(robotsAllows(rules, '/'), true);
  assert.equal(robotsAllows(rules, '/?q=1'), false);
  assert.equal(robotsAllows(rules, '/abc/x'), true);
  assert.equal(robotsAllows(rules, '/a/x/y'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /a\n').rules, '/b'), true);
});

// ---- next.config.ts の X-Robots-Tag ---------------------------------------------

/** headers() の規則のうち X-Robots-Tag を付けるものを、Next がビルド時に作る正規表現（routes-manifest の regex）にして返す */
async function noindexHeaderRules() {
  const { buildCustomRoute } = require('next/dist/lib/build-custom-route');
  const { default: config } = await import('../next.config.ts');
  const rules = await config.headers();
  return rules
    .filter((r) => r.headers.some((h) => h.key.toLowerCase() === 'x-robots-tag'))
    .map((r) => {
      assert.equal(r.has, undefined, `${r.source}: has の条件は想定していない`);
      assert.equal(r.missing, undefined, `${r.source}: missing の条件は想定していない`);
      return { source: r.source, re: new RegExp(buildCustomRoute('header', r).regex) };
    });
}

test('X-Robots-Tag の noindex はトップとアイコンに付かず、ほかのページ・確認用ファイルには付く', async () => {
  const rules = await noindexHeaderRules();
  assert.ok(rules.length > 0, 'X-Robots-Tag を付ける規則が無い');
  const noindexed = (pathname) => rules.some((r) => r.re.test(pathname));
  // ヘッダーの照合はパスだけ（クエリは含めない）
  for (const url of CRAWLABLE) {
    const pathname = url.split('?')[0];
    assert.equal(noindexed(pathname), false, `${pathname} に X-Robots-Tag が付く`);
  }
  for (const url of [...BLOCKED, VERIFICATION_FILE, '/robots.txt']) {
    const pathname = url.split('?')[0];
    if (pathname === '/') continue; // トップのクエリ付き（LINE ログインの戻り）は robots.txt で止める
    assert.equal(noindexed(pathname), true, `${pathname} に X-Robots-Tag が付かない`);
  }
});

// ---- metadata -------------------------------------------------------------------

/** app/ 以下の .ts / .tsx（web/ からのパス） */
function listAppFiles(dir = 'app') {
  const out = [];
  for (const entry of readdirSync(path.join(WEB_DIR, dir), { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAppFiles(child));
    else if (/\.tsx?$/.test(entry.name)) out.push(child);
  }
  return out;
}

/** metadata の robots: { index, follow } を取り出す（無ければ null） */
function robotsOf(source) {
  const m = /\brobots\s*:\s*\{([^}]*)\}/.exec(source);
  if (!m) return null;
  const flag = (name) => {
    const v = new RegExp(`\\b${name}\\s*:\\s*(true|false)`).exec(m[1]);
    return v ? v[1] === 'true' : undefined;
  };
  return { index: flag('index'), follow: flag('follow') };
}

const TOP_PAGE = path.join('app', '(app)', 'page.tsx');

test('ルートのレイアウトの既定は noindex・nofollow、トップのページだけ index: true（follow はしない）', () => {
  assert.deepEqual(robotsOf(read('app/layout.tsx')), { index: false, follow: false });
  const top = read(TOP_PAGE);
  // metadata を出せるのはサーバー側のページだけ
  assert.ok(!/^\s*['"]use client['"]/.test(top), 'トップのページがクライアントコンポーネントになっている');
  assert.match(top, /export const metadata\b/);
  assert.deepEqual(robotsOf(top), { index: true, follow: false });
});

test('トップ以外に index: true の metadata が無い（/demo のレイアウトは noindex のまま）', () => {
  assert.deepEqual(robotsOf(read('app/demo/layout.tsx')), { index: false, follow: false });
  const problems = [];
  for (const rel of listAppFiles()) {
    if (rel === TOP_PAGE) continue;
    const source = read(rel);
    if (/\bindex\s*:\s*true\b/.test(source)) problems.push(`${rel}: index: true がある`);
    if (/\bgenerateMetadata\b/.test(source)) problems.push(`${rel}: generateMetadata がある（robots を確かめていない）`);
    const robots = robotsOf(source);
    if (robots && robots.index !== false) problems.push(`${rel}: robots の index が false でない`);
  }
  assert.deepEqual(problems, []);
});

// ---- サイト名（JSON-LD）とアイコン ----------------------------------------------

test('トップの JSON-LD は WebSite で、サイト名と URL が決まった値', () => {
  assert.equal(SITE_URL, 'https://line-kakeibo.vercel.app/');
  assert.equal(SITE_NAME, 'ぶちこむ家計簿');
  assert.deepEqual(WEBSITE_JSON_LD, {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'ぶちこむ家計簿',
    alternateName: ['ぶちこむ家計簿アプリ'],
    url: 'https://line-kakeibo.vercel.app/',
  });
  const top = read(TOP_PAGE);
  assert.match(top, /type="application\/ld\+json"/);
  assert.match(top, /jsonLdScriptContent\(WEBSITE_JSON_LD\)/);
  assert.match(top, /siteName:\s*SITE_NAME/);
  // <title> と manifest の名前は今のまま（別名・サイト名と揃える）
  assert.match(read('app/layout.tsx'), /title:\s*"ぶちこむ家計簿アプリ"/);
  assert.match(read('app/manifest.ts'), /\bname:\s*'ぶちこむ家計簿'/);
});

test('JSON-LD の埋め込みは < を \\u003c にし、JSON としては同じ値に戻る', () => {
  const value = { name: '</script><script>alert(1)</script>', url: SITE_URL };
  const content = jsonLdScriptContent(value);
  assert.ok(!content.includes('<'), content);
  assert.deepEqual(JSON.parse(content), value);
  assert.deepEqual(JSON.parse(jsonLdScriptContent(WEBSITE_JSON_LD)), WEBSITE_JSON_LD);
});

/** PNG の幅と高さ（IHDR） */
function pngSize(rel) {
  const buf = readFileSync(path.join(WEB_DIR, rel));
  assert.equal(buf.toString('latin1', 12, 16), 'IHDR', `${rel} が PNG でない`);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('アイコン: 48px の倍数の正方形があり、ルートの metadata の link が robots.txt で巡回できる', () => {
  assert.deepEqual(pngSize('public/pwa/icon-192.png'), [192, 192]);
  assert.deepEqual(pngSize('app/apple-icon.png'), [180, 180]);
  // favicon.ico（scripts/gen-app-icons.mjs が作る）に 48px の画像が入っている
  const ico = readFileSync(path.join(WEB_DIR, 'app/favicon.ico'));
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico.readUInt8(6 + 16 * i));
  assert.ok(sizes.includes(48), `favicon.ico の大きさ: ${sizes.join(', ')}`);

  const layout = read('app/layout.tsx');
  assert.match(layout, /url:\s*"\/pwa\/icon-192\.png",\s*sizes:\s*"192x192",\s*type:\s*"image\/png"/);
  // icons を書くと app/apple-icon.png の link が自動で出なくなるので、apple も書いてある
  assert.match(layout, /apple:\s*\[\{\s*url:\s*"\/apple-icon\.png"/);
  for (const url of ['/pwa/icon-192.png', '/apple-icon.png', '/favicon.ico']) {
    assert.equal(robotsAllows(ROBOTS.rules, url), true, `${url} を巡回できない`);
  }
  assert.ok(existsSync(path.join(WEB_DIR, 'public', VERIFICATION_FILE.slice(1))), '確認用ファイルが無い');
});
