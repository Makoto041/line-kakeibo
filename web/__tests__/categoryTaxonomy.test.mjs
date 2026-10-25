// web の中項目の一覧（web/lib/categoryTaxonomy.ts）が、bot の一覧（bot/src/categoryTaxonomy.ts）と
// 一致することのテスト（#235）。一覧は二重管理なので、片方だけを変えるとここで落ちる。
// bot のモジュールは web から import できない（bot は CommonJS で、拡張子なしの import を含む）ため、
// bot のソースを文字列として読み、SUB_CATEGORIES の中の文字列を拾って比べる。
// node --test で実行する（Node 22.18 以降の型除去で .ts を直接読む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SUB_CATEGORIES } from '../lib/categoryTaxonomy.ts';

// CI は web/ を作業ディレクトリにして実行するので、このファイルからの相対で読む
const BOT_TAXONOMY = new URL('../../bot/src/categoryTaxonomy.ts', import.meta.url);

/** bot のソースから SUB_CATEGORIES（大項目 → 中項目の配列）を取り出す */
function readBotSubCategories() {
  const src = readFileSync(BOT_TAXONOMY, 'utf8');
  const start = src.indexOf('export const SUB_CATEGORIES');
  assert.notEqual(start, -1, 'bot/src/categoryTaxonomy.ts に SUB_CATEGORIES が無い');
  const open = src.indexOf('{', start);
  const close = src.indexOf('\n};', open);
  assert.ok(open !== -1 && close !== -1, 'SUB_CATEGORIES の範囲を読めない');
  const body = src.slice(open + 1, close);

  const str = /'([^']*)'|"([^"]*)"/g;
  const unquote = (s) => s.replace(/^['"]|['"]$/g, '');
  const result = {};
  for (const m of body.matchAll(/('[^']*'|"[^"]*"|[^\s'"{}[\],:]+)\s*:\s*\[([^\]]*)\]/g)) {
    const key = unquote(m[1]);
    assert.ok(!(key in result), `大項目が重複している: ${key}`);
    result[key] = [...m[2].matchAll(str)].map((s) => s[1] ?? s[2]);
  }
  return result;
}

test('web の中項目の一覧は、bot の一覧と大項目・中項目・並び順まで一致する', () => {
  const bot = readBotSubCategories();
  // 読み取りが空振りして、空どうしで一致しないように
  assert.ok(Object.keys(bot).length > 0, 'bot の一覧を読めない');
  for (const [major, subs] of Object.entries(bot)) {
    assert.ok(subs.length > 0, `bot の ${major} の中項目を読めない`);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(SUB_CATEGORIES).map(([k, v]) => [k, [...v]])),
    bot,
    'web/lib/categoryTaxonomy.ts と bot/src/categoryTaxonomy.ts の SUB_CATEGORIES を同じにする'
  );
});

test('中項目は食費・娯楽だけ。「その他の食費」「その他の娯楽」を含む', () => {
  assert.deepEqual(Object.keys(SUB_CATEGORIES), ['食費', '娯楽']);
  assert.equal(SUB_CATEGORIES['食費'].length, 10);
  assert.equal(SUB_CATEGORIES['娯楽'].length, 8);
  assert.equal(SUB_CATEGORIES['食費'].at(-1), 'その他の食費');
  assert.equal(SUB_CATEGORIES['娯楽'].at(-1), 'その他の娯楽');
});

// 保存する値は選択肢の文字列そのもの。firestore.rules の subCategory（文字列 50 文字以内）に収まること
test('中項目名は、大項目の中で一意・空でない・50 文字以内（ルールの上限）', () => {
  for (const [major, subs] of Object.entries(SUB_CATEGORIES)) {
    assert.equal(new Set(subs).size, subs.length, `${major} の中項目が重複している`);
    for (const name of subs) {
      assert.equal(typeof name, 'string');
      assert.ok(name.trim().length > 0, `${major} に空の中項目がある`);
      assert.ok(name.length <= 50, `${major} の「${name}」が 50 文字を超える`);
    }
  }
});
