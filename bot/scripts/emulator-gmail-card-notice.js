/**
 * カード利用通知の送信待ちの印（gmail/cardNotice.ts）の統合テスト（Firestore エミュレータ）
 *
 * 保存のあと LINE への push が失敗した・止まったときに、同じメールの再処理（Pub/Sub の再送・/gmail/force-process）で
 * カードを送り直すこと、二重に送らないこと（X-Line-Retry-Key）、印の無い既存の支出には送らないことを確かめる。
 * あわせて、失敗の記録（system/gmailFailures）の firstFailedAt と諦める条件（試行 3 回以上 かつ 最初の失敗から 6 時間以上。
 * 再送で回数だけすぐ増えても諦めない）、消されたメール（messages.get の 404）を失敗として数えず読み飛ばすことも確かめる。
 *
 * Gmail・分類器・LINE は偽物に差し替える（dist の exports を書き換える。呼び出し側は呼ぶときに exports を参照する）。
 * 支出の保存・印・重複判定・historyId（system/gmailState）は本物のコードでエミュレータに書く。
 * 偽の LINE は、受け付けた X-Line-Retry-Key をもう一度受けると 409 を返す（LINE の動きに合わせる）。
 * emulator-household-api.js と同じ形で実行する（npm -w bot run test:emulator から続けて動く）。
 * 本番のプロジェクトには接続しない（demo-* 以外は即終了）。
 */
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-kakeibo';
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;

if (!firestoreHost) {
  console.error('FIRESTORE_EMULATOR_HOST が必要です（firebase emulators:exec から実行する）');
  process.exit(2);
}
if (!projectId.startsWith('demo-')) {
  console.error(`安全のため demo-* のプロジェクトでだけ実行します（現在: ${projectId}）`);
  process.exit(2);
}

if (getApps().length === 0) initializeApp({ projectId });

const gmailAuth = require('../dist/gmail/auth');
const classifier = require('../dist/geminiCategoryClassifier');
const lineClient = require('../dist/line/client');
const { handleGmailPubSub, forceProcessMessage } = require('../dist/gmail/handler');
const { cardNoticeRetryKey, CARD_NOTICE_MAX_AGE_MS } = require('../dist/gmail/cardNotice');

const LINE_GROUP = 'C_emulator_group';
process.env.LINE_GROUP_ID = LINE_GROUP;
process.env.DEFAULT_GROUP_ID = 'g1';

let failed = 0;
let passed = 0;
/** 直前の呼び出しで出たログ（失敗したときだけ出す） */
let lastLogs = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
    for (const line of lastLogs) console.log(`         | ${line}`);
  }
}

async function clearFirestore() {
  const res = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`failed to clear firestore (${res.status})`);
}

// --- 偽の Gmail（history.list は historyMessageIds を返し、messages.get は mails[id] を本文にする） ---
let historyMessageIds = [];
const mails = {};
const cardMail = (dateTime, merchant, amount) =>
  ['【ご利用のお知らせ】', `ご利用日時：${dateTime}`, `ご利用店名：${merchant}`, `ご利用金額：${amount}円`, '三井住友ゴールドＶＩＳＡ（ＮＬ）'].join('\n');
/** 次の history.list で投げる例外（historyId が古すぎる 404 など） */
let historyError = null;
/** messages.get が 404 を返す（届いたあとに消された）メール */
const missingMails = new Set();
gmailAuth.getGmailClient = async () => ({
  users: {
    history: {
      list: async () => {
        if (historyError) {
          const error = historyError;
          historyError = null;
          throw error;
        }
        return { data: { history: [{ messagesAdded: historyMessageIds.map((id) => ({ message: { id } })) }] } };
      },
    },
    messages: {
      get: async ({ id }) => {
        // 消されたメールは Gmail API が 404 を返す（gaxios 7 は JSON のエラーの code を error.code に入れる）
        if (missingMails.has(id)) throw Object.assign(new Error('Requested entity was not found.'), { code: 404 });
        return {
          data: {
            payload: {
              headers: [{ name: 'From', value: 'statement@vpass.ne.jp' }],
              body: { data: Buffer.from(mails[id], 'utf-8').toString('base64') },
            },
          },
        };
      },
    },
  },
});

// --- 偽の分類器（同時実行のテストでは、2 本がそろうまで待つ） ---
let barrier = null;
classifier.classifyExpense = async () => {
  if (barrier) await barrier.wait();
  return { category: '食費', confidence: 0.9, reasoning: 'emulator', provider: 'jev' };
};
function makeBarrier(n) {
  let release;
  const all = new Promise((resolve) => {
    release = resolve;
  });
  // そろわなくても止まらないように（そろったかは arrived で確かめる）
  const timer = setTimeout(() => release(), 5000);
  const state = {
    arrived: 0,
    wait: async () => {
      state.arrived++;
      if (state.arrived >= n) {
        clearTimeout(timer);
        release();
      }
      await all;
    },
  };
  return state;
}

// --- 偽の LINE ---
/** push の試行（失敗も含む）: { to, retryKey, messages } */
const pushes = [];
/** LINE が受け付けた X-Line-Retry-Key（= 届いたカード） */
const accepted = new Set();
/** 次の push だけの振る舞い。'fail': 500 で失敗 / 'acceptThenLose': LINE は受け付けたが応答が届かない */
let nextPush = null;
/** この回数だけ、続けて 500 で失敗する */
let failNextPushes = 0;
lineClient.getLineClient = () => ({
  pushMessage: async (request, retryKey) => {
    pushes.push({ to: request.to, retryKey, messages: request.messages });
    const mode = nextPush;
    nextPush = null;
    if (failNextPushes > 0) {
      failNextPushes--;
      throw Object.assign(new Error('LINE 500'), { status: 500 });
    }
    if (mode === 'fail') throw Object.assign(new Error('LINE 500'), { status: 500 });
    if (retryKey && accepted.has(retryKey)) throw Object.assign(new Error('LINE 409'), { status: 409 });
    if (retryKey) accepted.add(retryKey);
    if (mode === 'acceptThenLose') throw new Error('socket hang up');
    return {};
  },
});
const pushesFor = (messageId) => pushes.filter((p) => p.retryKey === cardNoticeRetryKey(messageId));

// --- 呼び出し（ログは溜めて、失敗したときだけ出す） ---
async function quiet(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  lastLogs = [];
  const capture = (level) => (...args) =>
    lastLogs.push(`${level} ${args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  console.log = capture('log');
  console.warn = capture('warn');
  console.error = capture('error');
  try {
    return await fn();
  } finally {
    Object.assign(console, original);
  }
}
let historySeq = 1000;
/** Pub/Sub の通知 1 回分（例外は返す） */
async function pubsub(ids) {
  historyMessageIds = ids;
  const data = Buffer.from(JSON.stringify({ historyId: String(++historySeq) })).toString('base64');
  try {
    await handleGmailPubSub(data);
    return 'ok';
  } catch (error) {
    return error;
  }
}

(async () => {
  const db = getFirestore();
  await clearFirestore();
  await db.doc('system/gmailState').set({ historyId: '1000', watchExpiration: Date.now() + 86400000 });

  const expensesOf = async (messageId) => (await db.collection('expenses').where('gmailMessageId', '==', messageId).get()).docs;
  const noticeOf = (messageId) => db.collection('system').doc(`gmailCardNotice_${messageId}`).get();
  const seedExpense = async (messageId, amount) => {
    const ref = db.collection('expenses').doc();
    await ref.set({
      lineId: 'gmail-auto-system',
      payerId: 'gmail-auto-system',
      amount,
      description: '既存の店',
      date: '2026-10-01',
      category: '食費',
      confirmed: true,
      includeInTotal: true,
      status: 'shared',
      inputSource: 'gmail_auto',
      gmailMessageId: messageId,
      groupId: 'g1',
      lineGroupId: LINE_GROUP,
      createdAt: Timestamp.now(),
    });
    return ref.id;
  };
  const seedNotice = (messageId, expenseId, createdAt) =>
    db.doc(`system/gmailCardNotice_${messageId}`).set({
      expenseId,
      lineGroupId: LINE_GROUP,
      card: { expenseId, merchant: '既存の店', amount: 500, category: '食費', categoryEmoji: '🍽️', date: '10/1', status: 'shared', includeInTotal: true },
      ...(createdAt ? { createdAt } : {}),
    });

  console.log('\n[正常: 保存して送り、印を消す]');
  {
    const id = 'msg-ok-0001';
    mails[id] = cardMail('2026/10/20 12:30', 'テスト食堂', 1100);
    const r = await quiet(() => pubsub([id]));
    const sent = pushesFor(id);
    const expenses = await expensesOf(id);
    check('処理は成功する', r === 'ok', String(r));
    check('LINE グループへ 1 回 push し、X-Line-Retry-Key はメッセージから決まる値', sent.length === 1 && sent[0].to === LINE_GROUP, sent.length);
    check('支出は 1 件', expenses.length === 1, expenses.length);
    check('送ったら印を消す', !(await noticeOf(id)).exists);
    check('カードは保存した支出（店名・金額・判定元）', sent[0] && sent[0].messages[0].altText.includes('¥1,100') && JSON.stringify(sent[0].messages).includes(expenses[0].id) && JSON.stringify(sent[0].messages).includes('Jev'), sent[0] && sent[0].messages[0].altText);

    const r2 = await quiet(() => pubsub([id]));
    check('もう一度処理しても送らず、支出も増えない', r2 === 'ok' && pushesFor(id).length === 1 && (await expensesOf(id)).length === 1);
  }

  console.log('\n[push の失敗: 支出と印が残り、再処理で同じ key で送り直す]');
  {
    const id = 'msg-fail-0002';
    mails[id] = cardMail('2026/10/20 18:05', '夕食の店', 2300);
    const historyBefore = (await db.doc('system/gmailState').get()).get('historyId');
    nextPush = 'fail';
    const r = await quiet(() => pubsub([id]));
    const expenses = await expensesOf(id);
    const notice = await noticeOf(id);
    check('処理は失敗として投げる（historyId を進めず再処理させる）', r instanceof Error, String(r));
    check('支出は保存済み（1 件）', expenses.length === 1, expenses.length);
    check(
      '印が残る（支出の ID・送り先・送るはずだったカード・作った時刻）',
      notice.exists &&
        notice.get('expenseId') === expenses[0].id &&
        notice.get('lineGroupId') === LINE_GROUP &&
        notice.get('card.merchant') === '夕食の店' &&
        notice.get('card.categoryOrigin') === 'jev' &&
        notice.get('card.expenseId') === expenses[0].id &&
        typeof notice.get('createdAt').toMillis === 'function',
      notice.data()
    );
    check(
      '印の expireAt（TTL）は createdAt + 24 時間',
      notice.exists && notice.get('expireAt').toMillis() - notice.get('createdAt').toMillis() === 24 * 60 * 60 * 1000,
      notice.data()
    );
    check('LINE には届いていない', !accepted.has(cardNoticeRetryKey(id)));
    const historyAfter = (await db.doc('system/gmailState').get()).get('historyId');
    check('historyId は進まない', historyAfter === historyBefore, { historyBefore, historyAfter });

    const r2 = await quiet(() => pubsub([id]));
    const sent = pushesFor(id);
    check('再処理は成功する', r2 === 'ok', String(r2));
    check('同じ X-Line-Retry-Key でもう一度 push し、届く（試行 2 回・届いたのは 1 回）', sent.length === 2 && accepted.has(cardNoticeRetryKey(id)), sent.length);
    check('送り直したカードは保存時点の内容（1 回目と同じ）', sent.length === 2 && JSON.stringify(sent[0].messages) === JSON.stringify(sent[1].messages));
    check('支出は増えない（1 件）', (await expensesOf(id)).length === 1);
    check('送ったら印を消す', !(await noticeOf(id)).exists);
    check(
      '新しいログに messageId をそのまま出さない（maskId）',
      lastLogs.filter((l) => /card notice/i.test(l)).length > 0 && lastLogs.filter((l) => /card notice/i.test(l)).every((l) => !l.includes(id)),
      lastLogs.filter((l) => /card notice/i.test(l))
    );
  }

  console.log('\n[LINE が受け付けたが応答が届かなかった: 再処理の 409 を送れた扱いにする]');
  {
    const id = 'msg-409-0003';
    mails[id] = cardMail('2026/10/21 08:10', '朝の店', 640);
    nextPush = 'acceptThenLose';
    const r = await quiet(() => pubsub([id]));
    check('1 回目は失敗として投げ、印が残る', r instanceof Error && (await noticeOf(id)).exists, String(r));
    const r2 = await quiet(() => pubsub([id]));
    check('再処理は 409 を送れた扱いにして成功する', r2 === 'ok', String(r2));
    check('試行は同じ key で 2 回、届いたのは 1 回', pushesFor(id).length === 2 && accepted.has(cardNoticeRetryKey(id)));
    check('印を消し、支出は 1 件', !(await noticeOf(id)).exists && (await expensesOf(id)).length === 1);
  }

  console.log('\n[印の無い既存の支出には送らない]');
  {
    const id = 'msg-legacy-0004';
    mails[id] = cardMail('2026/10/01 12:00', '既存の店', 500);
    await seedExpense(id, 500);
    const r = await quiet(() => pubsub([id]));
    check('処理は成功し、push しない', r === 'ok' && pushesFor(id).length === 0, String(r));
    check('支出は増えない（1 件）', (await expensesOf(id)).length === 1);
    const forced = await quiet(() => forceProcessMessage(id));
    check('force-process も既存として返し、送らない（cardNotice: none）', forced.success && forced.alreadyExists && forced.cardNotice === 'none' && pushesFor(id).length === 0, forced);
  }

  console.log('\n[古い印（23 時間超）は送らずに消す・23 時間以内なら送る]');
  {
    const now = Date.now();
    const old = 'msg-old-0005';
    mails[old] = cardMail('2026/10/01 12:00', '既存の店', 501);
    await seedNotice(old, await seedExpense(old, 501), Timestamp.fromMillis(now - CARD_NOTICE_MAX_AGE_MS - 60 * 1000));
    const r = await quiet(() => pubsub([old]));
    check('23 時間 1 分前の印: 処理は成功し、push しない', r === 'ok' && pushesFor(old).length === 0, String(r));
    check('23 時間 1 分前の印: 印を消し、支出は 1 件のまま', !(await noticeOf(old)).exists && (await expensesOf(old)).length === 1);
    check('23 時間 1 分前の印: 警告を出す', lastLogs.some((l) => l.startsWith('warn Gmail card notice expired')), lastLogs);

    const noTime = 'msg-notime-0006';
    mails[noTime] = cardMail('2026/10/01 12:00', '既存の店', 502);
    await seedNotice(noTime, await seedExpense(noTime, 502), null);
    await quiet(() => pubsub([noTime]));
    check('作った時刻の無い印: 送らずに消す', pushesFor(noTime).length === 0 && !(await noticeOf(noTime)).exists);

    const fresh = 'msg-fresh-0007';
    mails[fresh] = cardMail('2026/10/01 12:00', '既存の店', 503);
    await seedNotice(fresh, await seedExpense(fresh, 503), Timestamp.fromMillis(now - 22 * 60 * 60 * 1000));
    const r2 = await quiet(() => pubsub([fresh]));
    check('22 時間前の印: 送って消す', r2 === 'ok' && pushesFor(fresh).length === 1 && !(await noticeOf(fresh)).exists, String(r2));
    check('22 時間前の印: 支出は増えない（1 件）', (await expensesOf(fresh)).length === 1);
  }

  console.log('\n[支出が消されていたら送らず、取り込み直さない]');
  {
    const id = 'msg-deleted-0008';
    mails[id] = cardMail('2026/10/02 12:00', '消した店', 777);
    await seedNotice(id, 'expense_deleted_by_user', Timestamp.now());
    const r = await quiet(() => pubsub([id]));
    check('処理は成功し、push しない', r === 'ok' && pushesFor(id).length === 0, String(r));
    check('印を消し、支出を作り直さない', !(await noticeOf(id)).exists && (await expensesOf(id)).length === 0);
  }

  console.log('\n[同じメールを 2 本同時に処理: 支出 1 件・同じ key・届くのは 1 回]');
  {
    const id = 'msg-race-0009';
    mails[id] = cardMail('2026/10/22 19:40', '同時の店', 3300);
    barrier = makeBarrier(2);
    const [a, b] = await quiet(() => Promise.all([pubsub([id]), pubsub([id])]));
    const arrived = barrier.arrived;
    barrier = null;
    const keys = new Set(pushes.filter((p) => p.messages[0].altText.includes('¥3,300')).map((p) => p.retryKey));
    check('2 本とも保存の手前まで同時に進んだ（テストの前提）', arrived === 2, arrived);
    check('どちらも成功する', a === 'ok' && b === 'ok', [String(a), String(b)]);
    check('支出は 1 件', (await expensesOf(id)).length === 1, (await expensesOf(id)).length);
    check('push の X-Line-Retry-Key はすべて同じ', keys.size === 1 && keys.has(cardNoticeRetryKey(id)), [...keys]);
    check('届いたのは 1 回、印は消える', accepted.has(cardNoticeRetryKey(id)) && !(await noticeOf(id)).exists);
  }

  console.log('\n[LINE_GROUP_ID が無ければ印を作らず、送らない]');
  {
    const id = 'msg-nogroup-0010';
    mails[id] = cardMail('2026/10/23 12:00', 'グループなし', 410);
    delete process.env.LINE_GROUP_ID;
    try {
      const r = await quiet(() => pubsub([id]));
      check('処理は成功し、支出は 1 件', r === 'ok' && (await expensesOf(id)).length === 1, String(r));
      check('印を作らず、push しない', !(await noticeOf(id)).exists && pushesFor(id).length === 0);
    } finally {
      process.env.LINE_GROUP_ID = LINE_GROUP;
    }
  }

  console.log('\n[force-process: 既存の支出の送信待ちを送り直す]');
  {
    const id = 'msg-force-0011';
    mails[id] = cardMail('2026/10/24 13:00', '手動の店', 1250);
    nextPush = 'fail';
    const r = await quiet(() => pubsub([id]));
    check('Pub/Sub で push に失敗し、印が残る', r instanceof Error && (await noticeOf(id)).exists, String(r));
    const forced = await quiet(() => forceProcessMessage(id));
    check('force-process は既存として返し、cardNotice: sent', forced.success && forced.alreadyExists && forced.cardNotice === 'sent', forced);
    check('同じ key で送り、印を消す', pushesFor(id).length === 2 && accepted.has(cardNoticeRetryKey(id)) && !(await noticeOf(id)).exists);
    const again = await quiet(() => forceProcessMessage(id));
    check('もう一度呼んでも送らない（cardNotice: none）', again.cardNotice === 'none' && pushesFor(id).length === 2, again);

    const id2 = 'msg-force-0012';
    mails[id2] = cardMail('2026/10/24 13:30', '手動の店 2', 1260);
    nextPush = 'fail';
    const first = await quiet(() => forceProcessMessage(id2));
    check('force-process の新規保存で push に失敗: success: false・支出 1 件・印が残る', first.success === false && (await expensesOf(id2)).length === 1 && (await noticeOf(id2)).exists, first);
    const second = await quiet(() => forceProcessMessage(id2));
    check('もう一度呼ぶと送り直す（cardNotice: sent）', second.success && second.cardNotice === 'sent' && pushesFor(id2).length === 2 && !(await noticeOf(id2)).exists, second);
  }

  const historyIdNow = async () => (await db.doc('system/gmailState').get()).get('historyId');
  const discardWarned = () => lastLogs.some((l) => l.startsWith('warn Gmail card notice discarded'));
  const HOUR = 60 * 60 * 1000;
  const failuresNow = async () => (await db.doc('system/gmailFailures').get()).data() || {};
  /** 失敗の記録の最初の失敗を ms 前にする（試行回数などはそのまま。Pub/Sub の再送が何時間も続いた状態を作る） */
  const backdateFirstFailure = (messageId, ms) =>
    db.doc('system/gmailFailures').set({ [messageId]: { firstFailedAt: Timestamp.fromMillis(Date.now() - ms) } }, { merge: true });

  console.log('\n[再送で 3 回失敗しても、最初の失敗から 6 時間たつまでは諦めない・たったら諦めて印を消す（支出は残る）]');
  {
    const id = 'msg-abandon-0013';
    mails[id] = cardMail('2026/10/25 12:00', '諦める店', 1330);
    failNextPushes = 4;
    const r1 = await quiet(() => pubsub([id]));
    const first = (await failuresNow())[id];
    check(
      '1 回目の失敗: 記録に試行 1・firstFailedAt・lastFailedAt（同じ時刻）を残す',
      first && first.attempts === 1 && first.firstFailedAt && first.lastFailedAt && first.firstFailedAt.toMillis() === first.lastFailedAt.toMillis(),
      first
    );
    const r2 = await quiet(() => pubsub([id]));
    check('1・2 回目は失敗として投げ、印が残る', r1 instanceof Error && r2 instanceof Error && (await noticeOf(id)).exists, [String(r1), String(r2)]);
    const historyBefore = await historyIdNow();
    const r3 = await quiet(() => pubsub([id]));
    const third = (await failuresNow())[id];
    check('3 回目（最初の失敗から数秒）: まだ諦めずに投げ、historyId を進めない', r3 instanceof Error && (await historyIdNow()) === historyBefore, String(r3));
    check(
      '3 回目: 試行 3・firstFailedAt は 1 回目のまま、lastFailedAt は進む',
      third && third.attempts === 3 && third.firstFailedAt.toMillis() === first.firstFailedAt.toMillis() && third.lastFailedAt.toMillis() >= first.lastFailedAt.toMillis(),
      third
    );
    check('3 回目: 印は残し、警告も出さない', (await noticeOf(id)).exists && !discardWarned());

    await backdateFirstFailure(id, 7 * HOUR);
    const r4 = await quiet(() => pubsub([id]));
    check('最初の失敗から 7 時間・4 回目の失敗: 諦めて投げない（historyId を進める）', r4 === 'ok' && (await historyIdNow()) !== historyBefore, String(r4));
    check('諦めたメールの印を消し、届かなかったことを警告する', !(await noticeOf(id)).exists && discardWarned());
    check('支出は残り（1 件）、カードは届いていない', (await expensesOf(id)).length === 1 && !accepted.has(cardNoticeRetryKey(id)) && pushesFor(id).length === 4);
    failNextPushes = 0;
  }

  console.log('\n[firstFailedAt の無い失敗の記録（項目を足す前の記録）は lastFailedAt で代用する]');
  {
    const id = 'msg-legacy-failure-0018';
    mails[id] = cardMail('2026/10/25 13:00', '古い記録の店', 1880);
    const lastFailedAt = Timestamp.fromMillis(Date.now() - 7 * HOUR);
    await db.doc('system/gmailFailures').set({ [id]: { attempts: 2, lastError: 'old', lastFailedAt } }, { merge: true });
    failNextPushes = 1;
    const historyBefore = await historyIdNow();
    const r = await quiet(() => pubsub([id]));
    const record = (await failuresNow())[id];
    check('lastFailedAt が 7 時間前・3 回目の失敗: 諦めて historyId を進める', r === 'ok' && (await historyIdNow()) !== historyBefore, String(r));
    check(
      '記録の firstFailedAt に、代用した lastFailedAt を書く（試行 3）',
      record && record.attempts === 3 && record.firstFailedAt && record.firstFailedAt.toMillis() === lastFailedAt.toMillis(),
      record
    );
    check('諦めたメールの印を消す', !(await noticeOf(id)).exists && discardWarned());
    failNextPushes = 0;

    const recent = 'msg-legacy-failure-0019';
    mails[recent] = cardMail('2026/10/25 13:30', '古い記録の店 2', 1990);
    await db.doc('system/gmailFailures').set({ [recent]: { attempts: 5, lastError: 'old', lastFailedAt: Timestamp.fromMillis(Date.now() - 60 * 1000) } }, { merge: true });
    failNextPushes = 1;
    const r2 = await quiet(() => pubsub([recent]));
    check('lastFailedAt が 1 分前なら、試行 6 回でも諦めない（投げる）', r2 instanceof Error && (await noticeOf(recent)).exists, String(r2));
    failNextPushes = 0;
    const r3 = await quiet(() => pubsub([recent]));
    check('次の再送で送れれば、印を消して失敗の記録も消す', r3 === 'ok' && !(await noticeOf(recent)).exists && (await failuresNow())[recent] === undefined, String(r3));
  }

  console.log('\n[メールが消されていた（messages.get が 404）: 失敗として数えず読み飛ばす]');
  {
    const id = 'msg-gone-0020';
    missingMails.add(id);
    // 前の実行で失敗していた（記録がある）
    await db.doc('system/gmailFailures').set({ [id]: { attempts: 1, lastError: 'old', firstFailedAt: Timestamp.now(), lastFailedAt: Timestamp.now() } }, { merge: true });
    const historyBefore = await historyIdNow();
    const r = await quiet(() => pubsub([id]));
    check('投げずに historyId を進める', r === 'ok' && (await historyIdNow()) !== historyBefore, String(r));
    check('失敗の記録を消し、支出も印も作らない', (await failuresNow())[id] === undefined && (await expensesOf(id)).length === 0 && !(await noticeOf(id)).exists);
    check(
      '固定文の警告を出し、messageId をそのまま出さない',
      lastLogs.some((l) => l.startsWith('warn Gmail message not found (deleted); skipping')) && lastLogs.every((l) => !l.includes(id)),
      lastLogs
    );
    missingMails.delete(id);
  }

  console.log('\n[同じ実行で A は諦め・B は再試行で投げる: historyId を進めず A の印は残り、次の実行で A に送る]');
  {
    const a = 'msg-mixed-a-0016';
    const b = 'msg-mixed-b-0017';
    mails[a] = cardMail('2026/10/26 08:00', '混在の店 A', 1660);
    mails[b] = cardMail('2026/10/26 08:30', '混在の店 B', 1770);
    failNextPushes = 1;
    const r1 = await quiet(() => pubsub([a]));
    failNextPushes = 1;
    const r2 = await quiet(() => pubsub([a]));
    check('A は 2 回失敗し、印が残る', r1 instanceof Error && r2 instanceof Error && (await noticeOf(a)).exists, [String(r1), String(r2)]);
    // A の最初の失敗を 7 時間前にする（次の失敗で諦める条件を満たす）
    await backdateFirstFailure(a, 7 * HOUR);
    const historyBefore = await historyIdNow();
    failNextPushes = 2;
    const r3 = await quiet(() => pubsub([a, b]));
    const failures = (await db.doc('system/gmailFailures').get()).data() || {};
    check(
      '3 回目: A は諦め（試行 3）、B は再試行（試行 1）で投げる',
      r3 instanceof Error && failures[a] && failures[a].attempts === 3 && failures[b] && failures[b].attempts === 1,
      { r3: String(r3), a: failures[a], b: failures[b] }
    );
    check('historyId は進まず、諦めた A の印も B の印も残る', (await historyIdNow()) === historyBefore && (await noticeOf(a)).exists && (await noticeOf(b)).exists);
    check('A のカードはまだ届かず、印を消した警告も出ない', !accepted.has(cardNoticeRetryKey(a)) && !discardWarned());
    const r4 = await quiet(() => pubsub([a, b]));
    check(
      '次の実行で A と B に送り、historyId を進める',
      r4 === 'ok' && accepted.has(cardNoticeRetryKey(a)) && accepted.has(cardNoticeRetryKey(b)) && (await historyIdNow()) !== historyBefore,
      String(r4)
    );
    check(
      'A と B の印を消し、支出はそれぞれ 1 件',
      !(await noticeOf(a)).exists && !(await noticeOf(b)).exists && (await expensesOf(a)).length === 1 && (await expensesOf(b)).length === 1
    );
  }

  console.log('\n[historyId が古すぎて先へ飛ばしたら、失敗の記録にあるメールの印を消す]');
  {
    const id = 'msg-skip-0014';
    mails[id] = cardMail('2026/10/25 18:00', '飛ばす店', 1440);
    nextPush = 'fail';
    const r = await quiet(() => pubsub([id]));
    const failures = (await db.doc('system/gmailFailures').get()).data() || {};
    check('push に失敗し、印と失敗の記録が残る', r instanceof Error && (await noticeOf(id)).exists && failures[id] !== undefined, String(r));
    // 失敗の記録に無い印（force-process で残ったものなど）は対象にしない
    const other = 'msg-forceonly-0015';
    await seedNotice(other, await seedExpense(other, 1550), Timestamp.now());
    historyError = Object.assign(new Error('Requested entity was not found.'), { code: 404 });
    const historyBefore = await historyIdNow();
    const r2 = await quiet(() => pubsub([id]));
    check('404: 先へ飛ばして投げず（historyId を進める）、送らない', r2 === 'ok' && (await historyIdNow()) !== historyBefore && pushesFor(id).length === 1, String(r2));
    check('404: 失敗の記録にあるメールの印を消し、警告する', !(await noticeOf(id)).exists && discardWarned());
    check('404: 失敗の記録に無い印は残す', (await noticeOf(other)).exists);
    check('404: 支出は残る（1 件）', (await expensesOf(id)).length === 1);
  }

  console.log(`\ngmail card notice emulator: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
