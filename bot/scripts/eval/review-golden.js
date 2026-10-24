/**
 * 評価データの正解ラベルを、ターミナルで素早く見直す
 *
 *   node bot/scripts/eval/review-golden.js [--all] [--label カテゴリ名] [--source text|merchant]
 *     --all     見直し済みの件も、もう一度見る（除外した件は出さない）
 *     --label   そのラベルが付いている件だけ見る（例: --all --label その他）
 *     --source  その経路の件だけ見る
 *
 * 10 件ずつ「いまのラベル」を見せる。
 *   Enter          … 10 件すべて正しい
 *   3=日用品 7=衣服 … 番号のラベルを直す（カテゴリ名は一覧のとおりに）
 *   x4             … 4 番を評価から外す（正解が決められないもの）
 *   q              … 保存して終了
 * 見直した件は reviewed: true になり、評価にはそれだけが使われる。1 バッチごとに保存する。
 * 画面に説明文・店名が出る。人に見せる画面では実行しないこと。
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { CANONICAL_CATEGORIES } = require('../../dist/categoryNormalization');

const file = path.join(__dirname, 'golden.local.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const redo = process.argv.includes('--all');
const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const onlyLabel = argOf('label');
const onlySource = argOf('source');
const queue = data.items.filter(
  (it) =>
    (redo || !it.reviewed) &&
    !it.excluded &&
    (!onlyLabel || it.label === onlyLabel) &&
    (!onlySource || it.source === onlySource)
);
const BATCH = 10;

const save = () => {
  const body = data.items.map((it) => '    ' + JSON.stringify(it)).join(',\n');
  fs.writeFileSync(file, `{\n  "meta": ${JSON.stringify(data.meta)},\n  "items": [\n${body}\n  ]\n}\n`);
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

async function main() {
  console.log('カテゴリ一覧:', CANONICAL_CATEGORIES.join(' / '));
  console.log(`見直す件数: ${queue.length}（全 ${data.items.length} 件、見直し済み ${data.items.filter((i) => i.reviewed).length} 件）\n`);

  for (let start = 0; start < queue.length; start += BATCH) {
    const batch = queue.slice(start, start + BATCH);
    batch.forEach((it, i) => {
      const tag = it.source === 'merchant' ? '店名' : '入力';
      console.log(`${String(i + 1).padStart(2)}  [${it.label}]  (${tag}) ${it.description}`);
    });
    const answer = (await ask('\nEnter=すべて正しい / 番号=カテゴリ / x番号=除外 / q=終了 > ')).trim();
    if (answer === 'q') break;

    const excluded = new Set();
    const fixes = new Map();
    let bad = false;
    for (const token of answer.split(/\s+/).filter(Boolean)) {
      const x = token.match(/^x(\d+)$/);
      const f = token.match(/^(\d+)=(.+)$/);
      if (x) excluded.add(Number(x[1]));
      else if (f && CANONICAL_CATEGORIES.includes(f[2])) fixes.set(Number(f[1]), f[2]);
      else {
        console.log(`  読み取れない入力: ${token}（このバッチはやり直し）`);
        bad = true;
      }
    }
    if (bad) {
      start -= BATCH;
      continue;
    }
    batch.forEach((it, i) => {
      const n = i + 1;
      if (fixes.has(n)) it.label = fixes.get(n);
      it.excluded = excluded.has(n);
      it.reviewed = true;
    });
    save();
    console.log(`  保存した（直した ${fixes.size} 件、除外 ${excluded.size} 件）\n`);
  }
  rl.close();
  const reviewed = data.items.filter((i) => i.reviewed && !i.excluded);
  console.log(`評価に使える件数: ${reviewed.length}（text ${reviewed.filter((i) => i.source === 'text').length} / merchant ${reviewed.filter((i) => i.source === 'merchant').length}）`);
}

main();
