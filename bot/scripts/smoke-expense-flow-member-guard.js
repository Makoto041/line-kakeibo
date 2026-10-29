/**
 * LINE のテキスト入力（processExpenseInBackground）で、世帯メンバーでない送信者の入力ではモデル（Jev・Gemini）を
 * 呼ばないことのスモークテスト（#245）
 *
 * @typesafe-ai/sdk の TypeSafeClient・Gemini・Firestore・LINE のクライアント・登録カードの送信を偽物に差し替え、
 * 本物の API を呼ばずに次を検証する。
 * - 個人チャット: LINE グループに紐づく世帯の有効メンバーなら従来どおり（辞書 → Jev → Gemini）
 * - 個人チャット: 所属なし・自作グループ（lineGroupId なし）だけなら辞書だけ（決まらなければ既定カテゴリか「その他」）
 * - LINE グループ: 発言元の LINE グループに紐づく世帯の有効メンバーなら従来どおり。非メンバー・紐づく世帯なしは辞書だけ
 * - 世帯の確認（getUserGroups・findLineGroupId）が失敗したらモデルを呼ぶ。個人チャットの失敗はキャッシュに残さない
 * - 個人チャットのキャッシュの期限は取得した時点から 15 分で、キャッシュに当たっても延びない
 * - プロフィールの取得に失敗した（表示名が取れなかった）入力は保存せず、その結果をキャッシュに残さない。
 *   次の入力で取り直して保存する（個人チャット・LINE グループとも。#261）
 * - lineGroupId を持つ、世帯ではないグループのメンバーは、メンバーとみなされモデルを呼ぶ（今の判定の定義のまま）
 * - 中項目（辞書で決まらない食費・娯楽だけ Jev に聞く。subCategoryClassifier.ts）: メンバーなら、大項目が既定カテゴリに
 *   置き換わったときも、カテゴリを指定したときも聞く。メンバーでなければ指定の有無にかかわらず聞かない。
 *   大項目の Jev が失敗して Gemini で決まったときは聞かない。中項目の Jev が失敗しても中項目なしで保存し、カードも送る
 * - ログに利用者 ID・入力を出さない
 *   node bot/scripts/smoke-expense-flow-member-guard.js
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

// 手元のシェルに本物の鍵があっても使わない（main で架空の値を入れる）
delete process.env.TYPESAFE_API_KEY;
delete process.env.GEMINI_API_KEY;

// --- @typesafe-ai/sdk の偽物（smoke-jev-classifier.js と同じ方法。classifier を読み込む前に差し替える） ---
// 質問の名前で答え分ける（大項目は category、中項目は subCategory）。jevCalls は両方の要求
const sdkPath = require.resolve('@typesafe-ai/sdk', { paths: [path.join(__dirname, '..')] });
const realSdk = require(sdkPath);
let jevCalls = [];
const answerOf = (name, choice, confidence) => ({
  model: 'jev-1.13.0',
  answers: { [name]: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } },
  usage: { input_tokens: 100, output_tokens: 0 },
});
const DEFAULT_MAJOR = () => answerOf('category', '娯楽', 0.9);
const DEFAULT_SUB = () => answerOf('subCategory', 'スポーツ・アウトドア', 0.9);
let majorBehavior = DEFAULT_MAJOR;
let subBehavior = DEFAULT_SUB;
class FakeTypeSafeClient {
  async systemOne(request) {
    jevCalls.push(request);
    return 'subCategory' in (request.questions || {}) ? subBehavior(request) : majorBehavior(request);
  }
}
/** 大項目の要求（category の質問）・中項目の要求（subCategory の質問） */
const majorCalls = () => jevCalls.filter((r) => 'category' in (r.questions || {}));
const subCalls = () => jevCalls.filter((r) => 'subCategory' in (r.questions || {}));
require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  loaded: true,
  exports: { ...realSdk, TypeSafeClient: FakeTypeSafeClient },
};

// --- Gemini・Firestore・LINE・登録カードの偽物（expenseFlow は呼び出し時に exports を参照する） ---
const geminiClient = require('../dist/geminiClient');
const firestore = require('../dist/firestore');
const lineClient = require('../dist/line/client');
const flexMessage = require('../dist/line/flexMessage');
const linkUserResolver = require('../dist/linkUserResolver');

let geminiCalls = 0;
let geminiReply = { category: '娯楽', confidence: 0.9 };
geminiClient.generateJson = async () => {
  geminiCalls++;
  return geminiReply;
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
// findLineGroupId の結果（LINE グループ ID ごと）。failingLineGroups に入れた ID では例外を投げる
const groupIdByLineGroup = { L_house: 'G_house' };
const failingLineGroups = new Set();
firestore.findLineGroupId = async (lineGroupId) => {
  if (failingLineGroups.has(lineGroupId)) throw new Error('firestore unavailable');
  return Object.hasOwn(groupIdByLineGroup, lineGroupId) ? groupIdByLineGroup[lineGroupId] : null;
};
const settingsByUser = {};
firestore.getUserSettings = async (lineId) => settingsByUser[lineId] ?? null;
firestore.getAllUserCategories = async () => [];
const saved = [];
firestore.saveExpense = async (expense) => {
  saved.push(expense);
  return `exp_${saved.length}`;
};
linkUserResolver.resolveAppUidForExpense = async (lineId) => `app_${lineId}`;
// LINE のプロフィール。failingProfileUsers に入れた lineId ではすぐに例外を投げ（リトライの待ちを短くする）、
// emptyNameUsers に入れた lineId では表示名を空で返す。失敗の返信（replyWithPushFallback）は replies に集める
// （replyWithPushFallback は client.ts の中で getLineClient を直接呼ぶので、関数ごと差し替える）
const failingProfileUsers = new Set();
const emptyNameUsers = new Set();
let profileCalls = 0;
let groupProfileCalls = 0;
function fakeProfile(userId) {
  if (failingProfileUsers.has(userId)) throw new Error('line api unavailable');
  return { displayName: emptyNameUsers.has(userId) ? '' : 'テスト' };
}
const replies = [];
const fakeLine = {
  getProfile: async (userId) => {
    profileCalls++;
    return fakeProfile(userId);
  },
  getGroupMemberProfile: async (_lineGroupId, userId) => {
    groupProfileCalls++;
    return fakeProfile(userId);
  },
};
lineClient.getLineClient = () => fakeLine;
lineClient.replyWithPushFallback = async (_replyToken, _to, messages) => {
  replies.push(...messages);
  return 'reply';
};
const cards = [];
flexMessage.sendTextExpenseNotification = async (targetId, info) => {
  cards.push({ targetId, info });
};

// 時計（キャッシュの期限のケースで進める）。expenseFlow はキャッシュの期限を Date.now() で判定する
const MINUTE = 60 * 1000;
const realDateNow = Date.now;
let clockOffset = 0;
Date.now = () => realDateNow() + clockOffset;

const { processExpenseInBackground } = require('../dist/line/expenseFlow');

// 処理中のログを集める（画面には出さない）。logs はケースごとに消し、allLogs は最後の確認に使う
const logs = [];
const allLogs = [];
const inputs = [];
const userIds = [];
async function post({ userId, lineGroupId, description, category }) {
  inputs.push(description);
  userIds.push(userId);
  const event = {
    source: lineGroupId ? { type: 'group', groupId: lineGroupId, userId } : { type: 'user', userId },
  };
  // category は入力でカテゴリを指定したとき（textParser.ts の parseTextExpense が返す名前）
  const parsed = { amount: 500, description, date: '2026-10-25', paymentMethod: 'unknown', ...(category ? { category } : {}) };
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      logs.push({ level, args });
      allLogs.push({ level, args });
    };
  }
  const before = { saved: saved.length, cards: cards.length, replies: replies.length };
  try {
    await processExpenseInBackground(event, parsed, 'reply-token');
  } finally {
    Object.assign(console, original);
  }
  // 保存しなかった回は expense・card を undefined にする（前の回の支出を拾わない）
  return {
    expense: saved.length > before.saved ? saved[saved.length - 1] : undefined,
    card: cards.length > before.cards ? cards[cards.length - 1].info : undefined,
    replies: replies.slice(before.replies),
  };
}
function reset() {
  jevCalls = [];
  geminiCalls = 0;
  getUserGroupsCalls = 0;
  profileCalls = 0;
  groupProfileCalls = 0;
  logs.length = 0;
  majorBehavior = DEFAULT_MAJOR;
  subBehavior = DEFAULT_SUB;
  geminiReply = { category: '娯楽', confidence: 0.9 };
}
const subModelLog = () => logs.filter((l) => l.args[0] === 'Subcategory classified by model').pop()?.args[1];
const PROFILE_ERROR_TEXT = 'ユーザー情報の取得に失敗しました';
const profileErrorReplied = (r) => r.replies.some((m) => m.type === 'text' && m.text.includes(PROFILE_ERROR_TEXT));
const profileErrorLog = () => logs.find((l) => l.args[0] === 'PROFILE ERROR: Failed to get user profile');
const skipLog = () => logs.find((l) => l.args[0] === 'Skipping category models: poster is not a household member');
const failOpenLog = () => logs.find((l) => l.args[0] === 'Household membership lookup failed; classifying with models');

async function main() {
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.GEMINI_API_KEY = 'test-key';

  console.log('\n# 個人チャット: 世帯メンバー → 従来どおり Jev');
  reset();
  groupsByUser.U_member1 = [household];
  let r = await post({ userId: 'U_member1', description: 'ボルダリング' });
  check('Jev を 1 回呼ぶ（中項目は辞書で決まり、聞かない）', majorCalls().length === 1 && subCalls().length === 0 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);
  check('中項目は辞書（ボルダリング → スポーツ・アウトドア）', r.expense?.subCategory === 'スポーツ・アウトドア', JSON.stringify(r.expense));
  check('Jev の結果で保存し、判定元は jev', r.expense?.category === '娯楽' && r.card?.categoryOrigin === 'jev', JSON.stringify(r.card));
  check('世帯の支出（groupId）として保存', r.expense?.groupId === 'G_house' && r.expense?.lineGroupId === undefined, JSON.stringify(r.expense));
  check('スキップのログは出さない', skipLog() === undefined);

  console.log('\n# 個人チャット: 所属なし → モデルを呼ばない');
  reset();
  groupsByUser.U_guest1 = [];
  r = await post({ userId: 'U_guest1', description: 'ボルダリング' });
  check('Jev・Gemini は呼ばれない', jevCalls.length === 0 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);
  check('辞書で決まらなければ「その他」（判定元は unclassified）', r.expense?.category === 'その他' && r.card?.categoryOrigin === 'unclassified', JSON.stringify(r.card));
  check('支出は保存する（個人支出）', r.expense && r.expense.groupId === undefined && r.expense.lineGroupId === undefined, JSON.stringify(r.expense));
  const skip = skipLog();
  check('スキップを固定文 + オブジェクトでログに出す（利用者 ID は伏せる）', skip && skip.args.length === 2 && skip.args[1].user === '…est1', JSON.stringify(skip?.args));

  reset();
  r = await post({ userId: 'U_guest1', description: 'ランチ' });
  check('辞書に当たれば辞書で決める（判定元は dictionary）', r.expense?.category === '食費' && r.card?.categoryOrigin === 'dictionary', JSON.stringify(r.card));
  check('辞書で決まっても Jev・Gemini は呼ばれない', jevCalls.length === 0 && geminiCalls === 0);

  reset();
  groupsByUser.U_guest2 = [];
  settingsByUser.U_guest2 = { defaultCategory: '娯楽費' };
  r = await post({ userId: 'U_guest2', description: 'カヌー' });
  check('既定カテゴリがあればそれ（旧名は正準名に。判定元は default）', r.expense?.category === '娯楽' && r.card?.categoryOrigin === 'default', JSON.stringify(r.card));
  check('既定カテゴリでも Jev・Gemini は呼ばれない', jevCalls.length === 0 && geminiCalls === 0);

  console.log('\n# 個人チャット: 自作グループ（「グループ作成」。lineGroupId なし）だけ → モデルを呼ばない');
  reset();
  groupsByUser.U_self1 = [selfMade];
  r = await post({ userId: 'U_self1', description: 'ボルダリング' });
  check('Jev・Gemini は呼ばれない', jevCalls.length === 0 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);
  check('支出は個人支出として保存（groupId を付けない。世帯の外の人の支出に groupId が付くと、Storage のレシート判定が世帯の支出とみなすため）', r.expense?.groupId === undefined && r.expense?.lineGroupId === undefined, JSON.stringify(r.expense));

  console.log('\n# 個人チャット: 世帯の確認に失敗 → モデルを呼ぶ（失敗はキャッシュに残さない）');
  reset();
  failingUsers.add('U_fail1');
  r = await post({ userId: 'U_fail1', description: 'ボルダリング' });
  check('Jev を呼ぶ', majorCalls().length === 1, `jev ${jevCalls.length}`);
  check('判定元は jev', r.card?.categoryOrigin === 'jev', JSON.stringify(r.card));
  const failOpen = failOpenLog();
  check('確認の失敗を固定文 + オブジェクトで warn に出す（利用者 ID は伏せる）', failOpen?.level === 'warn' && failOpen.args[1]?.user === '…ail1', JSON.stringify(failOpen?.args));
  reset();
  failingUsers.delete('U_fail1');
  groupsByUser.U_fail1 = [];
  r = await post({ userId: 'U_fail1', description: 'カヌー' });
  check('次の入力では所属を読み直す（失敗を「所属なし」としてキャッシュしていない）', getUserGroupsCalls === 1, `${getUserGroupsCalls} 回`);
  check('読み直した結果（所属なし）でモデルを呼ばない', jevCalls.length === 0 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);
  reset();
  r = await post({ userId: 'U_fail1', description: 'ヨット' });
  check('成功した結果はキャッシュする（読み直さない）', getUserGroupsCalls === 0 && jevCalls.length === 0, `${getUserGroupsCalls} 回`);

  console.log('\n# 個人チャット: キャッシュの期限は取得した時点から 15 分（キャッシュに当たっても延ばさない）');
  reset();
  groupsByUser.U_ttl1 = [household];
  r = await post({ userId: 'U_ttl1', description: 'ボルダリング' });
  check('最初の入力で所属を読む', getUserGroupsCalls === 1, `${getUserGroupsCalls} 回`);
  reset();
  clockOffset = 10 * MINUTE;
  r = await post({ userId: 'U_ttl1', description: 'カヌー' });
  // 「カヌー」は中項目が辞書で決まらないので、メンバーなら中項目も Jev に聞く（大項目 1 回 + 中項目 1 回）
  check('10 分後はキャッシュに当たる（読まない。世帯メンバーのまま）', getUserGroupsCalls === 0 && majorCalls().length === 1, `${getUserGroupsCalls} 回 / jev ${majorCalls().length}`);
  check('メンバーなので中項目も Jev に聞く', subCalls().length === 1 && r.expense?.subCategory === 'スポーツ・アウトドア', `${subCalls().length} 回 / ${JSON.stringify(r.expense)}`);
  reset();
  clockOffset = 16 * MINUTE;
  groupsByUser.U_ttl1 = []; // 管理スクリプトで無効化した想定
  r = await post({ userId: 'U_ttl1', description: 'ヨット' });
  check('取得から 16 分後（キャッシュに当たった回からは 6 分後）は読み直す', getUserGroupsCalls === 1, `${getUserGroupsCalls} 回`);
  check('読み直した結果（無効化）が反映され、モデルを呼ばず個人支出になる', jevCalls.length === 0 && geminiCalls === 0 && r.expense && r.expense.groupId === undefined, `jev ${jevCalls.length} / gemini ${geminiCalls} / ${JSON.stringify(r.expense)}`);
  clockOffset = 0;

  console.log('\n# 個人チャット: 取得できたプロフィールは 15 分キャッシュし、その間は取り直さない（#258 の挙動）');
  reset();
  groupsByUser.U_ttl2 = [household];
  r = await post({ userId: 'U_ttl2', description: 'ボルダリング' });
  check('最初の入力でプロフィールを取得し、保存する', profileCalls === 1 && r.expense?.userDisplayName === 'テスト', `${profileCalls} 回 / ${JSON.stringify(r.expense)}`);
  reset();
  clockOffset = 10 * MINUTE;
  r = await post({ userId: 'U_ttl2', description: 'カヌー' });
  check('10 分後はキャッシュに当たり、プロフィールを取り直さずに保存する', profileCalls === 0 && r.expense?.userDisplayName === 'テスト', `${profileCalls} 回 / ${JSON.stringify(r.expense)}`);
  reset();
  clockOffset = 16 * MINUTE;
  r = await post({ userId: 'U_ttl2', description: 'ヨット' });
  check('取得から 16 分後はプロフィールを取り直す', profileCalls === 1 && r.expense?.userDisplayName === 'テスト', `${profileCalls} 回 / ${JSON.stringify(r.expense)}`);
  clockOffset = 0;

  console.log('\n# 個人チャット: プロフィールの取得に失敗 → その入力は保存しない。失敗はキャッシュに残さず、次の入力で取り直す（#261）');
  reset();
  groupsByUser.U_prof1 = [household];
  failingProfileUsers.add('U_prof1');
  r = await post({ userId: 'U_prof1', description: 'ボルダリング' });
  check('支出を保存せず、カードも送らない', r.expense === undefined && r.card === undefined, JSON.stringify(r.expense));
  check('「ユーザー情報の取得に失敗しました」と返す', profileErrorReplied(r), JSON.stringify(r.replies));
  check('プロフィールは 3 回まで試す', profileCalls === 3, `${profileCalls} 回`);
  const profileError = profileErrorLog();
  check('失敗を固定文 + オブジェクトで error に出す（利用者 ID は伏せる）', profileError?.level === 'error' && profileError.args[1]?.user === '…rof1', JSON.stringify(profileError?.args));
  reset();
  failingProfileUsers.delete('U_prof1');
  clockOffset = 1 * MINUTE;
  r = await post({ userId: 'U_prof1', description: 'カヌー' });
  check('1 分後の入力でプロフィールと所属を取り直す（失敗をキャッシュしていない）', profileCalls === 1 && getUserGroupsCalls === 1, `profile ${profileCalls} 回 / groups ${getUserGroupsCalls} 回`);
  check('取り直した表示名で、世帯の支出として保存する', r.expense?.userDisplayName === 'テスト' && r.expense?.payerDisplayName === 'テスト' && r.expense?.groupId === 'G_house', JSON.stringify(r.expense));
  check('失敗の返信はしない', !profileErrorReplied(r), JSON.stringify(r.replies));
  reset();
  clockOffset = 5 * MINUTE;
  r = await post({ userId: 'U_prof1', description: 'ヨット' });
  check('取り直して成功した結果はキャッシュする（5 分後は取り直さずに保存）', profileCalls === 0 && getUserGroupsCalls === 0 && r.expense?.userDisplayName === 'テスト', `profile ${profileCalls} 回 / groups ${getUserGroupsCalls} 回 / ${JSON.stringify(r.expense)}`);
  clockOffset = 0;

  console.log('\n# 個人チャット: プロフィールの表示名が空 → 失敗と同じく保存せず、キャッシュにも残さない（#261）');
  reset();
  groupsByUser.U_prof2 = [household];
  emptyNameUsers.add('U_prof2');
  r = await post({ userId: 'U_prof2', description: 'ボルダリング' });
  check('支出を保存せず、「ユーザー情報の取得に失敗しました」と返す', r.expense === undefined && profileErrorReplied(r), `${JSON.stringify(r.expense)} / ${JSON.stringify(r.replies)}`);
  reset();
  emptyNameUsers.delete('U_prof2');
  clockOffset = 1 * MINUTE;
  r = await post({ userId: 'U_prof2', description: 'カヌー' });
  check('1 分後の入力でプロフィールを取り直して保存する', profileCalls === 1 && r.expense?.userDisplayName === 'テスト', `${profileCalls} 回 / ${JSON.stringify(r.expense)}`);
  clockOffset = 0;

  console.log('\n# LINE グループ: 世帯の有効メンバー → 従来どおり Jev');
  reset();
  groupsByUser.U_member2 = [household];
  r = await post({ userId: 'U_member2', lineGroupId: 'L_house', description: 'ボルダリング' });
  check('Jev を 1 回呼ぶ', majorCalls().length === 1, `jev ${jevCalls.length}`);
  check('判定元は jev、世帯の支出', r.card?.categoryOrigin === 'jev' && r.expense?.groupId === 'G_house' && r.expense?.lineGroupId === 'L_house', JSON.stringify(r.expense));

  console.log('\n# LINE グループ: 世帯の LINE グループにいる非メンバー → モデルを呼ばない');
  reset();
  groupsByUser.U_guest3 = [];
  r = await post({ userId: 'U_guest3', lineGroupId: 'L_house', description: 'ボルダリング' });
  check('Jev・Gemini は呼ばれない', jevCalls.length === 0 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);
  check('判定元は unclassified、個人支出', r.card?.categoryOrigin === 'unclassified' && r.expense?.groupId === undefined, JSON.stringify(r.expense));

  console.log('\n# LINE グループ: 世帯に紐づかない LINE グループ（自作グループのメンバー）→ モデルを呼ばない');
  reset();
  groupsByUser.U_self2 = [selfMade];
  r = await post({ userId: 'U_self2', lineGroupId: 'L_other', description: 'ボルダリング' });
  check('Jev・Gemini は呼ばれない', jevCalls.length === 0 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);

  console.log('\n# LINE グループ: 世帯の確認に失敗 → モデルを呼ぶ');
  reset();
  failingLineGroups.add('L_flaky');
  r = await post({ userId: 'U_member3', lineGroupId: 'L_flaky', description: 'ボルダリング' });
  check('Jev を呼ぶ', majorCalls().length === 1, `jev ${jevCalls.length}`);
  check('確認の失敗を warn に出す', failOpenLog()?.level === 'warn', JSON.stringify(failOpenLog()?.args));

  console.log('\n# LINE グループ: プロフィールの取得に失敗 → その発言は保存しない。次の発言で取り直す（今までと同じ）');
  reset();
  groupsByUser.U_prof3 = [household];
  failingProfileUsers.add('U_prof3');
  r = await post({ userId: 'U_prof3', lineGroupId: 'L_house', description: 'ボルダリング' });
  check('支出を保存せず、「ユーザー情報の取得に失敗しました」と返す', r.expense === undefined && profileErrorReplied(r), `${JSON.stringify(r.expense)} / ${JSON.stringify(r.replies)}`);
  check('グループのメンバープロフィールを 2 回、個人のプロフィールを 1 回試す', groupProfileCalls === 2 && profileCalls === 1, `group ${groupProfileCalls} 回 / individual ${profileCalls} 回`);
  reset();
  failingProfileUsers.delete('U_prof3');
  clockOffset = 1 * MINUTE;
  r = await post({ userId: 'U_prof3', lineGroupId: 'L_house', description: 'カヌー' });
  check('1 分後の発言でプロフィールを取り直す', groupProfileCalls === 1, `${groupProfileCalls} 回`);
  check('取り直した表示名で、世帯の支出として保存する', r.expense?.userDisplayName === 'テスト' && r.expense?.groupId === 'G_house' && r.expense?.lineGroupId === 'L_house', JSON.stringify(r.expense));
  reset();
  clockOffset = 5 * MINUTE;
  r = await post({ userId: 'U_prof3', lineGroupId: 'L_house', description: 'ヨット' });
  check('取り直して成功した結果はキャッシュする（5 分後は取り直さずに保存）', groupProfileCalls === 0 && profileCalls === 0 && r.expense?.userDisplayName === 'テスト' && r.expense?.groupId === 'G_house', `group ${groupProfileCalls} 回 / ${JSON.stringify(r.expense)}`);
  clockOffset = 0;

  // isHouseholdMember は「lineGroupId を持つどれかのグループの有効メンバー」をメンバーとみなす。以前に bot が
  // LINE グループごとに自動で作ったグループが残っていて作成者が有効なままなら、世帯でなくてもモデルを呼べる。
  // PR #258 で、本番では世帯以外に lineGroupId を持つ有効なグループが無いことを確かめ、世帯の groupId には限らず
  // この定義のままにした。そうしたグループができたらモデルを呼べることを、ここで挙動として残す
  console.log('\n# lineGroupId を持つ、世帯ではないグループのメンバー → モデルを呼ぶ（今の判定の定義のまま）');
  const legacy = { id: 'G_legacy', name: '以前に自動作成されたグループ', lineGroupId: 'L_legacy' };
  groupIdByLineGroup.L_legacy = 'G_legacy';
  reset();
  groupsByUser.U_legacy1 = [legacy];
  r = await post({ userId: 'U_legacy1', description: 'ボルダリング' });
  check('個人チャット: Jev を呼ぶ（現状）', majorCalls().length === 1 && r.card?.categoryOrigin === 'jev', `jev ${jevCalls.length} / ${JSON.stringify(r.card)}`);
  check('個人チャット: 支出はそのグループの支出になる（所属の決め方は変えていない）', r.expense?.groupId === 'G_legacy', JSON.stringify(r.expense));
  reset();
  groupsByUser.U_legacy2 = [legacy];
  r = await post({ userId: 'U_legacy2', lineGroupId: 'L_legacy', description: 'ボルダリング' });
  check('そのグループの LINE グループでの発言: Jev を呼ぶ（現状）', majorCalls().length === 1 && r.card?.categoryOrigin === 'jev', `jev ${jevCalls.length} / ${JSON.stringify(r.card)}`);
  check('その LINE グループでの発言: 支出はそのグループの支出になる', r.expense?.groupId === 'G_legacy' && r.expense?.lineGroupId === 'L_legacy', JSON.stringify(r.expense));

  // 中項目（辞書で決まらない食費・娯楽だけ Jev に聞く。subCategoryClassifier.ts）。店名・説明は架空のもの
  console.log('\n# 中項目: メンバーで大項目が「その他」→ 既定の食費 → 中項目を Jev に聞き、外食を保存してカードにも出す');
  reset();
  groupsByUser.U_sub1 = [household];
  settingsByUser.U_sub1 = { defaultCategory: '食費' };
  majorBehavior = () => answerOf('category', 'その他', 0.9);
  subBehavior = () => answerOf('subCategory', '外食', 0.8);
  r = await post({ userId: 'U_sub1', description: '架空亭' });
  check('大項目 1 回 + 中項目 1 回（Gemini は呼ばない）', majorCalls().length === 1 && subCalls().length === 1 && geminiCalls === 0, `major ${majorCalls().length} / sub ${subCalls().length} / gemini ${geminiCalls}`);
  check('既定の食費（判定元は default）で、中項目は外食を保存', r.expense?.category === '食費' && r.expense?.subCategory === '外食' && r.card?.categoryOrigin === 'default', JSON.stringify(r.expense));
  check('カードにも外食を出す', r.card?.subCategory === '外食', JSON.stringify(r.card));
  const subRequest = subCalls()[0];
  check(
    '中項目の要求: 質問は subCategory だけ・質問文に既定の大項目（食費）・入力は説明',
    JSON.stringify(Object.keys(subRequest?.questions || {})) === '["subCategory"]' &&
      (subRequest?.questions?.subCategory?.instructions || '').includes('「食費」') &&
      subRequest?.state?.input === '架空亭',
    JSON.stringify(subRequest?.questions?.subCategory?.instructions)
  );
  check('ログ: adopted・majorOrigin は default', subModelLog()?.outcome === 'adopted' && subModelLog()?.majorOrigin === 'default' && subModelLog()?.answer === '外食', JSON.stringify(subModelLog()));

  console.log('\n# 中項目: メンバーでない送信者は、カテゴリの指定の有無にかかわらず Jev に聞かない');
  reset();
  groupsByUser.U_sub_guest1 = [];
  settingsByUser.U_sub_guest1 = { defaultCategory: '食費' };
  r = await post({ userId: 'U_sub_guest1', description: '架空亭' });
  check('指定なし: Jev は 0 回（大項目も中項目も）', jevCalls.length === 0 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);
  check('指定なし: 既定の食費で保存し、中項目なし（上でキャッシュした外食も使わない）', r.expense?.category === '食費' && r.expense?.subCategory === undefined && r.card?.subCategory === undefined, JSON.stringify(r.expense));
  check('指定なし: ログは models_not_allowed', subModelLog()?.outcome === 'models_not_allowed', JSON.stringify(subModelLog()));
  reset();
  groupsByUser.U_sub_guest2 = [];
  r = await post({ userId: 'U_sub_guest2', description: '架空亭', category: '食費' });
  check('指定あり: Jev は 0 回', jevCalls.length === 0 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);
  check('指定あり: 指定の食費で保存し、中項目なし', r.expense?.category === '食費' && r.expense?.subCategory === undefined && r.card?.categoryOrigin === 'specified', JSON.stringify(r.expense));
  reset();
  r = await post({ userId: 'U_guest3', lineGroupId: 'L_house', description: '架空亭', category: '食費' });
  check('LINE グループの非メンバーの指定あり: Jev は 0 回', jevCalls.length === 0 && geminiCalls === 0 && r.expense?.subCategory === undefined, `jev ${jevCalls.length}`);

  console.log('\n# 中項目: メンバーがカテゴリを指定したら、中項目だけ Jev に聞く');
  reset();
  groupsByUser.U_sub2 = [household];
  subBehavior = () => answerOf('subCategory', 'カフェ', 0.7);
  r = await post({ userId: 'U_sub2', description: '架空亭 二号店', category: '食費' });
  check('大項目は聞かず、中項目だけ 1 回', majorCalls().length === 0 && subCalls().length === 1 && geminiCalls === 0, `major ${majorCalls().length} / sub ${subCalls().length}`);
  check('指定の食費・中項目はカフェで保存（判定元は specified）', r.expense?.category === '食費' && r.expense?.subCategory === 'カフェ' && r.card?.subCategory === 'カフェ' && r.card?.categoryOrigin === 'specified', JSON.stringify(r.expense));
  check('ログ: majorOrigin は specified、majorConfidence は null', subModelLog()?.majorOrigin === 'specified' && subModelLog()?.majorConfidence === null, JSON.stringify(subModelLog()));
  reset();
  r = await post({ userId: 'U_sub2', description: '食費', category: '食費' });
  check('説明がカテゴリ名だけ（「食費 500」）なら聞かない', jevCalls.length === 0 && r.expense?.subCategory === undefined && subModelLog()?.outcome === 'no_info', JSON.stringify(subModelLog()));

  console.log('\n# 中項目: 世帯の確認に失敗したら、カテゴリを指定した入力でも中項目を Jev に聞く（allowModels の fail-open）');
  reset();
  failingUsers.add('U_fail2');
  subBehavior = () => answerOf('subCategory', '外食', 0.8);
  r = await post({ userId: 'U_fail2', description: '架空亭 五号店', category: '食費' });
  check('大項目は聞かず、中項目だけ 1 回', majorCalls().length === 0 && subCalls().length === 1 && geminiCalls === 0, `major ${majorCalls().length} / sub ${subCalls().length}`);
  check('中項目は外食で保存（判定元は specified）', r.expense?.category === '食費' && r.expense?.subCategory === '外食' && r.card?.categoryOrigin === 'specified', JSON.stringify(r.expense));
  failingUsers.delete('U_fail2');

  console.log('\n# 中項目: 大項目の Jev がタイムアウトして Gemini で決まったら、中項目は聞かない');
  reset();
  groupsByUser.U_sub3 = [household];
  majorBehavior = () => {
    throw new realSdk.APITimeoutError(3000);
  };
  geminiReply = { category: '食費', confidence: 0.9 };
  r = await post({ userId: 'U_sub3', description: '架空亭 三号店' });
  check('大項目: Jev 1 回（タイムアウト）→ Gemini 1 回、中項目は聞かない', majorCalls().length === 1 && geminiCalls === 1 && subCalls().length === 0, `major ${majorCalls().length} / gemini ${geminiCalls} / sub ${subCalls().length}`);
  check('Gemini の食費で保存し、中項目なし', r.expense?.category === '食費' && r.card?.categoryOrigin === 'gemini' && r.expense?.subCategory === undefined, JSON.stringify(r.expense));
  check('ログ: jev_unavailable', subModelLog()?.outcome === 'jev_unavailable' && subModelLog()?.majorOrigin === 'gemini', JSON.stringify(subModelLog()));

  console.log('\n# 中項目: 中項目の Jev がタイムアウトしても、中項目なしで保存してカードを送る');
  reset();
  groupsByUser.U_sub4 = [household];
  majorBehavior = () => answerOf('category', '食費', 0.9);
  subBehavior = () => {
    throw new realSdk.APITimeoutError(3000);
  };
  r = await post({ userId: 'U_sub4', description: '架空亭 四号店' });
  check('大項目 1 回 + 中項目 1 回、Gemini は呼ばない', majorCalls().length === 1 && subCalls().length === 1 && geminiCalls === 0, `major ${majorCalls().length} / sub ${subCalls().length} / gemini ${geminiCalls}`);
  check('中項目なしで保存し、カードも送る（判定元は jev）', r.expense?.category === '食費' && r.expense?.subCategory === undefined && r.card?.subCategory === undefined && r.card?.categoryOrigin === 'jev', JSON.stringify(r.card));
  check('ログ: failed', subModelLog()?.outcome === 'failed', JSON.stringify(subModelLog()));
  check(
    '中項目の失敗は大項目と別の文言で警告する',
    logs.some((l) => l.args[0] === 'Jev subcategory classification failed') && !logs.some((l) => l.args[0] === 'Jev classification failed'),
    JSON.stringify(logs.filter((l) => l.level === 'warn').map((l) => l.args[0]))
  );

  console.log('\n# ログ');
  const logged = JSON.stringify(allLogs.map((l) => l.args.map((a) => (a instanceof Error ? a.message : a))));
  check('ログに利用者 ID を出さない', allLogs.length > 0 && !userIds.some((id) => logged.includes(id)), logged);
  check('ログに入力を出さない', !inputs.some((text) => logged.includes(text)), logged);

  console.log(failed ? `\n${failed} failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
