// デモ（/demo。ログイン不要・架空データだけ）が、Firestore・認証・LINE・bot の API・ブラウザの保存領域に触れないことのテスト。
// 起点（ルートのレイアウト・Providers・app/demo・components/demo・lib/demo のファイル）から、値として import する
// web/ 内のモジュール（相対パスと @/）を順にたどり、禁止したモジュール・パッケージに届いたら失敗にする。
// `import type` / `export type` は実行時に読まれないのでたどらない。`import { type A }` は値の import として扱う
// （設定によっては空の import としてモジュールが読まれる）。
// .tsx は node の型除去で読めないので、ソースを文字列として読み、import の文を正規表現で取り出す。
// 1 行に複数の import があっても拾えるよう、行頭に依存しない。決まった形で読めない import があれば失敗にする。
// あわせて、デモのファイル自身に通信・保存・外部 URL・/demo 以外へのリンクが無いことを確かめる。
// 発表後に /demo と一緒に消す。node --test で実行する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CI は web/ を作業ディレクトリにして実行するので、このファイルからの相対で読む
const WEB_DIR = fileURLToPath(new URL('../', import.meta.url));
const DEMO_DIRS = ['app/demo', 'components/demo', 'lib/demo'];
const ROOT_ENTRIES = ['app/layout.tsx', 'app/providers.tsx'];
const CODE_EXT = /\.(?:tsx?|jsx?|mjs)$/;

/** 値として import してはいけない web/ 内のモジュール（web/ からのパス。拡張子なし。末尾 / はディレクトリごと） */
const FORBIDDEN_LOCAL = [
  'lib/firebase',
  'lib/hooks',
  'lib/lineAuth',
  'lib/householdApi',
  'lib/recurringApi',
  'lib/dateSettings',
  'lib/swrCache',
  'lib/sampleData',
  'components/layout/', // AppShell（LINE ログインの起動）と、本番の画面へのナビ
  'components/PeriodSplitCard',
  'components/LeftoverAdvancesCard',
  'components/RecurringExpensesPanel',
  'components/PreviewModeBanner',
  'components/settings/', // InstallAppCard（lineAuth）・SettlementNotifyCard（householdApi）
];
/** 値として import してはいけないパッケージ（Firebase の SDK・LIFF） */
const FORBIDDEN_PACKAGE = /^(?:firebase|@line\/liff)(?:\/|$)/;

// import / export … from の文。句に使える文字を絞り、関数の本体などまで読み進まないようにする。行頭（^）には依存しない
const IMPORT_FROM = /\bimport\s+(type\s+)?([\w$*\s{},]+?)\s*from\s*(['"])([^'"\n]+)\3/g;
const IMPORT_SIDE_EFFECT = /\bimport\s*(['"])([^'"\n]+)\1/g;
const EXPORT_FROM = /\bexport\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[\w$\s,]*\})\s*from\s*(['"])([^'"\n]+)\3/g;
// 動的な読み込み（import() / require()）は形を問わず値の読み込みとして扱う
const DYNAMIC = /\bimport\s*\(\s*(['"`])([^'"`\n]*)\1|\brequire\s*\(\s*(['"`])([^'"`\n]*)\3/g;
const DYNAMIC_ANY = /\bimport\s*\(|\brequire\s*\(/g;
// 文の始め（ファイルの先頭・改行・; { } の後）の import / export、どこかの from '…'。上の形で読めなければ失敗にする
const STATEMENT_START = /(?:^|[\n;{}])[ \t]*((?:import|export)\b)/g;
const FROM_CLAUSE = /\bfrom\s*['"][^'"\n]*['"]/g;

/**
 * ソースから import / export … from / 動的な読み込みを取り出す。imports は { spec, typeOnly, line } の配列。
 * unparsed は、決まった形で読めなかった import（文の始めの import / export … from、from '…'）
 */
export function parseImports(source) {
  const found = [];
  const covered = []; // 読み取れた文の [開始, 終了)
  const lineOf = (index) => source.slice(0, index).split('\n').length;
  const cover = (m) => {
    covered.push([m.index, m.index + m[0].length]);
    return lineOf(m.index);
  };
  for (const m of source.matchAll(IMPORT_FROM)) found.push({ spec: m[4], typeOnly: Boolean(m[1]), line: cover(m) });
  for (const m of source.matchAll(IMPORT_SIDE_EFFECT)) found.push({ spec: m[2], typeOnly: false, line: cover(m) });
  for (const m of source.matchAll(EXPORT_FROM)) found.push({ spec: m[4], typeOnly: Boolean(m[1]), line: cover(m) });
  const dynamicAt = new Set();
  for (const m of source.matchAll(DYNAMIC)) {
    found.push({ spec: m[2] ?? m[4], typeOnly: false, line: cover(m) });
    dynamicAt.add(m.index);
  }
  // 文字列リテラル以外を渡す import() / require() は、読む先が分からないので失敗にする
  for (const m of source.matchAll(DYNAMIC_ANY)) {
    if (!dynamicAt.has(m.index)) found.push({ spec: null, typeOnly: false, line: lineOf(m.index) });
  }
  const isCovered = (index) => covered.some(([start, end]) => index >= start && index < end);
  const unparsed = [];
  for (const m of source.matchAll(STATEMENT_START)) {
    const at = m.index + m[0].length - m[1].length;
    if (isCovered(at)) continue;
    const rest = source.slice(at, at + 200);
    // export の宣言（export default / const / function など）と import.meta・import() は import の文ではない
    if (m[1] === 'export' && !/^export\s+(?:type\s+)?(?:\*|\{[^}]*\}\s*from)/.test(rest)) continue;
    if (m[1] === 'import' && /^import\s*(?:\(|\.)/.test(rest)) continue;
    unparsed.push({ line: lineOf(at), text: rest.split('\n')[0].trim() });
  }
  for (const m of source.matchAll(FROM_CLAUSE)) {
    if (!isCovered(m.index)) unparsed.push({ line: lineOf(m.index), text: m[0] });
  }
  return { imports: found, unparsed };
}

/** 相対パス・`@/` の指定を web/ 内のファイルに解決する。パッケージは null、解決できなければ undefined */
function resolveLocal(fromFile, spec, exists) {
  let base;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith('@/')) base = path.join(WEB_DIR, spec.slice(2));
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** 禁止したモジュールか。web/ からのパス（拡張子なし）で比べる */
export function isForbiddenLocal(relNoExt) {
  return FORBIDDEN_LOCAL.some((f) => (f.endsWith('/') ? relNoExt.startsWith(f) : relNoExt === f));
}

const defaultIo = {
  read: (file) => readFileSync(file, 'utf8'),
  exists: (file) => existsSync(file) && statSync(file).isFile(),
};

/**
 * entries から値の import をたどり、禁止したモジュール・パッケージを値として import している箇所を返す。
 * io を差し替えると、ディスクに無いソースでも検査できる（検査そのもののテスト用）
 */
export function findForbiddenValueImports(entries, io = defaultIo) {
  const problems = [];
  const visited = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    // CSS・画像などは読まない（globals.css の @import をモジュールの import と取り違えないように）
    if (!CODE_EXT.test(file)) continue;
    const rel = path.relative(WEB_DIR, file);
    const { imports, unparsed } = parseImports(io.read(file));
    for (const u of unparsed) problems.push(`${rel}:${u.line}: 読み取れない import「${u.text}」`);
    for (const imp of imports) {
      if (imp.typeOnly) continue;
      if (imp.spec === null) {
        problems.push(`${rel}:${imp.line}: 読む先が文字列でない import() / require()`);
        continue;
      }
      if (FORBIDDEN_PACKAGE.test(imp.spec)) {
        problems.push(`${rel}:${imp.line}: ${imp.spec} を値として import している`);
        continue;
      }
      const resolved = resolveLocal(file, imp.spec, io.exists);
      if (resolved === undefined) {
        problems.push(`${rel}:${imp.line}: ${imp.spec} を web/ 内のファイルに解決できない`);
        continue;
      }
      if (resolved === null) continue; // パッケージ（react・next・lucide-react・recharts・dayjs など）
      const target = path.relative(WEB_DIR, resolved).replace(CODE_EXT, '');
      if (isForbiddenLocal(target)) {
        problems.push(`${rel}:${imp.line}: ${target} を値として import している（型だけなら import type { … } にする）`);
        continue;
      }
      queue.push(resolved);
    }
  }
  return { problems, visited: [...visited].map((f) => path.relative(WEB_DIR, f)) };
}

function listCodeFiles(dir) {
  const abs = path.join(WEB_DIR, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listCodeFiles(child));
    else if (CODE_EXT.test(entry.name)) out.push(child);
  }
  return out;
}

const DEMO_FILES = DEMO_DIRS.flatMap(listCodeFiles);
const ENTRIES = [...ROOT_ENTRIES, ...DEMO_FILES].map((f) => path.join(WEB_DIR, f));

// ---- デモのファイル自身の中身 --------------------------------------------------

/** 通信・ブラウザの保存領域・ページの外への移動 */
const BANNED_IN_DEMO = [
  [/\bfetch\s*\(/, 'fetch('],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/WebSocket/, 'WebSocket'],
  [/EventSource/, 'EventSource'],
  [/sendBeacon/, 'sendBeacon'],
  [/localStorage/, 'localStorage'],
  [/sessionStorage/, 'sessionStorage'],
  [/indexedDB/i, 'indexedDB'],
  [/\bcaches\s*\./, 'caches'],
  [/document\.cookie/, 'document.cookie'],
  [/window\.open\b/, 'window.open'],
  [/\blocation\.(?:href|assign|replace)\b/, 'location の書き換え'],
  [/\brouter\.(?:push|replace)\b/, 'router.push / replace'],
  [/\bredirect\s*\(/, 'redirect('],
  [/\bhttps?:\/\//, 'http(s):// の URL'],
];
// href の値: 文字列（"…" / '…' / `…`）か、それ以外の式
const HREF_ATTR = /\bhref\s*=\s*(?:\{\s*)?(?:(['"`])([^'"`]*)\1|([^}\s>]+))/g;
const HREF_PROP = /\bhref\s*:\s*(?:(['"`])([^'"`]*)\1|([^,}\s]+))/g;
// 式で渡してよいのは、場面の一覧（lib/demo/demoScenes.ts。中身は demoData.test.mjs で確かめる）の href だけ
const HREF_EXPR_OK = /^(?:[\w$]+\.href|DEMO_INDEX_HREF)$/;
// 型の宣言（href: string）は値ではない
const HREF_TYPE = /^(?:string|`\/demo\/\$\{string\}\/`)\s*;?$/;

export function scanDemoSource(rel, source) {
  const problems = [];
  const lineOf = (index) => source.slice(0, index).split('\n').length;
  for (const [re, label] of BANNED_IN_DEMO) {
    const m = re.exec(source);
    if (m) problems.push(`${rel}:${lineOf(m.index)}: ${label} がある`);
  }
  for (const re of [HREF_ATTR, HREF_PROP]) {
    for (const m of source.matchAll(re)) {
      const literal = m[2];
      const expr = m[3];
      if (literal !== undefined) {
        if (!literal.startsWith('/demo/') && literal !== '/demo') problems.push(`${rel}:${lineOf(m.index)}: /demo 以外へのリンク「${literal}」`);
      } else if (expr !== undefined && !HREF_EXPR_OK.test(expr) && !HREF_TYPE.test(expr)) {
        problems.push(`${rel}:${lineOf(m.index)}: href に場面の一覧以外の式「${expr}」`);
      }
    }
  }
  return problems;
}

// ---- テスト ---------------------------------------------------------------------

test('起点のファイルが見つかる（ルートのレイアウト・Providers と、デモの画面・枠・データ）', () => {
  for (const file of [
    ...ROOT_ENTRIES,
    'app/demo/layout.tsx',
    'app/demo/page.tsx',
    'app/demo/not-found.tsx',
    'app/demo/home/page.tsx',
    'app/demo/expenses/page.tsx',
    'app/demo/settlement/page.tsx',
    'components/demo/DemoShell.tsx',
    'lib/demo/demoData.ts',
  ]) {
    assert.ok(existsSync(path.join(WEB_DIR, file)), `${file} が無い`);
    assert.ok(ROOT_ENTRIES.includes(file) || DEMO_FILES.includes(file), `${file} を起点に入れていない`);
  }
});

test('デモは Firebase・認証・LINE・bot の API・本番のナビ / キャッシュを値として import しない（たどった先も）', () => {
  const { problems, visited } = findForbiddenValueImports(ENTRIES);
  assert.deepEqual(problems, []);
  // たどりが空振りして何も見ずに通らないように（使っている部品と純関数の lib まで見ている）
  for (const file of [
    'components/theme/ThemeProvider.tsx',
    'components/ThemeToggle.tsx',
    'components/PeriodSplitView.tsx',
    'components/drilldown/DrillSheet.tsx',
    'components/home/CategoryBreakdownCard.tsx',
    'components/home/BudgetProgress.tsx',
    'components/expenses/ExpenseCard.tsx',
    'components/expenses/ExpenseControls.tsx',
    'components/Charts.tsx',
    'lib/expenseState.ts',
    'lib/periodSplit.ts',
    'lib/drilldown.ts',
    'lib/budgetAnalytics.ts',
  ]) {
    assert.ok(visited.includes(file), `${file} までたどれていない: ${visited.join(', ')}`);
  }
});

test('たどった先のどのファイルも通信しない。ブラウザの保存領域はテーマの設定（ThemeProvider）だけ', () => {
  const { visited } = findForbiddenValueImports(ENTRIES);
  const problems = [];
  for (const rel of visited.filter((f) => CODE_EXT.test(f))) {
    const source = readFileSync(path.join(WEB_DIR, rel), 'utf8');
    if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(source)) problems.push(`${rel}: 通信している`);
    if (/sessionStorage|indexedDB|document\.cookie/i.test(source)) problems.push(`${rel}: 保存領域を使っている`);
    if (/localStorage/.test(source) && rel !== 'components/theme/ThemeProvider.tsx') problems.push(`${rel}: localStorage を使っている`);
  }
  assert.deepEqual(problems, []);
});

test('デモのファイルに、通信・保存・外部 URL・ページの外への移動・/demo 以外へのリンクが無い', () => {
  const problems = DEMO_FILES.flatMap((rel) => scanDemoSource(rel, readFileSync(path.join(WEB_DIR, rel), 'utf8')));
  assert.deepEqual(problems, []);
});

test('検査が働くこと: 本番の画面のレイアウト（app/(app)/layout.tsx）は AppShell で引っかかる', () => {
  const { problems } = findForbiddenValueImports([path.join(WEB_DIR, 'app/(app)/layout.tsx')]);
  assert.ok(
    problems.some((p) => p.includes('components/layout/AppShell')),
    `AppShell を見つけられない: ${problems.join(' / ')}`
  );
});

test('検査が働くこと: たどった先で禁止したモジュールを値として import すると引っかかる（1 行に複数の import も）', () => {
  // ディスクに無いソースで、デモの部品 → 普通の部品 → 禁止したモジュール とたどらせる
  const files = new Map([
    [path.join(WEB_DIR, 'components/demo/Fake.tsx'), "import a from './FakeChild'; import { b } from '../../lib/money';\n"],
    [path.join(WEB_DIR, 'components/demo/FakeChild.tsx'), "import x from 'react'; import { auth } from '@/lib/lineAuth';\nimport { y } from '../../lib/drilldown';"],
    [path.join(WEB_DIR, 'lib/money.ts'), ''],
    [path.join(WEB_DIR, 'lib/drilldown.ts'), "export const z = 1; import type { Expense } from './hooks';"],
    [path.join(WEB_DIR, 'lib/lineAuth.ts'), ''],
    [path.join(WEB_DIR, 'lib/hooks.ts'), ''],
  ]);
  const io = { read: (f) => files.get(f) ?? '', exists: (f) => files.has(f) };
  const { problems, visited } = findForbiddenValueImports([path.join(WEB_DIR, 'components/demo/Fake.tsx')], io);
  assert.deepEqual(problems, ['components/demo/FakeChild.tsx:1: lib/lineAuth を値として import している（型だけなら import type { … } にする）']);
  // 型だけの import（lib/drilldown → lib/hooks）はたどらない
  assert.ok(visited.includes('lib/drilldown.ts') && !visited.includes('lib/hooks.ts'), visited.join(', '));

  // パッケージ・中括弧の中だけ type・動的な読み込み
  files.set(path.join(WEB_DIR, 'components/layout/AppShell.tsx'), '');
  files.set(path.join(WEB_DIR, 'components/settings/InstallAppCard.tsx'), '');
  const one = (src) =>
    findForbiddenValueImports([path.join(WEB_DIR, 'components/demo/Fake.tsx')], {
      read: (f) => (f.endsWith('Fake.tsx') ? src : ''),
      exists: (f) => files.has(f),
    }).problems;
  const flags = (src, needle) => {
    const problems = one(src);
    assert.ok(problems.length === 1 && problems[0].includes(needle), `${src} → ${problems.join(' / ')}`);
  };
  flags("import { a } from 'react'; import { getAuth } from 'firebase/auth';", 'firebase/auth を値として');
  flags("import liff from '@line/liff';", '@line/liff を値として');
  flags("import { type X } from '../../lib/hooks';", 'lib/hooks を値として');
  flags("const m = await import('../../lib/lineAuth');", 'lib/lineAuth を値として');
  flags('const m = await import(name);', '文字列でない');
  flags("import Shell from '@/components/layout/AppShell';", 'components/layout/AppShell を値として');
  flags("import Card from '@/components/settings/InstallAppCard';", 'components/settings/InstallAppCard を値として');
  flags("import Missing from './NoSuchFile';", '解決できない');
  assert.deepEqual(one("import type { X } from '../../lib/hooks';"), []);
});

test('import の読み取り: 1 行に複数・複数行・型だけ・再 export・動的・読めない形', () => {
  const read = (src) => parseImports(src).imports.map(({ spec, typeOnly }) => `${spec}:${typeOnly ? 'type' : 'value'}`);
  assert.deepEqual(read("import a from './a'; import { b } from '../lib/firebase';"), ['./a:value', '../lib/firebase:value']);
  assert.deepEqual(read("'use client'; import x from './x'"), ['./x:value']);
  assert.deepEqual(read("import type { Expense } from '../lib/hooks';"), ['../lib/hooks:type']);
  assert.deepEqual(read("import { type Expense } from '../lib/hooks';"), ['../lib/hooks:value']);
  assert.deepEqual(read("import {\n  DEFAULT_SETTINGS,\n  type DateRangeSettings,\n} from '../lib/dateSettings';"), ['../lib/dateSettings:value']);
  assert.deepEqual(read("import * as hooks from '../lib/hooks';"), ['../lib/hooks:value']);
  assert.deepEqual(read("import '../lib/firebase'; import './globals.css';"), ['../lib/firebase:value', './globals.css:value']);
  assert.deepEqual(read("export { db } from '../lib/firebase';"), ['../lib/firebase:value']);
  assert.deepEqual(read("export type { Expense } from '../lib/hooks';"), ['../lib/hooks:type']);
  assert.deepEqual(read("const m = await import('../lib/lineAuth');"), ['../lib/lineAuth:value']);
  // 決まった形で読めない import は unparsed に入る（黙って読み飛ばさない）
  assert.ok(parseImports("import {\n  a, // コメント\n} from '../lib/hooks';").unparsed.length > 0);
  assert.ok(parseImports("const x = 1; import {\n  a /* c */ } from '../lib/hooks';").unparsed.length > 0);
  // コメントや文の途中の import という語、export の宣言は import の文として扱わない
  assert.deepEqual(parseImports('// 値として import しない\nexport default function A() {}\nexport const b = 1;').unparsed, []);
  // 禁止の判定
  assert.equal(isForbiddenLocal('lib/hooks'), true);
  assert.equal(isForbiddenLocal('components/layout/TopBar'), true);
  assert.equal(isForbiddenLocal('lib/periodSplit'), false);
});

test('デモの中身の検査が働くこと: 通信・保存・外部 URL・/demo 以外へのリンク・場面の一覧以外の href を拾う', () => {
  const scan = (src) => scanDemoSource('x.tsx', src);
  assert.deepEqual(scan("<Link href=\"/demo/home/\">a</Link><Link href={scene.href}>b</Link>\nconst s = { href: '/demo/x/' };\ninterface A { href: string; }"), []);
  assert.equal(scan("await fetch('/api')").length, 1);
  assert.equal(scan('localStorage.setItem("a", "b")').length, 1);
  assert.equal(scan('const u = "https://example.com";').length >= 1, true);
  assert.equal(scan('<a href="/">ホーム</a>').length, 1);
  assert.equal(scan("<Link href='/expenses/'>一覧</Link>").length, 1);
  assert.equal(scan('<Link href={`/expenses?edit=${id}`}>編集</Link>').length, 1);
  assert.equal(scan('<Link href={makeHref(id)}>x</Link>').length, 1);
  assert.equal(scan("const s = { href: '/settings/' };").length, 1);
});
