/**
 * 期間の精算サマリー（settlementSummary.ts の sendDueSettlementSummaries / sendSettlementSummaryNow / settlementSummaryStatus）の
 * 統合テスト（Firestore エミュレータ）
 *
 * LINE には送らない（push を差し替えて、送った内容を記録する）。
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

const { sendDueSettlementSummaries, sendSettlementSummaryNow, settlementSummaryStatus } = require('../dist/settlementSummary');
const { buildSettlementSummaryMessages } = require('../dist/line/settlementSummaryMessage');

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

async function clearFirestore() {
  const res = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`failed to clear firestore (${res.status})`);
}

const A = 'U' + 'a'.repeat(32); // 光麦（集金するメンバー）
const B = 'U' + 'b'.repeat(32); // 誠
const C = 'U' + 'c'.repeat(32);
/** JST の 2026-10-15 09:10 */
const ON_START_DAY = new Date('2026-10-15T00:10:00Z');
const DAY_BEFORE = new Date('2026-10-14T00:10:00Z');

async function seed(db) {
  const ts = (iso) => Timestamp.fromDate(new Date(iso));
  const batch = db.batch();
  const set = (path, data) => batch.set(db.doc(path), data);

  // 対象の世帯（LINE グループあり・集金するメンバーあり・2 人）
  set('groups/g1', { name: '世帯', lineGroupId: 'C_line1', createdBy: B, splitSettings: { collectFromLineId: A } });
  set(`groupMembers/g1_${B}`, { groupId: 'g1', lineId: B, displayName: '岩渕 誠', isActive: true, joinedAt: ts('2026-01-01T00:00:00Z') });
  set(`groupMembers/g1_${A}`, { groupId: 'g1', lineId: A, displayName: '光麦', isActive: true, joinedAt: ts('2026-01-02T00:00:00Z') });
  set(`userSettings/${A}`, { dateSettings: { mode: 'customStart', customStartDay: 15 } });

  // 送らない世帯: 集金するメンバーが未設定 / 3 人 / LINE グループなし
  set('groups/g2', { name: '未設定', lineGroupId: 'C_line2', createdBy: C });
  set(`groupMembers/g2_${C}`, { groupId: 'g2', lineId: C, displayName: 'C', isActive: true });
  set(`groupMembers/g2_${A}`, { groupId: 'g2', lineId: A, displayName: '光麦', isActive: true });
  set('groups/g3', { name: '3人', lineGroupId: 'C_line3', splitSettings: { collectFromLineId: A } });
  for (const id of [A, B, C]) set(`groupMembers/g3_${id}`, { groupId: 'g3', lineId: id, displayName: id.slice(0, 2), isActive: true });
  set('groups/g4', { name: 'LINE なし', splitSettings: { collectFromLineId: A } });
  for (const id of [A, B]) set(`groupMembers/g4_${id}`, { groupId: 'g4', lineId: id, displayName: id.slice(0, 2), isActive: true });

  const base = { groupId: 'g1', lineGroupId: 'C_line1', includeInTotal: true, status: 'shared', confirmed: true, category: '食費', createdAt: ts('2026-09-20T00:00:00Z') };
  set('expenses/rent', { ...base, lineId: 'recurring-system', payerId: 'recurring-system', inputSource: 'recurring', amount: 120000, date: '2026-09-27', category: '住居費' });
  set('expenses/card1', { ...base, lineId: 'gmail-auto-system', payerId: 'gmail-auto-system', inputSource: 'gmail_auto', amount: 30000, date: '2026-10-01' });
  set('expenses/mitsu', { ...base, lineId: A, payerId: A, inputSource: 'line_text', amount: 4900, date: '2026-10-05', category: '日用品' });
  set('expenses/pending', { ...base, lineId: A, payerId: A, inputSource: 'line_text', amount: 2180, date: '2026-10-06', status: null, confirmed: false, includeInTotal: false });
  set('expenses/outside', { ...base, lineId: B, payerId: B, inputSource: 'line_text', amount: 50000, date: '2026-10-15' });
  // 以前の立替の印が残っている支出（折半には支払った人の分として入る）
  set('expenses/adv1', { ...base, lineId: B, payerId: B, advanceBy: B, inputSource: 'line_text', amount: 6000, date: '2026-10-02', status: 'advance_pending', category: '日用品' });
  await batch.commit();
}

(async () => {
  await clearFirestore();
  const db = getFirestore();
  await seed(db);

  const sent = [];
  let failNext = false;
  const deps = (now) => ({
    now,
    build: buildSettlementSummaryMessages,
    push: async (to, messages, retryKey) => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('LINE is down'), { status: 500 });
      }
      sent.push({ to, messages, retryKey });
    },
  });

  console.log('\n[起算日でない日は送らない]');
  {
    const r = await sendDueSettlementSummaries(db, deps(DAY_BEFORE));
    check('対象は集金するメンバーが決まった 2 人の LINE 世帯だけ（g1）', r.checked === 1, r);
    check('10/14 は送らない', r.sent === 0 && r.skipped === 1 && sent.length === 0, r);
  }

  console.log('\n[送信に失敗したら印を残さず、次の実行で送る]');
  {
    failNext = true;
    const r = await sendDueSettlementSummaries(db, deps(ON_START_DAY));
    check('失敗を数える', r.failed === 1 && r.sent === 0, r);
    const marker = await db.doc('system/settlementSummary_g1_2026-10-14').get();
    check('印（system/settlementSummary_g1_2026-10-14）は消える', !marker.exists);
  }

  console.log('\n[起算日に締まった期間を 1 回だけ送る]');
  {
    const r = await sendDueSettlementSummaries(db, deps(ON_START_DAY));
    check('10/15 に送る', r.sent === 1 && sent.length === 1, r);
    const msg = sent[0];
    check('送り先は世帯の LINE グループ', msg && msg.to === 'C_line1', msg && msg.to);
    check('メンション付きテキスト + Flex の 2 通（1 回の push）', msg && msg.messages.length === 2 && msg.messages[0].type === 'textV2' && msg.messages[1].type === 'flex');
    // 合計 160,900（立替の印が残っている支出も含む。期間外・要確認は入らない）÷ 2 − 光麦の 4,900 = 75,550
    check(
      '光麦から誠へ ¥75,550（Web の期間の精算と同じ式）',
      msg && msg.messages[0].text.includes('{u1} から {u2} へ ¥75,550') &&
        msg.messages[0].substitution.u1.mentionee.userId === A &&
        msg.messages[0].substitution.u2.mentionee.userId === B,
      msg && msg.messages[0]
    );
    const flex = JSON.stringify(msg && msg.messages[1]);
    check('Flex に期間・要確認（立替の案内は出さない）', flex.includes('9/15〜10/14') && flex.includes('要確認が 1件（¥2,180）') && !flex.includes('立替が'), flex.slice(0, 200));
    const marker = await db.doc('system/settlementSummary_g1_2026-10-14').get();
    check('印に送った時刻が入る', marker.exists && !!marker.get('sentAt'));

    const again = await sendDueSettlementSummaries(db, deps(ON_START_DAY));
    check('同じ日にもう一度動いても送らない（リトライ）', again.sent === 0 && again.skipped === 1 && sent.length === 1, again);
  }

  console.log('\n[前の実行が送信の途中で止まった（印はあるが sentAt が無い）]');
  {
    const ref = db.doc('system/settlementSummary_g1_2026-10-14');
    await ref.set({ groupId: 'g1', endDate: '2026-10-14' });
    const r = await sendDueSettlementSummaries(db, deps(ON_START_DAY));
    check('同じ X-Line-Retry-Key で送り直す', r.sent === 1 && sent.length === 2 && sent[1].retryKey === sent[0].retryKey, r);
    check('送り直したら sentAt が入る', !!(await ref.get()).get('sentAt'));
  }

  console.log('\n[手動の送信（Web の設定から）]');
  {
    /** JST の 2026-10-17 10:00（起算日の 2 日後） */
    const LATER = new Date('2026-10-17T01:00:00Z');
    const status = await settlementSummaryStatus(db, 'g1', LATER);
    check(
      '状態: 15日起算・締まった期間 9/15〜10/14（送信済み）・今の期間 10/15〜10/17',
      status && status.reason === null && status.startDay === 15 &&
        status.closed.startDate === '2026-09-15' && status.closed.endDate === '2026-10-14' &&
        status.current.startDate === '2026-10-15' && status.current.endDate === '2026-10-17' && typeof status.closedSentAt === 'string',
      status
    );
    const before = sent.length;
    const closed = await sendSettlementSummaryNow(db, 'g1', 'closed', deps(LATER));
    check('締まった期間は送信済みでも送る（日付にも関係なく）', closed && closed.ok && closed.range.endDate === '2026-10-14' && closed.interim === false && sent.length === before + 1, closed);
    const msg = sent[sent.length - 1];
    check('内容は自動の通知と同じ（メンション付き・同じ金額）', msg.to === 'C_line1' && msg.messages[0].type === 'textV2' && msg.messages[0].text.includes('¥75,550'), msg.messages[0]);
    check('X-Line-Retry-Key は自動の通知と別（同じ期間を送り直せる）', /^[0-9a-f-]{36}$/.test(msg.retryKey) && msg.retryKey !== sent[0].retryKey, msg.retryKey);

    const current = await sendSettlementSummaryNow(db, 'g1', 'current', deps(LATER));
    const interimMsg = sent[sent.length - 1];
    check('今の期間は今日までの途中経過（10/15〜10/17）', current && current.ok && current.interim === true && current.range.startDate === '2026-10-15' && current.range.endDate === '2026-10-17', current);
    check('途中経過はメンションせず見込みとして送る', interimMsg.messages[0].type === 'text' && interimMsg.messages[0].text.includes('途中経過') && interimMsg.messages[1].altText.includes('（途中経過）'), interimMsg.messages[0]);
    check('途中経過では印を付けない', !(await db.doc('system/settlementSummary_g1_2026-10-17').get()).exists);

    // 締まった期間を手動で送ったら、起算日の自動の通知はその期間を送らない
    await db.doc('system/settlementSummary_g1_2026-10-14').delete();
    await sendSettlementSummaryNow(db, 'g1', 'closed', deps(ON_START_DAY));
    const marker = await db.doc('system/settlementSummary_g1_2026-10-14').get();
    check('締まった期間を送ったら sentAt 付きの印を残す', marker.exists && !!marker.get('sentAt') && !!marker.get('manualSentAt'));
    const sentBeforeAuto = sent.length;
    const auto = await sendDueSettlementSummaries(db, deps(ON_START_DAY));
    check('同じ期間の自動の通知は送らない', auto.sent === 0 && auto.skipped === 1 && sent.length === sentBeforeAuto, auto);

    failNext = true;
    let threw = false;
    try {
      await sendSettlementSummaryNow(db, 'g1', 'current', deps(LATER));
    } catch {
      threw = true;
    }
    check('LINE に送れなければ例外（API が 502 にする）', threw);

    const unavailable = await Promise.all(['g2', 'g3', 'g4'].map((g) => sendSettlementSummaryNow(db, g, 'closed', deps(LATER))));
    check(
      '送れない世帯は理由を返す（集金するメンバー未指定・3 人・LINE グループなし）',
      unavailable.map((r) => r && r.reason).join(',') === 'no_collect_from,not_two_members,no_line_group',
      unavailable
    );
    check('世帯が無ければ null', (await sendSettlementSummaryNow(db, 'nope', 'closed', deps(LATER))) === null && (await settlementSummaryStatus(db, 'nope', LATER)) === null);
  }

  console.log('\n[固定期間・設定なしの世帯]');
  {
    await db.doc(`userSettings/${A}`).set({ dateSettings: { mode: 'custom', startDate: '2026-10-01', endDate: '2026-10-31' } });
    const r = await sendDueSettlementSummaries(db, deps(new Date('2026-11-15T00:10:00Z')));
    const sentBefore = sent.length;
    check('固定期間（custom）の世帯には送らない', r.sent === 0 && r.skipped === 1, r);
    const fixed = await sendSettlementSummaryNow(db, 'g1', 'closed', deps(new Date('2026-11-15T00:10:00Z')));
    const fixedStatus = await settlementSummaryStatus(db, 'g1', new Date('2026-11-15T00:10:00Z'));
    check('固定期間は手動でも送れない（fixed_period）', fixed && fixed.ok === false && fixed.reason === 'fixed_period' && fixedStatus.reason === 'fixed_period' && fixedStatus.closed === null && sent.length === sentBefore, { fixed, fixedStatus });
    // 集金するメンバーに設定が無ければ相手の設定（15日起算）を使う
    await db.doc(`userSettings/${A}`).delete();
    await db.doc(`userSettings/${B}`).set({ dateSettings: { mode: 'customStart', customStartDay: 15 } });
    const r2 = await sendDueSettlementSummaries(db, deps(new Date('2026-11-15T00:10:00Z')));
    check('相手の期間設定で 11/15 に 10/15〜11/14 の分を送る', r2.sent === 1 && sent.length === sentBefore + 1 && sent[sent.length - 1].messages[1].altText.startsWith('10/15〜11/14'), r2);
  }

  console.log(`\nsettlement summary emulator: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
