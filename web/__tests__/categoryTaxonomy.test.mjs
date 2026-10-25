// web の中項目の一覧（web/lib/categoryTaxonomy.ts）が、bot の一覧（bot/src/categoryTaxonomy.ts）と
// 一致することのテスト（#235）。一覧は二重管理なので、片方だけを変えるとここで落ちる。
// bot のモジュールは web から import できない（bot は CommonJS で、拡張子なしの import を含む）ため、
// bot のソースを文字列として読み、SUB_CATEGORIES のブロックを 1 行ずつ読んで比べる。
// 決まった形（開始行・大項目の見出し・中項目の行・`],`・`};`）以外の行があれば失敗にする
// （書き方を変えたときに、読み取りが黙って食い違わないように。変えたらこのテストの読み方も直す）。
// node --test で実行する（Node 22.18 以降の型除去で .ts を直接読む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SUB_CATEGORIES } from '../lib/categoryTaxonomy.ts';

// CI は web/ を作業ディレクトリにして実行するので、このファイルからの相対で読む
const BOT_TAXONOMY = new URL('../../bot/src/categoryTaxonomy.ts', import.meta.url);

// SUB_CATEGORIES のブロックの行の形。どれにも当たらない行があれば失敗にする
// （行末コメント付きの項目・1 行に並べた配列などを、黙って読み飛ばさないように）
const LINE_START = /^export const SUB_CATEGORIES\b[^=]*=\s*\{$/; // 開始行
const LINE_MAJOR = /^(?:([^\s'"{}[\],:]+)|'([^']+)'|"([^"]+)")\s*:\s*\[$/; // 大項目の見出し（食費: [）
const LINE_ITEM = /^(?:'([^']*)'|"([^"]*)"),?$/; // 中項目（'外食',）
const LINE_LIST_END = /^\],?$/; // 大項目の配列の終わり
const LINE_END = /^\};$/; // SUB_CATEGORIES の終わり

/**
 * bot のソースから SUB_CATEGORIES（大項目 → 中項目の配列）を取り出す。
 * 開始行から、SUB_CATEGORIES 自身の `};` までを 1 行ずつ読み、決まった形の行だけを受け付ける。
 */
function readBotSubCategories() {
  const lines = readFileSync(BOT_TAXONOMY, 'utf8').split('\n').map((l) => l.trim());
  const startAt = lines.findIndex((l) => l.startsWith('export const SUB_CATEGORIES'));
  assert.notEqual(startAt, -1, 'bot/src/categoryTaxonomy.ts に SUB_CATEGORIES が無い');
  assert.match(lines[startAt], LINE_START, `SUB_CATEGORIES の開始行の形が想定と違う: ${lines[startAt]}`);

  const result = {};
  let major = null;
  let ended = false;
  for (let i = startAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    const where = `bot/src/categoryTaxonomy.ts ${i + 1} 行目`;
    // 次の宣言に入る前に、SUB_CATEGORIES 自身の `};` で終わっていること（`} as const;` などで終端を
    // 読み違えると、後ろの SUB_CATEGORY_DESCRIPTIONS まで読んでしまう）
    assert.ok(!/^export\s/.test(line), `${where}: SUB_CATEGORIES が \`};\` で終わる前に次の宣言が始まった`);
    if (major === null) {
      if (LINE_END.test(line)) {
        ended = true;
        break;
      }
      const m = line.match(LINE_MAJOR);
      assert.ok(m, `${where}: 大項目の見出しか \`};\` のはずが「${line}」`);
      major = m[1] ?? m[2] ?? m[3];
      assert.ok(!(major in result), `${where}: 大項目が重複している: ${major}`);
      result[major] = [];
      continue;
    }
    if (LINE_LIST_END.test(line)) {
      major = null;
      continue;
    }
    const item = line.match(LINE_ITEM);
    assert.ok(item, `${where}: 中項目の行（'名前',）か \`],\` のはずが「${line}」`);
    result[major].push(item[1] ?? item[2]);
  }
  assert.ok(ended, 'SUB_CATEGORIES の終わり（`};` だけの行）が見つからない');
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
