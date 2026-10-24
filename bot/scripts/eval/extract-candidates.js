/**
 * カテゴリ分類の評価データ（候補）を Firestore から取り出す
 *
 *   npm -w bot run build
 *   node bot/scripts/eval/extract-candidates.js [--text 200] [--merchant 200] [--limit 600]
 *
 * 出力: bot/scripts/eval/golden.local.json（`*.local.json` は .gitignore 済み。commit しない）
 *   ファイルがすでにあるときは**追記**する。見直し済みの件とそのラベルは、そのまま残す。
 *   同じ経路・同じ説明文の件は足さない。--text / --merchant は「新しく足す件数の上限」。
 *
 * - text（LINE の入力）: キーワード辞書で外れたものだけ残す（モデルが呼ばれるのはそのときだけ）
 * - merchant（カードの店名）: 店名すべて
 * - label には保存済みのカテゴリを仮に入れる。ただしそれは分類器の出力のまま残っていることが多い
 *   （カード取込は確認不要）。必ず review-golden.js で人が見直し、reviewed: true のものだけを評価に使う。
 *
 * 本番の Firestore を読むので、自分のマシンで自分が実行する。説明文・店名は画面に出さない（件数だけ出す）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

// Firestore の認証は、実在するものを次の順に使う（パス以外は表示しない）
//   1. .env の GOOGLE_APPLICATION_CREDENTIALS（相対パスならリポジトリ直下から）
//   2. bot/kakeibo_service.json
//   3. どちらも無ければ、gcloud の Application Default Credentials
const envCred = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const credCandidates = [
  envCred && (path.isAbsolute(envCred) ? envCred : path.join(ROOT, envCred)),
  path.join(ROOT, 'bot/kakeibo_service.json'),
].filter(Boolean);
const credFile = credCandidates.find((p) => fs.existsSync(p));
if (credFile) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credFile;
  console.log('credentials:', path.relative(ROOT, credFile));
} else {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  console.log('credentials: gcloud application-default');
}
// 辞書だけで判定させるため、Gemini は使えない状態にする（キーはこのプロセスの中だけで消す）
delete process.env.GEMINI_API_KEY;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { classifyExpenseWithGemini } = require('../../dist/geminiCategoryClassifier');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}
const PER_SOURCE = { text: arg('text', 200), merchant: arg('merchant', 200) };
const LIMIT = arg('limit', 600);
const SOURCES = [
  { inputSource: 'line_text', source: 'text' },
  { inputSource: 'gmail_auto', source: 'merchant' },
];

/** 同じ並びになる疑似乱数（再実行しても同じ標本になる） */
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
  const db = getFirestore();
  const random = rng(20261019);
  const out = path.join(__dirname, 'golden.local.json');
  const existing = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { items: [] };
  const items = [...existing.items];
  const have = new Set(existing.items.map((it) => `${it.source}|${it.description.trim().toLowerCase()}`));
  const counts = {};

  for (const { inputSource, source } of SOURCES) {
    const snap = await db.collection('expenses').where('inputSource', '==', inputSource).limit(LIMIT).get();
    const seen = new Set();
    let candidates = [];
    for (const doc of snap.docs) {
      const d = doc.data();
      const description = String(d.description ?? '').trim();
      const key = description.toLowerCase();
      if (!description || !d.category || seen.has(key)) continue;
      seen.add(key);
      candidates.push({ description, saved: d.category });
    }
    const unique = candidates.length;
    candidates = candidates.filter((c) => !have.has(`${source}|${c.description.toLowerCase()}`));
    const alreadyHave = unique - candidates.length;

    if (source === 'text') {
      const misses = [];
      for (const c of candidates) {
        const r = await classifyExpenseWithGemini('eval', c.description, { source: 'text' });
        if (r.reasoning !== 'Fast local keyword matching') misses.push(c);
      }
      candidates = misses;
    }

    const picked = shuffle(candidates, random).slice(0, PER_SOURCE[source]);
    const base = existing.items.filter((it) => it.source === source).length;
    picked.forEach((c, i) =>
      items.push({
        id: `${source}-${String(base + i + 1).padStart(3, '0')}`,
        source,
        description: c.description,
        saved: c.saved,
        label: c.saved,
        reviewed: false,
      })
    );
    counts[source] = { fetched: snap.size, unique, alreadyHave, addable: candidates.length, added: picked.length };
  }

  const body = items.map((it) => '    ' + JSON.stringify(it)).join(',\n');
  const meta = JSON.stringify({ ...(existing.meta || {}), updatedAt: new Date().toISOString(), lastCounts: counts });
  fs.writeFileSync(out, `{\n  "meta": ${meta},\n  "items": [\n${body}\n  ]\n}\n`);
  console.log('counts', counts);
  console.log('wrote', path.relative(ROOT, out), `(合計 ${items.length} 件、うち見直し済み ${items.filter((it) => it.reviewed).length} 件; not committed)`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('extract failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
);
