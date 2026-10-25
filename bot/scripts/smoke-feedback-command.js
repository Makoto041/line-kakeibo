/**
 * 要望・改善・不具合・フィードバックのコマンド（line/commands/feedback.ts）のスモークテスト（#260）
 *
 * Gemini（generateJson）・GitHub（axios.post）・Firestore（getUserGroups）・LINE の返信を偽物に差し替え、
 * 本物の API を呼ばずに次を検証する。
 * - 世帯のメンバー（LINE グループに紐づく世帯の有効メンバー）なら、Gemini で整理して Issue を作る
 * - メンバーでない・自作グループだけ・別の LINE グループでの発言・userId なし・所属の確認に失敗 → Gemini も GitHub も呼ばない
 * - 本文が 1,000 文字（コードポイント）を超えたら呼ばない。超えた分は件数に数えない
 * - 同じ人は 10 分に 3 件まで（期間の境目、受け付けなかった分は数えないこと、人ごとに数えること）
 * - createIssueFromFeedback も、長すぎる本文では呼ばない
 * - ログに利用者 ID・本文を出さない
 *   node bot/scripts/smoke-feedback-command.js
 */
const path = require('path');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 偽の鍵（本物の鍵は使わない。偽物の差し替えが外れても、本物の鍵で外部を呼ばない）
process.env.GEMINI_API_KEY = 'test-key';
process.env.GITHUB_TOKEN = 'test-token';

// --- GitHub（axios）の偽物。bot/dist が読み込むのと同じ axios を差し替える ---
const axios = require(require.resolve('axios', { paths: [path.join(__dirname, '..')] }));
const githubPosts = [];
axios.post = async (url, body) => {
  githubPosts.push({ url, body });
  return { data: { html_url: `https://github.com/example/issues/${githubPosts.length}`, number: githubPosts.length } };
};

// --- Gemini・Firestore・LINE の偽物（feedback / issueCreator は呼び出し時に exports を参照する） ---
const geminiClient = require('../dist/geminiClient');
const firestore = require('../dist/firestore');
const lineClient = require('../dist/line/client');

const geminiPrompts = [];
geminiClient.generateJson = async (prompt) => {
  geminiPrompts.push(prompt);
  return {
    title: '月別のグラフを見たい',
    type: '機能要件',
    summary: '要約',
    details: '詳細',
    acceptanceCriteria: ['条件1', '条件2'],
  };
};

const household = { id: 'G_house', name: '世帯', lineGroupId: 'L_house' };
const selfMade = { id: 'G_self', name: '自作' };
// getUserGroups の結果（lineId ごと）。failingUsers に入れた lineId では例外を投げる
const groupsByUser = {};
const failingUsers = new Set();
let getUserGroupsCalls = 0;
firestore.getUserGroups = async (lineId) => {
  getUserGroupsCalls++;
  if (failingUsers.has(lineId)) throw new Error('firestore unavailable');
  return Object.hasOwn(groupsByUser, lineId) ? groupsByUser[lineId] : [];
};

const replies = [];
lineClient.replyText = async (replyToken, text) => {
  replies.push({ replyToken, text });
};

// 時計（件数の期間のケースで進める）。feedback は Date.now() で数えるので、固定の基準から進める
const MINUTE = 60 * 1000;
const BASE = Date.now();
let clockOffset = 0;
Date.now = () => BASE + clockOffset;

const {
  handleFeedbackCommand,
  FEEDBACK_RATE_LIMIT,
  FEEDBACK_RATE_WINDOW_MS,
  FEEDBACK_MEMBERS_ONLY_MESSAGE,
} = require('../dist/line/commands/feedback');
const { createIssueFromFeedback, FEEDBACK_MAX_LENGTH, FEEDBACK_TOO_LONG_MESSAGE } = require('../dist/issueCreator');

// 処理中のログを集める（画面には出さない）。logs はケースごとに消し、allLogs は最後の確認に使う
const logs = [];
const allLogs = [];
const bodies = [];
const userIds = [];
async function captureLogs(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      logs.push({ level, args });
      allLogs.push({ level, args });
    };
  }
  try {
    return await fn();
  } finally {
    Object.assign(console, original);
  }
}

/** 1 通送る。返り値はこの 1 通で増えた呼び出しの数と返信 */
async function send({ userId, lineGroupId, body, prefix = '要望' }) {
  bodies.push(body);
  if (userId) userIds.push(userId);
  const source = lineGroupId ? { type: 'group', groupId: lineGroupId } : { type: 'user' };
  if (userId) source.userId = userId;
  const event = { replyToken: 'reply-token', source };
  const before = { gemini: geminiPrompts.length, github: githubPosts.length, lookups: getUserGroupsCalls, replies: replies.length };
  const handled = await captureLogs(() => handleFeedbackCommand(event, `${prefix} ${body}`));
  return {
    handled,
    gemini: geminiPrompts.length - before.gemini,
    github: githubPosts.length - before.github,
    lookups: getUserGroupsCalls - before.lookups,
    reply: replies.length > before.replies ? replies[replies.length - 1].text : undefined,
    replyCount: replies.length - before.replies,
  };
}
const created = (r) => r.gemini === 1 && r.github === 1 && /^Issueを作成しました/.test(r.reply ?? '');
const notCalled = (r) => r.gemini === 0 && r.github === 0;
const detail = (r) => JSON.stringify(r);
const findLog = (message) => logs.find((l) => l.args[0] === message);

const RATE_MESSAGE_PATTERN = /10 分に 3 件まで/;

async function main() {
  console.log('\n# 定数');
  check('上限は 1,000 文字', FEEDBACK_MAX_LENGTH === 1000);
  check('件数は 10 分に 3 件', FEEDBACK_RATE_LIMIT === 3 && FEEDBACK_RATE_WINDOW_MS === 10 * MINUTE);
  check('長すぎるときの返信に上限を書く', FEEDBACK_TOO_LONG_MESSAGE.includes('1,000 文字以内'), FEEDBACK_TOO_LONG_MESSAGE);

  console.log('\n# 個人チャット: 世帯のメンバー → Gemini で整理して Issue を作る');
  logs.length = 0;
  groupsByUser.U_member1 = [household];
  let r = await send({ userId: 'U_member1', body: '月別のグラフが見たい' });
  check('コマンドとして処理する', r.handled === true);
  check('Gemini を 1 回・GitHub を 1 回呼び、作成を返信', created(r), detail(r));
  check('所属を 1 回読む', r.lookups === 1, detail(r));
  check('Gemini のプロンプトに本文が入る', geminiPrompts[geminiPrompts.length - 1]?.includes('月別のグラフが見たい'));
  const post = githubPosts[githubPosts.length - 1];
  check('公開リポジトリに Issue を作る', post?.url === 'https://api.github.com/repos/Makoto041/line-kakeibo/issues', post?.url);
  check('拒否のログは出さない', !logs.some((l) => String(l.args[0]).startsWith('Feedback rejected')));

  for (const prefix of ['改善', '不具合', 'フィードバック']) {
    groupsByUser[`U_prefix_${prefix}`] = [household];
    r = await send({ userId: `U_prefix_${prefix}`, body: `${prefix}の本文`, prefix });
    check(`「${prefix}」でも同じ（メンバーなら Issue を作る）`, created(r), detail(r));
  }

  console.log('\n# LINE グループ: 世帯の LINE グループでの、世帯のメンバーの発言 → Issue を作る');
  groupsByUser.U_member2 = [household];
  r = await send({ userId: 'U_member2', lineGroupId: 'L_house', body: 'グループからの要望' });
  check('Gemini を 1 回・GitHub を 1 回呼ぶ', created(r), detail(r));

  console.log('\n# メンバーでない → Gemini も GitHub も呼ばない');
  logs.length = 0;
  groupsByUser.U_guest1 = [];
  r = await send({ userId: 'U_guest1', body: '部外者の要望' });
  check('個人チャット・所属なし: 呼ばない', notCalled(r), detail(r));
  check('個人チャット・所属なし: メンバーだけと返す', r.reply === FEEDBACK_MEMBERS_ONLY_MESSAGE, detail(r));
  const rejected = findLog('Feedback rejected: the sender is not a household member');
  check(
    '拒否を固定文 + オブジェクトでログに出す（利用者 ID は伏せる）',
    rejected && rejected.args.length === 2 && rejected.args[1].user === '…est1',
    JSON.stringify(rejected?.args)
  );

  groupsByUser.U_self1 = [selfMade];
  r = await send({ userId: 'U_self1', body: '自作グループの人の要望' });
  check('個人チャット・自作グループ（lineGroupId なし）だけ: 呼ばない', notCalled(r) && r.reply === FEEDBACK_MEMBERS_ONLY_MESSAGE, detail(r));

  groupsByUser.U_guest2 = [];
  r = await send({ userId: 'U_guest2', lineGroupId: 'L_house', body: '世帯のグループにいる部外者の要望' });
  check('世帯の LINE グループにいる非メンバー: 呼ばない', notCalled(r) && r.reply === FEEDBACK_MEMBERS_ONLY_MESSAGE, detail(r));

  groupsByUser.U_member3 = [household];
  r = await send({ userId: 'U_member3', lineGroupId: 'L_other', body: '別のグループでの要望' });
  check('世帯のメンバーでも、世帯に紐づかない LINE グループでの発言: 呼ばない', notCalled(r) && r.reply === FEEDBACK_MEMBERS_ONLY_MESSAGE, detail(r));

  console.log('\n# 所属の確認に失敗（Firestore の障害）→ 拒否側に倒す');
  logs.length = 0;
  groupsByUser.U_fail1 = [household];
  failingUsers.add('U_fail1');
  r = await send({ userId: 'U_fail1', body: '障害中の要望' });
  check('メンバーでも呼ばない', notCalled(r), detail(r));
  check('確認に失敗したと返す', /メンバーの確認に失敗しました/.test(r.reply ?? ''), detail(r));
  const lookupFailed = findLog('Feedback rejected: household membership lookup failed');
  check(
    '失敗を固定文 + オブジェクトで warn に出す（利用者 ID は伏せる）',
    lookupFailed?.level === 'warn' && lookupFailed.args[1]?.user === '…ail1',
    JSON.stringify(lookupFailed?.args)
  );
  failingUsers.delete('U_fail1');
  r = await send({ userId: 'U_fail1', body: '復旧後の要望' });
  check('復旧すれば受け付ける（失敗を件数に数えていない・覚えていない）', created(r), detail(r));

  console.log('\n# userId が無い（LINE グループで、Bot を友だち追加していない人）→ 所属を読まずに拒否');
  r = await send({ lineGroupId: 'L_house', body: 'IDなしの要望' });
  check('所属を読まない', r.lookups === 0, detail(r));
  check('呼ばない', notCalled(r), detail(r));
  check('確認できなかったと返す', /送った人を確認できなかった/.test(r.reply ?? ''), detail(r));

  console.log('\n# 本文が空 → 使い方を返す（所属を読まない）');
  r = await captureLogs(async () => {
    const before = { lookups: getUserGroupsCalls, gemini: geminiPrompts.length, github: githubPosts.length };
    const handled = await handleFeedbackCommand({ replyToken: 'reply-token', source: { type: 'user', userId: 'U_empty' } }, '要望 　');
    return { handled, lookups: getUserGroupsCalls - before.lookups, gemini: geminiPrompts.length - before.gemini, github: githubPosts.length - before.github, reply: replies[replies.length - 1]?.text };
  });
  check('使い方を返し、所属を読まず、呼ばない', r.handled && /フィードバック内容を入力してください/.test(r.reply ?? '') && r.lookups === 0 && notCalled(r), detail(r));

  console.log('\n# 本文の長さ（1,000 文字まで。コードポイントで数える）');
  logs.length = 0;
  groupsByUser.U_len1 = [household];
  for (let i = 0; i < FEEDBACK_RATE_LIMIT; i++) {
    r = await send({ userId: 'U_len1', body: 'あ'.repeat(1001) });
    check(`1,001 文字（${i + 1} 回目）: 呼ばず、長すぎると返す`, notCalled(r) && r.reply === FEEDBACK_TOO_LONG_MESSAGE, detail({ ...r, reply: r.reply }));
  }
  const tooLong = findLog('Feedback rejected: too long');
  check('長すぎるログは長さだけ（本文は出さない。利用者 ID は伏せる）', tooLong?.args[1]?.length === 1001 && tooLong.args[1].user === '…len1', JSON.stringify(tooLong?.args));
  r = await send({ userId: 'U_len1', body: 'い'.repeat(1000) });
  check('ちょうど 1,000 文字は受け付ける（長すぎた分は件数に数えていない）', created(r), detail({ ...r }));
  groupsByUser.U_len2 = [household];
  r = await send({ userId: 'U_len2', body: '😀'.repeat(1000) });
  check('絵文字 1,000 個（UTF-16 で 2,000）は受け付ける', created(r), detail(r));
  r = await send({ userId: 'U_len2', body: '😀'.repeat(1001) });
  check('絵文字 1,001 個は呼ばない', notCalled(r) && r.reply === FEEDBACK_TOO_LONG_MESSAGE, detail(r));

  console.log('\n# createIssueFromFeedback も、長すぎる本文では Gemini・GitHub を呼ばない');
  {
    const before = { gemini: geminiPrompts.length, github: githubPosts.length };
    const result = await captureLogs(() => createIssueFromFeedback('う'.repeat(1001)));
    check(
      '1,001 文字: 呼ばず、失敗として長すぎると返す',
      result.success === false && result.message === FEEDBACK_TOO_LONG_MESSAGE && geminiPrompts.length === before.gemini && githubPosts.length === before.github,
      JSON.stringify({ result, gemini: geminiPrompts.length - before.gemini, github: githubPosts.length - before.github })
    );
    const ok = await captureLogs(() => createIssueFromFeedback('え'.repeat(1000)));
    check('1,000 文字: 呼ぶ', ok.success === true && geminiPrompts.length === before.gemini + 1 && githubPosts.length === before.github + 1, JSON.stringify(ok));
  }

  console.log('\n# 件数の制限（同じ人は 10 分に 3 件まで）');
  logs.length = 0;
  groupsByUser.U_rate1 = [household];
  groupsByUser.U_rate2 = [household];
  clockOffset = 0;
  r = await send({ userId: 'U_rate1', body: '連続 1' });
  check('0 分: 1 件目は受け付ける', created(r), detail(r));
  clockOffset = 1 * MINUTE;
  r = await send({ userId: 'U_rate1', body: '連続 2' });
  check('1 分: 2 件目は受け付ける', created(r), detail(r));
  clockOffset = 2 * MINUTE;
  r = await send({ userId: 'U_rate1', body: '連続 3' });
  check('2 分: 3 件目は受け付ける', created(r), detail(r));
  r = await send({ userId: 'U_rate1', body: '連続 4' });
  check('2 分: 4 件目は呼ばず、上限を返す', notCalled(r) && RATE_MESSAGE_PATTERN.test(r.reply ?? ''), detail(r));
  const limited = findLog('Feedback rejected: rate limited');
  check('制限を固定文 + オブジェクトでログに出す（利用者 ID は伏せる）', limited?.args[1]?.user === '…ate1', JSON.stringify(limited?.args));
  r = await send({ userId: 'U_rate2', body: '別の人' });
  check('2 分: 別の人は数えない（受け付ける）', created(r), detail(r));
  clockOffset = 10 * MINUTE - 1;
  r = await send({ userId: 'U_rate1', body: '連続 5' });
  check('10 分の 1ms 前: 1 件目がまだ期間内なので呼ばない', notCalled(r) && RATE_MESSAGE_PATTERN.test(r.reply ?? ''), detail(r));
  clockOffset = 10 * MINUTE;
  r = await send({ userId: 'U_rate1', body: '連続 6' });
  check('ちょうど 10 分: 1 件目が外れて受け付ける（受け付けなかった分は数えていない）', created(r), detail(r));
  r = await send({ userId: 'U_rate1', body: '連続 7' });
  check('ちょうど 10 分: 続けて送ると呼ばない（1 分・2 分・10 分の 3 件）', notCalled(r) && RATE_MESSAGE_PATTERN.test(r.reply ?? ''), detail(r));
  clockOffset = 0;

  console.log('\n# メンバーでない人は、何度送ってもメンバーだけと返す（件数の制限はメンバーの確認の後）');
  groupsByUser.U_guest3 = [];
  let allMembersOnly = true;
  for (let i = 0; i < FEEDBACK_RATE_LIMIT + 2; i++) {
    r = await send({ userId: 'U_guest3', body: `部外者の連投 ${i}` });
    if (!(notCalled(r) && r.reply === FEEDBACK_MEMBERS_ONLY_MESSAGE)) allMembersOnly = false;
  }
  check(`${FEEDBACK_RATE_LIMIT + 2} 回とも呼ばず、メンバーだけと返す（上限の返信にならない）`, allMembersOnly, detail(r));

  console.log('\n# フィードバックでない入力は処理しない');
  r = await captureLogs(() => handleFeedbackCommand({ replyToken: 'reply-token', source: { type: 'user', userId: 'U_other' } }, '500 ランチ'));
  check('false を返す', r === false);

  console.log('\n# ログ');
  const logged = JSON.stringify(allLogs.map((l) => l.args.map((a) => (a instanceof Error ? a.message : a))));
  check('ログに利用者 ID を出さない', allLogs.length > 0 && !userIds.some((id) => logged.includes(id)), logged);
  check('ログに本文を出さない', !bodies.some((body) => logged.includes(body)), logged);

  console.log(failed ? `\n${failed} failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
