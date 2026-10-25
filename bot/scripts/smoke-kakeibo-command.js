/**
 * LINE の「家計簿」コマンド（handleKakeiboCommand）が、LINE グループでは世帯の有効メンバーにだけ集計を返すことの
 * スモークテスト（#271）
 *
 * firebase-admin の getFirestore を偽の Firestore（メモリ上の文書）に、LINE の返信を記録用の偽物に差し替え、
 * 所属の確認（getUserGroups）と集計（getMonthlyGroupSummary・getMonthlyBudget）は本物を動かす。外には繋がない。
 * - LINE グループ: 発言元の LINE グループに紐づく世帯の有効メンバー → 世帯の集計（lineGroupId で引く）を返す
 * - LINE グループ: 脱退済み・世帯外・別の LINE グループの世帯のメンバー・自作グループだけのメンバー・userId なし
 *   → 拒否の文だけを返し、支出も予算も読まない
 * - LINE グループ: 所属の確認に失敗 → 拒否（集計を返さない）
 * - 個人チャット: 所属を読まず、送った本人の支出（lineId で引く）だけを集計する
 * - ログ・拒否の文に、利用者 ID・LINE グループ ID を出さない
 *   node bot/scripts/smoke-kakeibo-command.js
 */

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- 偽の Firestore（dist/firestore は最初の呼び出しで getFirestore() を覚えるので、呼ぶ前に差し替える） ---
const firestoreModule = require('firebase-admin/firestore');

/** パス（collection/id）→ 文書 */
const docs = new Map();
/** コレクションごとの読み取り回数 */
const reads = {};
/** 例外を投げるコレクション（所属の確認の失敗を作る） */
const failingCollections = new Set();

function matches(value, op, expected) {
  if (op === '==') return value === expected;
  if (op === '>=') return value >= expected;
  if (op === '<=') return value <= expected;
  throw new Error(`unsupported op ${op}`);
}

function snapshotOf(id, data) {
  return {
    id,
    exists: data !== undefined,
    data: () => (data === undefined ? undefined : { ...data }),
    get: (field) => (data ? data[field] : undefined),
  };
}

function queryOf(name, filters) {
  return {
    where: (field, op, value) => queryOf(name, [...filters, [field, op, value]]),
    limit: () => queryOf(name, filters),
    get: async () => {
      reads[name] = (reads[name] || 0) + 1;
      if (failingCollections.has(name)) throw new Error('firestore unavailable');
      // 本物の Firestore と同じく、undefined では問い合わせられない
      if (filters.some(([, , v]) => v === undefined)) throw new Error('Cannot use "undefined" as a Firestore value');
      const prefix = `${name}/`;
      const matched = [...docs]
        .filter(([path]) => path.startsWith(prefix))
        .filter(([, data]) => filters.every(([field, op, value]) => matches(data[field], op, value)))
        .map(([path, data]) => snapshotOf(path.slice(prefix.length), data));
      return { empty: matched.length === 0, size: matched.length, docs: matched };
    },
  };
}

const fakeDb = {
  collection: (name) => ({
    ...queryOf(name, []),
    doc: (id) => ({
      id,
      get: async () => {
        reads[name] = (reads[name] || 0) + 1;
        if (failingCollections.has(name)) throw new Error('firestore unavailable');
        return snapshotOf(id, docs.get(`${name}/${id}`));
      },
    }),
  }),
};
firestoreModule.getFirestore = () => fakeDb;

// --- LINE の返信の偽物（kakeibo は呼び出し時に client の exports を参照する。replyText は内部で replyMessages を
//     直接呼ぶので、両方を差し替える。本物のクライアントは作らせない） ---
const client = require('../dist/line/client');
const replies = [];
client.replyMessages = async (replyToken, messages) => {
  replies.push({ replyToken, messages });
};
client.replyText = async (replyToken, text) => {
  replies.push({ replyToken, messages: [{ type: 'text', text }] });
};
client.getLineClient = () => {
  throw new Error('the real LINE client must not be used in this test');
};

const { nowJST } = require('../dist/time');
const { handleKakeiboCommand } = require('../dist/line/commands/kakeibo');

// --- データ ---
// 世帯 G_house（LINE グループ L_house）: Alice・Bob が有効、Left は脱退済み。Self は自作グループ（lineGroupId なし）だけ
const month = nowJST().format('YYYY-MM');
const at = (millis) => ({ toMillis: () => millis });
docs.set('groups/G_house', { name: '世帯', lineGroupId: 'L_house_0001', createdBy: 'U_alice_0001', inviteCode: 'X' });
docs.set('groups/G_self', { name: '自作', createdBy: 'U_self_0001', inviteCode: 'Y' });
docs.set('groupMembers/G_house_U_alice_0001', { groupId: 'G_house', lineId: 'U_alice_0001', displayName: 'Alice', isActive: true });
docs.set('groupMembers/G_house_U_bob_0001', { groupId: 'G_house', lineId: 'U_bob_0001', displayName: 'Bob', isActive: true });
docs.set('groupMembers/G_house_U_left_0001', { groupId: 'G_house', lineId: 'U_left_0001', displayName: 'Left', isActive: false });
docs.set('groupMembers/G_self_U_self_0001', { groupId: 'G_self', lineId: 'U_self_0001', displayName: 'Self', isActive: true });
const householdExpense = (extra) => ({ groupId: 'G_house', lineGroupId: 'L_house_0001', date: `${month}-03`, category: '食費', includeInTotal: true, ...extra });
docs.set('expenses/e_alice_house', householdExpense({ lineId: 'U_alice_0001', amount: 1200, description: '世帯のランチ', createdAt: at(3) }));
docs.set('expenses/e_bob_house', householdExpense({ lineId: 'U_bob_0001', amount: 3400, description: 'パートナーの日用品', category: '日用品', createdAt: at(4) }));
docs.set('expenses/e_alice_personal', { lineId: 'U_alice_0001', amount: 500, description: 'アリスの個人の本', date: `${month}-05`, category: '教育', includeInTotal: true, createdAt: at(5) });
docs.set('expenses/e_stranger', { lineId: 'U_stranger_0001', amount: 800, description: '世帯外の人の支出', date: `${month}-06`, category: '娯楽', includeInTotal: true, createdAt: at(6) });
docs.set('budgetSettings/L_house_0001', { monthlyBudget: 100000 });

const DESCRIPTIONS = ['世帯のランチ', 'パートナーの日用品', 'アリスの個人の本', '世帯外の人の支出'];
const MEMBERS_ONLY = '家計簿の集計を表示できるのは、世帯のメンバーだけです。';
const LOOKUP_FAILED = '世帯のメンバーか確認できなかったため、集計を表示できませんでした。';
const IDS = ['U_alice_0001', 'U_bob_0001', 'U_left_0001', 'U_self_0001', 'U_stranger_0001', 'L_house_0001', 'L_other_0001'];

// --- 実行 ---
const logs = [];
const allLogs = [];

/** 「家計簿」を送る。lineGroupId を渡すと LINE グループ、userId を null にすると userId の無いイベントになる */
async function send({ userId, lineGroupId }) {
  for (const key of Object.keys(reads)) delete reads[key];
  logs.length = 0;
  const before = replies.length;
  const source = lineGroupId ? { type: 'group', groupId: lineGroupId } : { type: 'user' };
  if (userId) source.userId = userId;
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      logs.push({ level, args });
      allLogs.push({ level, args });
    };
  }
  let handled;
  try {
    handled = await handleKakeiboCommand({ replyToken: 'reply-token', source }, '家計簿');
  } finally {
    Object.assign(console, original);
  }
  const sent = replies.slice(before);
  const message = sent.length === 1 && sent[0].messages.length === 1 ? sent[0].messages[0] : null;
  const json = JSON.stringify(sent);
  return {
    handled,
    sent,
    message,
    json,
    shown: DESCRIPTIONS.filter((d) => json.includes(d)),
    reads: { ...reads },
  };
}

const describe = (r) => JSON.stringify({ sent: r.sent.length, type: r.message?.type, shown: r.shown, reads: r.reads });

/** 拒否のケース: 指定の文だけを 1 通返し、支出・予算を読まない */
function checkRefused(r, text) {
  check('コマンドとして処理する（支出の登録に回さない）', r.handled === true);
  check('拒否の文を 1 通だけ返す', r.message?.type === 'text' && r.message.text.startsWith(text), describe(r));
  check('Web のリンク（ID なし）を添える', r.message?.type === 'text' && r.message.text.endsWith('\nWebアプリ: https://line-kakeibo.vercel.app'), r.message?.text);
  check('集計（支出の内容）を返さない', r.shown.length === 0, describe(r));
  check('支出・予算を読まない', !r.reads.expenses && !r.reads.budgetSettings, describe(r));
}

async function main() {
  console.log('\n# LINE グループ: 世帯の有効メンバー → 世帯の集計');
  let r = await send({ userId: 'U_alice_0001', lineGroupId: 'L_house_0001' });
  check('Flex を 1 通返す', r.message?.type === 'flex', describe(r));
  check('世帯の支出（2 人分）を出す', r.shown.includes('世帯のランチ') && r.shown.includes('パートナーの日用品'), describe(r));
  check('個人の支出・世帯外の支出は出さない（lineGroupId で引く）', !r.shown.includes('アリスの個人の本') && !r.shown.includes('世帯外の人の支出'), describe(r));
  check('合計は世帯の 2 件（¥4,600）', r.message?.altText?.includes('¥4,600'), r.message?.altText);
  check('世帯の予算（budgetSettings/{lineGroupId}）を読む', r.reads.budgetSettings === 1, describe(r));
  r = await send({ userId: 'U_bob_0001', lineGroupId: 'L_house_0001' });
  check('もう 1 人のメンバーにも返す', r.message?.type === 'flex' && r.message.altText.includes('¥4,600'), describe(r));

  console.log('\n# LINE グループ: 脱退済みの元メンバー → 拒否');
  r = await send({ userId: 'U_left_0001', lineGroupId: 'L_house_0001' });
  checkRefused(r, MEMBERS_ONLY);
  const refusedLog = logs.find((l) => l.args[0] === 'Kakeibo summary refused: the sender is not a household member');
  check(
    '拒否を固定文 + オブジェクトで warn に出す（ID は伏せる）',
    refusedLog?.level === 'warn' && refusedLog.args.length === 2 && refusedLog.args[1].user === '…0001' && refusedLog.args[1].group === '…0001',
    JSON.stringify(refusedLog?.args)
  );

  console.log('\n# LINE グループ: 世帯の LINE グループにいる世帯外の人 → 拒否');
  r = await send({ userId: 'U_stranger_0001', lineGroupId: 'L_house_0001' });
  checkRefused(r, MEMBERS_ONLY);

  console.log('\n# LINE グループ: 世帯のメンバーが、世帯に紐づかない別の LINE グループで送る → 拒否');
  r = await send({ userId: 'U_alice_0001', lineGroupId: 'L_other_0001' });
  checkRefused(r, MEMBERS_ONLY);

  console.log('\n# LINE グループ: 自作グループ（lineGroupId なし）だけのメンバー → 拒否');
  r = await send({ userId: 'U_self_0001', lineGroupId: 'L_house_0001' });
  checkRefused(r, MEMBERS_ONLY);

  console.log('\n# LINE グループ: userId の無い発言（LINE の規約に同意していない人）→ 拒否');
  r = await send({ userId: null, lineGroupId: 'L_house_0001' });
  checkRefused(r, MEMBERS_ONLY);
  check('所属も読まない', !r.reads.groupMembers && !r.reads.groups, describe(r));

  console.log('\n# LINE グループ: 所属の確認に失敗 → 拒否（集計を返さない）');
  failingCollections.add('groupMembers');
  r = await send({ userId: 'U_alice_0001', lineGroupId: 'L_house_0001' });
  failingCollections.delete('groupMembers');
  checkRefused(r, LOOKUP_FAILED);
  const failedLog = logs.find((l) => l.args[0] === 'Kakeibo summary refused: household membership lookup failed');
  check(
    '確認の失敗を固定文 + オブジェクトで warn に出す（ID は伏せる）',
    failedLog?.level === 'warn' && failedLog.args[1]?.user === '…0001' && failedLog.args[1]?.error === 'firestore unavailable',
    JSON.stringify(failedLog?.args)
  );

  console.log('\n# 個人チャット: 世帯のメンバー → 本人の支出だけ');
  r = await send({ userId: 'U_alice_0001' });
  check('Flex を 1 通返す', r.message?.type === 'flex', describe(r));
  check('本人の支出（世帯で登録した分と個人の分）を出す', r.shown.includes('世帯のランチ') && r.shown.includes('アリスの個人の本'), describe(r));
  check('パートナー・世帯外の人の支出は出さない', !r.shown.includes('パートナーの日用品') && !r.shown.includes('世帯外の人の支出'), describe(r));
  check('合計は本人の 2 件（¥1,700）', r.message?.altText?.includes('¥1,700'), r.message?.altText);
  check('所属は読まない', !r.reads.groupMembers && !r.reads.groups, describe(r));

  console.log('\n# 個人チャット: 所属の無い人 → 本人の支出だけ（今までどおり）');
  r = await send({ userId: 'U_stranger_0001' });
  check('本人の支出だけを出す', r.message?.type === 'flex' && r.shown.length === 1 && r.shown[0] === '世帯外の人の支出', describe(r));

  console.log('\n# 個人チャット: 所属を読めない状態でも、本人の集計は返す（所属を読まないため）');
  failingCollections.add('groupMembers');
  r = await send({ userId: 'U_alice_0001' });
  failingCollections.delete('groupMembers');
  check('本人の集計を返す', r.message?.type === 'flex' && r.shown.includes('アリスの個人の本'), describe(r));

  console.log('\n# ログ・返信');
  const logged = JSON.stringify(allLogs.map((l) => l.args.map((a) => (a instanceof Error ? a.message : a))));
  check('ログに利用者 ID・LINE グループ ID を出さない', allLogs.length > 0 && !IDS.some((id) => logged.includes(id)), logged);
  const refusals = JSON.stringify(replies.filter((x) => x.messages[0]?.type === 'text'));
  check('拒否の文に ID を載せない', refusals.length > 2 && !IDS.some((id) => refusals.includes(id)), refusals);
  check('フォールバック（読み込み中）の文は出ていない', !replies.some((x) => JSON.stringify(x).includes('現在データを読み込み中')));

  console.log(failed ? `\n${failed} failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
