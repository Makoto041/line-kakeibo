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
 * - lineGroupId を持つ、世帯ではないグループのメンバーは、メンバーとみなされモデルを呼ぶ（今の判定の定義のまま）
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

// --- @typesafe-ai/sdk の偽物（smoke-jev-classifier.js と同じ方法。classifier を読み込む前に差し替える） ---
const sdkPath = require.resolve('@typesafe-ai/sdk', { paths: [path.join(__dirname, '..')] });
const realSdk = require(sdkPath);
let jevCalls = [];
const jevCategory = '娯楽';
class FakeTypeSafeClient {
  async systemOne(request) {
    jevCalls.push(request);
    return {
      model: 'jev-1.13.0',
      answers: { category: { type: 'choice', choice: jevCategory, confidence: 0.9, probabilities: { [jevCategory]: 0.9 } } },
      usage: { input_tokens: 100, output_tokens: 0 },
    };
  }
}
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
geminiClient.generateJson = async () => {
  geminiCalls++;
  return { category: '娯楽', confidence: 0.9 };
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
const fakeLine = {
  getProfile: async () => ({ displayName: 'テスト' }),
  getGroupMemberProfile: async () => ({ displayName: 'テスト' }),
};
lineClient.getLineClient = () => fakeLine;
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
async function post({ userId, lineGroupId, description }) {
  inputs.push(description);
  userIds.push(userId);
  const event = {
    source: lineGroupId ? { type: 'group', groupId: lineGroupId, userId } : { type: 'user', userId },
  };
  const parsed = { amount: 500, description, date: '2026-10-25', paymentMethod: 'unknown' };
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      logs.push({ level, args });
      allLogs.push({ level, args });
    };
  }
  try {
    await processExpenseInBackground(event, parsed, 'reply-token');
  } finally {
    Object.assign(console, original);
  }
  return { expense: saved[saved.length - 1], card: cards[cards.length - 1]?.info };
}
function reset() {
  jevCalls = [];
  geminiCalls = 0;
  getUserGroupsCalls = 0;
  logs.length = 0;
}
const skipLog = () => logs.find((l) => l.args[0] === 'Skipping category models: poster is not a household member');
const failOpenLog = () => logs.find((l) => l.args[0] === 'Household membership lookup failed; classifying with models');

async function main() {
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.GEMINI_API_KEY = 'test-key';

  console.log('\n# 個人チャット: 世帯メンバー → 従来どおり Jev');
  reset();
  groupsByUser.U_member1 = [household];
  let r = await post({ userId: 'U_member1', description: 'ボルダリング' });
  check('Jev を 1 回呼ぶ', jevCalls.length === 1 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);
  check('Jev の結果で保存し、判定元は jev', r.expense?.category === '娯楽' && r.card?.categoryOrigin === 'jev', JSON.stringify(r.card));
  check('世帯の支出（groupId）として保存', r.expense?.groupId === 'G_house' && r.expense?.lineGroupId === undefined, JSON.stringify(r.expense));
  check('スキップのログは出さない', skipLog() === undefined);

  console.log('\n# 個人チャット: 所属なし → モデルを呼ばない');
  reset();
  groupsByUser.U_guest1 = [];
  r = await post({ userId: 'U_guest1', description: 'ボルダリング' });
  check('Jev・Gemini は呼ばれない', jevCalls.length === 0 && geminiCalls === 0, `jev ${jevCalls.length} / gemini ${geminiCalls}`);
  check('辞書で決まらなければ「その他」（判定元は unclassified）', r.expense?.category === 'その他' && r.card?.categoryOrigin === 'unclassified', JSON.stringify(r.card));
  check('支出は保存する（個人支出）', r.expense?.groupId === undefined && r.expense?.lineGroupId === undefined, JSON.stringify(r.expense));
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
  check('支出は自作グループのまま保存（所属の決め方は変えない）', r.expense?.groupId === 'G_self', JSON.stringify(r.expense));

  console.log('\n# 個人チャット: 世帯の確認に失敗 → モデルを呼ぶ（失敗はキャッシュに残さない）');
  reset();
  failingUsers.add('U_fail1');
  r = await post({ userId: 'U_fail1', description: 'ボルダリング' });
  check('Jev を呼ぶ', jevCalls.length === 1, `jev ${jevCalls.length}`);
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
  check('10 分後はキャッシュに当たる（読まない。世帯メンバーのまま）', getUserGroupsCalls === 0 && jevCalls.length === 1, `${getUserGroupsCalls} 回 / jev ${jevCalls.length}`);
  reset();
  clockOffset = 16 * MINUTE;
  groupsByUser.U_ttl1 = []; // 管理スクリプトで無効化した想定
  r = await post({ userId: 'U_ttl1', description: 'ヨット' });
  check('取得から 16 分後（キャッシュに当たった回からは 6 分後）は読み直す', getUserGroupsCalls === 1, `${getUserGroupsCalls} 回`);
  check('読み直した結果（無効化）が反映され、モデルを呼ばず個人支出になる', jevCalls.length === 0 && geminiCalls === 0 && r.expense?.groupId === undefined, `jev ${jevCalls.length} / gemini ${geminiCalls} / ${JSON.stringify(r.expense)}`);
  clockOffset = 0;

  console.log('\n# LINE グループ: 世帯の有効メンバー → 従来どおり Jev');
  reset();
  groupsByUser.U_member2 = [household];
  r = await post({ userId: 'U_member2', lineGroupId: 'L_house', description: 'ボルダリング' });
  check('Jev を 1 回呼ぶ', jevCalls.length === 1, `jev ${jevCalls.length}`);
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
  check('Jev を呼ぶ', jevCalls.length === 1, `jev ${jevCalls.length}`);
  check('確認の失敗を warn に出す', failOpenLog()?.level === 'warn', JSON.stringify(failOpenLog()?.args));

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
  check('個人チャット: Jev を呼ぶ（現状）', jevCalls.length === 1 && r.card?.categoryOrigin === 'jev', `jev ${jevCalls.length} / ${JSON.stringify(r.card)}`);
  check('個人チャット: 支出はそのグループの支出になる（所属の決め方は変えていない）', r.expense?.groupId === 'G_legacy', JSON.stringify(r.expense));
  reset();
  groupsByUser.U_legacy2 = [legacy];
  r = await post({ userId: 'U_legacy2', lineGroupId: 'L_legacy', description: 'ボルダリング' });
  check('そのグループの LINE グループでの発言: Jev を呼ぶ（現状）', jevCalls.length === 1 && r.card?.categoryOrigin === 'jev', `jev ${jevCalls.length} / ${JSON.stringify(r.card)}`);
  check('その LINE グループでの発言: 支出はそのグループの支出になる', r.expense?.groupId === 'G_legacy' && r.expense?.lineGroupId === 'L_legacy', JSON.stringify(r.expense));

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
