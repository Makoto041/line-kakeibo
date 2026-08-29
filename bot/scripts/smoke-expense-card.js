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
} = require('../dist/line/flexMessage');

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
  check('現在の設定は3行', rows.length === 3, `got ${rows.length}`);
  check('各行にアイコンがある', rows.every((r) => r.contents[0].type === 'image'));
  check(
    '支出区分は未設定＋userアイコン',
    rowText(rows[0]) === '支出区分：未設定' && rows[0].contents[0].url.endsWith('/user.png'),
    rows[0].contents[0].url
  );
  check(
    '立替はwalletアイコン',
    rows[1].contents[0].url.endsWith('/wallet.png'),
    rows[1].contents[0].url
  );
  check(
    'カテゴリは食費アイコン',
    rowText(rows[2]) === 'カテゴリ：食費' && rows[2].contents[0].url.endsWith('/cat-food.png'),
    rows[2].contents[0].url
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
    status: 'pending',
    includeInTotal: true,
  });
  common('カード利用通知（Gmail）', msg);

  const rows = settingsRows(msg);
  check('現在の設定は3行', rows.length === 3, `got ${rows.length}`);
  check(
    '支出区分は共同費（未確認）＋usersアイコン',
    rowText(rows[0]) === '支出区分：共同費（未確認）' &&
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
  check('現在の設定は3行', rows.length === 3, `got ${rows.length}`);
  check('支出区分に[変更]が出ない', !rows[0].contents.some((c) => c.action));
  check('立替に[変更]が出ない', !rows[1].contents.some((c) => c.action));
  check('カテゴリは変更できる', rows[2].contents.some((c) => c.action));
  check(
    'paymentMethod の生値が漏れない',
    !JSON.stringify(msg).includes('unknown'),
  );
}

// ------------------------------------------- status ごとのアイコン・ラベル分岐
{
  console.log('\n[status ごとの支出区分アイコン]');
  const cases = [
    ['personal', '支出区分：個人費', '/user.png'],
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

  // 立替のラベル
  const settled = buildExpenseCardFromRecord('e', {
    category: '食費', status: 'advance_settled', inputSource: 'line_text',
  });
  check('advance_settled の立替は精算済み', rowText(settingsRows(settled)[1]) === '立替：精算済み');
  const pendingAdv = buildExpenseCardFromRecord('e', {
    category: '食費', status: 'advance_pending', inputSource: 'line_text',
  });
  check(
    'advance_pending の立替はあり（精算待ち）',
    rowText(settingsRows(pendingAdv)[1]) === '立替：あり（精算待ち）'
  );
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
    const url = settingsRows(msg)[2].contents[0].url;
    check(`${category} → ${key}`, url.endsWith(`/${key}.png`), url);
  }
}

console.log(failed === 0 ? '\nすべて通過' : `\n${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
