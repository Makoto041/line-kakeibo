// 精算の表示部分（components/PeriodSplitView.tsx）が、Firestore・認証・bot の API に触れないことのテスト。
// デモ（ログイン不要・架空データ）からも使うので、hooks / householdApi / firebase / lineAuth / dateSettings /
// recurringApi を値として import しない（`import type { … }` は可。型は消えるので実行時に読まれない）。
// View から値として import する相対パスのモジュールを順にたどり、その先でも値として import していないことも確かめる
// （View が使う lib に Firebase の import が足されたときに、ここで落ちるように）。
// .tsx は node の型除去で読めないため、ソースを文字列として読み、import の文を正規表現で取り出す。
// 決まった形で読めない import の行があれば失敗にする（書き方を変えたときに、読み取りが黙って漏れないように）。
// node --test で実行する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CI は web/ を作業ディレクトリにして実行するので、このファイルからの相対で読む
const WEB_DIR = fileURLToPath(new URL('../', import.meta.url));
const VIEW = path.join(WEB_DIR, 'components/PeriodSplitView.tsx');
const CARD = path.join(WEB_DIR, 'components/PeriodSplitCard.tsx');

/** 値として import してはいけない web/lib のモジュール（拡張子を除いたファイル名） */
const FORBIDDEN_MODULES = new Set(['hooks', 'householdApi', 'firebase', 'lineAuth', 'dateSettings', 'recurringApi']);
/** 値として import してはいけないパッケージ（Firebase の SDK・LIFF） */
const FORBIDDEN_PACKAGE = /^(?:firebase|@line\/liff)(?:\/|$)/;

// import / export … from の文。句に使える文字を絞り、関数の本体などまで読み進まないようにする
const IMPORT_FROM = /^[ \t]*import\s+(type\s+)?([\w$*\s{},]+?)\s*from\s*(['"])([^'"\n]+)\3/gm;
const IMPORT_SIDE_EFFECT = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gm;
const EXPORT_FROM = /^[ \t]*export\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[\w$\s,]*\})\s*from\s*(['"])([^'"\n]+)\3/gm;
// 動的な読み込み（import() / require()）は形を問わず値の読み込みとして扱う
const DYNAMIC = /\bimport\s*\(\s*(['"`])([^'"`\n]*)\1|\brequire\s*\(\s*(['"`])([^'"`\n]*)\3/g;
const DYNAMIC_ANY = /\bimport\s*\(|\brequire\s*\(/g;

/**
 * ソースから import / export … from / 動的な読み込みを取り出す。imports は { spec, typeOnly, line } の配列。
 * 型だけとみなすのは `import type` / `export type` だけ。`import { type A }`（中括弧の中だけ type）は、
 * 設定（verbatimModuleSyntax）によっては空の import としてモジュールが読まれるので、値の import として扱う
 */
function parseImports(source) {
  const found = [];
  const covered = new Set(); // 読み取れた文が占める行
  const lineOf = (index) => source.slice(0, index).split('\n').length;
  const cover = (m) => {
    const first = lineOf(m.index);
    const last = lineOf(m.index + m[0].length);
    for (let l = first; l <= last; l++) covered.add(l);
    return first;
  };
  for (const m of source.matchAll(IMPORT_FROM)) {
    found.push({ spec: m[4], typeOnly: Boolean(m[1]), line: cover(m) });
  }
  for (const m of source.matchAll(IMPORT_SIDE_EFFECT)) {
    found.push({ spec: m[2], typeOnly: false, line: cover(m) });
  }
  for (const m of source.matchAll(EXPORT_FROM)) {
    found.push({ spec: m[4], typeOnly: Boolean(m[1]), line: cover(m) });
  }
  const dynamicAt = new Set();
  for (const m of source.matchAll(DYNAMIC)) {
    found.push({ spec: m[2] ?? m[4], typeOnly: false, line: lineOf(m.index) });
    dynamicAt.add(m.index);
  }
  // 文字列リテラル以外を渡す import() / require() は、読む先が分からないので失敗にする
  for (const m of source.matchAll(DYNAMIC_ANY)) {
    if (!dynamicAt.has(m.index)) found.push({ spec: null, typeOnly: false, line: lineOf(m.index) });
  }
  // 読み取れなかった import の行（決まった形でない）を拾う: 行頭の import、`from '…'` で終わる行
  const lines = source.split('\n');
  const unparsed = [];
  lines.forEach((text, i) => {
    const n = i + 1;
    if (covered.has(n)) return;
    if (/^[ \t]*import\b(?!\s*\()/.test(text) || /\bfrom\s*['"][^'"\n]+['"]\s*;?\s*$/.test(text)) {
      unparsed.push({ line: n, text: text.trim() });
    }
  });
  return { imports: found, unparsed };
}

/** 相対パス・`@/` の指定を web/ 内のファイルに解決する。パッケージは null */
function resolveLocal(fromFile, spec) {
  let base;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith('@/')) base = path.join(WEB_DIR, spec.slice(2));
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined; // 解決できない（たどり漏れにしないよう、呼び出し側で失敗にする）
}

function isForbidden(spec) {
  if (FORBIDDEN_PACKAGE.test(spec)) return true;
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return false;
  const name = path.basename(spec).replace(/\.(?:tsx?|jsx?|mjs)$/, '');
  return FORBIDDEN_MODULES.has(name);
}

/**
 * entry から、値として import する web/ 内のモジュールをたどり、禁止したモジュールを値として import している箇所を返す。
 * 型だけの import（`import type`）はたどらない（実行時には読まれない）
 */
function findForbiddenValueImports(entry) {
  const problems = [];
  const visited = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const rel = path.relative(WEB_DIR, file);
    const { imports, unparsed } = parseImports(readFileSync(file, 'utf8'));
    for (const u of unparsed) problems.push(`${rel}:${u.line}: 読み取れない import の行「${u.text}」`);
    for (const imp of imports) {
      if (imp.typeOnly) continue;
      if (imp.spec === null) {
        problems.push(`${rel}:${imp.line}: 読む先が文字列でない import() / require()`);
        continue;
      }
      if (isForbidden(imp.spec)) {
        problems.push(`${rel}:${imp.line}: ${imp.spec} を値として import している（型だけなら import type { … } にする）`);
        continue;
      }
      const resolved = resolveLocal(file, imp.spec);
      if (resolved === undefined) problems.push(`${rel}:${imp.line}: ${imp.spec} を web/ 内のファイルに解決できない`);
      else if (resolved !== null) queue.push(resolved);
    }
  }
  return { problems, visited: [...visited].map((f) => path.relative(WEB_DIR, f)) };
}

test('PeriodSplitView は、hooks / householdApi / firebase / lineAuth / dateSettings / recurringApi を値として import しない（たどった先も）', () => {
  const { problems, visited } = findForbiddenValueImports(VIEW);
  assert.deepEqual(problems, []);
  // たどりが空振りして、何も見ずに通らないように（内訳シートと計算の lib まで見ている）
  for (const file of ['components/drilldown/DrillSheet.tsx', 'lib/periodSplit.ts', 'lib/drilldown.ts', 'lib/expenseState.ts']) {
    assert.ok(visited.includes(file), `${file} までたどれていない: ${visited.join(', ')}`);
  }
});

test('検査が働くこと: 取得・保存を受け持つ PeriodSplitCard は、hooks / householdApi / dateSettings の値の import で引っかかる', () => {
  const { problems } = findForbiddenValueImports(CARD);
  for (const name of ['lib/hooks', 'lib/householdApi', 'lib/dateSettings']) {
    assert.ok(
      problems.some((p) => p.startsWith('components/PeriodSplitCard.tsx:') && p.includes(name)),
      `${name} を見つけられない: ${problems.join(' / ')}`
    );
  }
});

test('import の読み取り: 型だけの import は通し、値の import（複数行・中括弧の中だけ type・再 export・動的）は拾う', () => {
  const read = (src) => parseImports(src).imports.map(({ spec, typeOnly }) => `${spec}:${typeOnly ? 'type' : 'value'}`);
  assert.deepEqual(read("import type { Expense } from '../lib/hooks';"), ['../lib/hooks:type']);
  assert.deepEqual(read("import type Foo from './foo';"), ['./foo:type']);
  assert.deepEqual(read("import { type Expense } from '../lib/hooks';"), ['../lib/hooks:value']);
  assert.deepEqual(read("import DrillSheet, { type DrillView } from './drilldown/DrillSheet';"), ['./drilldown/DrillSheet:value']);
  assert.deepEqual(
    read("import {\n  DEFAULT_SETTINGS,\n  type DateRangeSettings,\n} from '../lib/dateSettings';"),
    ['../lib/dateSettings:value']
  );
  assert.deepEqual(read("import * as hooks from '../lib/hooks';"), ['../lib/hooks:value']);
  assert.deepEqual(read("import '../lib/firebase';"), ['../lib/firebase:value']);
  assert.deepEqual(read("export { db } from '../lib/firebase';"), ['../lib/firebase:value']);
  assert.deepEqual(read("export type { Expense } from '../lib/hooks';"), ['../lib/hooks:type']);
  assert.deepEqual(read("const m = await import('../lib/lineAuth');"), ['../lib/lineAuth:value']);
  assert.deepEqual(read('const m = await import(name);'), ['null:value']);
  // 決まった形で読めない import の行は unparsed に入る（黙って読み飛ばさない）
  assert.equal(parseImports("import {\n  a, // コメント\n} from '../lib/hooks';").unparsed.length > 0, true);
  // 禁止の判定: web/lib のモジュール名とパッケージ
  assert.equal(isForbidden('../lib/hooks'), true);
  assert.equal(isForbidden('@/lib/lineAuth'), true);
  assert.equal(isForbidden('../../lib/recurringApi.ts'), true);
  assert.equal(isForbidden('firebase/firestore'), true);
  assert.equal(isForbidden('@line/liff'), true);
  assert.equal(isForbidden('../lib/periodSplit'), false);
  assert.equal(isForbidden('react'), false);
});
