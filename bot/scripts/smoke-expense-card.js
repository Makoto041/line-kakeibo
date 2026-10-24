/**
 * 登録・編集カードのスモークテスト
 *
 * LINEへ実送信せずに Flex JSON を組み立て、構造と主要な仕様を検証する。
 *   node bot/scripts/smoke-expense-card.js
 */
const {
  buildCardUsageFlexMessage,
  buildTextExpenseFlexMessage,
  buildExpenseCardFromRecord,
  buildExpenseEditUrl,
  buildCategorySelectCarousel,
  CATEGORY_ORIGIN_LABELS,
} = require('../dist/line/flexMessage');
const { CANONICAL_CATEGORIES, normalizeCategoryName, toCanonicalCategoryName } = require('../dist/categoryNormalization');
const { parseTextExpense } = require('../dist/textParser');
// どちらも LINE クライアント・Firestore・Gmail のクライアントは最初に使うときに作るので、読み込むだけなら外部に接続しない
const { decideTextExpenseCategory } = require('../dist/line/expenseFlow');
const { merchantCategoryOf } = require('../dist/gmail/handler');

let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 深さ優先で全コンポーネントを列挙する */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out));
    return out;
  }
  out.push(node);
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') walk(v, out);
  }
  return out;
}

function settingsRows(msg) {
  // 「現在の設定」ラベルを持つ box の中の、image を先頭に持つ horizontal box
  return walk(msg.contents).filter(
    (n) =>
      n.type === 'box' &&
      n.layout === 'horizontal' &&
      Array.isArray(n.contents) &&
      n.contents[0] &&
      n.contents[0].type === 'image' &&
      n.contents.some((c) => c.type === 'text' && Array.isArray(c.contents))
  );
}

function rowText(row) {
  const t = row.contents.find((c) => c.type === 'text' && Array.isArray(c.contents));
  return t.contents.map((s) => s.text).join('');
}

function footerButtonActions(msg) {
  const footer = msg.contents.footer;
  return walk(footer)
    .filter((n) => n.action)
    .map((n) => n.action);
}

function common(name, msg) {
  console.log(`\n[${name}]`);
  const nodes = walk(msg.contents);

  check('altText がある', typeof msg.altText === 'string' && msg.altText.length > 0);

  // 画像URLは https のみ（LINEの制約）
  const badImg = nodes.filter((n) => n.type === 'image' && !String(n.url).startsWith('https://'));
  check('画像URLはすべて https', badImg.length === 0, JSON.stringify(badImg.map((n) => n.url)));

  // text は text と contents を併用できない
  const badText = nodes.filter((n) => n.type === 'text' && n.text && n.contents);
  check('text の text/contents 併用なし', badText.length === 0);

  // postback data は 300 バイト以内
  const over = walk(msg.contents)
    .filter((n) => n.action && n.action.type === 'postback')
    .filter((n) => Buffer.byteLength(n.action.data, 'utf8') > 300);
  check('postback data は 300 バイト以内', over.length === 0);

  // uri アクションは https 必須・1000文字以内
  const uris = walk(msg.contents)
    .filter((n) => n.action && n.action.type === 'uri')
    .map((n) => n.action.uri);
  check('uri アクションはすべて https', uris.every((u) => u.startsWith('https://')), uris.join(' '));
  check('uri アクションは 1000 文字以内', uris.every((u) => u.length <= 1000));

  return { nodes };
}

// ---------------------------------------------------------------- 手入力
{
  const msg = buildTextExpenseFlexMessage({
    expenseId: 'exp_text_1',
    description: 'ランチ',
    amount: 1200,
    category: '食費',
    categoryEmoji: '🍽',
    date: '2026-08-11',
    paymentMethod: '現金',
    payerName: 'まこと',
    includeInTotal: false,
    editUrl: buildExpenseEditUrl('exp_text_1', 'U1'),
  });
  common('手入力の登録カード', msg);

  const rows = settingsRows(msg);
  check('現在の設定は4行', rows.length === 4, `got ${rows.length}`);
  check('各行にアイコンがある', rows.every((r) => r.contents[0].type === 'image'));
  check(
    '支出区分は共同費（未確認）＋usersアイコン',
    rowText(rows[0]) === '支出区分：共同費（未確認）' && rows[0].contents[0].url.endsWith('/users.png'),
    rows[0].contents[0].url
  );
  check(
    '支払った人は登録者の名前＋walletアイコン',
    rowText(rows[1]) === '支払った人：まこと' && rows[1].contents[0].url.endsWith('/wallet.png'),
    `${rowText(rows[1])} / ${rows[1].contents[0].url}`
  );
  check('支払った人は詳細行に重ねて出さない', !JSON.stringify(msg.contents.body.contents.slice(0, -1)).includes('まこと'));
  check(
    '立替はなし（折半）＋hand-coinsアイコン',
    rowText(rows[2]) === '立替：なし（折半）' && rows[2].contents[0].url.endsWith('/hand-coins.png'),
    `${rowText(rows[2])} / ${rows[2].contents[0].url}`
  );
  check(
    'カテゴリは食費アイコン',
    rowText(rows[3]) === 'カテゴリ：食費' && rows[3].contents[0].url.endsWith('/cat-food.png'),
    rows[3].contents[0].url
  );
  check('各行に[変更]がある', rows.every((r) => r.contents.some((c) => c.action)));

  const actions = footerButtonActions(msg);
  const edit = actions.find((a) => a.label === '修正');
  check('修正は直リンク(uri)', edit && edit.type === 'uri', edit && edit.type);
  check(
    '修正URLに expenseId と lineId が入る',
    edit.uri.includes('edit=exp_text_1') && edit.uri.includes('lineId=U1'),
    edit.uri
  );
  const list = actions.find((a) => a.label === '家計簿一覧を見る');
  check('家計簿一覧は直リンク(uri)', list && list.type === 'uri', list && list.type);
  check('家計簿一覧の遷移先は支出一覧ページ', list && list.uri.endsWith('/expenses'), list && list.uri);
  check('家計簿一覧URLに lineId を含まない', list && !list.uri.includes('lineId'), list && list.uri);
  check('OK は postback', actions.find((a) => a.label === 'OK').type === 'postback');
  check('日付は M/D 表記', JSON.stringify(msg).includes('"8/11"'));
}

// ------------------------------------------------------- カード利用（Gmail）
{
  const msg = buildCardUsageFlexMessage({
    expenseId: 'exp_gmail_1',
    merchant: 'セブン-イレブン',
    amount: 580,
    category: '食費',
    categoryEmoji: '🍽',
    date: '8/11',
    remainingBudget: 120000,
    // Gmail 取込は共同費として確定で保存する（handler.ts と同じ値）
    status: 'shared',
    includeInTotal: true,
  });
  common('カード利用通知（Gmail）', msg);

  const rows = settingsRows(msg);
  check('現在の設定は4行', rows.length === 4, `got ${rows.length}`);
  check(
    '支出区分は共同費（未確認なし）＋usersアイコン',
    rowText(rows[0]) === '支出区分：共同費' &&
      rows[0].contents[0].url.endsWith('/users.png'),
    `${rowText(rows[0])} / ${rows[0].contents[0].url}`
  );

  const actions = footerButtonActions(msg);
  const edit = actions.find((a) => a.label === '修正');
  check('修正は postback（押下者が未定のため）', edit && edit.type === 'postback', edit && edit.type);
  const list = actions.find((a) => a.label === '家計簿一覧を見る');
  // 本人判定が URL から Firebase の検証済みクレームへ移ったため、押下者が未定の
  // Gmail 通知でも個人化不要の固定URLへ直接遷移できる。
  check('家計簿一覧は直リンク(uri)', list && list.type === 'uri', list && list.type);
  check('家計簿一覧の遷移先は支出一覧ページ', list && list.uri.endsWith('/expenses'), list && list.uri);
}

// ------------------------------------------------- 精算済み（変更不可の状態）
{
  const msg = buildExpenseCardFromRecord(
    'exp_settled',
    {
      description: '飲み会',
      amount: 8000,
      category: 'その他',
      date: '2026-08-01',
      status: 'advance_settled',
      includeInTotal: true,
      inputSource: 'line_text',
      paymentMethod: 'unknown',
    },
    { editUrl: buildExpenseEditUrl('exp_settled', 'U1') }
  );
  common('精算済みの再構築カード', msg);

  const rows = settingsRows(msg);
  check('現在の設定は4行', rows.length === 4, `got ${rows.length}`);
  check('支出区分にボタンが出ない', !rows[0].contents.some((c) => c.action));
  check('支払った人にボタンが出ない', !rows[1].contents.some((c) => c.action));
  check('立替は精算済みでボタンが出ない', rowText(rows[2]) === '立替：精算済み' && !rows[2].contents.some((c) => c.action), rowText(rows[2]));
  check('カテゴリは変更できる', rows[3].contents.some((c) => c.action));
  check(
    'paymentMethod の生値が漏れない',
    !JSON.stringify(msg).includes('unknown'),
  );
}

// ------------------------------------------- status ごとのアイコン・ラベル分岐
{
  console.log('\n[status ごとの支出区分アイコン]');
  const cases = [
    ['personal', '支出区分：除外', '/user.png'],
    ['shared', '支出区分：共同費', '/users.png'],
    ['advance_pending', '支出区分：共同費', '/users.png'],
    ['advance_settled', '支出区分：共同費', '/users.png'],
  ];
  for (const [status, expectText, expectIcon] of cases) {
    const msg = buildExpenseCardFromRecord('exp_' + status, {
      description: 'テスト',
      amount: 100,
      category: '食費',
      date: '2026-08-11',
      status,
      includeInTotal: true,
      inputSource: 'line_text',
    });
    const row = settingsRows(msg)[0];
    check(
      `${status} → ${expectText} / ${expectIcon}`,
      rowText(row) === expectText && row.contents[0].url.endsWith(expectIcon),
      `${rowText(row)} / ${row.contents[0].url}`
    );
  }

  // 要確認は手入力の支出だけ: 以前に pending で入った Gmail 取込は共同費として出す
  for (const status of [undefined, 'pending']) {
    const gmail = settingsRows(buildExpenseCardFromRecord('e', { category: '食費', status, inputSource: 'gmail_auto' }))[0];
    check(`Gmail 取込の ${status ?? '未指定'} → 支出区分：共同費`, rowText(gmail) === '支出区分：共同費', rowText(gmail));
    const manual = settingsRows(buildExpenseCardFromRecord('e', { category: '食費', status, inputSource: 'line_text' }))[0];
    check(`手入力の ${status ?? '未指定'} → 支出区分：共同費（未確認）`, rowText(manual) === '支出区分：共同費（未確認）', rowText(manual));
  }

  // 支払った人のラベル（Web の resolvePayerName と同じ分け方）
  const payerCases = [
    [{ inputSource: 'gmail_auto', lineId: 'gmail-auto-system', payerId: 'gmail-auto-system' }, 'カード', '/credit-card.png'],
    [{ inputSource: 'recurring', lineId: 'recurring-system', payerId: 'recurring-system' }, '共通口座', '/wallet.png'],
    [{ inputSource: 'line_text', lineId: 'U1', payerId: 'U2', payerDisplayName: 'ひかり', userDisplayName: 'まこと' }, 'ひかり', '/wallet.png'],
    [{ inputSource: 'line_text', lineId: 'U1', userDisplayName: 'まこと' }, 'まこと', '/wallet.png'],
    [{ inputSource: 'line_text', lineId: 'U1' }, 'メンバー', '/wallet.png'],
  ];
  for (const [record, name, icon] of payerCases) {
    const row = settingsRows(buildExpenseCardFromRecord('e', { category: '食費', status: 'shared', ...record }))[1];
    check(`支払った人：${name}`, rowText(row) === `支払った人：${name}` && row.contents[0].url.endsWith(icon), `${rowText(row)} / ${row.contents[0].url}`);
  }
  // 立替のラベル（全額で返す立替と、全額にする前の立替）
  const full = buildExpenseCardFromRecord('e', { category: '食費', status: 'advance_pending', advanceFull: true, inputSource: 'line_text' });
  check('全額の立替は「あり（全額を精算に加算）」', rowText(settingsRows(full)[2]) === '立替：あり（全額を精算に加算）', rowText(settingsRows(full)[2]));
  const legacy = buildExpenseCardFromRecord('e', { category: '食費', status: 'advance_pending', inputSource: 'line_text' });
  check('全額にする前の立替は「あり」', rowText(settingsRows(legacy)[2]) === '立替：あり', rowText(settingsRows(legacy)[2]));
  const card = settingsRows(
    buildCardUsageFlexMessage({ expenseId: 'g1', merchant: 'SHOP', amount: 100, category: '食費', categoryEmoji: '', date: '8/1', status: 'shared' })
  )[1];
  check('カード利用通知の支払った人はカード', rowText(card) === '支払った人：カード', rowText(card));
}

// ------------------------------------------- 操作ボタンの表記・色・postback
{
  console.log('\n[操作ボタンの表記・色]');
  const RED = '#DC2626';
  const BLUE = '#2563EB';
  /** 行末ボタンの表記・文字色・postback data を取り出す */
  function button(row) {
    const b = row.contents.find((c) => c.action);
    if (!b) return null;
    return { label: b.contents[0].text, color: b.contents[0].color, data: JSON.parse(b.action.data) };
  }
  // [status, 支出区分ボタン, 色, to, 立替ボタン, 色, to]。支払った人はどの状態でも［自分が払った］（青・set_payer）
  const cases = [
    [undefined, '除外', RED, 'personal', '自分が立替', BLUE, 'on'],
    ['pending', '除外', RED, 'personal', '自分が立替', BLUE, 'on'],
    ['shared', '除外', RED, 'personal', '自分が立替', BLUE, 'on'],
    ['personal', '戻す', BLUE, 'shared', '自分が立替', BLUE, 'on'],
    ['advance_pending', '除外', RED, 'personal', '取り消す', RED, 'off'],
  ];
  for (const [status, splitLabel, splitColor, splitTo, advLabel, advColor, advTo] of cases) {
    const rows = settingsRows(
      buildExpenseCardFromRecord('exp_b', { category: '食費', status, inputSource: 'gmail_auto' })
    );
    const split = button(rows[0]);
    const payer = button(rows[1]);
    const adv = button(rows[2]);
    const cat = button(rows[3]);
    check(
      `${status ?? '未指定'} → 支出区分[${splitLabel}]`,
      split && split.label === splitLabel && split.color === splitColor &&
        split.data.action === 'set_split' && split.data.to === splitTo &&
        split.data.expenseId === 'exp_b' && split.data.source === 'gmail',
      JSON.stringify(split)
    );
    check(
      `${status ?? '未指定'} → 支払った人[自分が払った]`,
      payer && payer.label === '自分が払った' && payer.color === BLUE &&
        payer.data.action === 'set_payer' && payer.data.expenseId === 'exp_b' && payer.data.source === 'gmail',
      JSON.stringify(payer)
    );
    check(
      `${status ?? '未指定'} → 立替[${advLabel}]`,
      adv && adv.label === advLabel && adv.color === advColor &&
        adv.data.action === 'set_advance' && adv.data.to === advTo && adv.data.expenseId === 'exp_b',
      JSON.stringify(adv)
    );
    check(`${status ?? '未指定'} → カテゴリ[変更]は青`, cat && cat.label === '変更' && cat.color === BLUE);
  }
}

// ------------------------------------------------------ カテゴリアイコン解決
{
  console.log('\n[カテゴリアイコンの解決]');
  const expect = {
    食費: 'cat-food', 交通費: 'cat-transport', 貯蓄: 'cat-savings',
    投資: 'cat-savings', 交際費: 'cat-fun', 趣味: 'cat-fun',
    その他: 'cat-other', 未知のカテゴリ: 'cat-other',
  };
  for (const [category, key] of Object.entries(expect)) {
    const msg = buildExpenseCardFromRecord('e', {
      category, status: 'shared', inputSource: 'line_text',
    });
    const url = settingsRows(msg)[3].contents[0].url;
    check(`${category} → ${key}`, url.endsWith(`/${key}.png`), url);
  }
}

// ------------------------------------------- カテゴリの判定元（最初のカードだけ）
{
  console.log('\n[カテゴリの判定元]');
  const base = {
    expenseId: 'exp_origin',
    description: 'ランチ',
    amount: 500,
    category: '食費',
    categoryEmoji: '🍽',
    date: '2026-08-11',
    paymentMethod: '現金',
    payerName: 'まこと',
    includeInTotal: false,
    editUrl: buildExpenseEditUrl('exp_origin', 'U1'),
  };
  const expected = {
    dictionary: '（辞書）',
    jev: '（Jev）',
    gemini: '（Gemini）',
    specified: '（指定）',
    default: '（既定）',
    unclassified: '（未判定）',
  };
  check('判定元は 6 つ', Object.keys(CATEGORY_ORIGIN_LABELS).sort().join(',') === Object.keys(expected).sort().join(','), Object.keys(CATEGORY_ORIGIN_LABELS).join(','));

  const plain = buildTextExpenseFlexMessage(base);
  const plainRows = settingsRows(plain);
  check('判定元が無ければ カテゴリ：食費（括弧なし）', rowText(plainRows[3]) === 'カテゴリ：食費', rowText(plainRows[3]));
  const postbackData = (msg) =>
    walk(msg.contents)
      .filter((n) => n.action && n.action.type === 'postback')
      .map((n) => n.action.data);
  /** カテゴリの行の 3 つ目の span（判定元）を外したもの */
  function withoutNote(msg) {
    const copy = JSON.parse(JSON.stringify(msg));
    const textNode = settingsRows(copy)[3].contents.find((c) => c.type === 'text' && Array.isArray(c.contents));
    textNode.contents = textNode.contents.slice(0, 2);
    return copy;
  }

  for (const [origin, note] of Object.entries(expected)) {
    const msg = buildTextExpenseFlexMessage({ ...base, categoryOrigin: origin });
    const rows = settingsRows(msg);
    check(`${origin} → カテゴリ：食費${note}`, rowText(rows[3]) === `カテゴリ：食費${note}`, rowText(rows[3]));
    const spans = rows[3].contents.find((c) => c.type === 'text' && Array.isArray(c.contents)).contents;
    const noteSpan = spans[2];
    check(
      `${origin} → 括弧は xs・灰色（#64748B）・太字でない span`,
      spans.length === 3 && noteSpan.type === 'span' && noteSpan.text === note &&
        noteSpan.size === 'xs' && noteSpan.color === '#64748B' && noteSpan.weight === undefined,
      JSON.stringify(noteSpan)
    );
    check(
      `${origin} → 支出区分・支払った人・立替の 3 行は変わらない`,
      JSON.stringify(rows.slice(0, 3)) === JSON.stringify(plainRows.slice(0, 3))
    );
    check(
      `${origin} → postback の data と altText は判定元が無いときと同じ`,
      JSON.stringify(postbackData(msg)) === JSON.stringify(postbackData(plain)) && msg.altText === plain.altText &&
        !postbackData(msg).join(' ').includes(CATEGORY_ORIGIN_LABELS[origin]) && !msg.altText.includes(note)
    );
    check(`${origin} → 違いはカテゴリの括弧だけ`, JSON.stringify(withoutNote(msg)) === JSON.stringify(plain));
  }

  // Gmail のカード利用通知
  const gmailBase = { expenseId: 'exp_gmail_origin', merchant: 'SHOP', amount: 100, categoryEmoji: '', date: '8/1', status: 'shared', includeInTotal: true };
  const gmailJev = settingsRows(buildCardUsageFlexMessage({ ...gmailBase, category: '食費', categoryOrigin: 'jev' }))[3];
  check('Gmail: jev → カテゴリ：食費（Jev）', rowText(gmailJev) === 'カテゴリ：食費（Jev）', rowText(gmailJev));
  const gmailNone = settingsRows(buildCardUsageFlexMessage({ ...gmailBase, category: 'その他', categoryOrigin: 'unclassified' }))[3];
  check('Gmail: unclassified → カテゴリ：その他（未判定）', rowText(gmailNone) === 'カテゴリ：その他（未判定）', rowText(gmailNone));
  const gmailPlain = settingsRows(buildCardUsageFlexMessage({ ...gmailBase, category: '食費' }))[3];
  check('Gmail: 判定元が無ければ括弧なし', rowText(gmailPlain) === 'カテゴリ：食費', rowText(gmailPlain));

  // postback で作り直したカード（保存した値から組み立てる）には出ない
  for (const inputSource of ['line_text', 'gmail_auto']) {
    const rebuilt = settingsRows(buildExpenseCardFromRecord('e', { category: '食費', status: 'shared', inputSource }))[3];
    check(`作り直したカード（${inputSource}）のカテゴリ行に括弧が入らない`, rowText(rebuilt) === 'カテゴリ：食費' && !rowText(rebuilt).includes('（'), rowText(rebuilt));
  }
}

// ------------------------------------- LINE の入力のカテゴリと判定元の決め方
{
  console.log('\n[decideTextExpenseCategory]');
  const jev = (category, confidence) => ({ category, confidence, reasoning: 'Jev classification', provider: 'jev' });
  const cases = [
    ['指定 → 指定', { specified: '食費' }, '食費', 'specified'],
    ['指定があれば分類・既定より優先', { specified: '光熱費', classified: jev('食費', 0.9), defaultCategory: '日用品' }, '光熱費', 'specified'],
    ['辞書 0.8 → dictionary', { classified: { category: '食費', confidence: 0.8, reasoning: 'Fast local keyword matching', provider: 'dictionary' } }, '食費', 'dictionary'],
    ['Jev 0.4 ちょうど → jev', { classified: jev('娯楽', 0.4), defaultCategory: '日用品' }, '娯楽', 'jev'],
    ['Gemini 0.7 → gemini', { classified: { category: '娯楽', confidence: 0.7, reasoning: 'Gemini classification', provider: 'gemini' } }, '娯楽', 'gemini'],
    ['Jev 0.39・既定あり → 既定のカテゴリ・default', { classified: jev('娯楽', 0.39), defaultCategory: '日用品' }, '日用品', 'default'],
    ['Jev 0.39・既定なし → その他・unclassified', { classified: jev('娯楽', 0.39) }, 'その他', 'unclassified'],
    ['「その他」0.9・既定あり → default', { classified: jev('その他', 0.9), defaultCategory: '日用品' }, '日用品', 'default'],
    ['「その他」0.9・既定なし → その他・jev', { classified: jev('その他', 0.9) }, 'その他', 'jev'],
    ['分類が失敗（null）・既定あり → default', { classified: null, defaultCategory: '日用品' }, '日用品', 'default'],
    ['分類が失敗（null）・既定なし → その他・unclassified', { classified: null, defaultCategory: undefined }, 'その他', 'unclassified'],
    ['決まらない（category: null）・既定あり → default', { classified: { category: null, confidence: 0 }, defaultCategory: '日用品' }, '日用品', 'default'],
    ['category はあるが provider が無い → origin は undefined', { classified: { category: '食費', confidence: 0.9 } }, '食費', undefined],
  ];
  for (const [name, input, category, origin] of cases) {
    const r = decideTextExpenseCategory(input);
    check(name, r.category === category && r.origin === origin, JSON.stringify(r));
  }
}

// ------------------------------------- LINE の旧名を正準名に揃える（#243）
//
// 下の 2 つの一覧は textParser.ts の VALID_CATEGORIES と commands/category.ts の LINE_DEFAULT_CATEGORIES の写し
// （どちらも変えない）。カルーセルの選択肢は組み立てたメッセージから取り出す。
const LINE_INPUT_CATEGORIES = [
  '食費', '日用品', '交通費', '医療費', '娯楽費', '衣服費', '教育費', '通信費', '光熱費', '住居費',
  '保険', '税金', '貯蓄', '投資', '美容', 'ペット', '趣味', '交際費', 'その他',
];
const LINE_COMMAND_CATEGORIES = ['食費', '日用品', '交通費', '医療費', '娯楽費', '衣服費', '教育費', '通信費', 'その他'];
const CAROUSEL_LABELS = ['食費', '日用品', '交通費', '医療費', '娯楽費', '衣服費', '教育費', '通信費', '光熱費', 'その他'];
/** 旧名 → 正準名（正準名と、揃えられない「貯蓄」「趣味」は載せない） */
const LEGACY_TO_CANONICAL = {
  医療費: '医療・健康',
  娯楽費: '娯楽',
  衣服費: '衣服',
  教育費: '教育',
  投資: '貯金',
  交際費: '娯楽',
};
const expectedCanonical = (name) => LEGACY_TO_CANONICAL[name] ?? name;

{
  console.log('\n[toCanonicalCategoryName]');
  check('正準名はそのまま', CANONICAL_CATEGORIES.every((c) => toCanonicalCategoryName(c) === c));
  for (const [legacy, canonical] of Object.entries(LEGACY_TO_CANONICAL)) {
    check(`${legacy} → ${canonical}`, toCanonicalCategoryName(legacy) === canonical, toCanonicalCategoryName(legacy));
    check(`${legacy}: normalizeCategoryName と同じ正準名`, toCanonicalCategoryName(legacy) === normalizeCategoryName(legacy));
  }
  check('前後の空白は無視する', toCanonicalCategoryName(' 医療費 ') === '医療・健康');
  // normalizeCategoryName は「その他」や部分一致で寄せるが、保存ではカスタム名などを変えない
  for (const name of ['貯蓄', '趣味', '推し活', '本田', 'ジム代', '日用品費', '', ' 推し活 ', 'constructor', '__proto__', 'toString']) {
    check(`揃えられない名前は変えない: ${JSON.stringify(name)}`, toCanonicalCategoryName(name) === name, JSON.stringify(toCanonicalCategoryName(name)));
  }
  check('（参考）normalizeCategoryName なら「本田」は教育・「趣味」はその他になる', normalizeCategoryName('本田') === '教育' && normalizeCategoryName('趣味') === 'その他');

  check(
    '「カテゴリー」コマンドの選択肢はすべて正準名に揃う',
    LINE_COMMAND_CATEGORIES.every((c) => CANONICAL_CATEGORIES.includes(toCanonicalCategoryName(c))),
    LINE_COMMAND_CATEGORIES.map(toCanonicalCategoryName).join(',')
  );
  check(
    '入力で指定できる名前は「貯蓄」「趣味」以外すべて正準名に揃う',
    LINE_INPUT_CATEGORIES.every((c) => ['貯蓄', '趣味'].includes(c) || CANONICAL_CATEGORIES.includes(toCanonicalCategoryName(c))),
    LINE_INPUT_CATEGORIES.map(toCanonicalCategoryName).join(',')
  );
}

{
  console.log('\n[LINE の入力・既定カテゴリ → 保存するカテゴリ]');
  const jev = (category, confidence) => ({ category, confidence, reasoning: 'Jev classification', provider: 'jev' });

  // (a) 「500 医療費」のような入力。入力として受け付ける名前は今まで通り
  for (const name of LINE_INPUT_CATEGORIES) {
    const parsed = parseTextExpense(`500 ${name}`);
    const r = decideTextExpenseCategory({ specified: parsed && parsed.category });
    check(
      `「500 ${name}」→ ${expectedCanonical(name)}（指定）`,
      parsed && parsed.category === name && r.category === expectedCanonical(name) && r.origin === 'specified',
      JSON.stringify({ parsed: parsed && parsed.category, r })
    );
  }

  // (b)(d)(e) 既定カテゴリが旧名、正準名・カスタム名は変わらない、判定元・閾値は従来どおり
  const cases = [
    ['指定が旧名でも分類・既定より優先', { specified: '娯楽費', classified: jev('食費', 0.9), defaultCategory: '日用品' }, '娯楽', 'specified'],
    ['既定が旧名・Jev 0.39 → 正準名・default', { classified: jev('食費', 0.39), defaultCategory: '娯楽費' }, '娯楽', 'default'],
    ['既定が旧名・分類が「その他」0.9 → 正準名・default', { classified: jev('その他', 0.9), defaultCategory: '娯楽費' }, '娯楽', 'default'],
    ['既定が旧名・分類が失敗（null）→ 正準名・default', { classified: null, defaultCategory: '医療費' }, '医療・健康', 'default'],
    ['既定が旧名でも Jev 0.4 ちょうどなら分類を採用', { classified: jev('食費', 0.4), defaultCategory: '娯楽費' }, '食費', 'jev'],
    ['既定が正準名はそのまま', { classified: null, defaultCategory: '娯楽' }, '娯楽', 'default'],
    ['既定がカスタム名はそのまま', { classified: null, defaultCategory: '推し活' }, '推し活', 'default'],
    ['既定が旧名・既定を使わない（分類 0.9）→ 分類のまま', { classified: jev('交通費', 0.9), defaultCategory: '医療費' }, '交通費', 'jev'],
  ];
  for (const [name, input, category, origin] of cases) {
    const r = decideTextExpenseCategory(input);
    check(name, r.category === category && r.origin === origin, JSON.stringify(r));
  }
  // 「カテゴリー」コマンドで保存済みの旧名（移行しない既存データ）も、使うときに正準名になる
  for (const name of LINE_COMMAND_CATEGORIES) {
    const r = decideTextExpenseCategory({ classified: null, defaultCategory: name });
    check(`保存済みの既定「${name}」→ ${expectedCanonical(name)}（既定）`, r.category === expectedCanonical(name) && r.origin === 'default', JSON.stringify(r));
  }
}

{
  console.log('\n[カテゴリ選択のカルーセル]');
  const carousel = (currentCategory) =>
    buildCategorySelectCarousel({ expenseId: 'exp_cat', currentCategory, source: 'text', merchant: 'SHOP', amount: 500 });
  const bubbles = (msg) => msg.contents.contents;
  const label = (b) => b.body.contents[1].text;
  const action = (b) => walk(b.footer).find((n) => n.action && n.action.type === 'postback').action;
  const selected = (msg) => bubbles(msg).filter((b) => b.body.backgroundColor === '#ECFDF5').map(label);

  // 画面の選択肢（ボタンの文言・postback の値）は変えない
  const msg = carousel('食費');
  check('選択肢の文言は従来どおり', JSON.stringify(bubbles(msg).map(label)) === JSON.stringify(CAROUSEL_LABELS), bubbles(msg).map(label).join(','));
  check(
    'postback の値は選択肢の文言のまま（保存するときに揃える）',
    bubbles(msg).every((b) => JSON.parse(action(b).data).category === label(b) && JSON.parse(action(b).data).action === 'set_category')
  );
  // (c) カルーセルの値はすべて正準名で保存される
  check(
    'カルーセルの値はすべて正準名に揃う',
    bubbles(msg).every((b) => CANONICAL_CATEGORIES.includes(toCanonicalCategoryName(JSON.parse(action(b).data).category)))
  );

  // 選択中: 正準名で保存された値も、旧名のままの既存データも、対応する選択肢を選択中にする
  const highlightCases = [
    ['医療・健康', ['医療費']],
    ['医療費', ['医療費']],
    ['娯楽', ['娯楽費']],
    ['娯楽費', ['娯楽費']],
    ['交際費', ['娯楽費']],
    ['衣服', ['衣服費']],
    ['教育', ['教育費']],
    ['食費', ['食費']],
    ['その他', ['その他']],
    ['サブスク', []],
    ['趣味', []],
  ];
  for (const [current, expected] of highlightCases) {
    const m = carousel(current);
    const sel = selected(m);
    const labels = bubbles(m).filter((b) => action(b).label === '選択中').map(label);
    check(
      `保存値「${current}」→ 選択中は ${expected.join(',') || 'なし'}`,
      JSON.stringify(sel) === JSON.stringify(expected) && JSON.stringify(labels) === JSON.stringify(expected),
      JSON.stringify({ sel, labels })
    );
  }
}

// ------------------------------------- カード利用通知の店名のカテゴリと判定元
{
  console.log('\n[merchantCategoryOf]');
  const cases = [
    ['jev → そのカテゴリ・jev', { category: '食費', confidence: 0.2, reasoning: 'Jev classification', provider: 'jev' }, '食費', 'jev'],
    ['dictionary → そのカテゴリ・dictionary', { category: '食費', confidence: 0.8, reasoning: 'Fast local keyword matching', provider: 'dictionary' }, '食費', 'dictionary'],
    ['category: null → その他・unclassified', { category: null, confidence: 0 }, 'その他', 'unclassified'],
  ];
  for (const [name, input, category, origin] of cases) {
    const r = merchantCategoryOf(input);
    check(name, r.category === category && r.origin === origin, JSON.stringify(r));
  }
}

console.log(failed === 0 ? '\nすべて通過' : `\n${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
