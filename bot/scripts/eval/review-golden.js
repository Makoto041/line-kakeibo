/**
 * 評価データの正解ラベルを、ターミナルで素早く見直す
 *
 *   node bot/scripts/eval/review-golden.js [--all] [--label カテゴリ名] [--source text|merchant] [--ids PATH] [--golden PATH]
 *     --all     見直し済みの件も、もう一度見る（除外した件は出さない）
 *     --label   そのラベルが付いている件だけ見る（例: --all --label その他）
 *     --source  その経路の件だけ見る
 *     --ids     JSON { "<id>": "<モデルの答え>" } に載っている件だけ、見直し済みでも見る。モデルの答えを横に出す
 *               （ファイル名は *.local.json にしてコミットしない）
 *     --golden  評価データ（既定 bot/scripts/eval/golden.local.json。別のファイルにするときも *.local.json の名前にする）
 *
 * 10 件ずつ「いまのラベル」を見せる。
 *   Enter          … 10 件すべて正しい
 *   3=日用品 7=衣服 … 番号のラベルを直す（カテゴリ名は一覧のとおりに）
 *   x4             … 4 番を評価から外す（正解が決められないもの）
 *   q              … 保存して終了
 * 見直した件は reviewed: true になり、評価にはそれだけが使われる。1 バッチごとに保存する。
 *
 * 中項目（#235）の正解 subLabel を付ける:
 *   node bot/scripts/eval/review-golden.js --sub [--redo] [--label カテゴリ名] [--source text|merchant] [--ids PATH] [--golden PATH]
 *     --sub     見直し済み・除外していない・大項目に中項目の一覧がある件（一覧は bot/src/categoryTaxonomy.ts。仮）のうち、
 *               subLabel がまだ無い件を 1 件ずつ見る
 *     --redo    subLabel がすでにある件（「決められない」を含む）も、付け直す
 *     --ids     その JSON に載っている件だけに絞る。--sub ではモデルの答えを出さない（先に見ると引きずられるため）
 *   1〜n … その番号の中項目（中項目名をそのまま打ってもよい）
 *   0    … 決められない（subLabel: null）
 *   s    … スキップ（何も書かない）
 *   q    … 終了（1 件ごとに保存するので、それまでの分は保存済み）
 * 書き換えるのは subLabel だけ（label・reviewed・excluded は変えない）。大項目を直すときは --sub なしで実行する。
 * 対象の件があるときは、書き換える前に評価データのコピー（<名前>.sub-backup-<時刻>.local.json。同じフォルダー）を作り、パスを出す。
 *
 * 古い subLabel の扱い: 大項目を --sub なしで直しても、subLabel は自動では消えない。
 *   - 直した先の大項目に中項目の一覧があり、subLabel がその一覧に無ければ、--redo なしでも --sub の対象になる
 *   - 中項目の一覧が無い大項目（例: 日用品）に直した件は、--sub の対象に出ない（古い subLabel が残る）
 *   そのため、中項目を評価するときは validSubLabel(item) が true の件（subLabel がいまの大項目の一覧にある件）だけを数える。
 *
 * 保存は、同じフォルダーの一時ファイル（<名前>.tmp.local.json）に書いてから置き換える（途中で失敗しても元のファイルは壊れない）。
 * 画面に説明文・店名（実データ）が出る。人に見せる画面では実行しないこと。
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { CANONICAL_CATEGORIES } = require('../../dist/categoryNormalization');
const { SUB_CATEGORIES, subCategoriesOf } = require('../../dist/categoryTaxonomy');

const BATCH = 10;
/** --sub で「決められない」（subLabel: null）を選ぶキー */
const SUB_NULL_KEY = '0';

const argOf = (argv, name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

/** file と同じフォルダーの <名前>.<tag>.local.json（*.local.json は .gitignore 済み） */
function siblingPath(file, tag) {
  const base = path.basename(file).replace(/\.local\.json$/, '');
  return path.join(path.dirname(file), `${base}.${tag}.local.json`);
}

/** 一時ファイルに書いてから置き換える。失敗したら一時ファイルを消して投げ直す（元のファイルはそのまま） */
function saveGolden(file, data) {
  const body = data.items.map((it) => '    ' + JSON.stringify(it)).join(',\n');
  const text = `{\n  "meta": ${JSON.stringify(data.meta)},\n  "items": [\n${body}\n  ]\n}\n`;
  const tmp = siblingPath(file, 'tmp');
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_e) {
      // 一時ファイルができていない
    }
    throw e;
  }
}

/** 評価データのコピーを <名前>.sub-backup-<時刻>.local.json に作り、そのパスを返す（同名があれば上書きせずに投げる） */
function backupGolden(file, now = new Date()) {
  const backup = siblingPath(file, `sub-backup-${now.toISOString().replace(/[-:.]/g, '')}`);
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  return backup;
}

/** 中項目の正解として使えるか（subLabel が、いまの大項目の中項目の一覧にある）。null（決められない）や古い subLabel は false */
function validSubLabel(item) {
  return typeof item.subLabel === 'string' && subCategoriesOf(item.label).includes(item.subLabel);
}

/**
 * 中項目の答えを当てた、新しい item を返す（item は変えない。subLabel 以外のキーもそのまま）。
 * key: 1〜list.length の番号、list にある中項目名、または SUB_NULL_KEY（決められない → null）。
 * list はその大項目の中項目の一覧（subCategoriesOf(item.label)）。読み取れない答え・一覧が空なら null を返す。
 */
function applySubLabel(item, key, list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const k = String(key ?? '').trim();
  if (k === SUB_NULL_KEY) return { ...item, subLabel: null };
  if (/^\d+$/.test(k)) {
    const n = Number(k);
    return n >= 1 && n <= list.length ? { ...item, subLabel: list[n - 1] } : null;
  }
  return list.includes(k) ? { ...item, subLabel: k } : null;
}

/**
 * --sub で中項目を付ける件（items の要素そのもの）を、並び順のまま返す。
 * 見直し済み・除外していない・大項目に中項目の一覧がある件だけが対象。そのうえで:
 *   - subLabel が無い件は対象。ある件（null = 決められない、を含む）は opts.redo のときだけ対象
 *   - subLabel が、いまの大項目の一覧に無い値なら（大項目を後から直した件）、redo でなくても対象
 * opts.ids（id の配列か Set）・opts.label・opts.source があれば、それに合う件だけに絞る。
 */
function itemsToLabelSub(items, opts = {}) {
  const ids = opts.ids ? new Set(opts.ids) : null;
  return items.filter((it) => {
    if (!it.reviewed || it.excluded) return false;
    if (ids && !ids.has(it.id)) return false;
    if (opts.label && it.label !== opts.label) return false;
    if (opts.source && it.source !== opts.source) return false;
    if (subCategoriesOf(it.label).length === 0) return false;
    if (opts.redo || it.subLabel === undefined) return true;
    return it.subLabel !== null && !validSubLabel(it);
  });
}

async function reviewLabels({ file, data, hints, label: onlyLabel, source: onlySource, redo }) {
  const queue = data.items.filter(
    (it) =>
      (hints ? Object.prototype.hasOwnProperty.call(hints, it.id) : redo || !it.reviewed) &&
      !it.excluded &&
      (!onlyLabel || it.label === onlyLabel) &&
      (!onlySource || it.source === onlySource)
  );
  const save = () => saveGolden(file, data);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.log('カテゴリ一覧:', CANONICAL_CATEGORIES.join(' / '));
  console.log(`見直す件数: ${queue.length}（全 ${data.items.length} 件、見直し済み ${data.items.filter((i) => i.reviewed).length} 件）\n`);

  for (let start = 0; start < queue.length; start += BATCH) {
    const batch = queue.slice(start, start + BATCH);
    batch.forEach((it, i) => {
      const tag = it.source === 'merchant' ? '店名' : '入力';
      const hint = hints ? `  ← モデル: ${hints[it.id]}` : '';
      console.log(`${String(i + 1).padStart(2)}  [${it.label}]  (${tag}) ${it.description}${hint}`);
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

async function reviewSubLabels({ file, data, hints, label, source, redo }) {
  // --ids は件を絞るだけに使い、モデルの答え（値）は読まない・出さない
  const queue = itemsToLabelSub(data.items, { redo, label, source, ids: hints ? Object.keys(hints) : null });

  console.log('中項目の一覧（仮。bot/src/categoryTaxonomy.ts）:');
  for (const [major, list] of Object.entries(SUB_CATEGORIES)) console.log(`  ${major}: ${list.join(' / ')}`);
  console.log(`中項目を付ける件数: ${queue.length}（全 ${data.items.length} 件、subLabel あり ${data.items.filter((i) => i.subLabel !== undefined).length} 件）`);
  // 書き換える前に 1 回だけ、評価データのコピーを作る（書き換える件が無ければ作らない）
  if (queue.length > 0) console.log(`バックアップ: ${backupGolden(file)}`);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // rl.question は、まとめて届いた行（パイプからの入力など）を取りこぼすので、行を順に読む。入力が終わったら q と同じ
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    rl.setPrompt(q);
    rl.prompt();
    const r = await lines.next();
    if (r.done) console.log('');
    return r.done ? 'q' : r.value;
  };

  let labeled = 0;
  let skipped = 0;
  for (let i = 0; i < queue.length; i++) {
    const it = queue[i];
    const list = subCategoriesOf(it.label);
    const tag = it.source === 'merchant' ? '店名' : '入力';
    const now = it.subLabel === undefined ? '' : `  （いまの中項目: ${it.subLabel ?? '決められない'}）`;
    console.log(`[${i + 1}/${queue.length}]  [${it.label}]  (${tag}) ${it.description}${now}`);
    list.forEach((name, j) => console.log(`  ${String(j + 1).padStart(2)}  ${name}`));
    console.log(`  ${SUB_NULL_KEY.padStart(2)}  決められない`);
    const answer = (await ask('番号=中項目 / 0=決められない / s=スキップ / q=終了 > ')).trim();
    if (answer === 'q') break;
    if (answer === 's') {
      skipped++;
      console.log('');
      continue;
    }
    const next = applySubLabel(it, answer, list);
    if (!next) {
      console.log(`  読み取れない入力: ${answer}（この件はやり直し）\n`);
      i--;
      continue;
    }
    data.items[data.items.indexOf(it)] = next;
    saveGolden(file, data);
    labeled++;
    console.log(`  保存した: ${next.subLabel ?? '決められない'}\n`);
  }
  rl.close();
  const eligible = itemsToLabelSub(data.items, { redo: true });
  console.log(
    `中項目を付けられる件: ${eligible.length}、うち正解として使える ${eligible.filter(validSubLabel).length}・` +
      `決められない ${eligible.filter((i) => i.subLabel === null).length}。今回 付けた ${labeled} 件、スキップ ${skipped} 件`
  );
}

async function main(argv) {
  const file = argOf(argv, 'golden') || path.join(__dirname, 'golden.local.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const idsFile = argOf(argv, 'ids');
  const hints = idsFile ? JSON.parse(fs.readFileSync(idsFile, 'utf8')) : null;
  const opts = { file, data, hints, label: argOf(argv, 'label'), source: argOf(argv, 'source') };
  if (argv.includes('--sub')) return reviewSubLabels({ ...opts, redo: argv.includes('--redo') });
  if (argv.includes('--redo')) {
    console.error('--redo は --sub と一緒に使う（大項目の見直しをやり直すときは --all）');
    process.exitCode = 1;
    return;
  }
  return reviewLabels({ ...opts, redo: argv.includes('--all') });
}

module.exports = { SUB_NULL_KEY, applySubLabel, itemsToLabelSub, validSubLabel, saveGolden, backupGolden };

if (require.main === module) {
  main(process.argv);
}
