/**
 * 要望・改善・不具合・フィードバックのコマンド（line/commands/feedback.ts・issueCreator.ts）のスモークテスト（#260）
 *
 * Gemini（generateJson）・GitHub（axios.post）・Firestore（getFirestore の偽物。groupMembers の文書だけを持つ）・
 * LINE の返信を偽物に差し替え、本物の API を呼ばずに次を検証する。
 * - 世帯（DEFAULT_GROUP_ID のグループ）の有効メンバーなら、Gemini で整理して Issue を作る（どのトークからでも。
 *   所属が複数あっても）。読み取りは groupMembers/{DEFAULT_GROUP_ID}_{userId} の 1 回だけ
 * - 世帯ではない LINE 連携グループだけの人・無効化された元メンバー・DEFAULT_GROUP_ID が無い・読み取りの例外・userId なし
 *   → Gemini も GitHub も呼ばない
 * - 本文が 1,000 文字（コードポイント）を超えたら呼ばない。超えた分は件数に数えない
 * - 同じ人は 10 分に 3 件まで（期間の境目、受け付けなかった分は数えないこと、人ごとに数えること）
 * - createIssueFromFeedback も、長すぎる本文では呼ばない
 * - 公開 Issue の本文: 元の本文はコードブロックに入れ、Gemini の結果はメンション・参照・HTML コメント・HTML タグ・
 *   リンク先を無効にし、長さを切る
 * - 使い方と作成できたときの返信に、公開されることの注意を付ける
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
process.env.DEFAULT_GROUP_ID = 'G_house';

const fromBot = (name) => require(require.resolve(name, { paths: [path.join(__dirname, '..')] }));

// --- GitHub（axios）の偽物。bot/dist が読み込むのと同じ axios を差し替える ---
const axios = fromBot('axios');
const githubPosts = [];
axios.post = async (url, body) => {
  githubPosts.push({ url, body });
  return { data: { html_url: `https://github.com/example/issues/${githubPosts.length}`, number: githubPosts.length } };
};

// --- Firestore の偽物（readActiveMember が読む groupMembers の文書だけ。dist は呼ぶたびに getFirestore を引く） ---
// memberDocs: 文書 ID → 文書。failingDocs に入れた文書 ID の読み取りは例外を投げる
const memberDocs = new Map();
const failingDocs = new Set();
const reads = [];
const fakeDb = {
  collection: (name) => ({
    doc: (id) => ({
      get: async () => {
        reads.push(`${name}/${id}`);
        if (failingDocs.has(id)) throw new Error('firestore unavailable');
        const data = name === 'groupMembers' ? memberDocs.get(id) : undefined;
        return { exists: data !== undefined, get: (field) => data?.[field] };
      },
    }),
  }),
};
fromBot('firebase-admin/firestore').getFirestore = () => fakeDb;

/** groupMembers/{groupId}_{lineId}（scripts/manage-group-members.mjs と同じ形） */
function putMember(groupId, lineId, isActive = true) {
  memberDocs.set(`${groupId}_${lineId}`, { groupId, lineId, isActive, displayName: 'テスト' });
}

// --- Gemini・LINE の偽物（feedback / issueCreator は呼び出し時に exports を参照する） ---
const geminiClient = require('../dist/geminiClient');
const lineClient = require('../dist/line/client');

const geminiPrompts = [];
const defaultAnalysis = {
  title: '月別のグラフを見たい',
  type: '機能要件',
  summary: '要約',
  details: '詳細',
  acceptanceCriteria: ['条件1', '条件2'],
};
let geminiReply = defaultAnalysis;
geminiClient.generateJson = async (prompt) => {
  geminiPrompts.push(prompt);
  return geminiReply;
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
  FEEDBACK_PUBLIC_NOTICE,
} = require('../dist/line/commands/feedback');
const {
  createIssueFromFeedback,
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_TOO_LONG_MESSAGE,
  ISSUE_TITLE_MAX_LENGTH,
  sanitizeIssueTitle,
  sanitizeIssueMarkdown,
  fencedOriginalText,
} = require('../dist/issueCreator');

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

/**
 * 1 通送る。返り値はこの 1 通で増えた呼び出しの数と返信
 * @param source 'user'（既定）/ 'group' / 'room'
 */
async function send({ userId, source = 'user', lineGroupId = 'L_house', body, prefix = '要望', logBody = true }) {
  if (logBody) bodies.push(body);
  if (userId) userIds.push(userId);
  const src = source === 'group' ? { type: 'group', groupId: lineGroupId } : source === 'room' ? { type: 'room', roomId: 'R_1' } : { type: 'user' };
  if (userId) src.userId = userId;
  const event = { replyToken: 'reply-token', source: src };
  const before = { gemini: geminiPrompts.length, github: githubPosts.length, reads: reads.length, replies: replies.length };
  const handled = await captureLogs(() => handleFeedbackCommand(event, `${prefix} ${body}`));
  return {
    handled,
    gemini: geminiPrompts.length - before.gemini,
    github: githubPosts.length - before.github,
    reads: reads.slice(before.reads),
    reply: replies.length > before.replies ? replies[replies.length - 1].text : undefined,
  };
}
const created = (r) => r.gemini === 1 && r.github === 1 && /^Issueを作成しました/.test(r.reply ?? '');
const notCalled = (r) => r.gemini === 0 && r.github === 0;
const detail = (r) => JSON.stringify(r);
const findLog = (message) => logs.find((l) => l.args[0] === message);
const show = (s) => JSON.stringify(String(s).replace(/\u200B/g, '<ZW>'));

const RATE_MESSAGE_PATTERN = /10 分に 3 件まで/;

/** Issue の本文を、元の本文のコードブロック（inside）とそれ以外（outside）に分ける */
function splitIssueBody(body) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^`{3,}text$/.test(l));
  if (start < 0) return null;
  const fence = lines[start].slice(0, -'text'.length);
  const end = lines.findIndex((l, i) => i > start && l === fence);
  if (end < 0) return null;
  return {
    fence,
    inside: lines.slice(start + 1, end).join('\n'),
    outside: [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n'),
  };
}
/** Markdown として働きうるもの（メンション・参照・HTML コメント・タグ・リンク・自動リンク）が残っていれば、その名前 */
function liveMarkup(text) {
  const found = [];
  if (/(^|[^A-Za-z0-9_])@[A-Za-z0-9]/.test(text)) found.push('mention');
  if (/#\d/.test(text)) found.push('issue ref');
  if (/\bGH-\d/i.test(text)) found.push('GH ref');
  if (/<!--/.test(text)) found.push('html comment');
  if (/<\/?[A-Za-z]/.test(text)) found.push('html tag');
  if (/\]\(/.test(text)) found.push('markdown link');
  if (/:\/\//.test(text)) found.push('autolink');
  if (/(^|\n) {0,3}(`{3,}|~{3,})/.test(text)) found.push('code fence');
  return found;
}

async function main() {
  console.log('\n# 定数');
  check('上限は 1,000 文字', FEEDBACK_MAX_LENGTH === 1000);
  check('件数は 10 分に 3 件', FEEDBACK_RATE_LIMIT === 3 && FEEDBACK_RATE_WINDOW_MS === 10 * MINUTE);
  check('長すぎるときの返信に上限を書く', FEEDBACK_TOO_LONG_MESSAGE.includes('1,000 文字以内'), FEEDBACK_TOO_LONG_MESSAGE);
  check('公開の注意に、公開リポジトリと個人情報を書く', /公開リポジトリ/.test(FEEDBACK_PUBLIC_NOTICE) && /個人情報/.test(FEEDBACK_PUBLIC_NOTICE), FEEDBACK_PUBLIC_NOTICE);

  console.log('\n# 世帯（DEFAULT_GROUP_ID）の有効メンバー → Gemini で整理して Issue を作る');
  logs.length = 0;
  putMember('G_house', 'U_member1');
  let r = await send({ userId: 'U_member1', body: '月別のグラフが見たい' });
  check('コマンドとして処理する', r.handled === true);
  check('Gemini を 1 回・GitHub を 1 回呼び、作成を返信', created(r), detail(r));
  check('読み取りは groupMembers/{DEFAULT_GROUP_ID}_{userId} の 1 回だけ', r.reads.length === 1 && r.reads[0] === 'groupMembers/G_house_U_member1', detail(r.reads));
  check('作成の返信に、公開の注意を付ける', r.reply?.endsWith(FEEDBACK_PUBLIC_NOTICE), detail(r));
  check('Gemini のプロンプトに本文が入る', geminiPrompts[geminiPrompts.length - 1]?.includes('月別のグラフが見たい'));
  let post = githubPosts[githubPosts.length - 1];
  check('公開リポジトリに Issue を作る', post?.url === 'https://api.github.com/repos/Makoto041/line-kakeibo/issues', post?.url);
  check('ラベルは固定（user-feedback と種別）', JSON.stringify(post?.body?.labels) === JSON.stringify(['user-feedback', '機能要件']), JSON.stringify(post?.body?.labels));
  check('拒否のログは出さない', !logs.some((l) => String(l.args[0]).startsWith('Feedback rejected')));

  for (const prefix of ['改善', '不具合', 'フィードバック']) {
    putMember('G_house', `U_prefix_${prefix}`);
    r = await send({ userId: `U_prefix_${prefix}`, body: `${prefix}の本文`, prefix });
    check(`「${prefix}」でも同じ（メンバーなら Issue を作る）`, created(r), detail(r));
  }

  putMember('G_house', 'U_member2');
  r = await send({ userId: 'U_member2', source: 'group', lineGroupId: 'L_house', body: 'グループからの要望' });
  check('世帯の LINE グループから: 作る', created(r), detail(r));
  r = await send({ userId: 'U_member2', source: 'group', lineGroupId: 'L_other', body: '別のグループからの要望' });
  check('世帯に紐づかない LINE グループから: 作る（どのトークでも世帯のメンバーかで決める）', created(r), detail(r));
  r = await send({ userId: 'U_member2', source: 'room', body: '複数人トークからの要望' });
  check('複数人トーク（room）から: 作る（1 対 1 と同じ）', created(r), detail(r));

  putMember('G_self', 'U_multi');
  putMember('G_legacy', 'U_multi');
  putMember('G_house', 'U_multi');
  r = await send({ userId: 'U_multi', body: '所属が複数ある人の要望' });
  check('所属が複数ある世帯のメンバー: 作る（世帯の文書だけを読む）', created(r) && r.reads.length === 1 && r.reads[0] === 'groupMembers/G_house_U_multi', detail(r));

  console.log('\n# 世帯の有効メンバーでない → Gemini も GitHub も呼ばない');
  logs.length = 0;
  r = await send({ userId: 'U_guest1', body: '部外者の要望' });
  check('所属なし: 呼ばない', notCalled(r), detail(r));
  check('所属なし: メンバーだけと返す', r.reply === FEEDBACK_MEMBERS_ONLY_MESSAGE, detail(r));
  check('所属なし: 読み取りは 1 回', r.reads.length === 1, detail(r.reads));
  const rejected = findLog('Feedback rejected: the sender is not a household member');
  check(
    '拒否を固定文 + オブジェクトでログに出す（利用者 ID は伏せる）',
    rejected && rejected.args.length === 2 && rejected.args[1].user === '…est1',
    JSON.stringify(rejected?.args)
  );

  putMember('G_legacy', 'U_legacy1');
  putMember('G_self', 'U_legacy1');
  r = await send({ userId: 'U_legacy1', source: 'group', lineGroupId: 'L_legacy', body: '世帯ではない LINE 連携グループの人の要望' });
  check('世帯ではない LINE 連携グループ・自作グループにだけ所属（そのグループの LINE グループから）: 呼ばない', notCalled(r) && r.reply === FEEDBACK_MEMBERS_ONLY_MESSAGE, detail(r));
  r = await send({ userId: 'U_legacy1', body: '世帯ではない LINE 連携グループの人の要望（1 対 1）' });
  check('同じ人の 1 対 1 から: 呼ばない', notCalled(r) && r.reply === FEEDBACK_MEMBERS_ONLY_MESSAGE, detail(r));

  putMember('G_house', 'U_former', false);
  r = await send({ userId: 'U_former', source: 'group', lineGroupId: 'L_house', body: '元メンバーの要望' });
  check('無効化された元メンバー（isActive:false）: 呼ばない', notCalled(r) && r.reply === FEEDBACK_MEMBERS_ONLY_MESSAGE, detail(r));

  memberDocs.set('G_house_U_forged', { groupId: 'G_other', lineId: 'U_forged', isActive: true });
  r = await send({ userId: 'U_forged', body: '文書の中身が合わない人の要望' });
  check('文書 ID は合うが中身の groupId が違う: 呼ばない（readActiveMember の照合）', notCalled(r) && r.reply === FEEDBACK_MEMBERS_ONLY_MESSAGE, detail(r));

  console.log('\n# DEFAULT_GROUP_ID が無い → 読まずに拒否');
  logs.length = 0;
  for (const value of [undefined, '']) {
    if (value === undefined) delete process.env.DEFAULT_GROUP_ID;
    else process.env.DEFAULT_GROUP_ID = value;
    r = await send({ userId: 'U_member1', body: '設定なしの要望' });
    check(`${value === undefined ? '未設定' : '空文字'}: 世帯のメンバーでも呼ばず、読まない`, notCalled(r) && r.reads.length === 0 && /現在、このコマンドは使えません/.test(r.reply ?? ''), detail(r));
  }
  const notSet = findLog('Feedback rejected: DEFAULT_GROUP_ID is not set');
  check('設定の欠けを error に出す（利用者 ID は伏せる）', notSet?.level === 'error' && notSet.args[1]?.user === '…ber1', JSON.stringify(notSet?.args));
  process.env.DEFAULT_GROUP_ID = 'G_house';

  console.log('\n# 読み取りの例外（Firestore の障害）→ 拒否側に倒す');
  logs.length = 0;
  putMember('G_house', 'U_fail1');
  failingDocs.add('G_house_U_fail1');
  r = await send({ userId: 'U_fail1', body: '障害中の要望' });
  check('メンバーでも呼ばない', notCalled(r), detail(r));
  check('確認に失敗したと返す', /メンバーの確認に失敗しました/.test(r.reply ?? ''), detail(r));
  const lookupFailed = findLog('Feedback rejected: household membership lookup failed');
  check(
    '失敗を固定文 + オブジェクトで warn に出す（利用者 ID は伏せる）',
    lookupFailed?.level === 'warn' && lookupFailed.args[1]?.user === '…ail1',
    JSON.stringify(lookupFailed?.args)
  );
  failingDocs.delete('G_house_U_fail1');
  r = await send({ userId: 'U_fail1', body: '復旧後の要望' });
  check('復旧すれば受け付ける', created(r), detail(r));

  console.log('\n# userId が無い（LINE グループで、Bot を友だち追加していない人）→ 読まずに拒否');
  r = await send({ source: 'group', lineGroupId: 'L_house', body: 'IDなしの要望' });
  check('読まない', r.reads.length === 0, detail(r));
  check('呼ばない', notCalled(r), detail(r));
  check('確認できなかったと返し、世帯のメンバーは友だち追加で使えると案内する', /送った人を確認できなかった/.test(r.reply ?? '') && /世帯のメンバーは、この Bot を友だち追加すると使えます/.test(r.reply ?? ''), detail(r));

  console.log('\n# 本文が空 → 使い方を返す（読まない）');
  r = await captureLogs(async () => {
    const before = { reads: reads.length, gemini: geminiPrompts.length, github: githubPosts.length };
    const handled = await handleFeedbackCommand({ replyToken: 'reply-token', source: { type: 'user', userId: 'U_empty' } }, '要望 　');
    return { handled, reads: reads.length - before.reads, gemini: geminiPrompts.length - before.gemini, github: githubPosts.length - before.github, reply: replies[replies.length - 1]?.text };
  });
  check('使い方を返し、読まず、呼ばない', r.handled && /フィードバック内容を入力してください/.test(r.reply ?? '') && r.reads === 0 && notCalled(r), detail(r));
  check('使い方に、公開の注意を付ける', r.reply?.includes(FEEDBACK_PUBLIC_NOTICE), detail(r));

  console.log('\n# 本文の長さ（1,000 文字まで。コードポイントで数える）');
  logs.length = 0;
  putMember('G_house', 'U_len1');
  for (let i = 0; i < FEEDBACK_RATE_LIMIT; i++) {
    r = await send({ userId: 'U_len1', body: 'あ'.repeat(1001) });
    check(`1,001 文字（${i + 1} 回目）: 呼ばず、長すぎると返す`, notCalled(r) && r.reply === FEEDBACK_TOO_LONG_MESSAGE, detail(r));
  }
  const tooLong = findLog('Feedback rejected: too long');
  check('長すぎるログは長さだけ（本文は出さない。利用者 ID は伏せる）', tooLong?.args[1]?.length === 1001 && tooLong.args[1].user === '…len1', JSON.stringify(tooLong?.args));
  r = await send({ userId: 'U_len1', body: 'い'.repeat(1000) });
  check('ちょうど 1,000 文字は受け付ける（長すぎた分は件数に数えていない）', created(r), detail(r));
  putMember('G_house', 'U_len2');
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
  putMember('G_house', 'U_rate1');
  putMember('G_house', 'U_rate2');
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
  let allMembersOnly = true;
  for (let i = 0; i < FEEDBACK_RATE_LIMIT + 2; i++) {
    r = await send({ userId: 'U_guest3', body: `部外者の連投 ${i}` });
    if (!(notCalled(r) && r.reply === FEEDBACK_MEMBERS_ONLY_MESSAGE)) allMembersOnly = false;
  }
  check(`${FEEDBACK_RATE_LIMIT + 2} 回とも呼ばず、メンバーだけと返す（上限の返信にならない）`, allMembersOnly, detail(r));

  console.log('\n# 公開 Issue の本文の無害化（関数）');
  const hostile = '@victim と @org/team、other/repo#1 と #2 と GH-3 <!-- 隠し --> [リンク](https://evil.example/x) ![画像](https://evil.example/i.png) <b>太字</b> <img src=x onerror=alert(1)> <https://evil.example> https://github.com/other/repo/issues/1 www.evil.example &#64;victim\n\n```\n閉じさせる\n~~~';
  const md = sanitizeIssueMarkdown(hostile, 2000, { multiline: true });
  check('Markdown: メンション・参照・コメント・タグ・リンク・自動リンク・フェンスが残らない', liveMarkup(md).length === 0, `${liveMarkup(md)} ${show(md)}`);
  check('Markdown: 隠し文（HTML コメントの中身）とリンク先を除く', !md.includes('隠し') && !md.includes('evil.example/x') && !md.includes('i.png'), show(md));
  check('Markdown: リンクの表示文字・メンションの名前は読める形で残る', md.includes('リンク') && md.includes('画像') && md.includes('victim') && md.includes('org/team'), show(md));
  check('Markdown: 文字参照のメンション（&#64;）も働かない', md.includes('&amp;#'), show(md));
  check('Markdown: 閉じていない HTML コメントは末尾まで除く', sanitizeIssueMarkdown('前 <!-- 隠し 後ろ', 100, { multiline: true }) === '前', show(sanitizeIssueMarkdown('前 <!-- 隠し 後ろ', 100, { multiline: true })));
  check('Markdown: 長さを切る', Array.from(sanitizeIssueMarkdown('あ'.repeat(300), 200, { multiline: false })).length === 200);
  check('Markdown: 1 行の項目は改行をまとめる', !sanitizeIssueMarkdown('一\n\n二', 200, { multiline: false }).includes('\n'));

  const title = sanitizeIssueTitle(`<!-- 隠し -->@victim を other/repo#1 で <b>直す</b> [リンク](https://evil.example) ${'あ'.repeat(200)}`);
  check('タイトル: メンション・参照・コメント・タグ・リンク先が残らない', liveMarkup(title).length === 0 && !title.includes('隠し') && !title.includes('evil') && title.includes('直す'), show(title));
  check(`タイトル: ${ISSUE_TITLE_MAX_LENGTH} 文字前後で切る（ゼロ幅スペースを除いて）`, Array.from(title.replace(/\u200B/g, '')).length === ISSUE_TITLE_MAX_LENGTH, show(title));
  check('タイトル: 無害化して空なら固定のタイトル', sanitizeIssueTitle('<!-- だけ -->') === 'LINE からのフィードバック');

  const fenced = fencedOriginalText('a ```` b\n\n@victim');
  check('元の本文: フェンスは本文中のバッククォートの最長の連続より長い', fenced.startsWith('`````text\n') && fenced.endsWith('\n`````'), show(fenced));
  check('元の本文: フェンスは 3 個以上', fencedOriginalText('x').startsWith('```text\n'));

  console.log('\n# 公開 Issue の本文の無害化（コマンドから作った Issue）');
  putMember('G_house', 'U_hostile');
  geminiReply = {
    title: '@victim の other/repo#1 を直す <!-- 隠し -->',
    type: '機能要件',
    summary: '@org/team に知らせる <b>太字</b> [リンク](https://evil.example/phish)',
    details: '詳細\n\n<!-- 隠し指示 -->\n```\nフェンスを閉じさせる\n#3 と https://github.com/other/repo/issues/9',
    acceptanceCriteria: ['@victim', 'other/repo#1', '<!-- c -->', '[a](https://evil.example)', '5', '6', '7'],
  };
  const original = '前半の文\n\n@victim と other/repo#1 <!-- 隠し --> [リンク](https://evil.example)\n> 引用を抜ける\n```` で閉じさせる';
  r = await send({ userId: 'U_hostile', body: original, logBody: false });
  check('Issue を作る', created(r), detail(r));
  post = githubPosts[githubPosts.length - 1];
  const parts = splitIssueBody(post.body.body);
  check('元の本文はコードブロックの中にそのまま入る（空行で引用を抜けない）', parts?.inside === original, show(post.body.body));
  check('元の本文のフェンスは、本文中の最長の連続（4）より長い', parts?.fence === '`````', parts?.fence);
  check('コードブロックの外に、メンション・参照・コメント・タグ・リンク・自動リンク・フェンスが残らない', parts && liveMarkup(parts.outside).length === 0, `${parts && liveMarkup(parts.outside)} ${show(parts?.outside)}`);
  check('コードブロックの外に、隠し文とリンク先を残さない', parts && !parts.outside.includes('隠し') && !parts.outside.includes('evil.example'), show(parts?.outside));
  check('受け入れ条件は 5 個まで', (parts?.outside.match(/^- \[ \] /gm) || []).length === 5, show(parts?.outside));
  check('タイトルも無害化する', liveMarkup(post.body.title).length === 0 && !post.body.title.includes('隠し'), show(post.body.title));
  check('ラベルは固定のまま', JSON.stringify(post.body.labels) === JSON.stringify(['user-feedback', '機能要件']), JSON.stringify(post.body.labels));

  geminiReply = null; // Gemini が使えないとき（代わりに本文から作る）
  putMember('G_house', 'U_hostile2');
  const original2 = '@victim other/repo#1 <!-- 隠し --> [リンク](https://evil.example)';
  r = await send({ userId: 'U_hostile2', body: original2, logBody: false });
  post = githubPosts[githubPosts.length - 1];
  const parts2 = splitIssueBody(post.body.body);
  check('Gemini が使えないとき: Issue を作る', created(r), detail(r));
  check('Gemini が使えないとき: 本文から作ったタイトル・概要・詳細も無害化する', parts2 && liveMarkup(parts2.outside).length === 0 && liveMarkup(post.body.title).length === 0, `${show(post.body.title)} ${show(parts2?.outside)}`);
  check('Gemini が使えないとき: 元の本文はコードブロックにそのまま', parts2?.inside === original2, show(post.body.body));
  geminiReply = defaultAnalysis;

  console.log('\n# フィードバックでない入力は処理しない');
  r = await captureLogs(() => handleFeedbackCommand({ replyToken: 'reply-token', source: { type: 'user', userId: 'U_other' } }, '500 ランチ'));
  check('false を返す', r === false);

  console.log('\n# ログ');
  const logged = JSON.stringify(allLogs.map((l) => l.args.map((a) => (a instanceof Error ? a.message : a))));
  check('ログに利用者 ID を出さない', allLogs.length > 0 && !userIds.some((id) => logged.includes(id)), logged);
  check('ログに本文を出さない', !bodies.some((body) => logged.includes(body)) && !logged.includes('前半の文'), logged);

  console.log(failed ? `\n${failed} failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
