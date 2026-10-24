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
 * 階層化（大項目 / 中項目。#235）の評価:
 *   node bot/scripts/eval/eval-classifier.js --provider jev --variant v3 --scheme stage2 --limit 5          # 試運転
 *   node bot/scripts/eval/eval-classifier.js --provider jev --variant v3 --scheme stage2 --subset tune
 *   node bot/scripts/eval/eval-classifier.js --provider jev --variant v3 --scheme flat --decode sum --subset tune
 *
 *   --scheme major|stage2|flat   major = 大項目だけを測る（既定。今までどおり）。stage2 / flat は --provider jev のときだけ
 *                                （Jev だけで判定する。辞書は通さず、Gemini には送らない）。
 *                                stage2 = 1 回目は major と同じ要求（同じ --variant。本番と同じにするなら --variant v3）。
 *                                  1 回目で決まった大項目に中項目の一覧（bot/src/categoryTaxonomy.ts の subCategoriesOf。仮）が
 *                                  あるときだけ、2 回目の要求（その大項目の中項目から 1 つを選ぶ choice の質問 1 問。質問文は SUB_QUESTIONS）を送る。
 *                                flat = 大項目と中項目を並べた 1 回の要求。選択肢は、中項目のある大項目は「大項目/中項目」、
 *                                  中項目の無い大項目は大項目名（説明は --variant のとおり）。質問文は major と同じ。
 *   --sub-desc on|off            stage2 / flat のみ。中項目の選択肢に説明（categoryTaxonomy.ts の SUB_CATEGORY_DESCRIPTIONS。仮）を
 *                                付けるか（既定 off = 説明なし）。説明の無い中項目は説明なしで送る（その個数を画面と summary に出す）
 *   --stage2-major pred|gold     stage2 のみ。2 回目に使う大項目（既定 pred = 1 回目の答え / gold = 正解の大項目。2 回目だけの精度を
 *                                切り分ける用。gold でも 1 回目は送る。--show-errors では 1 回目の大項目と、正解の大項目の下で選んだ
 *                                中項目を分けて出す）
 *   --decode argmax|sum         flat のみ。argmax = Jev の答え（choice）をそのまま使う（既定）/ sum = probabilities を大項目ごとに
 *                                合計して大項目を決め、その大項目の中で確率の最も高い中項目を選ぶ（同点は選択肢の並び順で先のもの）
 *   - 対象は、中項目の正解がある件だけ（review-golden.js の validSubLabel が true。subLabel が、いまの大項目の中項目の一覧にある件）。
 *     tune / hold の振り分けは major と同じ（振り分けた後で対象を絞る）。--limit は絞った後の各経路の先頭 N 件。
 *   - 集計: 既存の項目（正解率 = 大項目の正解率、レイテンシ = 1 件の段の合計、トークン・コスト = 段の合計）はそのまま。
 *     summary.bySource.*.hierarchy に、大項目が正解の件の中での中項目の正解率、大項目と中項目の両方が正解の割合、
 *     中項目の正解率（全件。gold では 2 回目だけの精度）、1 件あたりの呼び出し回数、1 件のレイテンシの p50 / p95、
 *     段ごとの呼び出し回数・トークン・レイテンシ・コスト（stage2 は 1 回目に対する倍率も）を足す。
 *   - データと費用: 評価データ（実際の支出の説明文・店名）を、切らずに Jev に送る（stage2 は 1 件につき最大 2 回）。
 *     鍵は本番と別のもの（評価用に作った TYPESAFE_API_KEY）を使う。費用の目安は、1 回 119 件で、stage2 は major の約 1.2〜1.4 倍の見込み
 *     （major は 1 回で 1 セント未満。実測で置き換える）。flat は選択肢が増える分だけ増える。
 *     評価の対象は中項目のある大項目の件だけなので、ほぼ全件で 2 回目を送る。本番の倍率は、2 回目を送る件の割合で変わる。
 *
 * 出力: bot/scripts/eval/results/<tag>-<時刻>.local.json（`*.local.json` は .gitignore 済み。
 *   tag = gemini / jev-<variant>〔既定以外のモデルは -<model>〕。stage2 は -stage2-subdesc-<on|off>-major-<pred|gold>、
 *   flat は -flat-subdesc-<on|off>-<argmax|sum> を足す。--subset tune|hold なら末尾に -tune / -hold）
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
const SCHEME = arg('scheme', 'major');
const SUB_DESC = arg('sub-desc', 'off');
const DECODE = arg('decode', 'argmax');
const STAGE2_MAJOR = arg('stage2-major', 'pred');

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

// ---- 階層化（#235）の方式 ----
const SCHEMES = ['major', 'stage2', 'flat'];
const SUB_DESCS = ['on', 'off'];
const DECODES = ['argmax', 'sum'];
const STAGE2_MAJORS = ['pred', 'gold'];
/** flat の選択肢名で、大項目と中項目をつなぐ文字（「食費/外食」） */
const FLAT_SEP = '/';

/**
 * stage2 の 2 回目の質問文（仮。#235 の評価用）。state は 1 回目と同じ { input } で、決まった大項目は質問文に入れる。
 * 入力の説明は 1 回目（本番の JEV_QUESTIONS）にそろえ、経路（text / merchant）で変える
 */
const SUB_QUESTIONS = {
  text: (major) => `\`input\` は家計簿アプリに利用者が入力した支出の内容。この支出は「${major}」に分類された。「${major}」のうち、どの中項目？`,
  merchant: (major) =>
    `\`input\` はクレジットカードの利用明細に載った店名（半角カナ・ローマ字・略称が混ざる）。この支出は「${major}」に分類された。店の業態から、「${major}」のうち、どの中項目？`,
};

const shown = (v) => (v === undefined || v.startsWith('--') ? '値なし' : v);

/**
 * --scheme と、方式ごとのオプションを確かめる。合わなければ投げる（評価データを読む前・API を呼ぶ前・結果を書く前に呼ぶ）。
 * given: そのオプションがコマンドラインにあるか（方式に合わないオプションを黙って無視しないため）
 */
function checkSchemeOptions({ provider, scheme, subDesc, decode, stage2Major, given = {} }) {
  if (!SCHEMES.includes(scheme)) throw new Error(`--scheme は major / stage2 / flat（指定: ${shown(scheme)}）`);
  if (!SUB_DESCS.includes(subDesc)) throw new Error(`--sub-desc は on / off（指定: ${shown(subDesc)}）`);
  if (!DECODES.includes(decode)) throw new Error(`--decode は argmax / sum（指定: ${shown(decode)}）`);
  if (!STAGE2_MAJORS.includes(stage2Major)) throw new Error(`--stage2-major は pred / gold（指定: ${shown(stage2Major)}）`);
  if (scheme !== 'major' && provider !== 'jev') throw new Error(`--scheme ${scheme} は --provider jev のときだけ（Gemini には送らない）`);
  if (given.subDesc && scheme === 'major') throw new Error('--sub-desc は --scheme stage2 / flat のときだけ');
  if (given.decode && scheme !== 'flat') throw new Error('--decode は --scheme flat のときだけ');
  if (given.stage2Major && scheme !== 'stage2') throw new Error('--stage2-major は --scheme stage2 のときだけ');
}

/** 結果の tag に足す方式の部分（major は空） */
function schemeTag({ scheme, subDesc, decode, stage2Major }) {
  if (scheme === 'stage2') return `-stage2-subdesc-${subDesc}-major-${stage2Major}`;
  if (scheme === 'flat') return `-flat-subdesc-${subDesc}-${decode}`;
  return '';
}

/**
 * 評価する件を選ぶ。経路ごとに、tune / hold の 1 件おきの振り分け → keep（中項目の正解がある件だけ、など）→ 先頭 limit 件。
 * keep を振り分けの後にするのは、方式を変えても各件の tune / hold が変わらないようにするため（hold を調整に使わない）
 */
function pickItems(items, { sources, subset, limit, keep = null }) {
  return sources.flatMap((s) =>
    items
      .filter((it) => it.source === s)
      .filter((_, i) => subset === 'all' || (subset === 'tune' ? i % 2 === 0 : i % 2 === 1))
      .filter((it) => !keep || keep(it))
      .slice(0, limit)
  );
}

/** 中項目の説明（無ければ null） */
function describeSub(descriptions, major, sub) {
  const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  return own(descriptions, major) && own(descriptions[major], sub) && typeof descriptions[major][sub] === 'string'
    ? descriptions[major][sub]
    : null;
}

/** 説明のある中項目の数（--sub-desc on のときに出す） */
function countDescribed(subCategories, descriptions) {
  const all = Object.entries(subCategories).flatMap(([major, list]) => list.map((sub) => [major, sub]));
  return { described: all.filter(([major, sub]) => describeSub(descriptions, major, sub) !== null).length, total: all.length };
}

/** stage2 の 2 回目の選択肢（中項目名 → 説明。descriptions が null なら説明なし） */
function subCriteria(subs, major, descriptions) {
  return Object.fromEntries(subs.map((sub) => [sub, describeSub(descriptions, major, sub)]));
}

/**
 * flat の選択肢。majorCriteria（大項目名 → 説明。並び順のまま）の大項目ごとに、中項目があれば「大項目/中項目」（説明は
 * descriptions の中項目の説明か null）、無ければ大項目名（説明は majorCriteria のまま）。
 * index は選択肢名 → { major, sub }（中項目の無い大項目は sub: null）。選択肢名を文字で分けずに、ここから引く
 */
function flatChoices(majorCriteria, subsOf, descriptions) {
  const criteria = {};
  const index = new Map();
  const add = (name, description, major, sub) => {
    if (index.has(name)) throw new Error(`flat の選択肢の名前が重なる: ${name}`);
    criteria[name] = description;
    index.set(name, { major, sub });
  };
  for (const [major, description] of Object.entries(majorCriteria)) {
    const subs = subsOf(major);
    if (subs.length === 0) add(major, description, major, null);
    else for (const sub of subs) add(`${major}${FLAT_SEP}${sub}`, describeSub(descriptions, major, sub), major, sub);
  }
  return { criteria, index };
}

/**
 * flat の答えから大項目と中項目を決める。answer は Jev の choice の答え（{ choice, confidence, probabilities }）。
 *   argmax: answer.choice をそのまま使う（confidence は Jev の confidence）
 *   sum:    probabilities を大項目ごとに合計し、最も高い大項目を選び、その中で確率の最も高い中項目を選ぶ（中項目の無い大項目は sub: null）。
 *           confidence は大項目の合計。同点は index の並び順（大項目の並び → 中項目の並び）で先のもの
 * 決められない（答えなし・選択肢に無い名前・確率が無い）ときは null
 */
function decodeFlat(answer, decode, index) {
  if (!answer || typeof answer !== 'object') return null;
  if (decode === 'argmax') {
    const hit = typeof answer.choice === 'string' ? index.get(answer.choice) : undefined;
    if (!hit) return null;
    const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : 0;
    return { major: hit.major, sub: hit.sub, confidence };
  }
  const probs = answer.probabilities;
  if (!probs || typeof probs !== 'object') return null;
  const byMajor = new Map();
  let seen = false;
  for (const [name, { major, sub }] of index) {
    const m = byMajor.get(major) ?? { total: 0, sub: null, best: -Infinity };
    const p = probs[name];
    if (typeof p === 'number' && Number.isFinite(p)) {
      seen = true;
      m.total += p;
      if (sub !== null && p > m.best) {
        m.best = p;
        m.sub = sub;
      }
    }
    byMajor.set(major, m);
  }
  if (!seen) return null;
  let pick = null;
  for (const [major, m] of byMajor) if (pick === null || m.total > pick.total) pick = { major, sub: m.sub, total: m.total };
  return { major: pick.major, sub: pick.sub, confidence: Math.min(1, pick.total) };
}

/**
 * 1 件の階層の正誤。pred = { major, sub, subMajor }（subMajor = 中項目を選んだときの大項目。stage2 の gold では正解の大項目）。
 * 中項目は、正解の大項目の下で正解の中項目を選んだときだけ正解（大項目が違えば、同じ名前の中項目でも不正解）
 */
function scoreHierarchical(item, pred) {
  const majorCorrect = typeof pred.major === 'string' && pred.major === item.label;
  const subCorrect = typeof pred.sub === 'string' && pred.subMajor === item.label && pred.sub === item.subLabel;
  return { majorCorrect, subCorrect, bothCorrect: majorCorrect && subCorrect };
}

/**
 * --show-errors の 1 行（stage2 / flat。説明文・店名を含む）。
 * pred・flat は「大項目/中項目」が 1 つの予測なので並べて出す。stage2 の gold は、1 回目の大項目と、
 * 正解の大項目の下で選んだ中項目が別の予測なので、分けて出す（1 つの予測に見えないように）
 */
function hierarchyErrorLine(r, gold) {
  const predicted = gold
    ? `大項目 ${r.pred ?? 'null'} ${r.confidence} | 中項目 ${r.label}/${r.predSub ?? 'null'}（正解の大項目の下で選んだ）`
    : `${r.pred ?? 'null'}/${r.predSub ?? 'null'} ${r.confidence}`;
  return `${r.id} [${r.label}/${r.subLabel} → ${predicted}] ${r.description}`;
}

// ---- 分類器（provider ごとに classify(item) => { category, confidence, via, probabilities? } を用意する） ----
const usageLog = [];
/** --sub-desc on のとき、説明のある中項目の数（setupJev が入れる） */
let subDescribed = null;

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
  // 質問文は本番の JEV_QUESTIONS（v2 の店名だけ JEV_V2.merchant）
  const questionText = { text: JEV_QUESTIONS.text, merchant: VARIANT === 'v2' ? JEV_V2.merchant : JEV_QUESTIONS.merchant };
  const questions = {
    text: choice(questionText.text, criteria),
    merchant: choice(questionText.merchant, criteria),
  };
  if (SCHEME === 'major') {
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

  // ---- stage2 / flat（Jev だけ。失敗しても Gemini には回さない） ----
  const { SUB_CATEGORIES, SUB_CATEGORY_DESCRIPTIONS, subCategoriesOf } = require('../../dist/categoryTaxonomy');
  // 説明が dist に無い（古い dist など）ときは、説明なしで送る
  const descriptions = SUB_DESC === 'on' ? (SUB_CATEGORY_DESCRIPTIONS ?? null) : null;
  if (SUB_DESC === 'on') {
    subDescribed = countDescribed(SUB_CATEGORIES, descriptions);
    if (subDescribed.described < subDescribed.total) {
      console.warn(`--sub-desc on: 中項目 ${subDescribed.total} 個のうち ${subDescribed.total - subDescribed.described} 個は説明が無いので、説明なしで送る`);
    }
  }
  /** 1 問を送る（1 回の要求）。失敗しても投げずに answer: null。トークンは段の番号つきで usageLog にも入れる */
  const ask = async (stage, item, name, question) => {
    const t0 = Date.now();
    try {
      const { answers, model, usage } = await client.systemOne({ state: { input: item.description }, questions: { [name]: question } });
      const used = { stage, model, input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, nullUsage: usage.input_tokens === null };
      usageLog.push(used);
      return { answer: answers[name] ?? null, call: { stage, ms: Date.now() - t0, error: false, inTok: used.input, outTok: used.output, model } };
    } catch {
      return { answer: null, call: { stage, ms: Date.now() - t0, error: true, inTok: 0, outTok: 0, model: null } };
    }
  };

  if (SCHEME === 'stage2') {
    return async (item) => {
      // 1 回目は major と同じ要求（同じ質問オブジェクト・同じ問いの名前）
      const first = await ask(1, item, 'category', questions[item.source]);
      const a = first.answer;
      const major = typeof a?.choice === 'string' ? a.choice : null;
      const subMajor = STAGE2_MAJOR === 'gold' ? item.label : major;
      const subs = typeof subMajor === 'string' ? subCategoriesOf(subMajor) : [];
      const stages = [first.call];
      let sub = null;
      let subConfidence = null;
      if (subs.length > 0) {
        const second = await ask(2, item, 'subcategory', choice(SUB_QUESTIONS[item.source](subMajor), subCriteria(subs, subMajor, descriptions)));
        stages.push(second.call);
        if (typeof second.answer?.choice === 'string') {
          sub = second.answer.choice;
          subConfidence = second.answer.confidence ?? null;
        }
      }
      return {
        category: major,
        confidence: a?.confidence ?? 0,
        via: first.call.error ? 'error' : 'jev',
        probabilities: a?.probabilities,
        sub,
        subMajor: sub === null ? null : subMajor,
        subConfidence,
        stages,
      };
    };
  }

  const flat = flatChoices(criteria, subCategoriesOf, descriptions);
  const flatQuestions = {
    text: choice(questionText.text, flat.criteria),
    merchant: choice(questionText.merchant, flat.criteria),
  };
  return async (item) => {
    const only = await ask(1, item, 'category', flatQuestions[item.source]);
    const d = decodeFlat(only.answer, DECODE, flat.index);
    return {
      category: d ? d.major : null,
      confidence: d ? d.confidence : 0,
      via: only.call.error ? 'error' : 'jev',
      probabilities: only.answer?.probabilities,
      sub: d ? d.sub : null,
      subMajor: d && d.sub !== null ? d.major : null,
      subConfidence: null,
      stages: [only.call],
    };
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

/**
 * 階層化の集計（summarize に足す分）。rows は stage2 / flat の行（correct = 大項目の正誤、subCorrect・bothCorrect、
 * stages = 呼び出しごとの { stage, ms, error, inTok, outTok, model }、ms = 1 件の合計）。stageNumbers は集計する段（stage2 は [1, 2]、flat は [1]）。
 * コストは段ごとに、呼び出しのモデルの単価で計算する（失敗した呼び出しはモデル名なしで 0。単価の無いモデルがあれば null）
 */
function summarizeHierarchy(rows, stageNumbers, prices = PRICES) {
  const n = rows.length;
  if (n === 0) return null;
  const count = (pred) => rows.filter(pred).length;
  const majorCorrect = count((r) => r.correct);
  const bothCorrect = count((r) => r.bothCorrect);
  const subCorrect = count((r) => r.subCorrect);
  const calls = rows.flatMap((r) => r.stages || []);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const stages = {};
  const costs = {};
  for (const st of stageNumbers) {
    const these = calls.filter((c) => c.stage === st);
    let usd = 0;
    let known = true;
    for (const c of these) {
      const p = prices[c.model];
      if (!p) {
        if (c.model) known = false;
        continue;
      }
      usd += (c.inTok * p.input + c.outTok * p.output) / 1e6;
    }
    costs[st] = known ? usd : null;
    const input = these.reduce((s, c) => s + c.inTok, 0);
    const output = these.reduce((s, c) => s + c.outTok, 0);
    const succeeded = these.filter((c) => !c.error).length;
    const stMs = these.map((c) => c.ms).sort((a, b) => a - b);
    stages[`stage${st}`] = {
      calls: these.length,
      errors: these.length - succeeded,
      // inputPerCall は成功した呼び出し 1 回あたり（1 回の要求の大きさ）。inputPerItem は全件で割る（既存の inputPerItem と同じ）
      tokens: { input, output, inputPerCall: succeeded ? round(input / succeeded, 0) : null, inputPerItem: round(input / n, 0) },
      latencyMs: { p50: percentile(stMs, 0.5), p95: percentile(stMs, 0.95) },
      costUsdPaidRate: known ? round(usd, 6) : null,
      costUsdPer1000: known ? round((usd / n) * 1000, 4) : null,
    };
  }
  const h = {
    n,
    majorCorrect,
    majorAccuracy: round(majorCorrect / n),
    subAccuracyAmongMajorCorrect: majorCorrect ? round(bothCorrect / majorCorrect) : null,
    bothCorrect,
    bothCorrectRate: round(bothCorrect / n),
    subCorrect,
    subAccuracy: round(subCorrect / n),
    callsPerItem: round(calls.length / n, 2),
    latencyTotalMs: { p50: percentile(ms, 0.5), p95: percentile(ms, 0.95) },
    stages,
  };
  if (stageNumbers.includes(2)) {
    // 2 段の合計が、1 回目（major と同じ要求）だけの何倍か
    const total = Object.values(costs).every((c) => c !== null) ? Object.values(costs).reduce((s, c) => s + c, 0) : null;
    h.costRatioToStage1 = total !== null && costs[1] ? round(total / costs[1], 2) : null;
  }
  return h;
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
  if (s.hierarchy) printHierarchy(s.hierarchy);
}

function printHierarchy(h) {
  console.log(
    `中項目: 大項目が正解の件の中での正解率 ${h.subAccuracyAmongMajorCorrect ?? '-'}（${h.bothCorrect}/${h.majorCorrect}）` +
      ` | 大項目と中項目の両方が正解 ${h.bothCorrectRate}（${h.bothCorrect}/${h.n}）| 中項目の正解率（全件）${h.subAccuracy}（${h.subCorrect}/${h.n}）`
  );
  console.log(`1 件あたりの呼び出し ${h.callsPerItem} 回 | レイテンシ（1 件の合計）p50 ${h.latencyTotalMs.p50}ms / p95 ${h.latencyTotalMs.p95}ms`);
  for (const [name, st] of Object.entries(h.stages)) {
    const cost = st.costUsdPaidRate === null ? '単価不明のモデルあり' : `$${st.costUsdPaidRate}（1,000 件あたり $${st.costUsdPer1000}）`;
    console.log(
      `  ${name === 'stage1' ? '1 回目' : '2 回目'}: 呼び出し ${st.calls} 回（失敗 ${st.errors}）| 入力 ${st.tokens.input}（成功した 1 回 ${st.tokens.inputPerCall ?? '-'}）/ 出力 ${st.tokens.output}` +
        ` | レイテンシ p50 ${st.latencyMs.p50 ?? '-'}ms / p95 ${st.latencyMs.p95 ?? '-'}ms | コスト ${cost}`
    );
  }
  if ('costRatioToStage1' in h) console.log(`  コストは 1 回目（major と同じ要求）だけの ${h.costRatioToStage1 ?? '-'} 倍`);
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
  checkSchemeOptions({
    provider: PROVIDER,
    scheme: SCHEME,
    subDesc: SUB_DESC,
    decode: DECODE,
    stage2Major: STAGE2_MAJOR,
    given: { subDesc: flag('sub-desc'), decode: flag('decode'), stage2Major: flag('stage2-major') },
  });
  const hierarchical = SCHEME !== 'major';
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  let items = golden.items.filter((it) => !it.excluded && (it.reviewed || flag('include-unreviewed')));
  if (!flag('include-unreviewed') && items.length === 0) throw new Error('reviewed な件が 0 件。review-golden.js で見直すか、--include-unreviewed を付ける');
  const sources = SOURCE === 'all' ? ['text', 'merchant'] : [SOURCE];
  // stage2 / flat は中項目の正解がある件だけ（review-golden.js の validSubLabel。dist の中項目の一覧を読む）
  const keep = hierarchical ? require('./review-golden').validSubLabel : null;
  items = pickItems(items, { sources, subset: SUBSET, limit: LIMIT, keep });
  if (hierarchical && items.length === 0) {
    throw new Error('中項目の正解（subLabel）が使える件が 0 件。review-golden.js --sub で付ける（--source / --subset / --limit も確かめる）');
  }

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
    const row = {
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
    };
    if (hierarchical) {
      const pred = { major: result.category ?? null, sub: result.sub ?? null, subMajor: result.subMajor ?? null };
      const score = scoreHierarchical(item, pred);
      Object.assign(row, {
        subLabel: item.subLabel,
        predSub: pred.sub,
        subMajor: pred.subMajor,
        subConfidence: result.subConfidence ?? null,
        subCorrect: score.subCorrect,
        bothCorrect: score.bothCorrect,
        stages: result.stages ?? [],
      });
    }
    rows.push(row);
    if (DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  const tag =
    (PROVIDER === 'jev' ? `jev-${VARIANT}${JEV_MODEL === 'jev-1.13.0' ? '' : `-${JEV_MODEL}`}` : 'gemini') +
    schemeTag({ scheme: SCHEME, subDesc: SUB_DESC, decode: DECODE, stage2Major: STAGE2_MAJOR }) +
    (SUBSET === 'all' ? '' : `-${SUBSET}`);
  const schemeInfo = hierarchical
    ? {
        scheme: SCHEME,
        subDesc: SUB_DESC,
        stage2Major: SCHEME === 'stage2' ? STAGE2_MAJOR : null,
        decode: SCHEME === 'flat' ? DECODE : null,
        subDescribed,
        note: 'Jev だけで判定（辞書は通さず、Gemini には送らない）。対象は中項目の正解（validSubLabel）がある件だけ。中項目の一覧は仮（categoryTaxonomy.ts）',
      }
    : {};
  const summary = { tag, provider: PROVIDER, variant: PROVIDER === 'jev' ? VARIANT : null, ...schemeInfo, createdAt: new Date().toISOString(), bySource: {} };
  if (hierarchical) console.log(`\n${SCHEME}: Jev だけで判定（Gemini には送らない）。対象は中項目の正解がある ${rows.length} 件`);
  for (const s of [...sources, 'all']) {
    const subset = s === 'all' ? rows : rows.filter((r) => r.source === s);
    summary.bySource[s] = summarize(subset);
    if (hierarchical && summary.bySource[s]) summary.bySource[s].hierarchy = summarizeHierarchy(subset, SCHEME === 'stage2' ? [1, 2] : [1]);
    if (s !== 'all' || sources.length > 1) print(`${tag} / ${s}`, summary.bySource[s]);
  }

  const dir = arg('out-dir', path.join(__dirname, 'results'));
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.local.json`);
  fs.writeFileSync(out, JSON.stringify({ summary, items: rows }, null, 2));
  console.log(`\nwrote ${path.relative(ROOT, out)}（items は説明文・店名を含む。commit しない。summary だけ Issue に貼ってよい）`);

  if (flag('show-errors')) {
    console.log('\n-- 間違い --');
    if (hierarchical) {
      // 説明文・店名（利用者の入力）を書式文字列にしない（% を含んでもそのまま出す）
      const gold = SCHEME === 'stage2' && STAGE2_MAJOR === 'gold';
      for (const r of rows.filter((x) => !x.bothCorrect)) console.log('%s', hierarchyErrorLine(r, gold));
    } else {
      for (const r of rows.filter((x) => !x.correct)) console.log(`${r.id} [${r.label} → ${r.pred ?? 'null'} ${r.confidence}] ${r.description}`);
    }
  }
}

module.exports = {
  PRICES,
  SCHEMES,
  FLAT_SEP,
  SUB_QUESTIONS,
  checkSchemeOptions,
  schemeTag,
  pickItems,
  describeSub,
  countDescribed,
  subCriteria,
  flatChoices,
  decodeFlat,
  scoreHierarchical,
  summarizeHierarchy,
  hierarchyErrorLine,
};

if (require.main === module) {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
  dotenv.config({ path: path.join(ROOT, 'bot/.env'), quiet: true });
  main().then(
    () => process.exit(0),
    (e) => {
      console.error('eval failed:', e && e.message ? e.message : e);
      process.exit(1);
    }
  );
}
