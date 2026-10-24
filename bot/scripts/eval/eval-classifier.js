/**
 * カテゴリ分類の評価（正解率・null 率・レイテンシ・トークン・コスト・信頼度帯・閾値ごとの採用率）
 *
 *   npm -w bot run build
 *   node bot/scripts/eval/eval-classifier.js --provider gemini
 *   node bot/scripts/eval/eval-classifier.js --provider jev --variant guide
 *
 * オプション:
 *   --provider gemini|jev        評価する分類器（gemini = 本番の分類処理から Jev を外したもの。キャッシュ・辞書・Gemini。TYPESAFE_API_KEY を消して呼ぶ。
 *                                jev = Jev だけ。辞書・Gemini は通さない。jev は入力を切らずに送る。本番は先頭 100 文字に切ってから送るので、
 *                                100 文字を超える件だけ --variant v3 と本番の条件が少しずれる）
 *   --variant none|guide|v2|v3   jev のみ。選択肢の説明: none = 説明なし / guide = CATEGORY_GUIDE の一文 / v3 = 本番の Jev の説明
 *                                （bot/src/jevCategoryClassifier.ts。guide の食費・娯楽だけ JEV_V2 の説明にしたもの。「その他」は元のまま） / v2 = 「その他」への逃げを抑えた質問文と説明（JEV_V2）。
 *                                質問文は v2 の店名以外、本番の JEV_QUESTIONS
 *   --subset tune|hold|all       各経路を 1 件おきに「調整用（tune）」と「最終確認用（hold）」に分け、片方だけ使う（既定 all）。
 *                                調整は tune だけで行い、hold は最後に 1 回だけ測る。
 *                                振り分けは、除外・未見直しを外した後の並び順で 1 件おき。実行の間に review-golden.js で除外したり
 *                                見直したりすると、同じ経路の後ろの件で tune と hold が入れ替わる。tune で調整を始めた後は除外・見直しを
 *                                変えない（変えたら tune と hold をやり直す）
 *   --model ID                   jev のみ。モデル（jev- で始まる名前。既定 jev-1.13.0。プレビューは jev-1.14.0）。
 *                                値が無い・形が合わないときは止める
 *   --source text|merchant|all   評価する経路（既定 all）
 *   --limit N                    各経路の先頭 N 件だけ（試運転用）
 *   --delay-ms N                 1 件ごとに N ミリ秒待つ（Gemini の無料枠の 429 を避ける。既定 gemini=4000 / jev=0。待ちは計測に含めない）
 *   --golden PATH                評価データ（既定 bot/scripts/eval/golden.local.json）。形は架空のサンプル golden.sample.json を見る。
 *                                サンプルで試すときは *.local.json の名前（例: golden.try.local.json）にコピーして指定する
 *                                （golden.local.json は実データなので上書きしない。実データは必ず *.local.json の名前にする）
 *   --out-dir PATH               結果の出力先（既定 bot/scripts/eval/results）
 *   --include-unreviewed         reviewed でない件も使う（動作確認用。数字の報告には使わない）
 *   --show-errors                間違えた件を画面に出す（説明文・店名が出る。人に見せる画面では使わない）
 *
 * 出力: bot/scripts/eval/results/<tag>-<時刻>.local.json（`*.local.json` は .gitignore 済み。
 *   tag = gemini / jev-<variant>〔既定以外のモデルは -<model>〕。--subset tune|hold なら末尾に -tune / -hold）
 *   - items: 1 件ごとの結果（説明文・店名を含む。commit しない）
 *   - summary: 集計だけ（説明文を含まない。Issue に貼ってよい）
 * 画面には集計だけを出す。
 *
 * 前提: GEMINI_API_KEY（gemini）・TYPESAFE_API_KEY（jev）を .env（リポジトリ直下）か bot/.env に置く（両方を読む。両方にあればリポジトリ直下の値を使う）。
 *   bot/ は本番の Functions のソースで、TYPESAFE_API_KEY は関数の secrets の宣言と同名なので、TYPESAFE_API_KEY は bot/ 配下に置かず
 *   リポジトリ直下の .env に置くのを勧める。
 *   Jev の接続先とログの詳しさは本番と同じ値に固定する（環境変数 TYPESAFE_BASE_URL / TYPESAFE_LOG_LEVEL は効かない）。
 * 公式の単価は 2026-10-19 に確認した値（PRICES）。発表の前に公式ページで確かめ直す。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../..');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
dotenv.config({ path: path.join(ROOT, 'bot/.env'), quiet: true });

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const PROVIDER = arg('provider', 'gemini');
const VARIANT = arg('variant', 'guide');
const JEV_MODEL = arg('model', 'jev-1.13.0');
const SUBSET = arg('subset', 'all');
const SOURCE = arg('source', 'all');
const LIMIT = arg('limit') ? Number(arg('limit')) : Infinity;
const DELAY_MS = Number(arg('delay-ms', PROVIDER === 'gemini' ? 4000 : 0));
const GOLDEN = arg('golden', path.join(__dirname, 'golden.local.json'));

/** USD / 100 万トークン。出典: ai.google.dev/gemini-api/docs/pricing、docs.typesafe.ai/models.md（2026-10-19 確認） */
const PRICES = {
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'jev-1.13.0': { input: 0.042, output: 0 },
  // プレビュー版の単価は未確認。1.13.0 と同額と仮置きしているので、コストの数字は報告に使わない
  'jev-1.14.0': { input: 0.042, output: 0 },
};
const BINS = [
  [0, 0.4],
  [0.4, 0.6],
  [0.6, 0.8],
  [0.8, 0.9],
  [0.9, 1.0001],
];
const THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/**
 * v2: Jev の「その他」への逃げを抑える質問文と説明。評価データの店名・入力は一切入れていない（情報の漏れを避けるため）。
 * 食費・娯楽・その他は、評価の誤りの偏り（カテゴリ単位）を見て書き直した。この点は発表で開示する。
 * 食費・娯楽の説明は v3 として本番（bot/src/jevCategoryClassifier.ts）に移した。v3 は本番の値を使い、ここは v2 の記録として残す。
 */
const JEV_V2 = {
  merchant:
    '`input` はクレジットカードの利用明細に載った店名（半角カナ・ローマ字・略称・支店名が混ざる）。店名から業態を推測し、この家計で一番ありそうなカテゴリを選ぶ。業態が推測できる限り「その他」は選ばない。',
  descriptions: {
    食費: '食材、外食（飲食店・居酒屋・ファストフード・ラーメン・牛丼・寿司）、カフェ、コンビニ・スーパー・自販機での買い物、飲み物、弁当・デリバリー、飲み会',
    娯楽: '映画、ゲーム、書籍、漫画、おもちゃ、カラオケ、ライブ、趣味用品、スポーツ観戦、ゲームセンター、銭湯・サウナなどのレジャー施設。宿泊を伴う旅行は含めない',
    その他: '業態がまったく推測できないものだけ。飲食・買い物・娯楽などの業態が店名から推測できるなら、最も近いカテゴリを選ぶ',
  },
};

// ---- 分類器（provider ごとに classify(item) => { category, confidence, via, probabilities? } を用意する） ----
const usageLog = [];

function setupGemini() {
  // 本番の分類は Jev を先に呼ぶので、鍵を消して Gemini だけを測る（Jev のクォータも使わない）
  delete process.env.TYPESAFE_API_KEY;
  // 本番のコードは変えずに、SDK の呼び出しをラップしてトークン数を拾う
  const genai = require('@google/genai');
  const Original = genai.GoogleGenAI;
  genai.GoogleGenAI = class extends Original {
    constructor(options) {
      super(options);
      const call = this.models.generateContent;
      this.models.generateContent = async (params) => {
        const response = await call(params);
        const u = response.usageMetadata || {};
        usageLog.push({
          model: params.model,
          input: u.promptTokenCount ?? 0,
          output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        });
        return response;
      };
    }
  };
  // カテゴリ一覧は Firestore を使わず固定（空を返すと CANONICAL_CATEGORIES になる）
  require('../../dist/firestore').getAllUserCategories = async () => [];
  const { classifyExpenseWithGemini } = require('../../dist/geminiCategoryClassifier');
  return async (item) => {
    const r = await classifyExpenseWithGemini(`eval-${item.id}`, item.description, { source: item.source });
    const via = r.category === null ? 'none' : r.reasoning === 'Fast local keyword matching' ? 'dict' : 'gemini';
    return { category: r.category, confidence: r.confidence, via };
  };
}

function setupJev() {
  const { TypeSafeClient, choice } = require('@typesafe-ai/sdk');
  const { CANONICAL_CATEGORIES } = require('../../dist/categoryNormalization');
  const { CATEGORY_GUIDE } = require('../../dist/categoryGuide');
  // 質問文と v3 の説明は本番の値をそのまま使う（評価と本番がずれないように）
  const { jevCriteria, JEV_QUESTIONS, JEV_BASE_URL, JEV_LOG_LEVEL } = require('../../dist/jevCategoryClassifier');
  if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not set');
  // 接続先とログの詳しさは本番と同じ値に固定する（未指定だと SDK が環境変数 TYPESAFE_BASE_URL / TYPESAFE_LOG_LEVEL を読み、
  // 入力が別の接続先に送られたり debug ログで画面に出たりする）。dist が古くて値が無いときは止める
  if (!JEV_BASE_URL || !JEV_LOG_LEVEL) throw new Error('JEV_BASE_URL / JEV_LOG_LEVEL が dist に無い。npm -w bot run build で作り直す');
  const client = new TypeSafeClient({
    baseURL: JEV_BASE_URL,
    logLevel: JEV_LOG_LEVEL,
    defaultModel: JEV_MODEL,
    timeout: 10000,
    retry: { maxRetries: 1 },
  });
  // 選択肢の説明: none = なし / v2 = JEV_V2 → CATEGORY_GUIDE / v3 = 本番の jevCriteria / それ以外（guide）= CATEGORY_GUIDE
  const describe = (name) =>
    VARIANT === 'none' ? null : VARIANT === 'v2' ? (JEV_V2.descriptions[name] ?? CATEGORY_GUIDE[name] ?? null) : (CATEGORY_GUIDE[name] ?? null);
  const criteria =
    VARIANT === 'v3' ? jevCriteria(CANONICAL_CATEGORIES) : Object.fromEntries(CANONICAL_CATEGORIES.map((name) => [name, describe(name)]));
  // 質問文は本番の JEV_QUESTIONS（v2 の店名だけ JEV_V2.merchant）。仮の文なので、Ch5 で自分の言葉に決め直す
  const questions = {
    text: choice(JEV_QUESTIONS.text, criteria),
    merchant: choice(VARIANT === 'v2' ? JEV_V2.merchant : JEV_QUESTIONS.merchant, criteria),
  };
  return async (item) => {
    const { answers, model, usage } = await client.systemOne({
      state: { input: item.description },
      questions: { category: questions[item.source] },
    });
    usageLog.push({ model, input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, nullUsage: usage.input_tokens === null });
    const a = answers.category;
    return { category: a.choice, confidence: a.confidence, via: 'jev', probabilities: a.probabilities };
  };
}

// ---- 集計 ----
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);
const round = (x, d = 3) => (x === null || x === undefined ? null : Number(x.toFixed(d)));

function summarize(rows) {
  const n = rows.length;
  if (n === 0) return null;
  const answered = rows.filter((r) => r.pred !== null);
  const correct = rows.filter((r) => r.correct);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const inTok = rows.reduce((s, r) => s + r.inTok, 0);
  const outTok = rows.reduce((s, r) => s + r.outTok, 0);
  const models = [...new Set(rows.map((r) => r.model).filter(Boolean))];
  let costUsd = 0;
  let costKnown = true;
  for (const r of rows) {
    const p = PRICES[r.model];
    if (!p) {
      // 呼び出しが失敗してトークンが 0 の件（モデル名なし）は、単価不明とは数えない
      if (r.model) costKnown = false;
      continue;
    }
    costUsd += (r.inTok * p.input + r.outTok * p.output) / 1e6;
  }
  return {
    n,
    correct: correct.length,
    accuracy: round(correct.length / n),
    answered: answered.length,
    nullRate: round((n - answered.length) / n),
    accuracyAmongAnswered: answered.length ? round(correct.length / answered.length) : null,
    via: rows.reduce((m, r) => ((m[r.via] = (m[r.via] || 0) + 1), m), {}),
    latencyMs: { p50: percentile(ms, 0.5), p95: percentile(ms, 0.95), mean: round(ms.reduce((s, x) => s + x, 0) / n, 0) },
    tokens: { input: inTok, output: outTok, inputPerItem: round(inTok / n, 0), outputPerItem: round(outTok / n, 0) },
    models,
    costUsdPaidRate: costKnown ? round(costUsd, 6) : null,
    costUsdPer1000: costKnown ? round((costUsd / n) * 1000, 4) : null,
    byConfidenceBin: BINS.map(([lo, hi]) => {
      const inBin = answered.filter((r) => r.confidence >= lo && r.confidence < hi);
      return { range: `${lo}-${Math.min(hi, 1)}`, n: inBin.length, accuracy: inBin.length ? round(inBin.filter((r) => r.correct).length / inBin.length) : null };
    }),
    byThreshold: THRESHOLDS.map((t) => {
      const adopted = answered.filter((r) => r.confidence >= t);
      return {
        threshold: t,
        adoptedRate: round(adopted.length / n),
        accuracyAmongAdopted: adopted.length ? round(adopted.filter((r) => r.correct).length / adopted.length) : null,
      };
    }),
  };
}

function print(title, s) {
  if (!s) return;
  console.log(`\n== ${title} (n=${s.n}) ==`);
  console.log(`正解率 ${s.accuracy}（${s.correct}/${s.n}、null は不正解）| null 率 ${s.nullRate} | 回答した中での正解率 ${s.accuracyAmongAnswered}`);
  console.log(`判定の出どころ ${JSON.stringify(s.via)} | モデル ${s.models.join(', ') || '-'}`);
  console.log(`レイテンシ p50 ${s.latencyMs.p50}ms / p95 ${s.latencyMs.p95}ms / 平均 ${s.latencyMs.mean}ms`);
  console.log(`トークン 入力 ${s.tokens.input}（1 件 ${s.tokens.inputPerItem}）/ 出力 ${s.tokens.output}（1 件 ${s.tokens.outputPerItem}）`);
  console.log(`コスト（有料単価で計算）${s.costUsdPaidRate === null ? '単価不明のモデルあり' : `$${s.costUsdPaidRate}（1,000 件あたり $${s.costUsdPer1000}）`}`);
  console.log('信頼度帯ごとの正解率: ' + s.byConfidenceBin.map((b) => `${b.range}: ${b.accuracy ?? '-'}（${b.n}件）`).join(' | '));
  console.log('閾値ごと（採用率 / 採用した中の正解率）: ' + s.byThreshold.map((t) => `${t.threshold}: ${t.adoptedRate} / ${t.accuracyAmongAdopted ?? '-'}`).join(' | '));
}

async function main() {
  // 打ち間違いを黙って別の条件で測らない（特に --subset の誤りが hold 扱いになると、最終確認用を使ってしまう）
  if (!['gemini', 'jev'].includes(PROVIDER)) throw new Error(`--provider は gemini か jev（指定: ${PROVIDER}）`);
  if (!['none', 'guide', 'v2', 'v3'].includes(VARIANT)) throw new Error(`--variant は none / guide / v2 / v3（指定: ${VARIANT}）`);
  if (!['tune', 'hold', 'all'].includes(SUBSET)) throw new Error(`--subset は tune / hold / all（指定: ${SUBSET}）`);
  if (!['text', 'merchant', 'all'].includes(SOURCE)) throw new Error(`--source は text / merchant / all（指定: ${SOURCE}）`);
  // モデル名は結果のファイル名にも入る。値が無いと SDK が環境変数 TYPESAFE_DEFAULT_MODEL か jev-latest を使うので止める
  if (typeof JEV_MODEL !== 'string' || !/^jev-[\w.-]+$/.test(JEV_MODEL)) {
    const given = JEV_MODEL === undefined || JEV_MODEL.startsWith('--') ? '値なし' : JEV_MODEL;
    throw new Error(`--model は jev- で始まるモデル名（指定: ${given}）`);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  let items = golden.items.filter((it) => !it.excluded && (it.reviewed || flag('include-unreviewed')));
  if (!flag('include-unreviewed') && items.length === 0) throw new Error('reviewed な件が 0 件。review-golden.js で見直すか、--include-unreviewed を付ける');
  const sources = SOURCE === 'all' ? ['text', 'merchant'] : [SOURCE];
  items = sources.flatMap((s) =>
    items
      .filter((it) => it.source === s)
      .filter((_, i) => SUBSET === 'all' || (SUBSET === 'tune' ? i % 2 === 0 : i % 2 === 1))
      .slice(0, LIMIT)
  );

  const classify = PROVIDER === 'jev' ? setupJev() : setupGemini();
  // 初回の接続・モデル一覧の取得を測定に含めないため、1 回空打ちする
  await classify({ id: 'warmup', source: 'merchant', description: 'WARMUP' }).catch(() => {});
  usageLog.length = 0;

  const rows = [];
  for (const item of items) {
    const before = usageLog.length;
    const t0 = Date.now();
    let result;
    try {
      result = await classify(item);
    } catch {
      result = { category: null, confidence: 0, via: 'error' };
    }
    const ms = Date.now() - t0;
    const used = usageLog.slice(before);
    rows.push({
      id: item.id,
      source: item.source,
      description: item.description,
      label: item.label,
      pred: result.category,
      confidence: result.confidence,
      via: result.via,
      correct: result.category !== null && result.category === item.label,
      ms,
      inTok: used.reduce((s, u) => s + u.input, 0),
      outTok: used.reduce((s, u) => s + u.output, 0),
      model: used.length ? used[used.length - 1].model : null,
      probabilities: result.probabilities,
    });
    if (DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  const tag = (PROVIDER === 'jev' ? `jev-${VARIANT}${JEV_MODEL === 'jev-1.13.0' ? '' : `-${JEV_MODEL}`}` : 'gemini') + (SUBSET === 'all' ? '' : `-${SUBSET}`);
  const summary = { tag, provider: PROVIDER, variant: PROVIDER === 'jev' ? VARIANT : null, createdAt: new Date().toISOString(), bySource: {} };
  for (const s of [...sources, 'all']) {
    const subset = s === 'all' ? rows : rows.filter((r) => r.source === s);
    summary.bySource[s] = summarize(subset);
    if (s !== 'all' || sources.length > 1) print(`${tag} / ${s}`, summary.bySource[s]);
  }

  const dir = arg('out-dir', path.join(__dirname, 'results'));
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.local.json`);
  fs.writeFileSync(out, JSON.stringify({ summary, items: rows }, null, 2));
  console.log(`\nwrote ${path.relative(ROOT, out)}（items は説明文・店名を含む。commit しない。summary だけ Issue に貼ってよい）`);

  if (flag('show-errors')) {
    console.log('\n-- 間違い --');
    for (const r of rows.filter((x) => !x.correct)) console.log(`${r.id} [${r.label} → ${r.pred ?? 'null'} ${r.confidence}] ${r.description}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('eval failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
);
