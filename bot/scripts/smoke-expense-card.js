/**
 * 登録・編集カードのスモークテスト
 *
 * LINEへ実送信せずに Flex JSON を組み立て、構造と主要な仕様を検証する。
 * 末尾では、LINE の入力・カード利用通知の保存データ（カテゴリと中項目）を、Firestore・LINE・Gmail・分類器を
 * 偽物に差し替えて確かめる（本物の API・Firestore には接続しない）。
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
const { decideTextExpenseCategory, textSubCategoryOf } = require('../dist/line/expenseFlow');
const { merchantCategoryOf, merchantSubCategoryOf } = require('../dist/gmail/handler');
const { cardNoticeRetryKey } = require('../dist/gmail/cardNotice');

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
  // span の text は空にしない
  const emptySpans = nodes.filter((n) => n.type === 'span' && (typeof n.text !== 'string' || n.text.length === 0));
  check('span の text は空でない', emptySpans.length === 0, JSON.stringify(emptySpans));

  // LINE の上限（Messaging API リファレンスの Flex Message）: バブルを定義する JSON は 30 KB まで、altText は 1500 文字まで。
  // 30 KB は 30,000 バイトとして、少し厳しめに見る
  const bubbleBytes = Buffer.byteLength(JSON.stringify(msg.contents), 'utf8');
  check('バブルの JSON は 30 KB 以内', bubbleBytes <= 30000, `${bubbleBytes} bytes`);
  check('altText は 1500 文字以内', [...msg.altText].length <= 1500, `${[...msg.altText].length} chars`);

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

// ------------------------------------- 中項目（#235）: カテゴリの行に「食費 › 昼ご飯」
{
  console.log('\n[中項目: カテゴリの行に「大項目 › 中項目」]');
  const { decideSetCategory } = require('../dist/expenseActions');
  const SEP = ' › ';
  const json = (v) => JSON.stringify(v);
  /** カテゴリの行（4 行目）の span */
  const catSpans = (msg) => settingsRows(msg)[3].contents.find((c) => c.type === 'text' && Array.isArray(c.contents)).contents;
  const postbackData = (msg) =>
    walk(msg.contents)
      .filter((n) => n.action && n.action.type === 'postback')
      .map((n) => n.action.data);
  /** カテゴリの行から区切りと中項目の span（3・4 つ目）を外したもの */
  function withoutSub(msg) {
    const copy = JSON.parse(json(msg));
    const textNode = settingsRows(copy)[3].contents.find((c) => c.type === 'text' && Array.isArray(c.contents));
    textNode.contents.splice(2, 2);
    return copy;
  }

  const textBase = {
    expenseId: 'exp_sub',
    description: 'ランチ',
    amount: 800,
    categoryEmoji: '',
    date: '2026-10-24',
    payerName: 'まこと',
    includeInTotal: false,
    editUrl: buildExpenseEditUrl('exp_sub', 'U1'),
  };
  const textCard = (category, subCategory, categoryOrigin) =>
    buildTextExpenseFlexMessage({ ...textBase, category, subCategory, categoryOrigin });
  const gmailBase = { expenseId: 'exp_sub_g', merchant: 'SHOP', amount: 600, categoryEmoji: '', date: '10/24', remainingBudget: 142300, status: 'shared', includeInTotal: true };
  const gmailCard = (category, subCategory, categoryOrigin) =>
    buildCardUsageFlexMessage({ ...gmailBase, category, subCategory, categoryOrigin });
  const recordCard = (record) =>
    buildExpenseCardFromRecord('exp_sub_r', record, { editUrl: buildExpenseEditUrl('exp_sub_r', 'U1'), headerText: '設定を更新しました', headerIconKey: 'check' });

  // 出す: 食費 › 昼ご飯、娯楽 › スポーツ・アウトドア、いちばん長い「デリバリー・テイクアウト」
  for (const [category, sub] of [
    ['食費', '昼ご飯'],
    ['娯楽', 'スポーツ・アウトドア'],
    ['食費', 'デリバリー・テイクアウト'],
  ]) {
    const msg = textCard(category, sub);
    const plain = textCard(category, undefined);
    common(`手入力の登録カード（${category} › ${sub}）`, msg);
    const rows = settingsRows(msg);
    check('現在の設定は4行のまま', rows.length === 4, `got ${rows.length}`);
    check(`カテゴリ：${category}${SEP}${sub}`, rowText(rows[3]) === `カテゴリ：${category}${SEP}${sub}`, rowText(rows[3]));
    const spans = catSpans(msg);
    check(
      'span は ラベル → 大項目（太字）→ 区切り（#94A3B8・太字でない）→ 中項目（太字・#0F172A）',
      spans.length === 4 &&
        spans.every((s) => s.type === 'span') &&
        spans[1].text === category && spans[1].weight === 'bold' &&
        spans[2].text === SEP && spans[2].color === '#94A3B8' && spans[2].weight === undefined && spans[2].size === undefined &&
        spans[3].text === sub && spans[3].weight === 'bold' && spans[3].color === '#0F172A',
      json(spans)
    );
    check('違いはカテゴリの行の区切りと中項目だけ', json(withoutSub(msg)) === json(plain));
    check(
      'postback の data と altText は中項目なしと同じ（中項目を入れない）',
      json(postbackData(msg)) === json(postbackData(plain)) && msg.altText === plain.altText &&
        !postbackData(msg).join(' ').includes(sub) && !msg.altText.includes(sub)
    );
  }

  // いちばん長い中項目に、注記（判定元）を付けても上限内（common で 30 KB・altText を見る）
  for (const origin of Object.keys(CATEGORY_ORIGIN_LABELS)) {
    const longest = textCard('食費', 'デリバリー・テイクアウト', origin);
    const bytes = Buffer.byteLength(json(longest.contents), 'utf8');
    const plainBytes = Buffer.byteLength(json(textCard('食費', undefined, origin).contents), 'utf8');
    check(
      `いちばん長い中項目＋（${CATEGORY_ORIGIN_LABELS[origin]}）: バブルの JSON は 30 KB 以内（増えるのは span 2 つ分だけ）`,
      bytes <= 30000 && bytes - plainBytes < 200,
      `${bytes} bytes（中項目なし ${plainBytes}）`
    );
  }

  // 出さない: 中項目が無い・空・一覧に無い（Web で入れた自由な値）・別の大項目の中項目・文字列でない、一覧の無い大項目
  const notShown = [
    ['食費', undefined, '中項目なし'],
    ['食費', '', '空文字'],
    ['食費', 'おやつ', '一覧に無い値（Web で入れた自由な値）'],
    ['食費', ' 昼ご飯', '前に空白のある値'],
    ['食費', '映画', '娯楽の中項目'],
    ['食費', 'その他の娯楽', '娯楽の「その他」'],
    ['娯楽', '昼ご飯', '食費の中項目'],
    ['食費', null, 'null'],
    ['食費', 123, '数値'],
    ['食費', ['昼ご飯'], '配列'],
    ['食費', { toString: () => '昼ご飯' }, 'オブジェクト'],
    ['日用品', '昼ご飯', '日用品（一覧の無い大項目）'],
    ['その他', 'その他の食費', 'その他（一覧の無い大項目）'],
    ['推し活', '昼ご飯', 'カスタム名の大項目'],
    ['constructor', '昼ご飯', '大項目が constructor'],
  ];
  for (const [category, sub, name] of notShown) {
    const t = textCard(category, sub);
    check(`手入力: ${name} → 大項目だけ（JSON 全体が中項目なしと同じ）`, json(t) === json(textCard(category, undefined)), rowText(settingsRows(t)[3]));
    const g = gmailCard(category, sub, 'jev');
    check(`カード利用通知: ${name} → 大項目だけ`, json(g) === json(gmailCard(category, undefined, 'jev')), rowText(settingsRows(g)[3]));
    const r = recordCard({ category, subCategory: sub, status: 'shared', inputSource: 'line_text' });
    check(`作り直したカード: ${name} → 大項目だけ`, json(r) === json(recordCard({ category, status: 'shared', inputSource: 'line_text' })), rowText(settingsRows(r)[3]));
  }
  // 大項目は正準名で一覧を引く（保存済みの旧名「娯楽費」でも娯楽の一覧で見る）
  check(
    '旧名の大項目「娯楽費」でも娯楽の中項目を出す',
    rowText(settingsRows(recordCard({ category: '娯楽費', subCategory: 'スポーツ・アウトドア', inputSource: 'line_text' }))[3]) === `カテゴリ：娯楽費${SEP}スポーツ・アウトドア`
  );

  // 判定元の注記（最初のカードだけ）は今までどおり行の最後に付く
  for (const [origin, label] of Object.entries(CATEGORY_ORIGIN_LABELS)) {
    const msg = textCard('食費', '昼ご飯', origin);
    const rows = settingsRows(msg);
    check(`${origin} → カテゴリ：食費${SEP}昼ご飯（${label}）`, rowText(rows[3]) === `カテゴリ：食費${SEP}昼ご飯（${label}）`, rowText(rows[3]));
    const spans = catSpans(msg);
    check(
      `${origin} → 注記は最後の span（xs・#64748B・太字でない）`,
      spans.length === 5 && spans[4].text === `（${label}）` && spans[4].size === 'xs' && spans[4].color === '#64748B' && spans[4].weight === undefined,
      json(spans[4])
    );
    check(`${origin} → 区切りと中項目を外すと、中項目なし・同じ判定元のカードと同じ`, json(withoutSub(msg)) === json(textCard('食費', undefined, origin)));
  }

  // カード利用通知（Gmail）
  {
    const msg = gmailCard('食費', 'カフェ', 'dictionary');
    common('カード利用通知（食費 › カフェ）', msg);
    const rows = settingsRows(msg);
    check('カード利用通知: 現在の設定は4行のまま', rows.length === 4, `got ${rows.length}`);
    check('カード利用通知: カテゴリ：食費 › カフェ（辞書）', rowText(rows[3]) === `カテゴリ：食費${SEP}カフェ（辞書）`, rowText(rows[3]));
    check('カード利用通知: 違いはカテゴリの行の区切りと中項目だけ', json(withoutSub(msg)) === json(gmailCard('食費', undefined, 'dictionary')));
  }

  // 作り直したカード（postback の返信。保存した中項目を出し、判定元は出さない）
  for (const inputSource of ['line_text', 'gmail_auto']) {
    const msg = recordCard({ description: 'ランチ', amount: 800, category: '食費', subCategory: '夜ご飯', status: 'shared', inputSource });
    common(`作り直したカード（${inputSource}・食費 › 夜ご飯）`, msg);
    const rows = settingsRows(msg);
    check(`作り直したカード（${inputSource}）: 現在の設定は4行のまま`, rows.length === 4, `got ${rows.length}`);
    check(`作り直したカード（${inputSource}）: カテゴリ：食費 › 夜ご飯（括弧なし）`, rowText(rows[3]) === `カテゴリ：食費${SEP}夜ご飯`, rowText(rows[3]));
  }

  // set_category の返信: { ...data, ...cardPatch } から作る（postback.ts の replyUpdatedCard と同じ）
  const afterSetCategory = (data, category) => {
    const decision = decideSetCategory(category)(data);
    return { decision, msg: recordCard({ ...data, ...decision.cardPatch }) };
  };
  const base = { amount: 800, date: '2026-10-24', status: 'shared', inputSource: 'line_text', lineId: 'U1' };
  {
    const { decision, msg } = afterSetCategory({ ...base, description: 'ランチ', category: '娯楽' }, '食費');
    check(
      'set_category: 娯楽 → 食費（ランチ）→ カテゴリ：食費 › 昼ご飯',
      decision.cardPatch.subCategory === '昼ご飯' && rowText(settingsRows(msg)[3]) === `カテゴリ：食費${SEP}昼ご飯`,
      rowText(settingsRows(msg)[3])
    );
  }
  {
    const data = { ...base, description: '居酒屋', category: '食費', subCategory: '外食' };
    const { decision, msg } = afterSetCategory(data, '娯楽');
    check('set_category: 食費 › 外食 → 娯楽（居酒屋）: cardPatch.subCategory は undefined（キーはある）', 'subCategory' in decision.cardPatch && decision.cardPatch.subCategory === undefined, json(Object.keys(decision.cardPatch)));
    check('set_category: 食費 › 外食 → 娯楽 → カテゴリ：娯楽（古い中項目を出さない）', rowText(settingsRows(msg)[3]) === 'カテゴリ：娯楽', rowText(settingsRows(msg)[3]));
    check(
      'set_category: 中項目が消えたカードは、中項目の無い支出のカードと同じ',
      json(msg) === json(recordCard({ ...base, description: '居酒屋', category: '娯楽' }))
    );
  }
  {
    const { msg } = afterSetCategory({ ...base, description: 'ランチ', category: '食費', subCategory: '昼ご飯' }, '日用品');
    check('set_category: 食費 › 昼ご飯 → 日用品 → カテゴリ：日用品', rowText(settingsRows(msg)[3]) === 'カテゴリ：日用品', rowText(settingsRows(msg)[3]));
  }
  {
    const { decision, msg } = afterSetCategory({ ...base, description: 'ランチ', category: '食費', subCategory: '夜ご飯' }, '食費');
    check(
      'set_category: 大項目が同じなら中項目は触らず、そのまま出す（食費 › 夜ご飯）',
      !('subCategory' in decision.cardPatch) && rowText(settingsRows(msg)[3]) === `カテゴリ：食費${SEP}夜ご飯`,
      rowText(settingsRows(msg)[3])
    );
  }
  {
    const { msg } = afterSetCategory({ ...base, description: 'ランチ', category: '食費', subCategory: 'おやつ' }, '食費');
    check('set_category: 大項目が同じで、一覧に無い中項目（Web で入れた値）が残っていても出さない', rowText(settingsRows(msg)[3]) === 'カテゴリ：食費', rowText(settingsRows(msg)[3]));
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
/** 旧名 → 正準名（正準名は載せない） */
const LEGACY_TO_CANONICAL = {
  医療費: '医療・健康',
  娯楽費: '娯楽',
  衣服費: '衣服',
  教育費: '教育',
  投資: '貯金',
  交際費: '娯楽',
  貯蓄: '貯金',
  趣味: '娯楽',
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
  check('飲み会 → 食費（#235）', toCanonicalCategoryName('飲み会') === '食費', toCanonicalCategoryName('飲み会'));
  check('飲み会: normalizeCategoryName も食費', normalizeCategoryName('飲み会') === '食費', normalizeCategoryName('飲み会'));
  // normalizeCategoryName は「その他」や部分一致で寄せるが、保存ではカスタム名などを変えない
  for (const name of ['推し活', '本田', 'ジム代', '日用品費', '趣味の本', '', ' 推し活 ', 'constructor', '__proto__', 'toString']) {
    check(`揃えられない名前は変えない: ${JSON.stringify(name)}`, toCanonicalCategoryName(name) === name, JSON.stringify(toCanonicalCategoryName(name)));
  }
  check('（参考）normalizeCategoryName なら「本田」は教育・「推し活」はその他になる', normalizeCategoryName('本田') === '教育' && normalizeCategoryName('推し活') === 'その他');
  // 部分一致は ALIAS_TO_CANONICAL の上から順に見る。「趣味」が教育の「本」より後ろにあると教育になる
  check('（参考）normalizeCategoryName なら「趣味の本」は娯楽になる（「趣味」は「本」より前）', normalizeCategoryName('趣味の本') === '娯楽', normalizeCategoryName('趣味の本'));

  check(
    '「カテゴリー」コマンドの選択肢はすべて正準名に揃う',
    LINE_COMMAND_CATEGORIES.every((c) => CANONICAL_CATEGORIES.includes(toCanonicalCategoryName(c))),
    LINE_COMMAND_CATEGORIES.map(toCanonicalCategoryName).join(',')
  );
  check(
    '入力で指定できる名前はすべて正準名に揃う',
    LINE_INPUT_CATEGORIES.every((c) => CANONICAL_CATEGORIES.includes(toCanonicalCategoryName(c))),
    LINE_INPUT_CATEGORIES.map(toCanonicalCategoryName).join(',')
  );
}

/**
 * LINE で指定・選択できる名前が、Web の normalizeCategoryName（web/lib/categoryNormalization.ts。表は bot の写し）でも
 * bot の保存と同じ正準名になること（#243）。片方の表だけに別名を足すと、LINE で保存した値が Web で別のカテゴリに入る。
 * Web 側は Node の型除去で .ts を直接読む（smoke-settlement-summary.js と同じ）。末尾でほかの確かめの後に呼ぶ。
 */
async function webNormalizationChecks() {
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  console.log('\n[Web の normalizeCategoryName も bot と同じ正準名]');
  const web = await import(pathToFileURL(path.join(__dirname, '../../web/lib/categoryNormalization.ts')).href);
  for (const name of new Set([...LINE_INPUT_CATEGORIES, ...LINE_COMMAND_CATEGORIES, ...CAROUSEL_LABELS])) {
    const expected = toCanonicalCategoryName(name);
    check(`「${name}」→ Web も ${expected}`, web.normalizeCategoryName(name) === expected, web.normalizeCategoryName(name));
  }
  check('「趣味の本」→ Web も娯楽（「趣味」は「本」より前）', web.normalizeCategoryName('趣味の本') === '娯楽', web.normalizeCategoryName('趣味の本'));
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
    ['趣味', ['娯楽費']],
    ['貯蓄', []],
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

// ------------------------------------- 中項目（#235）: カード利用通知の店名・LINE の説明文
/** fn の間の console 出力を集める（画面には出さない） */
function captureConsole(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  for (const level of Object.keys(original)) {
    console[level] = (...args) => lines.push({ level, args });
  }
  try {
    return { result: fn(), lines };
  } finally {
    Object.assign(console, original);
  }
}
async function captureConsoleAsync(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  for (const level of Object.keys(original)) {
    console[level] = (...args) => lines.push({ level, args });
  }
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, original);
  }
}
/** 'Subcategory resolved' のログ（固定文＋オブジェクト）だけを取り出す */
const subLogs = (lines) => lines.filter((l) => l.args[0] === 'Subcategory resolved');
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const NOON = new Date('2026-03-14T03:30:00.000Z'); // JST 3/14 12:30
const MORNING = new Date('2026-03-14T23:00:00.000Z'); // JST 3/15 08:00
const EVENING = new Date('2026-03-14T10:20:00.000Z'); // JST 3/14 19:20
const LATE_NIGHT = new Date('2026-03-14T16:30:00.000Z'); // JST 3/15 01:30

{
  console.log('\n[merchantSubCategoryOf]');
  const withTime = (merchant, usedAt) => ({ merchant, usedAt, usedAtHasTime: true });
  const noTime = (merchant, usedAt) => ({ merchant, usedAt, usedAtHasTime: false });
  // [名前, 大項目, parsed, 中項目, 'Subcategory resolved' のログが出るか]
  const cases = [
    ['食費・「スターバックス 渋谷店」（時刻あり）→ カフェ（時刻のルールは当てない）', '食費', withTime('スターバックス 渋谷店', NOON), 'カフェ', true],
    ['食費・飲食店（時刻あり・JST 12:30）→ 昼ご飯', '食費', withTime('テスト食堂 駅前店', NOON), '昼ご飯', true],
    ['食費・飲食店（時刻あり・JST 8:00）→ 朝ご飯', '食費', withTime('テスト食堂 駅前店', MORNING), '朝ご飯', true],
    ['食費・飲食店（時刻あり・JST 19:20）→ 夜ご飯', '食費', withTime('テスト食堂 駅前店', EVENING), '夜ご飯', true],
    ['食費・飲食店（時刻あり・JST 1:30）→ 夜ご飯', '食費', withTime('SAMPLE RAMEN', LATE_NIGHT), '夜ご飯', true],
    // usedAt は正午の Date でも、時刻が無いメールなら時刻のルールを当てない
    ['食費・飲食店（時刻なし・usedAt は正午）→ 外食', '食費', noTime('テスト食堂 駅前店', NOON), '外食', true],
    ['食費・スーパー（時刻なし）→ 食料品（スーパー）', '食費', noTime('SAMPLE スーパー 駅前', NOON), '食料品（スーパー）', true],
    ['娯楽・「TOHOシネマズ 日比谷」→ 映画', '娯楽', withTime('TOHOシネマズ 日比谷', EVENING), '映画', true],
    ['食費・辞書に無い店名 → undefined', '食費', withTime('SAMPLE MART', NOON), undefined, true],
    ['食費・「不明な店舗」→ undefined', '食費', withTime('不明な店舗', NOON), undefined, true],
    ['日用品・「スターバックス」→ undefined（中項目の一覧が無い大項目）', '日用品', withTime('スターバックス', NOON), undefined, false],
    ['その他・飲食店 → undefined', 'その他', withTime('テスト食堂 駅前店', NOON), undefined, false],
  ];
  for (const [name, category, parsed, expected, logged] of cases) {
    const { result, lines } = captureConsole(() => merchantSubCategoryOf(category, parsed));
    check(name, result === expected, JSON.stringify(result));
    const logs = subLogs(lines);
    if (logged) {
      check(
        `${name}: ログは 1 行で { source, subCategory } だけ（店名を出さない）`,
        logs.length === 1 && logs[0].level === 'log' && logs[0].args.length === 2 &&
          sameJson(logs[0].args[1], { source: 'merchant', subCategory: expected ?? null }) &&
          !JSON.stringify(lines).includes(parsed.merchant),
        JSON.stringify(lines)
      );
    } else {
      check(`${name}: ログを出さない`, lines.length === 0, JSON.stringify(lines));
    }
  }

  // 判定に失敗しても投げず、中項目なし（undefined）にする。店名は出さない
  const throwing = {
    get merchant() {
      throw new Error('merchant getter failed');
    },
    usedAt: NOON,
    usedAtHasTime: true,
  };
  let threw = false;
  const failed1 = captureConsole(() => {
    try {
      return merchantSubCategoryOf('食費', throwing);
    } catch {
      threw = true;
      return 'threw';
    }
  });
  check('店名を読むと例外になる入力でも投げずに undefined', !threw && failed1.result === undefined, JSON.stringify(failed1.result));
  check(
    '失敗は warn を 1 行（固定文＋{ source, errorName }。例外の文言は出さない）',
    failed1.lines.length === 1 && failed1.lines[0].level === 'warn' &&
      failed1.lines[0].args[0] === 'Subcategory resolution failed' &&
      sameJson(failed1.lines[0].args[1], { source: 'merchant', errorName: 'Error' }),
    JSON.stringify(failed1.lines)
  );
  const failedNull = captureConsole(() => merchantSubCategoryOf('食費', null));
  check('parsed が null でも投げずに undefined', failedNull.result === undefined, JSON.stringify(failedNull.result));
}

{
  console.log('\n[textSubCategoryOf]');
  const cases = [
    ['食費・「ランチ」→ 昼ご飯', '食費', 'ランチ', '昼ご飯', true],
    ['食費・「ラーメン」→ 外食（LINE の入力には時刻を当てない）', '食費', 'ラーメン', '外食', true],
    ['食費・「スタバ」→ カフェ', '食費', 'スタバ', 'カフェ', true],
    ['娯楽・「カラオケ」→ 音楽・ライブ', '娯楽', 'カラオケ', '音楽・ライブ', true],
    ['食費・「支出」（説明なし）→ undefined', '食費', '支出', undefined, true],
    ['食費・「食費」（カテゴリ名だけ）→ undefined', '食費', '食費', undefined, true],
    ['食費・辞書に無い説明 → undefined', '食費', 'おみやげ', undefined, true],
    ['日用品・「ランチ」→ undefined（中項目の一覧が無い大項目）', '日用品', 'ランチ', undefined, false],
    ['カスタム名「推し活」→ undefined', '推し活', 'カラオケ', undefined, false],
  ];
  for (const [name, category, description, expected, logged] of cases) {
    const { result, lines } = captureConsole(() => textSubCategoryOf(category, description));
    check(name, result === expected, JSON.stringify(result));
    const logs = subLogs(lines);
    if (logged) {
      check(
        `${name}: ログは 1 行で { source, subCategory } だけ（説明を出さない）`,
        logs.length === 1 && logs[0].args.length === 2 &&
          sameJson(logs[0].args[1], { source: 'text', subCategory: expected ?? null }) &&
          !JSON.stringify(lines).includes(description),
        JSON.stringify(lines)
      );
    } else {
      check(`${name}: ログを出さない`, lines.length === 0, JSON.stringify(lines));
    }
  }
}

{
  console.log('\n[中項目の判定が例外を投げても保存は続く（判定を差し替えて確かめる）]');
  const subRules = require('../dist/subCategoryRules');
  const realResolve = subRules.resolveSubCategory;
  subRules.resolveSubCategory = () => {
    throw new Error('resolveSubCategory failed');
  };
  /** 投げたら 'threw' を返す（投げたことをテストの失敗として出す） */
  const orThrew = (fn) => () => {
    try {
      return fn();
    } catch {
      return 'threw';
    }
  };
  try {
    const m = captureConsole(orThrew(() => merchantSubCategoryOf('食費', { merchant: 'テスト食堂', usedAt: NOON, usedAtHasTime: true })));
    check('merchantSubCategoryOf: 投げずに undefined', m.result === undefined, JSON.stringify(m.result));
    check('merchantSubCategoryOf: warn に店名を出さない', m.lines.length === 1 && m.lines[0].level === 'warn' && !JSON.stringify(m.lines).includes('テスト食堂'), JSON.stringify(m.lines));
    const t = captureConsole(orThrew(() => textSubCategoryOf('食費', 'ランチ')));
    check('textSubCategoryOf: 投げずに undefined', t.result === undefined, JSON.stringify(t.result));
    check('textSubCategoryOf: warn に説明を出さない', t.lines.length === 1 && t.lines[0].level === 'warn' && !JSON.stringify(t.lines).includes('ランチ'), JSON.stringify(t.lines));
  } finally {
    subRules.resolveSubCategory = realResolve;
  }
}

{
  console.log('\n[カード利用通知の X-Line-Retry-Key（gmail/cardNotice.ts）]');
  const a = cardNoticeRetryKey('18c0ffee12345678');
  check('同じメッセージなら同じ値', a === cardNoticeRetryKey('18c0ffee12345678'), a);
  check('別のメッセージなら別の値', a !== cardNoticeRetryKey('18c0ffee12345679'), a);
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  check('UUID v4 の形', ['18c0ffee12345678', 'msg-pubsub', ''].every((id) => uuidV4.test(cardNoticeRetryKey(id))), a);
}

// ------------------------------------- 保存データの subCategory（LINE の入力・カード利用通知の 3 経路）
//
// processExpenseInBackground と Gmail の 3 経路（Pub/Sub の processMessage・processLatestEmail・forceProcessMessage）を、
// Firestore・LINE・Gmail・分類器の偽物で動かし、保存に渡すデータを見る。dist の exports を書き換える
// （呼び出し側は呼ぶときに exports を参照する）。firebase-admin は初期化せず、getFirestore も偽物にする。
async function saveFlowChecks() {
  const path = require('path');
  const firestore = require('../dist/firestore');
  const classifier = require('../dist/geminiCategoryClassifier');
  const linkUserResolver = require('../dist/linkUserResolver');
  const lineClient = require('../dist/line/client');
  const flex = require('../dist/line/flexMessage');
  const gmailAuth = require('../dist/gmail/auth');
  const gmailWatch = require('../dist/gmail/watch');
  const gmailParser = require('../dist/gmail/parser');
  const subRules = require('../dist/subCategoryRules');
  const adminFirestore = require(require.resolve('firebase-admin/firestore', { paths: [path.join(__dirname, '..')] }));
  const { processExpenseInBackground } = require('../dist/line/expenseFlow');
  const { handleGmailPubSub, processLatestEmail, forceProcessMessage } = require('../dist/gmail/handler');

  // --- 偽物 ---
  const saved = [];
  const cards = [];
  const settingsByUser = {};
  let classifyReply = null;
  firestore.saveExpense = async (expense) => {
    saved.push(expense);
    return `exp_line_${saved.length}`;
  };
  firestore.getUserGroups = async () => [];
  firestore.getUserSettings = async (lineId) => settingsByUser[lineId] ?? null;
  firestore.findLineGroupId = async () => null;
  linkUserResolver.resolveAppUidForExpense = async () => 'uid_test';
  lineClient.getLineClient = () => ({
    getProfile: async () => ({ displayName: 'テスト' }),
    getGroupMemberProfile: async () => ({ displayName: 'テスト' }),
  });
  lineClient.replyText = async () => {};
  lineClient.replyWithPushFallback = async () => {};
  flex.sendTextExpenseNotification = async (targetId, info) => {
    cards.push(info);
  };
  // 本物の送信（X-Line-Retry-Key を pushMessage に渡すかを確かめる）
  const realSendCardUsageNotification = flex.sendCardUsageNotification;
  // 送れたカードと、その X-Line-Retry-Key
  const gmailCards = [];
  const gmailCardKeys = [];
  // 送ろうとした回数（失敗も含む）の X-Line-Retry-Key
  const gmailCardAttempts = [];
  /** 次からの送信で順に投げる例外（空なら送れる） */
  const cardSendErrors = [];
  flex.sendCardUsageNotification = async (to, info, retryKey) => {
    gmailCardAttempts.push(retryKey);
    if (cardSendErrors.length > 0) throw cardSendErrors.shift();
    gmailCards.push(info);
    gmailCardKeys.push(retryKey);
  };
  classifier.classifyExpense = async () => classifyReply;

  const gmailSaved = [];
  const gmailNotices = [];
  // 送信待ちの印（system/gmailCardNotice_*。gmail/cardNotice.ts）。偽の saveGmailExpenseAtomic が書き、偽の getFirestore で読む・消す
  const systemDocs = new Map();
  /** 'partnerSaved': 同じメールを同時に処理した相手が先に保存し、カードを送る前に止まった（印だけが残る・alreadyExists） */
  let saveMode = null;
  firestore.saveGmailExpenseAtomic = async (expense, notice) => {
    if (saveMode === 'partnerSaved') {
      if (notice) systemDocs.set(notice.ref.id, notice.build('exp_partner'));
      return { expenseId: 'exp_partner', alreadyExists: true };
    }
    gmailSaved.push(expense);
    gmailNotices.push(notice);
    const expenseId = `exp_gmail_${gmailSaved.length}`;
    if (notice) systemDocs.set(notice.ref.id, notice.build(expenseId));
    return { expenseId, alreadyExists: false };
  };
  let duplicateExpense = false;
  gmailParser.isDuplicateExpense = async () => duplicateExpense;
  gmailParser.getExpenseIdByGmailMessageId = async () => null;
  gmailWatch.getWatchState = async () => ({ historyId: '100', watchExpiration: Date.now() + 86400000 });
  // historyId を進めた回数を見る
  const historyUpdates = [];
  gmailWatch.updateHistoryId = async (historyId) => {
    historyUpdates.push(historyId);
  };
  /** doc().set の呼び出し（失敗の記録の消去 clearMessageFailure を見る）: { collection, id, data } */
  const docSets = [];
  // 失敗の記録（system/gmailFailures）の消去と、送信待ちの印の読み書き・支出の有無の確かめが getFirestore を直接使う
  adminFirestore.getFirestore = () => ({
    collection: (name) => ({
      doc: (id) => ({
        id,
        set: async (data) => {
          docSets.push({ collection: name, id, data });
        },
        get: async () => {
          // expenses は消されていない扱い
          const data = name === 'system' ? systemDocs.get(id) : { id };
          return { exists: data !== undefined, data: () => data };
        },
        delete: async () => {
          if (name === 'system') systemDocs.delete(id);
        },
      }),
    }),
    // 失敗の記録（recordMessageFailure）。本物の処理に priorFailures（前回までの記録）を読ませ、書いた値を failureWrites に残す
    // （書いた値は次の実行に持ち越さない。続けて失敗した状態は priorFailures で作る）
    runTransaction: async (fn) =>
      fn({
        get: async () => ({ exists: true, data: () => priorFailures }),
        set: (ref, data) => {
          failureWrites.push(data);
        },
      }),
  });
  /** 失敗の記録の前回までの値（messageId → { attempts, firstFailedAt?, lastFailedAt? }）。空なら初回の失敗 */
  let priorFailures = {};
  /** recordMessageFailure が書いた値（{ [messageId]: { attempts, errorName ほか最後の失敗の種類, firstFailedAt, lastFailedAt } }） */
  const failureWrites = [];
  /** history.list が返すメッセージ */
  let historyMessageIds = ['msg-pubsub'];
  /** 次の history.list で投げる例外（null なら historyMessageIds を返す） */
  let historyError = null;
  /**
   * history.list の応答の historyId（メールボックスの現在位置。取込が保存する historyId）。undefined なら応答に入れない。
   * 既定は、このテストで使う通知の historyId のどれとも違う値（保存したのが通知の値ではなく現在位置だと分かるように）
   */
  const MAILBOX_HISTORY_ID = '1000000';
  let mailboxHistoryId = MAILBOX_HISTORY_ID;
  /** 複数ページの history.list（[{ ids, historyId }]。null なら historyMessageIds の 1 ページ）。pageToken はページの番号 */
  let historyPages = null;
  /** users.getProfile（history.list が 404 のときの現在位置）の historyId・次に投げる例外・呼んだ回数 */
  let profileHistoryId = MAILBOX_HISTORY_ID;
  let profileError = null;
  let profileCalls = 0;
  let mailBody = '';
  /** messages.get が投げる例外（messageId → 例外。メールが消されていた 404 など） */
  const messageGetErrors = {};
  /** messages.get が返す data（messageId → data。名前の無いヘッダー・payload の無いメールなど。無ければ mailBody のメール） */
  const messageGetData = {};
  const historyPage = (ids, historyId) => ({
    history: [{ messagesAdded: ids.map((id) => ({ message: { id } })) }],
    ...(historyId === undefined ? {} : { historyId }),
  });
  const fakeGmailClient = async () => ({
    users: {
      history: {
        list: async ({ pageToken }) => {
          if (historyError) {
            const error = historyError;
            historyError = null;
            throw error;
          }
          if (historyPages) {
            const index = pageToken ? Number(pageToken) : 0;
            const page = historyPages[index];
            return {
              data: {
                ...historyPage(page.ids, page.historyId),
                ...(index + 1 < historyPages.length ? { nextPageToken: String(index + 1) } : {}),
              },
            };
          }
          return { data: historyPage(historyMessageIds, mailboxHistoryId) };
        },
      },
      getProfile: async () => {
        profileCalls++;
        if (profileError) throw profileError;
        return { data: { emailAddress: 'someone@example.com', ...(profileHistoryId === undefined ? {} : { historyId: profileHistoryId }) } };
      },
      messages: {
        list: async () => ({ data: { messages: [{ id: 'msg-latest' }] } }),
        get: async ({ id }) => {
          if (messageGetErrors[id]) throw messageGetErrors[id];
          if (id in messageGetData) return { data: messageGetData[id] };
          return {
            data: {
              payload: {
                headers: [{ name: 'From', value: 'statement@vpass.ne.jp' }],
                body: { data: Buffer.from(mailBody, 'utf-8').toString('base64') },
              },
            },
          };
        },
      },
    },
  });
  /** getGmailClient を呼んだ回数と、次に投げる例外（トークンが無いなど。null なら偽の Gmail を返す） */
  let gmailClientCalls = 0;
  let gmailClientError = null;
  gmailAuth.getGmailClient = async () => {
    gmailClientCalls++;
    if (gmailClientError) throw gmailClientError;
    return fakeGmailClient();
  };
  // カード利用通知は LINE_GROUP_ID があるときだけ送る。架空の値にして、送る内容（上の偽物が受け取る）を見る
  process.env.LINE_GROUP_ID = 'C_smoke_group';
  delete process.env.DEFAULT_GROUP_ID;

  const allLines = [];
  async function run(fn) {
    const { result, lines } = await captureConsoleAsync(fn);
    allLines.push(...lines);
    return result;
  }
  const last = (list) => list[list.length - 1];

  // --- LINE の入力 ---
  console.log('\n[保存データの subCategory: LINE の入力（processExpenseInBackground）]');
  let userSeq = 0;
  async function lineInput(text) {
    userSeq++;
    const userId = `U_sub_${userSeq}`; // プロフィールのキャッシュに当てないよう、毎回別の人にする
    const before = saved.length;
    await run(() => processExpenseInBackground({ source: { type: 'user', userId } }, parseTextExpense(text), 'rt'));
    return { userId, expense: saved.length > before ? last(saved) : null, card: last(cards) };
  }
  const dictionary = (category) => ({ category, confidence: 0.8, reasoning: 'Fast local keyword matching', provider: 'dictionary' });

  classifyReply = dictionary('食費');
  const lunch = await lineInput('900 ランチ');
  check(
    '「900 ランチ」（辞書で食費）→ subCategory: 昼ご飯',
    lunch.expense && lunch.expense.category === '食費' && lunch.expense.subCategory === '昼ご飯',
    JSON.stringify(lunch.expense)
  );
  check('判定元は変わらない（dictionary）', lunch.card && lunch.card.categoryOrigin === 'dictionary', JSON.stringify(lunch.card));
  check(
    'カードにも保存した中項目を渡す（昼ご飯）',
    lunch.card && lunch.card.description === 'ランチ' && lunch.card.subCategory === '昼ご飯',
    JSON.stringify(lunch.card)
  );
  const lunchRow = lunch.card ? rowText(settingsRows(buildTextExpenseFlexMessage(lunch.card))[3]) : '';
  check('そのカードのカテゴリの行は「食費 › 昼ご飯（辞書）」', lunchRow === 'カテゴリ：食費 › 昼ご飯（辞書）', lunchRow);

  classifyReply = dictionary('日用品'); // 指定があれば分類の結果は使わない
  const ramen = await lineInput('1200 ラーメン 食費');
  check(
    '「1200 ラーメン 食費」（指定）→ subCategory: 外食（時刻は当てない）',
    ramen.expense && ramen.expense.category === '食費' && ramen.expense.subCategory === '外食',
    JSON.stringify(ramen.expense)
  );
  check('判定元は変わらない（specified）', ramen.card && ramen.card.categoryOrigin === 'specified', JSON.stringify(ramen.card));
  check('カードにも中項目を渡す（外食）', ramen.card && ramen.card.description === 'ラーメン' && ramen.card.subCategory === '外食', JSON.stringify(ramen.card));

  classifyReply = { category: null, confidence: 0 };
  settingsByUser[`U_sub_${userSeq + 1}`] = { lineId: `U_sub_${userSeq + 1}`, defaultCategory: '娯楽費' };
  const karaoke = await lineInput('800 カラオケ');
  check(
    '「800 カラオケ」（既定のカテゴリ「娯楽費」）→ 娯楽・subCategory: 音楽・ライブ',
    karaoke.expense && karaoke.expense.category === '娯楽' && karaoke.expense.subCategory === '音楽・ライブ',
    JSON.stringify(karaoke.expense)
  );
  check('判定元は変わらない（default）', karaoke.card && karaoke.card.categoryOrigin === 'default', JSON.stringify(karaoke.card));

  classifyReply = dictionary('日用品');
  const linesBeforeTissue = allLines.length;
  const tissue = await lineInput('300 ティッシュ');
  check(
    '「300 ティッシュ」（日用品）→ subCategory は undefined（saveExpense が項目を付けない）',
    tissue.expense && tissue.expense.category === '日用品' && tissue.expense.subCategory === undefined,
    JSON.stringify(tissue.expense)
  );
  check('日用品では中項目のログを出さない', subLogs(allLines.slice(linesBeforeTissue)).length === 0, JSON.stringify(subLogs(allLines.slice(linesBeforeTissue))));
  check(
    '日用品のカードには中項目を渡さない',
    tissue.card && tissue.card.description === 'ティッシュ' && tissue.card.subCategory === undefined,
    JSON.stringify(tissue.card)
  );

  classifyReply = dictionary('食費');
  const unknownFood = await lineInput('500 おみやげ');
  check(
    '「500 おみやげ」（食費・辞書に無い）→ subCategory は undefined',
    unknownFood.expense && unknownFood.expense.category === '食費' && unknownFood.expense.subCategory === undefined,
    JSON.stringify(unknownFood.expense)
  );
  const unknownRow = unknownFood.card ? rowText(settingsRows(buildTextExpenseFlexMessage(unknownFood.card))[3]) : '';
  check(
    '中項目が決まらなければ、カードは今までどおり「食費（辞書）」',
    unknownFood.card && unknownFood.card.description === 'おみやげ' && unknownFood.card.subCategory === undefined && unknownRow === 'カテゴリ：食費（辞書）',
    unknownRow
  );

  const realResolve = subRules.resolveSubCategory;
  subRules.resolveSubCategory = () => {
    throw new Error('resolveSubCategory failed');
  };
  try {
    const failedLunch = await lineInput('900 ランチ');
    check(
      '中項目の判定が例外を投げても保存は続く（subCategory は undefined）',
      failedLunch.expense && failedLunch.expense.category === '食費' && failedLunch.expense.subCategory === undefined,
      JSON.stringify(failedLunch.expense)
    );
  } finally {
    subRules.resolveSubCategory = realResolve;
  }

  // --- カード利用通知（Gmail） ---
  console.log('\n[保存データの subCategory: カード利用通知（Gmail の 3 経路）]');
  const cardMail = (dateTime, merchant) =>
    [
      '【ご利用のお知らせ】',
      `ご利用日時：${dateTime}`,
      `ご利用店名：${merchant}`,
      'ご利用金額：980円',
      '三井住友ゴールドＶＩＳＡ（ＮＬ）',
    ].join('\n');
  const jev = (category) => ({ category, confidence: 0.3, reasoning: 'Jev classification', provider: 'jev' });

  mailBody = cardMail('2026/03/14 12:30', 'テスト食堂 駅前店');
  classifyReply = jev('食費');
  let before = gmailSaved.length;
  let cardsBefore = gmailCards.length;
  let linesBeforeMail = allLines.length;
  await run(() => handleGmailPubSub(Buffer.from(JSON.stringify({ emailAddress: 'someone@example.com', historyId: '200' })).toString('base64')));
  let g = gmailSaved.length > before ? last(gmailSaved) : null;
  check(
    'Pub/Sub（processMessage）: 時刻ありの飲食店 → subCategory: 昼ご飯',
    g && g.gmailMessageId === 'msg-pubsub' && g.category === '食費' && g.subCategory === '昼ご飯',
    JSON.stringify(g)
  );
  /** 直前の 1 通で送ったカード（送っていなければ null） */
  const sentCard = () => (gmailCards.length === cardsBefore + 1 ? last(gmailCards) : null);
  let gc = sentCard();
  check(
    'Pub/Sub（processMessage）: カードにも保存した中項目を渡す（昼ご飯）',
    gc && g && gc.expenseId === `exp_gmail_${gmailSaved.length}` && gc.subCategory === '昼ご飯' && gc.subCategory === g.subCategory,
    JSON.stringify(gc)
  );
  const gmailRow = gc ? rowText(settingsRows(buildCardUsageFlexMessage(gc))[3]) : '';
  check('Pub/Sub（processMessage）: カードのカテゴリの行は「食費 › 昼ご飯（Jev）」', gmailRow === 'カテゴリ：食費 › 昼ご飯（Jev）', gmailRow);
  const pubsubNotice = last(gmailNotices);
  check(
    'Pub/Sub（processMessage）: 保存に送信待ちの印（system/gmailCardNotice_{messageId}）を渡す',
    pubsubNotice && pubsubNotice.ref.id === 'gmailCardNotice_msg-pubsub',
    pubsubNotice && pubsubNotice.ref.id
  );
  check(
    'Pub/Sub（processMessage）: メッセージから決まる X-Line-Retry-Key を付けて送る',
    gc && last(gmailCardKeys) === cardNoticeRetryKey('msg-pubsub'),
    last(gmailCardKeys)
  );
  check('Pub/Sub（processMessage）: 送ったら印を消す', !systemDocs.has('gmailCardNotice_msg-pubsub'), JSON.stringify([...systemDocs.keys()]));
  check(
    'Pub/Sub（processMessage）: 中項目は 1 通で 1 回だけ決める（カードのために決め直さない）',
    subLogs(allLines.slice(linesBeforeMail)).length === 1,
    JSON.stringify(subLogs(allLines.slice(linesBeforeMail)))
  );

  before = gmailSaved.length;
  const latest = await run(() => processLatestEmail());
  g = gmailSaved.length > before ? last(gmailSaved) : null;
  check(
    'processLatestEmail: 時刻ありの飲食店 → subCategory: 昼ご飯',
    latest && latest.success && g && g.gmailMessageId === 'msg-latest' && g.category === '食費' && g.subCategory === '昼ご飯',
    JSON.stringify({ latest, g })
  );
  check('processLatestEmail: 送信待ちの印を作らない（カードを送らない）', last(gmailNotices) === undefined);

  before = gmailSaved.length;
  cardsBefore = gmailCards.length;
  linesBeforeMail = allLines.length;
  const forced = await run(() => forceProcessMessage('msg-force-1'));
  g = gmailSaved.length > before ? last(gmailSaved) : null;
  check(
    'forceProcessMessage: 時刻ありの飲食店 → subCategory: 昼ご飯',
    forced && forced.success && g && g.gmailMessageId === 'msg-force-1' && g.category === '食費' && g.subCategory === '昼ご飯',
    JSON.stringify({ forced, g })
  );
  gc = sentCard();
  check(
    'forceProcessMessage: カードにも保存した中項目を渡す（昼ご飯）',
    gc && forced && gc.expenseId === forced.expenseId && gc.subCategory === '昼ご飯',
    JSON.stringify(gc)
  );
  check(
    'forceProcessMessage: 印を渡し、同じ導き方の X-Line-Retry-Key で送り、送ったら消す',
    last(gmailNotices) &&
      last(gmailNotices).ref.id === 'gmailCardNotice_msg-force-1' &&
      last(gmailCardKeys) === cardNoticeRetryKey('msg-force-1') &&
      !systemDocs.has('gmailCardNotice_msg-force-1'),
    JSON.stringify({ key: last(gmailCardKeys), docs: [...systemDocs.keys()] })
  );
  check(
    'forceProcessMessage: 中項目は 1 通で 1 回だけ決める',
    subLogs(allLines.slice(linesBeforeMail)).length === 1,
    JSON.stringify(subLogs(allLines.slice(linesBeforeMail)))
  );

  mailBody = cardMail('2026/03/14', 'テスト食堂 駅前店');
  for (const [label, call, id] of [
    ['Pub/Sub（processMessage）', () => handleGmailPubSub(Buffer.from(JSON.stringify({ historyId: '201' })).toString('base64')), 'msg-pubsub'],
    ['processLatestEmail', () => processLatestEmail(), 'msg-latest'],
    ['forceProcessMessage', () => forceProcessMessage('msg-force-2'), 'msg-force-2'],
  ]) {
    before = gmailSaved.length;
    await run(call);
    g = gmailSaved.length > before ? last(gmailSaved) : null;
    check(`${label}: 時刻の無いメールの飲食店 → subCategory: 外食`, g && g.gmailMessageId === id && g.subCategory === '外食', JSON.stringify(g));
  }

  mailBody = cardMail('2026/03/14 12:30', 'SAMPLE DRUG');
  classifyReply = jev('日用品');
  const linesBeforeDaily = allLines.length;
  for (const [label, call] of [
    ['Pub/Sub（processMessage）', () => handleGmailPubSub(Buffer.from(JSON.stringify({ historyId: '202' })).toString('base64'))],
    ['processLatestEmail', () => processLatestEmail()],
    ['forceProcessMessage', () => forceProcessMessage('msg-force-3')],
  ]) {
    before = gmailSaved.length;
    cardsBefore = gmailCards.length;
    await run(call);
    g = gmailSaved.length > before ? last(gmailSaved) : null;
    check(`${label}: 日用品 → subCategory は undefined`, g && g.category === '日用品' && g.subCategory === undefined, JSON.stringify(g));
    if (label !== 'processLatestEmail') {
      // processLatestEmail はカードを送らない
      gc = sentCard();
      check(`${label}: 日用品のカードには中項目を渡さない`, gc && gc.category === '日用品' && gc.subCategory === undefined, JSON.stringify(gc));
    }
  }
  check('日用品のカード利用通知では中項目のログを出さない', subLogs(allLines.slice(linesBeforeDaily)).length === 0, JSON.stringify(subLogs(allLines.slice(linesBeforeDaily))));

  mailBody = cardMail('2026/03/14 12:30', 'テスト食堂 駅前店');
  classifyReply = jev('食費');
  subRules.resolveSubCategory = () => {
    throw new Error('resolveSubCategory failed');
  };
  try {
    for (const [label, call] of [
      ['Pub/Sub（processMessage）', () => handleGmailPubSub(Buffer.from(JSON.stringify({ historyId: '203' })).toString('base64'))],
      ['processLatestEmail', () => processLatestEmail()],
      ['forceProcessMessage', () => forceProcessMessage('msg-force-4')],
    ]) {
      before = gmailSaved.length;
      await run(call);
      g = gmailSaved.length > before ? last(gmailSaved) : null;
      check(`${label}: 中項目の判定が例外を投げても保存は続く（subCategory は undefined）`, g && g.category === '食費' && g.subCategory === undefined, JSON.stringify(g));
    }
  } finally {
    subRules.resolveSubCategory = realResolve;
  }

  // --- 送信待ちの印の送り直し（gmail/cardNotice.ts） ---
  // CI ではエミュレータのテストが走らないので、中核の経路はここでも確かめる（偽の systemDocs と getFirestore を使う）
  console.log('\n[カード利用通知の送り直し（送信待ちの印）]');
  {
    const { Timestamp } = adminFirestore;
    const HOUR = 60 * 60 * 1000;
    const noticeId = 'gmailCardNotice_msg-pubsub';
    const key = cardNoticeRetryKey('msg-pubsub');
    /** 前の処理が保存のあと、カードを送れずに終わった印（ageMs 前に作った） */
    const seedNotice = (ageMs, id = noticeId) =>
      systemDocs.set(id, {
        expenseId: 'exp_seeded',
        lineGroupId: 'C_smoke_group',
        card: { expenseId: 'exp_seeded', merchant: '前回の店', amount: 700, category: '食費', categoryOrigin: 'jev', categoryEmoji: '', date: '3/14', status: 'shared', includeInTotal: true },
        createdAt: Timestamp.fromMillis(Date.now() - ageMs),
      });
    let historySeq = 300;
    /** Pub/Sub の通知 1 回分（historyMessageIds）。投げたら例外を返す（投げた回のログも allLines に残す） */
    const pubsubOnce = () =>
      run(async () => {
        try {
          await handleGmailPubSub(Buffer.from(JSON.stringify({ historyId: String(++historySeq) })).toString('base64'));
          return 'ok';
        } catch (error) {
          return error;
        }
      });
    const counts = () => ({ saved: gmailSaved.length, cards: gmailCards.length, attempts: gmailCardAttempts.length });

    // sendCardUsageNotification は retryKey を X-Line-Retry-Key として pushMessage に渡す
    const fakeClient = lineClient.getLineClient;
    const pushed = [];
    lineClient.getLineClient = () => ({ pushMessage: async (request, retryKey) => pushed.push({ to: request.to, retryKey }) });
    try {
      await run(() =>
        realSendCardUsageNotification(
          'C_smoke_group',
          { expenseId: 'exp_key', merchant: '店', amount: 100, category: '食費', categoryEmoji: '', date: '3/14', status: 'shared' },
          key
        )
      );
    } finally {
      lineClient.getLineClient = fakeClient;
    }
    check('sendCardUsageNotification: retryKey を pushMessage に渡す', pushed.length === 1 && pushed[0].retryKey === key, JSON.stringify(pushed));

    mailBody = cardMail('2026/03/14 12:30', 'テスト食堂 駅前店');
    classifyReply = jev('食費');

    // (a) 印があり、支出は登録済み（重複判定で飛ばされる状態）
    duplicateExpense = true;
    seedNotice(1 * HOUR);
    let before = counts();
    let r = await pubsubOnce();
    check('登録済みでも印があれば: 処理は成功する', r === 'ok', String(r));
    check(
      '登録済みでも印があれば: 保存時点のカードを 1 回だけ、メッセージから決まる key で送る',
      gmailCardAttempts.length === before.attempts + 1 &&
        gmailCards.length === before.cards + 1 &&
        last(gmailCards).merchant === '前回の店' &&
        last(gmailCards).expenseId === 'exp_seeded' &&
        last(gmailCardKeys) === key,
      JSON.stringify({ card: last(gmailCards), key: last(gmailCardKeys) })
    );
    check('登録済みでも印があれば: 保存し直さない', gmailSaved.length === before.saved, String(gmailSaved.length - before.saved));
    check('登録済みでも印があれば: 送ったら印を消す', !systemDocs.has(noticeId));
    before = counts();
    r = await pubsubOnce();
    check('印を消したあとの再処理では送らない', r === 'ok' && gmailCardAttempts.length === before.attempts, String(r));

    // (b) LINE が受け付け済み（409）
    seedNotice(1 * HOUR);
    cardSendErrors.push(Object.assign(new Error('Conflict'), { status: 409 }));
    before = counts();
    r = await pubsubOnce();
    check('409: 送れた扱いにして成功し、印を消す', r === 'ok' && gmailCardAttempts.length === before.attempts + 1 && last(gmailCardAttempts) === key && !systemDocs.has(noticeId), String(r));
    seedNotice(1 * HOUR);
    cardSendErrors.push(Object.assign(new Error('Internal Server Error'), { status: 500 }));
    r = await pubsubOnce();
    check('409 以外の失敗: 投げて（再処理させて）印を残す', r instanceof Error && systemDocs.has(noticeId), String(r));
    systemDocs.delete(noticeId);

    // (c) 古い印（23 時間超）は送らずに消す・23 時間以内なら送る
    seedNotice(23 * HOUR + 60 * 1000);
    before = counts();
    r = await pubsubOnce();
    check('23 時間 1 分前の印: 送らずに消し、保存し直さない', r === 'ok' && gmailCardAttempts.length === before.attempts && !systemDocs.has(noticeId) && gmailSaved.length === before.saved, String(r));
    seedNotice(22 * HOUR);
    before = counts();
    r = await pubsubOnce();
    check('22 時間前の印: 送って消す', r === 'ok' && gmailCards.length === before.cards + 1 && !systemDocs.has(noticeId), String(r));
    duplicateExpense = false;

    // (d) 保存が「登録済み」（同時に処理した相手が先に保存し、カードを送る前に止まった）
    saveMode = 'partnerSaved';
    before = counts();
    try {
      r = await pubsubOnce();
    } finally {
      saveMode = null;
    }
    check(
      'alreadyExists: 相手が残した印のカードを同じ key で送り、印を消す',
      r === 'ok' && gmailCards.length === before.cards + 1 && last(gmailCards).expenseId === 'exp_partner' && last(gmailCardKeys) === key && !systemDocs.has(noticeId),
      String(r)
    );

    // 印の expireAt（TTL）は作ってから 24 時間
    const built = gmailNotices.filter(Boolean).pop().build('exp_ttl');
    check('印の expireAt は createdAt + 24 時間', built.expireAt.toMillis() - built.createdAt.toMillis() === 24 * HOUR, JSON.stringify(built));

    // (e0) 3 回目の失敗でも、最初の失敗から 6 時間たっていなければ諦めない（Pub/Sub の再送で回数だけすぐ増えるため）
    const serverError = () => Object.assign(new Error('Internal Server Error'), { status: 500 });
    const firstFailed5h = Timestamp.fromMillis(Date.now() - 5 * HOUR);
    cardSendErrors.push(serverError());
    priorFailures = { 'msg-pubsub': { attempts: 2, firstFailedAt: firstFailed5h, lastFailedAt: Timestamp.fromMillis(Date.now() - 10 * 60 * 1000) } };
    before = counts();
    let historyBefore = historyUpdates.length;
    let writesBefore = failureWrites.length;
    try {
      r = await pubsubOnce();
    } finally {
      priorFailures = {};
    }
    check(
      '3 回目の失敗・最初の失敗から 5 時間: 諦めずに投げ、historyId を進めない',
      r instanceof Error && gmailSaved.length === before.saved + 1 && historyUpdates.length === historyBefore,
      String(r)
    );
    check('3 回目の失敗・5 時間: 印は残す（次の再送で送れる）', systemDocs.has(noticeId), JSON.stringify([...systemDocs.keys()]));
    let write = failureWrites.slice(writesBefore).map((w) => w['msg-pubsub']).filter(Boolean)[0];
    check(
      '失敗の記録: 試行 3・firstFailedAt は前回の値を引き継ぎ、lastFailedAt は今',
      write &&
        write.attempts === 3 &&
        write.firstFailedAt.toMillis() === firstFailed5h.toMillis() &&
        Math.abs(write.lastFailedAt.toMillis() - Date.now()) < 60 * 1000,
      JSON.stringify(write)
    );
    systemDocs.delete(noticeId);

    // 初回の失敗: firstFailedAt と lastFailedAt は今
    cardSendErrors.push(serverError());
    writesBefore = failureWrites.length;
    r = await pubsubOnce();
    write = failureWrites.slice(writesBefore).map((w) => w['msg-pubsub']).filter(Boolean)[0];
    check(
      '初回の失敗: 試行 1・firstFailedAt と lastFailedAt は今（同じ時刻）、投げる',
      r instanceof Error &&
        write &&
        write.attempts === 1 &&
        write.firstFailedAt.toMillis() === write.lastFailedAt.toMillis() &&
        Math.abs(write.firstFailedAt.toMillis() - Date.now()) < 60 * 1000,
      JSON.stringify(write)
    );
    systemDocs.delete(noticeId);

    // (e) 試行 3 回以上 かつ 最初の失敗から 6 時間以上で諦めたら、印を消す
    const firstFailed7h = Timestamp.fromMillis(Date.now() - 7 * HOUR);
    cardSendErrors.push(serverError());
    priorFailures = { 'msg-pubsub': { attempts: 2, firstFailedAt: firstFailed7h } };
    before = counts();
    historyBefore = historyUpdates.length;
    try {
      r = await pubsubOnce();
    } finally {
      priorFailures = {};
    }
    check(
      '3 回目の失敗・最初の失敗から 7 時間で諦める（投げずに historyId を進める）',
      r === 'ok' && gmailSaved.length === before.saved + 1 && historyUpdates.length === historyBefore + 1,
      String(r)
    );
    check('諦めたメールの印を消す', !systemDocs.has(noticeId), JSON.stringify([...systemDocs.keys()]));

    // (e2) firstFailedAt の無い記録（この項目を足す前の記録）は lastFailedAt で代用する
    cardSendErrors.push(serverError());
    priorFailures = { 'msg-pubsub': { attempts: 2, lastFailedAt: firstFailed7h } };
    historyBefore = historyUpdates.length;
    writesBefore = failureWrites.length;
    try {
      r = await pubsubOnce();
    } finally {
      priorFailures = {};
    }
    write = failureWrites.slice(writesBefore).map((w) => w['msg-pubsub']).filter(Boolean)[0];
    check(
      'firstFailedAt の無い記録: lastFailedAt（7 時間前）を最初の失敗として諦め、firstFailedAt に書く',
      r === 'ok' && historyUpdates.length === historyBefore + 1 && write && write.firstFailedAt.toMillis() === firstFailed7h.toMillis(),
      JSON.stringify({ r: String(r), write })
    );
    check('firstFailedAt の無い記録で諦めたら、印を消す', !systemDocs.has(noticeId), JSON.stringify([...systemDocs.keys()]));

    // (f) 同じ実行で A は 3 回目の失敗で諦め、B は再試行で投げる → historyId は進まず A の印は残る → 次の実行で A に送る
    const idA = 'msg-abandon-a';
    const idB = 'msg-retry-b';
    const noticeA = `gmailCardNotice_${idA}`;
    const noticeB = `gmailCardNotice_${idB}`;
    duplicateExpense = true; // どちらも前の処理で保存済み（カードを送れずに終わった）
    seedNotice(1 * HOUR, noticeA);
    seedNotice(1 * HOUR, noticeB);
    historyMessageIds = [idA, idB];
    // A は 2 回失敗済みで最初の失敗から 7 時間（3 回目で諦める）、B は初回の失敗
    priorFailures = { [idA]: { attempts: 2, firstFailedAt: firstFailed7h } };
    cardSendErrors.push(serverError(), serverError());
    historyBefore = historyUpdates.length;
    try {
      r = await pubsubOnce();
    } finally {
      priorFailures = {};
    }
    check('A は諦め・B は再試行: 投げて historyId を進めない', r instanceof Error && historyUpdates.length === historyBefore, String(r));
    check('A は諦め・B は再試行: 同じ範囲をやり直すので、諦めた A の印も消さない', systemDocs.has(noticeA) && systemDocs.has(noticeB), JSON.stringify([...systemDocs.keys()]));
    before = counts();
    try {
      r = await pubsubOnce();
    } finally {
      historyMessageIds = ['msg-pubsub'];
      duplicateExpense = false;
    }
    const sentKeys = gmailCardKeys.slice(before.cards);
    check(
      '次の実行で A と B に送り、historyId を進める',
      r === 'ok' && sentKeys.includes(cardNoticeRetryKey(idA)) && sentKeys.includes(cardNoticeRetryKey(idB)) && historyUpdates.length === historyBefore + 1,
      JSON.stringify({ r: String(r), sentKeys })
    );
    check('送ったら A と B の印を消す', !systemDocs.has(noticeA) && !systemDocs.has(noticeB), JSON.stringify([...systemDocs.keys()]));

    // (g) historyId が古すぎて先へ飛ばしたら、失敗の記録にあるメールの印を消す（記録に無い印は残す）
    seedNotice(1 * HOUR);
    seedNotice(1 * HOUR, 'gmailCardNotice_msg-force-only');
    systemDocs.set('gmailFailures', { 'msg-pubsub': { attempts: 1 } });
    historyError = Object.assign(new Error('Requested entity was not found.'), { code: 404 });
    before = counts();
    r = await pubsubOnce();
    check('historyId が古すぎる（404）: 先へ飛ばして成功し、送らない', r === 'ok' && gmailCardAttempts.length === before.attempts, String(r));
    check('404: 失敗の記録にあるメールの印を消す', !systemDocs.has(noticeId));
    check('404: 失敗の記録に無い印は消さない', systemDocs.has('gmailCardNotice_msg-force-only'));
    systemDocs.delete('gmailCardNotice_msg-force-only');
    systemDocs.delete('gmailFailures');

    // (h) メールが消されていた（messages.get が 404）: 失敗として数えず読み飛ばし、historyId を進める
    const gone = 'msg-gone-404';
    historyMessageIds = [gone];
    const notFoundErrors = [
      ['code: 404（gaxios 7 が JSON のエラーの code を入れる）', Object.assign(new Error('Requested entity was not found.'), { code: 404, status: 404 })],
      ['status: 404 だけ', Object.assign(new Error('Not Found'), { status: 404 })],
    ];
    try {
      for (const [label, error] of notFoundErrors) {
        messageGetErrors[gone] = error;
        before = counts();
        historyBefore = historyUpdates.length;
        writesBefore = failureWrites.length;
        const setsBefore = docSets.length;
        r = await pubsubOnce();
        check(`messages.get が 404（${label}）: 投げずに historyId を進める`, r === 'ok' && historyUpdates.length === historyBefore + 1, String(r));
        check(
          `messages.get が 404（${label}）: 失敗として記録せず、保存も送信もしない`,
          failureWrites.length === writesBefore && gmailSaved.length === before.saved && gmailCardAttempts.length === before.attempts,
          JSON.stringify(failureWrites.slice(writesBefore))
        );
        check(
          `messages.get が 404（${label}）: 前の失敗の記録を消す`,
          docSets.slice(setsBefore).some((s) => s.collection === 'system' && s.id === 'gmailFailures' && Object.keys(s.data).includes(gone)),
          JSON.stringify(docSets.slice(setsBefore).map((s) => s.id))
        );
      }
      // 404 以外（Gmail API の 500 など）は今までどおり失敗として数え、投げる
      messageGetErrors[gone] = Object.assign(new Error('Backend Error'), { code: 500, status: 500 });
      historyBefore = historyUpdates.length;
      writesBefore = failureWrites.length;
      r = await pubsubOnce();
      check(
        'messages.get が 500: 失敗として記録し、投げて historyId を進めない',
        r instanceof Error && historyUpdates.length === historyBefore && failureWrites.slice(writesBefore).some((w) => w[gone] && w[gone].attempts === 1),
        String(r)
      );
    } finally {
      delete messageGetErrors[gone];
      historyMessageIds = ['msg-pubsub'];
    }
    const goneLogs = allLines.filter((l) => l.args[0] === 'Gmail message not found (deleted); skipping');
    check(
      '404 の読み飛ばしは固定文の警告で、messageId をそのまま出さない',
      goneLogs.length === notFoundErrors.length && goneLogs.every((l) => l.level === 'warn' && !JSON.stringify(l.args).includes(gone)),
      JSON.stringify(goneLogs)
    );
    const failureLogs = allLines.filter((l) => l.args[0] === 'Gmail message failed');
    check(
      '失敗のログは固定文＋オブジェクトで、messageId・エラーの文言を出さない',
      failureLogs.length > 0 &&
        failureLogs.every(
          (l) =>
            l.args.length === 2 &&
            ['msg-pubsub', idA, idB, gone].every((id) => !JSON.stringify(l.args).includes(id)) &&
            !JSON.stringify(l.args).includes('Internal Server Error')
        ),
      JSON.stringify(failureLogs.slice(0, 3))
    );

    // (i) やり直しても直らない失敗は投げずに終える（Pub/Sub に再送させない）。一時的な失敗は投げる
    const b64 = (text) => Buffer.from(text, 'utf-8').toString('base64');
    const pubsubData = (payload) => b64(JSON.stringify(payload));
    const handle = (data) =>
      run(async () => {
        try {
          await handleGmailPubSub(data);
          return 'ok';
        } catch (error) {
          return error;
        }
      });
    const warnsSince = (from) => allLines.slice(from).filter((l) => l.level === 'warn').map((l) => l.args);
    const DROP_LOG = 'Gmail Pub/Sub message has no usable historyId; dropping it (retrying does not help)';
    for (const [label, data] of [
      ['JSON でない本文', b64('not json')],
      ['JSON の null', b64('null')],
      ['historyId が無い', pubsubData({ emailAddress: 'someone@example.com' })],
      ['historyId が数値として読めない', pubsubData({ emailAddress: 'someone@example.com', historyId: 'abc' })],
      ['historyId が負の数', pubsubData({ emailAddress: 'someone@example.com', historyId: -1 })],
    ]) {
      const from = allLines.length;
      const callsBefore = gmailClientCalls;
      historyBefore = historyUpdates.length;
      r = await handle(data);
      const warns = warnsSince(from);
      check(
        `通知の本文の${label}: 投げずに終え、取込を始めない（Gmail を呼ばず historyId も進めない）`,
        r === 'ok' && gmailClientCalls === callsBefore && historyUpdates.length === historyBefore,
        String(r)
      );
      check(
        `通知の本文の${label}: 固定文の警告を 1 回だけ出し、本文（メールアドレス）を出さない`,
        warns.length === 1 && warns[0].length === 1 && warns[0][0] === DROP_LOG,
        JSON.stringify(warns)
      );
    }
    historyBefore = historyUpdates.length;
    r = await handle(pubsubData({ emailAddress: 'someone@example.com', historyId: 401 }));
    check(
      '数値の historyId（Gmail の形）の通知も処理し、保存するのは応答の現在位置（文字列。通知の値 401 ではない）',
      r === 'ok' && historyUpdates.length === historyBefore + 1 && historyUpdates[historyUpdates.length - 1] === MAILBOX_HISTORY_ID,
      JSON.stringify(historyUpdates.slice(-1))
    );

    // Gmail のトークンが無い（GmailTokenMissingError）: やり直しても直らないので投げない
    let from = allLines.length;
    historyBefore = historyUpdates.length;
    gmailClientError = new gmailAuth.GmailTokenMissingError();
    try {
      r = await handle(pubsubData({ historyId: '402' }));
    } finally {
      gmailClientError = null;
    }
    check(
      'Gmail のトークンが無い: 投げずに終え（historyId は進めない）、固定文の警告を出す',
      r === 'ok' &&
        historyUpdates.length === historyBefore &&
        JSON.stringify(warnsSince(from)) === JSON.stringify([['Gmail token not found; skipping (run the OAuth setup; retrying does not help)']]),
      JSON.stringify({ r: String(r), warns: warnsSince(from) })
    );
    // 同じ文言でも GmailTokenMissingError でなければ（種類で判定する）、Firestore の失敗などの一時的な失敗として投げる
    for (const [label, error] of [
      ['トークンの読み取りの失敗（Firestore UNAVAILABLE）', Object.assign(new Error('14 UNAVAILABLE: Firestore is down'), { code: 14 })],
      ['トークンの更新の失敗（Google の 503）', Object.assign(new Error('Service Unavailable'), { code: 503, status: 503 })],
      ['同じ文言の Error（種類が違う）', new Error('Gmail token not found. Please run OAuth2 setup first.')],
    ]) {
      gmailClientError = error;
      try {
        r = await handle(pubsubData({ historyId: '403' }));
      } finally {
        gmailClientError = null;
      }
      check(`getGmailClient の${label}: 投げて Pub/Sub に再送させる`, r instanceof Error, String(r));
    }
    // watch の状態が無い: 投げない。読み取りの失敗は投げる
    const realGetWatchState = gmailWatch.getWatchState;
    from = allLines.length;
    historyBefore = historyUpdates.length;
    gmailWatch.getWatchState = async () => null;
    try {
      r = await handle(pubsubData({ historyId: '404' }));
    } finally {
      gmailWatch.getWatchState = realGetWatchState;
    }
    check(
      'watch の状態が無い: 投げずに終え、historyId を進めない',
      r === 'ok' && historyUpdates.length === historyBefore && JSON.stringify(warnsSince(from)) === JSON.stringify([['Watch state not found, skipping processing']]),
      JSON.stringify({ r: String(r), warns: warnsSince(from) })
    );
    gmailWatch.getWatchState = async () => {
      throw Object.assign(new Error('14 UNAVAILABLE'), { code: 14 });
    };
    try {
      r = await handle(pubsubData({ historyId: '405' }));
    } finally {
      gmailWatch.getWatchState = realGetWatchState;
    }
    check('watch の状態の読み取りの失敗: 投げて再送させる', r instanceof Error, String(r));
    historyError = Object.assign(new Error('Backend Error'), { code: 503, status: 503 });
    r = await handle(pubsubData({ historyId: '406' }));
    check('history.list の 503: 投げて再送させる', r instanceof Error, String(r));
    const handleLogs = allLines.filter((l) => l.args[0] === 'Failed to handle Gmail Pub/Sub');
    check(
      '取込の失敗のログは固定文＋エラーの種類だけ（エラーの文言を出さない）',
      handleLogs.length > 0 &&
        handleLogs.every((l) => l.args.length === 2 && !/UNAVAILABLE|Service Unavailable|Backend Error|token not found/.test(JSON.stringify(l.args))),
      JSON.stringify(handleLogs.slice(0, 3))
    );

    // (j) 名前・値の無いヘッダー、payload の無いメールでも投げない（その 1 通で取込が止まらない）
    const oddHeaders = 'msg-odd-headers';
    const noPayload = 'msg-no-payload';
    const noBody = 'msg-no-body';
    messageGetData[oddHeaders] = {
      payload: {
        headers: [{ name: null, value: 'x' }, { name: 'From', value: null }, { value: 'y' }, { name: 'From', value: 'statement@vpass.ne.jp' }],
        body: { data: b64(mailBody) },
      },
    };
    messageGetData[noPayload] = {};
    messageGetData[noBody] = { payload: { headers: [{ name: null, value: null }] } };
    try {
      for (const [label, id, saves] of [
        ['名前・値の無いヘッダーがある（残りの From で判定する）', oddHeaders, 1],
        ['payload が無い', noPayload, 0],
        ['本文が無く、ヘッダーの名前・値も無い', noBody, 0],
      ]) {
        historyMessageIds = [id];
        before = counts();
        historyBefore = historyUpdates.length;
        writesBefore = failureWrites.length;
        r = await pubsubOnce();
        check(
          `${label}: 投げずに historyId を進め、失敗として数えない`,
          r === 'ok' && historyUpdates.length === historyBefore + 1 && failureWrites.length === writesBefore,
          String(r)
        );
        check(`${label}: 保存は ${saves} 件`, gmailSaved.length === before.saved + saves, String(gmailSaved.length - before.saved));
      }
    } finally {
      delete messageGetData[oddHeaders];
      delete messageGetData[noPayload];
      delete messageGetData[noBody];
      historyMessageIds = ['msg-pubsub'];
    }

    // (k) 保存する historyId は常にメールボックスの現在位置（#298。通知の historyId は使わない。偽の通知で保存値を動かさない）
    console.log('\n[保存する historyId はメールボックスの現在位置（通知の値は使わない）]');
    {
      const { mailboxHistoryIdToSave } = gmailWatch;
      /** detail を JSON で出す（失敗したときに読めるように） */
      const checkJson = (name, cond, detail) => check(name, cond, detail === undefined ? undefined : JSON.stringify(detail));
      const FORGED = '18446744073709551615';
      const PADDED = '0'.repeat(100000) + '1005';
      checkJson(
        'mailboxHistoryIdToSave: 10 進の正規の形の文字列はそのまま返す',
        ['0', '1000', FORGED].every((v) => mailboxHistoryIdToSave(v) === v),
        ['0', '1000', FORGED].map((v) => mailboxHistoryIdToSave(v))
      );
      checkJson(
        'mailboxHistoryIdToSave: 数値の現在位置は 10 進の文字列にする',
        mailboxHistoryIdToSave(1000) === '1000' && mailboxHistoryIdToSave(0) === '0',
        [mailboxHistoryIdToSave(1000), mailboxHistoryIdToSave(0)]
      );
      const unusableMailbox = [undefined, null, '', 'abc', '-1', -1, 1.5, '00', '01010', PADDED, '18446744073709551616', '100000000000000000000', 1e20];
      checkJson(
        'mailboxHistoryIdToSave: 無い・数値として読めない・先頭ゼロ・uint64 超 → null（進めない）',
        unusableMailbox.every((m) => mailboxHistoryIdToSave(m) === null),
        unusableMailbox.map((m) => [String(m).slice(0, 24), mailboxHistoryIdToSave(m)])
      );

      // 先頭ゼロ・桁あふれの historyId（BigInt では小さい数と同じになり、大小の比較をすり抜けて長い文字列のまま保存されうる）
      const { isUsableHistoryId, resolveWatchHistoryId } = gmailWatch;
      const usable = ['0', '1005', '10000000000000000000', '18446744073709551615', 0, 1005];
      const notUsable = ['00', '01005', PADDED, '18446744073709551616', '99999999999999999999', '100000000000000000000', 1e20, -1, 1.5];
      checkJson('isUsableHistoryId: 10 進の正規の形で uint64 以下の値は使える（数値も）', usable.every((v) => isUsableHistoryId(v) === true), usable.map((v) => isUsableHistoryId(v)));
      checkJson(
        'isUsableHistoryId: 先頭ゼロ・"00"・uint64 超・21 桁以上は使えない',
        notUsable.every((v) => isUsableHistoryId(v) === false),
        notUsable.map((v) => [String(v).slice(0, 24), isUsableHistoryId(v)])
      );
      const replaced = resolveWatchHistoryId('0001000', '500');
      checkJson('resolveWatchHistoryId: 先頭ゼロで保存された値は watch の更新で応答の値に置き換える（replaced）', replaced.historyId === '500' && replaced.source === 'replaced', replaced);

      const MISSING_WARN = 'Gmail did not return the mailbox historyId; keeping the saved historyId (the range is processed again on the next notification)';
      const missingWarnsSince = (start) => warnsSince(start).filter((args) => args[0] === MISSING_WARN);
      const lastUpdate = () => historyUpdates[historyUpdates.length - 1];
      const logSince = (start, text) => allLines.slice(start).find((l) => l.args[0] === text);
      const notFound = () => Object.assign(new Error('Requested entity was not found.'), { code: 404 });

      // 正当な通知: 通知の値（501）ではなく、応答の現在位置まで進め、警告を出さない。history.list が成功したら getProfile は呼ばない
      from = allLines.length;
      historyBefore = historyUpdates.length;
      let profileBefore = profileCalls;
      r = await handle(pubsubData({ emailAddress: 'someone@example.com', historyId: '501' }));
      checkJson(
        '正当な通知（通知 501 < 現在位置）: 現在位置（1000000）を保存し、通知の値は保存しない・警告を出さない',
        r === 'ok' && historyUpdates.length === historyBefore + 1 && lastUpdate() === MAILBOX_HISTORY_ID && warnsSince(from).length === 0,
        { r: String(r), last: lastUpdate(), warns: warnsSince(from) }
      );
      checkJson('history.list が成功したときは getProfile を呼ばない（API の呼び出しを増やさない）', profileCalls === profileBefore, profileCalls - profileBefore);

      // 数値の通知（Gmail の形）: 保存するのは応答の現在位置の文字列（#295 までは通知の数値をそのまま保存していた）
      mailboxHistoryId = '600';
      r = await handle(pubsubData({ emailAddress: 'someone@example.com', historyId: 600 }));
      checkJson(
        '現在位置と同じ値の数値の通知: 現在位置を文字列（"600"）で保存する（数値の型は保たない）',
        r === 'ok' && lastUpdate() === '600' && typeof lastUpdate() === 'string',
        { r: String(r), last: lastUpdate() }
      );

      // 偽の通知（連携中のアドレスを書けば照合は通る）: 通知の値がどれでも、保存するのは現在位置（保存値 100 < 現在位置 600）。
      // メールの処理は続ける（範囲は保存値から処理するので、通知の値で処理の範囲も変わらない）
      for (const [label, historyId] of [
        ['極端に大きい（uint64 の最大）', FORGED],
        ['現在位置より大きい', '601'],
        ['保存値と現在位置の間', '300'],
        ['保存値と同じ', '100'],
        ['保存値より小さい', '1'],
        ['ゼロ（文字列）', '0'],
        ['ゼロ（数値）', 0],
      ]) {
        before = counts();
        from = allLines.length;
        historyBefore = historyUpdates.length;
        r = await handle(pubsubData({ emailAddress: 'someone@example.com', historyId }));
        checkJson(
          `偽の通知（${label}）: 現在位置（"600"）を保存する`,
          r === 'ok' && JSON.stringify(historyUpdates.slice(historyBefore)) === JSON.stringify(['600']),
          { r: String(r), updates: historyUpdates.slice(historyBefore) }
        );
        checkJson(
          `偽の通知（${label}）: メールの処理は続け（保存して送る）、警告を出さない`,
          gmailSaved.length === before.saved + 1 && gmailCards.length === before.cards + 1 && warnsSince(from).length === 0,
          { counts: counts(), warns: warnsSince(from) }
        );
        const processedLog = logSince(from, 'Processed Gmail messages; updated historyId');
        checkJson(
          `偽の通知（${label}）: 更新のログには保存した値（現在位置）を出す`,
          processedLog && processedLog.args[1].historyId === '600',
          processedLog && processedLog.args
        );
      }

      // 先頭ゼロ・桁あふれの historyId の通知: 読めない通知として捨てる（Gmail を呼ばず、保存もせず、値をログに出さない）
      mailboxHistoryId = '1010';
      const DROP = 'Gmail Pub/Sub message has no usable historyId; dropping it (retrying does not help)';
      for (const [label, historyId] of [
        ['長いゼロ埋め（"0"×100000 + "1005"）', PADDED],
        ['先頭ゼロ（"01005"）', '01005'],
        ['"00"', '00'],
        ['21 桁', '100000000000000000000'],
        ['uint64 を超える 20 桁', '18446744073709551616'],
        ['uint64 を超える数値', 1e20],
      ]) {
        from = allLines.length;
        historyBefore = historyUpdates.length;
        const callsBefore = gmailClientCalls;
        r = await handle(pubsubData({ emailAddress: 'someone@example.com', historyId }));
        const warns = warnsSince(from);
        checkJson(
          `通知の historyId が${label}: 投げずに捨て、Gmail を呼ばず historyId も進めない`,
          r === 'ok' && gmailClientCalls === callsBefore && historyUpdates.length === historyBefore,
          { r: String(r), calls: gmailClientCalls - callsBefore, updates: historyUpdates.slice(historyBefore).map((v) => String(v).slice(0, 24)) }
        );
        checkJson(
          `通知の historyId が${label}: ログは固定文の警告 1 行だけで、値を出さない`,
          JSON.stringify(warns) === JSON.stringify([[DROP]]) && JSON.stringify(allLines.slice(from).map((l) => l.args)) === JSON.stringify([[DROP]]),
          allLines.slice(from).map((l) => JSON.stringify(l.args).slice(0, 120))
        );
      }
      mailboxHistoryId = MAILBOX_HISTORY_ID;

      // 応答に historyId が無い: 進めずに終える（範囲は次の通知でもう一度処理される）
      mailboxHistoryId = undefined;
      from = allLines.length;
      historyBefore = historyUpdates.length;
      r = await handle(pubsubData({ emailAddress: 'someone@example.com', historyId: '650' }));
      checkJson('応答に historyId が無い: 投げずに終え、historyId を進めない（通知の値でも進めない）', r === 'ok' && historyUpdates.length === historyBefore, String(r));
      let warns = missingWarnsSince(from);
      checkJson(
        '応答に historyId が無い: 固定文の警告を 1 回だけ出す（source だけ）',
        JSON.stringify(warns) === JSON.stringify([[MISSING_WARN, { source: 'history.list' }]]),
        warns
      );
      checkJson('応答に historyId が無い: 更新のログを出さない', !logSince(from, 'Processed Gmail messages; updated historyId'));
      // 同じ実行で諦めたメールがあっても、範囲はもう一度処理されるので印を消さない（進めたときだけ消す）
      cardSendErrors.push(serverError());
      priorFailures = { 'msg-pubsub': { attempts: 2, firstFailedAt: firstFailed7h } };
      try {
        r = await handle(pubsubData({ historyId: '651' }));
      } finally {
        priorFailures = {};
        mailboxHistoryId = MAILBOX_HISTORY_ID;
      }
      checkJson(
        '応答に historyId が無い・諦めたメールがある: 投げず、進めず、諦めたメールの印を消さない',
        r === 'ok' && historyUpdates.length === historyBefore && systemDocs.has(noticeId),
        { r: String(r), docs: [...systemDocs.keys()] }
      );
      systemDocs.delete(noticeId);

      // 複数ページ: 最後のページ（nextPageToken の無い応答）の historyId を保存する（前のページの値も通知の値も使わない）
      try {
        historyPages = [{ ids: ['msg-pubsub'], historyId: '700' }, { ids: [], historyId: '800' }];
        r = await handle(pubsubData({ historyId: '900' }));
        checkJson('複数ページ・通知 900 > 最後のページ: 最後のページの historyId（800）を保存する', r === 'ok' && lastUpdate() === '800', { r: String(r), last: lastUpdate() });
        r = await handle(pubsubData({ historyId: '750' }));
        checkJson('複数ページ・通知 750 < 最後のページ: 通知の値ではなく、最後のページの historyId（800）を保存する', r === 'ok' && lastUpdate() === '800', { r: String(r), last: lastUpdate() });
        historyPages = [{ ids: ['msg-pubsub'], historyId: '700' }, { ids: [] }];
        historyBefore = historyUpdates.length;
        r = await handle(pubsubData({ historyId: '760' }));
        checkJson('最後のページに historyId が無い: 前のページの値は使わず、進めない', r === 'ok' && historyUpdates.length === historyBefore, { r: String(r), updates: historyUpdates.slice(historyBefore) });
      } finally {
        historyPages = null;
      }

      // history.list が 404（開始位置が古すぎる）: getProfile の historyId（現在位置）を保存する
      historyError = notFound();
      from = allLines.length;
      profileBefore = profileCalls;
      r = await handle(pubsubData({ historyId: '801' }));
      checkJson(
        '404・正当な通知: getProfile を 1 回呼び、getProfile の現在位置（1000000）を保存する（通知の値 801 ではない。警告なし）',
        r === 'ok' && profileCalls === profileBefore + 1 && lastUpdate() === MAILBOX_HISTORY_ID && missingWarnsSince(from).length === 0,
        { r: String(r), profileCalls: profileCalls - profileBefore, last: lastUpdate(), warns: missingWarnsSince(from) }
      );
      profileHistoryId = '900';
      historyError = notFound();
      from = allLines.length;
      r = await handle(pubsubData({ emailAddress: 'someone@example.com', historyId: FORGED }));
      checkJson('404・偽の大きい通知: getProfile の現在位置（900）を保存する', r === 'ok' && lastUpdate() === '900', { r: String(r), last: lastUpdate() });
      checkJson('404・偽の大きい通知: 警告を出さない（現在位置は取れた）', missingWarnsSince(from).length === 0, missingWarnsSince(from));
      const skipLog = logSince(from, 'Gmail historyId is too old (Gmail keeps ~1 week); skipping ahead, and mail in between is NOT imported');
      checkJson(
        '404: 先へ飛ばしたログは固定文と桁数だけで、保存値（100）・現在位置（900）・通知の値を出さない',
        skipLog && JSON.stringify(skipLog.args[1]) === JSON.stringify({ fromDigits: 3, toDigits: 3 }) && !/100|900|18446744073709551615/.test(JSON.stringify(skipLog.args)),
        skipLog && skipLog.args
      );
      profileHistoryId = 950;
      historyError = notFound();
      r = await handle(pubsubData({ historyId: '1' }));
      checkJson('404・getProfile の historyId が数値: 10 進の文字列（"950"）で保存する', r === 'ok' && lastUpdate() === '950', { r: String(r), last: lastUpdate() });
      profileHistoryId = MAILBOX_HISTORY_ID;

      // 404・getProfile に historyId が無い / getProfile が失敗: 進めず、飛ばしたメールの印も消さない
      seedNotice(1 * HOUR);
      systemDocs.set('gmailFailures', { 'msg-pubsub': { attempts: 1 } });
      try {
        profileHistoryId = undefined;
        historyError = notFound();
        from = allLines.length;
        historyBefore = historyUpdates.length;
        r = await handle(pubsubData({ historyId: '901' }));
        checkJson(
          '404・getProfile に historyId が無い: 投げずに終え、進めず（通知の値でも進めない）、印も消さない',
          r === 'ok' && historyUpdates.length === historyBefore && systemDocs.has(noticeId),
          { r: String(r), docs: [...systemDocs.keys()] }
        );
        warns = missingWarnsSince(from);
        checkJson('404・getProfile に historyId が無い: 固定文の警告を 1 回だけ出す（source: getProfile）', JSON.stringify(warns) === JSON.stringify([[MISSING_WARN, { source: 'getProfile' }]]), warns);

        profileHistoryId = MAILBOX_HISTORY_ID;
        profileError = Object.assign(new Error('Backend Error'), { code: 503, status: 503 });
        historyError = notFound();
        r = await handle(pubsubData({ historyId: '902' }));
        checkJson(
          '404・getProfile が失敗: 投げて再送させ、進めず、印も消さない',
          r instanceof Error && historyUpdates.length === historyBefore && systemDocs.has(noticeId),
          { r: String(r), docs: [...systemDocs.keys()] }
        );
      } finally {
        profileHistoryId = MAILBOX_HISTORY_ID;
        profileError = null;
        historyError = null;
        systemDocs.delete(noticeId);
        systemDocs.delete('gmailFailures');
      }
    }

    // 古いログ行（書式文字列で ID を埋めていたもの）も含め、Pub/Sub の取込のログ全体に messageId・メールアドレスを出さない
    const rawIds = ['msg-pubsub', idA, idB, gone, oddHeaders, noPayload, noBody, 'someone@example.com'];
    const leaked = allLines.filter((l) => rawIds.some((id) => JSON.stringify(l.args).includes(id)));
    check('Pub/Sub の取込のログ全体に、messageId とメールアドレスをそのまま出さない', leaked.length === 0, JSON.stringify(leaked.slice(0, 3)));
    const savedLogs = allLines.filter((l) => l.args[0] === 'Expense saved from Gmail');
    check(
      '保存のログは固定文で、支出の ID を伏せる（maskId）',
      savedLogs.length > 0 && savedLogs.every((l) => l.args.length === 2 && !/exp_gmail_/.test(JSON.stringify(l.args))),
      JSON.stringify(savedLogs.slice(0, 2))
    );

    const noticeLogs = allLines.filter((l) => typeof l.args[0] === 'string' && /card notice/i.test(l.args[0]));
    check(
      '印のログは固定文で、messageId をそのまま出さない（maskId）',
      noticeLogs.length > 0 && noticeLogs.every((l) => ['msg-pubsub', idA, idB].every((id) => !JSON.stringify(l.args).includes(id))),
      JSON.stringify(noticeLogs.slice(0, 3))
    );
    check(
      '諦めた・飛ばしたメールの印を消したら警告を出す',
      // 諦めた (e)・(e2) と、飛ばした (g) の 3 回
      noticeLogs.filter((l) => l.level === 'warn' && l.args[0] === 'Gmail card notice discarded; the card was not delivered').length === 3,
      JSON.stringify(noticeLogs.filter((l) => l.level === 'warn'))
    );
  }

  // --- ログ ---
  const logs = subLogs(allLines);
  check(
    '中項目のログは { source, subCategory } だけで、説明・店名・ID を出さない',
    logs.length > 0 &&
      logs.every((l) => l.args.length === 2 && sameJson(Object.keys(l.args[1]), ['source', 'subCategory'])) &&
      !['ランチ', 'ラーメン', 'カラオケ', 'テスト食堂', 'U_sub_', 'msg-'].some((s) => JSON.stringify(logs).includes(s)),
    JSON.stringify(logs)
  );
}

saveFlowChecks()
  .catch((error) => {
    failed++;
    console.log(`  FAIL 保存データの確かめで例外 — ${error && error.stack}`);
  })
  .then(() => webNormalizationChecks())
  .catch((error) => {
    failed++;
    console.log(`  FAIL Web の正規化との突き合わせで例外 — ${error && error.stack}`);
  })
  .finally(() => {
    console.log(failed === 0 ? '\nすべて通過' : `\n${failed} 件失敗`);
    process.exit(failed === 0 ? 0 : 1);
  });
