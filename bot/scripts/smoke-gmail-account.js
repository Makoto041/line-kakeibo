/**
 * Gmail の Pub/Sub 通知の emailAddress を、連携中のアカウントと照合するスモークテスト（#280。Firestore・Gmail には接続しない）
 *
 * - normalizeEmailAddress / emailAddressOfPubSubData / notificationAccountOf: アドレスの正規化・通知からの取り出し・照合
 * - watchStateFields: watch の登録・更新で、連携中のアドレス（emailAddress）を書くこと（historyId の決め方には関係なく）
 * - handleGmailPubSub の流れ（Gmail・watch の状態・historyId の更新は偽物）:
 *   一致 → 処理 / 不一致・通知にアドレスが無い → history.list を呼ばず historyId を更新しない（投げない）/
 *   アドレスが保存されていない → 照合せず以前どおり処理 / 大文字小文字の違い → 一致 / watch の状態の読み取りの失敗 → 投げる
 * - registerWatch（Gmail と Firestore は偽物）: getProfile のアドレスを保存する・watch の後に呼ぶ・失敗したら投げる・
 *   応答にアドレスが無ければ保存してある値を変えない・別のアカウントなら固定文で警告する
 *
 * どのログにもメールアドレスを出さないことも確かめる。Firestore を使う確認は emulator-gmail-import.js。
 *
 *   node bot/scripts/smoke-gmail-account.js
 */
const path = require('path');
const gmailAuth = require('../dist/gmail/auth');
const gmailWatch = require('../dist/gmail/watch');
const adminFirestore = require(require.resolve('firebase-admin/firestore', { paths: [path.join(__dirname, '..')] }));
const { handleGmailPubSub, emailAddressOfPubSubData, notificationAccountOf } = require('../dist/gmail/handler');

const { normalizeEmailAddress, watchStateFields, resolveWatchHistoryId } = gmailWatch;

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

async function captureConsole(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  for (const level of Object.keys(original)) {
    console[level] = (...args) => lines.push({ level, args });
  }
  try {
    let result;
    try {
      result = await fn();
    } catch (error) {
      result = error;
    }
    return { result, lines };
  } finally {
    Object.assign(console, original);
  }
}

const b64 = (text) => Buffer.from(text, 'utf-8').toString('base64');
const pubsubData = (payload) => b64(JSON.stringify(payload));
/** ログの引数にメールアドレス（@ を含む文字列）が出ていない */
const noAddressInLogs = (lines) => !lines.some((l) => JSON.stringify(l.args).includes('@'));

console.log('\n[normalizeEmailAddress]');
check('小文字にして前後の空白を落とす', normalizeEmailAddress('  Linked.User@Example.COM \n') === 'linked.user@example.com');
check('空・空白だけ → null', normalizeEmailAddress('') === null && normalizeEmailAddress('   ') === null);
check(
  '文字列でない → null',
  [undefined, null, 1, {}, ['a@example.com']].every((v) => normalizeEmailAddress(v) === null)
);

console.log('\n[emailAddressOfPubSubData（通知の本文から emailAddress を取り出す）]');
check('Gmail の形（emailAddress と数値の historyId）→ 小文字で返す', emailAddressOfPubSubData(pubsubData({ emailAddress: 'User@Example.com', historyId: 1 })) === 'user@example.com');
check('emailAddress が無い → null', emailAddressOfPubSubData(pubsubData({ historyId: 1 })) === null);
check('emailAddress が文字列でない・空 → null', [1, null, {}, ''].every((v) => emailAddressOfPubSubData(pubsubData({ emailAddress: v, historyId: 1 })) === null));
check('JSON でない・オブジェクトでない・本文が文字列でない → null', [b64('{x'), b64('null'), b64('"a@example.com"'), undefined, 1].every((d) => emailAddressOfPubSubData(d) === null));

console.log('\n[notificationAccountOf（通知のアカウントと連携中のアカウントの照合）]');
check('同じアドレス → match', notificationAccountOf('linked@example.com', 'linked@example.com') === 'match');
check('大文字小文字・前後の空白の違い → match', notificationAccountOf('LINKED@example.com', ' Linked@Example.com ') === 'match');
check('違うアドレス → mismatch', notificationAccountOf('old@example.com', 'new@example.com') === 'mismatch');
check('通知にアドレスが無い（確かめられない）→ mismatch', notificationAccountOf(null, 'linked@example.com') === 'mismatch');
check(
  '連携中のアドレスが保存されていない（この照合の前に登録した watch）→ unchecked',
  [undefined, null, '', 1].every((linked) => notificationAccountOf('a@example.com', linked) === 'unchecked') &&
    notificationAccountOf(null, undefined) === 'unchecked'
);

console.log('\n[watchStateFields（連携中のアドレスを書く）]');
const NOW = { marker: 'now' };
const EXP = 1793577600000;
let f = watchStateFields(resolveWatchHistoryId('100', '500'), EXP, NOW, 'linked@example.com');
check(
  '残すとき（kept）: historyId は書かず、emailAddress は書く',
  !('historyId' in f) && f.emailAddress === 'linked@example.com' && Object.keys(f).sort().join(',') === 'emailAddress,updatedAt,watchExpiration',
  f
);
f = watchStateFields(resolveWatchHistoryId(undefined, '500'), EXP, NOW, 'linked@example.com');
check('保存値なし（initialized）: historyId と emailAddress を書く', f.historyId === '500' && f.emailAddress === 'linked@example.com', f);
f = watchStateFields(resolveWatchHistoryId('abc', '500'), EXP, NOW, 'linked@example.com');
check('使えない保存値（replaced）: historyId と emailAddress を書く', f.historyId === '500' && f.emailAddress === 'linked@example.com', f);
f = watchStateFields(resolveWatchHistoryId('100', '500'), EXP, NOW);
check('アドレスを渡さないとき: emailAddress の項目を含めない（保存してある値を変えない）', !('emailAddress' in f), f);

async function flowChecks() {
  console.log('\n[handleGmailPubSub（Gmail・watch の状態・historyId の更新は偽物）]');
  let watchState = null;
  let watchStateError = null;
  const historyUpdates = [];
  let historyListCalls = 0;
  let messageGetCalls = 0;
  let gmailClientCalls = 0;
  gmailWatch.getWatchState = async () => {
    if (watchStateError) throw watchStateError;
    return watchState;
  };
  gmailWatch.updateHistoryId = async (historyId) => {
    historyUpdates.push(historyId);
  };
  gmailAuth.getGmailClient = async () => {
    gmailClientCalls++;
    return {
      users: {
        history: {
          list: async () => {
            historyListCalls++;
            return { data: { history: [] } };
          },
        },
        messages: {
          get: async () => {
            messageGetCalls++;
            throw new Error('not expected');
          },
        },
      },
    };
  };
  const reset = (state) => {
    watchState = state;
    watchStateError = null;
    historyUpdates.length = 0;
    historyListCalls = 0;
    messageGetCalls = 0;
    gmailClientCalls = 0;
  };
  const stored = (emailAddress) => ({ historyId: '100', watchExpiration: Date.now() + 86400000, ...(emailAddress === undefined ? {} : { emailAddress }) });

  // 一致 → 処理する
  reset(stored('linked@example.com'));
  let { result, lines } = await captureConsole(() => handleGmailPubSub(pubsubData({ emailAddress: 'linked@example.com', historyId: 200 })));
  check(
    '一致: history.list を引き、通知の historyId まで進める',
    result === undefined && historyListCalls === 1 && JSON.stringify(historyUpdates) === JSON.stringify([200]),
    { result: String(result), historyListCalls, historyUpdates }
  );
  check('一致: 照合の警告を出さない', !lines.some((l) => l.level === 'warn'), lines);

  // 不一致（切り替える前のアカウントの watch の通知。historyId は別のメールボックスの大きな値）→ 読み飛ばす
  reset(stored('new@example.com'));
  ({ result, lines } = await captureConsole(() => handleGmailPubSub(pubsubData({ emailAddress: 'old@example.com', historyId: '999999999' }))));
  check('不一致: 投げない（再送させない＝ack）', result === undefined, String(result));
  check(
    '不一致: Gmail の API（history.list・messages.get）を呼ばない（getGmailClient は照合の前に呼ぶ）',
    historyListCalls === 0 && messageGetCalls === 0 && gmailClientCalls === 1,
    { historyListCalls, messageGetCalls, gmailClientCalls }
  );
  check('不一致: historyId を更新しない', historyUpdates.length === 0, historyUpdates);
  const mismatchWarns = lines.filter((l) => l.level === 'warn');
  check(
    '不一致: 固定文の警告を 1 回だけ出す（引数は文だけ）',
    mismatchWarns.length === 1 &&
      mismatchWarns[0].args.length === 1 &&
      mismatchWarns[0].args[0] === 'Gmail Pub/Sub notification is not for the linked account; dropping it without updating historyId',
    mismatchWarns
  );
  check('不一致: どのログにもメールアドレスを出さない', noAddressInLogs(lines), lines);

  // 通知にアドレスが無い（確かめられない）→ 読み飛ばす
  reset(stored('linked@example.com'));
  ({ result } = await captureConsole(() => handleGmailPubSub(pubsubData({ historyId: '300' }))));
  check(
    '通知にアドレスが無い（連携中のアドレスは保存済み）: 投げず、history.list を呼ばず、historyId を更新しない',
    result === undefined && historyListCalls === 0 && historyUpdates.length === 0,
    { result: String(result), historyListCalls, historyUpdates }
  );

  // アドレスが保存されていない（この照合を入れる前に登録した watch）→ 照合せず以前どおり処理する
  reset(stored(undefined));
  ({ result, lines } = await captureConsole(() => handleGmailPubSub(pubsubData({ emailAddress: 'someone@example.com', historyId: '400' }))));
  check(
    'アドレスが保存されていない: 以前どおり history.list を引き、historyId を進める（取込を止めない）',
    result === undefined && historyListCalls === 1 && JSON.stringify(historyUpdates) === JSON.stringify(['400']),
    { result: String(result), historyListCalls, historyUpdates }
  );
  const uncheckedLogs = lines.filter((l) => l.args[0] === 'Linked Gmail address is not saved yet; skipping the account check (saved on the next watch registration)');
  check(
    'アドレスが保存されていない: 照合を飛ばしたことを固定文で出し（警告ではない）、アドレスは出さない',
    uncheckedLogs.length === 1 && uncheckedLogs[0].level === 'log' && uncheckedLogs[0].args.length === 1 && noAddressInLogs(lines),
    lines
  );
  reset(stored(undefined));
  await captureConsole(() => handleGmailPubSub(pubsubData({ historyId: '401' })));
  check(
    'アドレスが保存されていない・通知にも無い: 以前どおり処理する',
    historyListCalls === 1 && JSON.stringify(historyUpdates) === JSON.stringify(['401']),
    { historyListCalls, historyUpdates }
  );

  // 大文字小文字の違い → 一致
  reset(stored('linked@example.com'));
  ({ result } = await captureConsole(() => handleGmailPubSub(pubsubData({ emailAddress: 'Linked@Example.COM', historyId: '500' }))));
  check(
    '大文字小文字の違い: 同じアカウントとして処理する',
    result === undefined && historyListCalls === 1 && JSON.stringify(historyUpdates) === JSON.stringify(['500']),
    { result: String(result), historyListCalls, historyUpdates }
  );

  // 連携中のアドレスの取得（watch の状態の読み取り）の一時的な失敗 → 投げて再送させる
  reset(stored('linked@example.com'));
  watchStateError = Object.assign(new Error('14 UNAVAILABLE'), { code: 14 });
  ({ result, lines } = await captureConsole(() => handleGmailPubSub(pubsubData({ emailAddress: 'linked@example.com', historyId: '600' }))));
  check(
    '連携中のアドレスを読めない（Firestore の一時的な失敗）: 投げて Pub/Sub に再送させ、historyId を更新しない',
    result instanceof Error && historyListCalls === 0 && historyUpdates.length === 0,
    { result: String(result), historyListCalls, historyUpdates }
  );
  check('読めないときもログにアドレスを出さない', noAddressInLogs(lines), lines);
}

async function registerWatchChecks() {
  console.log('\n[registerWatch（Gmail と Firestore は偽物）]');
  const calls = [];
  let profileReply = { data: { emailAddress: 'Linked@Example.com' } };
  let profileError = null;
  gmailAuth.getGmailClient = async () => ({
    users: {
      watch: async () => {
        calls.push('watch');
        return { data: { historyId: '500', expiration: String(Date.UTC(2026, 10, 2)) } };
      },
      getProfile: async (params) => {
        calls.push(`getProfile:${params && params.userId}`);
        if (profileError) throw profileError;
        return profileReply;
      },
    },
  });
  let storedDoc = undefined;
  const writes = [];
  adminFirestore.getFirestore = () => ({
    collection: () => ({ doc: (id) => ({ id }) }),
    runTransaction: async (fn) =>
      fn({
        get: async () => ({ exists: storedDoc !== undefined, data: () => storedDoc }),
        set: (ref, data, options) => {
          writes.push({ id: ref.id, data, options });
        },
      }),
  });
  const reset = (doc) => {
    storedDoc = doc;
    writes.length = 0;
    calls.length = 0;
    profileReply = { data: { emailAddress: 'Linked@Example.com' } };
    profileError = null;
  };

  reset({ historyId: '100' });
  let { result, lines } = await captureConsole(() => gmailWatch.registerWatch());
  const w = writes[0];
  check('watch の後に getProfile（userId: me）を呼ぶ', JSON.stringify(calls) === JSON.stringify(['watch', 'getProfile:me']), calls);
  check(
    'getProfile のアドレスを小文字で gmailState に merge で書き、historyId は残す（#278）',
    writes.length === 1 && w.id === 'gmailState' && w.data.emailAddress === 'linked@example.com' && !('historyId' in w.data) && w.options && w.options.merge === true,
    writes
  );
  check('戻り値にアドレスを含めない（/gmail/register-watch の応答に出さない）', result && !('emailAddress' in result) && result.historyId === '100', result);
  check('ログにアドレスを出さない', noAddressInLogs(lines), lines);

  reset(undefined);
  ({ result } = await captureConsole(() => gmailWatch.registerWatch()));
  check(
    '保存値が無い（初回・revoke の後）: 応答の historyId とアドレスを書く',
    writes.length === 1 && writes[0].data.historyId === '500' && writes[0].data.emailAddress === 'linked@example.com',
    writes
  );

  reset({ historyId: '100', emailAddress: 'linked@example.com' });
  profileError = Object.assign(new Error('Backend Error'), { code: 503, status: 503 });
  ({ result } = await captureConsole(() => gmailWatch.registerWatch()));
  check(
    'getProfile が失敗: 投げる（watch は呼んだ後）・gmailState に書かない',
    result instanceof Error && JSON.stringify(calls) === JSON.stringify(['watch', 'getProfile:me']) && writes.length === 0,
    { result: String(result), calls, writes }
  );

  reset({ historyId: '100', emailAddress: 'linked@example.com' });
  profileReply = { data: {} };
  ({ result, lines } = await captureConsole(() => gmailWatch.registerWatch()));
  check(
    'getProfile の応答にアドレスが無い: 投げず、emailAddress を書かない（保存してある値を変えない）',
    !(result instanceof Error) && writes.length === 1 && !('emailAddress' in writes[0].data) && writes[0].data.watchExpiration > 0,
    { result: String(result), writes }
  );
  check(
    'getProfile の応答にアドレスが無い: 固定文の警告を出す',
    lines.some((l) => l.level === 'warn' && l.args.length === 1 && /Gmail profile has no email address/.test(l.args[0])),
    lines
  );

  reset({ historyId: '100', emailAddress: 'old@example.com' });
  profileReply = { data: { emailAddress: 'new@example.com' } };
  ({ result, lines } = await captureConsole(() => gmailWatch.registerWatch()));
  const changed = lines.filter((l) => l.level === 'warn' && /Gmail account differs from the saved one/.test(String(l.args[0])));
  check(
    '保存してあるアドレスと違うアカウント（revoke せずに認可し直した）: 新しいアドレスを書き、historyId は残す',
    writes.length === 1 && writes[0].data.emailAddress === 'new@example.com' && !('historyId' in writes[0].data),
    writes
  );
  check('そのとき固定文の警告を 1 回出し、アドレスは出さない', changed.length === 1 && changed[0].args.length === 1 && noAddressInLogs(lines), lines);

  reset({ historyId: '100', emailAddress: 'linked@example.com' });
  profileReply = { data: { emailAddress: 'LINKED@example.com' } };
  ({ lines } = await captureConsole(() => gmailWatch.registerWatch()));
  check('同じアカウント（大文字小文字だけ違う）: 警告を出さない', !lines.some((l) => l.level === 'warn'), lines);
}

flowChecks()
  .then(registerWatchChecks)
  .catch((error) => {
    failed++;
    console.log('  FAIL チェックが例外で止まった', error && error.name, error && error.message);
  })
  .then(() => {
    console.log(failed === 0 ? '\nすべて通過' : `\n${failed} 件失敗`);
    process.exit(failed === 0 ? 0 : 1);
  });
