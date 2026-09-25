/**
 * 固定費（/household/recurring と毎日の計上）の統合テスト（Firestore・Auth エミュレータ + 実際の Express ルーター）
 *
 * emulator-household-api.js と同じ形で実行する（npm -w bot run test:emulator から続けて動く）。
 * 本番のプロジェクトには接続しない（demo-* 以外は即終了）。
 */
const express = require('express');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-kakeibo';
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (!firestoreHost || !authHost) {
  console.error('FIRESTORE_EMULATOR_HOST と FIREBASE_AUTH_EMULATOR_HOST が必要です（firebase emulators:exec から実行する）');
  process.exit(2);
}
if (!projectId.startsWith('demo-')) {
  console.error(`安全のため demo-* のプロジェクトでだけ実行します（現在: ${projectId}）`);
  process.exit(2);
}

if (getApps().length === 0) initializeApp({ projectId });

const { householdRouter, householdErrorHandler } = require('../dist/householdApi');
const { postDueRecurringExpenses } = require('../dist/recurringExpenses');
const { getAdvanceSummaryByUser } = require('../dist/firestore');

const ORIGIN = 'https://line-kakeibo.vercel.app';

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

async function clearEmulators() {
  const fs = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  const au = await fetch(`http://${authHost}/emulator/v1/projects/${projectId}/accounts`, { method: 'DELETE' });
  if (!fs.ok || !au.ok) throw new Error(`failed to clear emulators (${fs.status}/${au.status})`);
}

async function idTokenFor(uid, claims) {
  const customToken = await getAuth().createCustomToken(uid, claims);
  const res = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const body = await res.json();
  if (!body.idToken) throw new Error(`signInWithCustomToken failed: ${res.status}`);
  return body.idToken;
}

async function seed(db) {
  const batch = db.batch();
  const set = (path, data) => batch.set(db.doc(path), data);
  set('groups/h1', { name: 'LINEグループ home', inviteCode: '101010', createdBy: 'Uaki', lineGroupId: 'C_home' });
  set('groupMembers/h1_Uaki', { groupId: 'h1', lineId: 'Uaki', displayName: 'Aki', isActive: true });
  set('groupMembers/h1_Uben', { groupId: 'h1', lineId: 'Uben', displayName: 'Ben', isActive: true });
  set('groupMembers/h1_Uold', { groupId: 'h1', lineId: 'Uold', displayName: 'Old', isActive: false });
  set('groups/h2', { name: 'other', inviteCode: '202020', createdBy: 'Uzed' });
  set('groupMembers/h2_Uzed', { groupId: 'h2', lineId: 'Uzed', displayName: 'Zed', isActive: true });
  await batch.commit();
}

async function main() {
  await clearEmulators();
  const db = getFirestore();
  await seed(db);

  const app = express();
  app.use(express.json());
  app.use('/household', householdRouter, householdErrorHandler);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { token, body } = {}) {
    const headers = { Origin: ORIGIN };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  const aki = await idTokenFor('app-aki', { lineId: 'Uaki' });
  const zed = await idTokenFor('app-zed', { lineId: 'Uzed' });

  try {
    console.log('recurring API: 認可');
    check('トークンなしは 401', (await call('GET', '/household/recurring?groupId=h1')).status === 401);
    check('他の世帯のメンバーは 403', (await call('GET', '/household/recurring?groupId=h1', { token: zed })).status === 403);
    const empty = await call('GET', '/household/recurring?groupId=h1', { token: aki });
    check('一覧（空）と有効メンバー', empty.status === 200 && empty.body.items.length === 0 && empty.body.members.length === 2, empty.body);
    const pre = await fetch(`${base}/household/recurring/x`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    check('プリフライトで PATCH / DELETE を許可', (pre.headers.get('access-control-allow-methods') || '').includes('PATCH'));

    console.log('recurring API: 作成');
    const rent = { groupId: 'h1', name: '家賃', amount: 120000, category: '住居費', dayOfMonth: 27, payment: 'advance', payerLineId: 'Uaki' };
    const created = await call('POST', '/household/recurring', { token: aki, body: rent });
    check('家賃（Aki の立替）を作成', created.status === 201 && created.body.item.name === '家賃' && created.body.item.active === true, created.body);
    const rentId = created.body.item.id;
    const util = { groupId: 'h1', name: '電気代', amount: 9000, category: '光熱費', dayOfMonth: 10, payment: 'shared', payerLineId: null };
    const createdUtil = await call('POST', '/household/recurring', { token: aki, body: util });
    check('電気代（共通カード）を作成', createdUtil.status === 201, createdUtil.body);
    const utilId = createdUtil.body.item.id;

    check('脱退者を立替者にできない', (await call('POST', '/household/recurring', { token: aki, body: { ...rent, payerLineId: 'Uold' } })).status === 400);
    check('世帯外の人を立替者にできない', (await call('POST', '/household/recurring', { token: aki, body: { ...rent, payerLineId: 'Uzed' } })).status === 400);
    check('不正な金額は 400', (await call('POST', '/household/recurring', { token: aki, body: { ...rent, amount: -5 } })).status === 400);
    check('他の世帯へは作れない', (await call('POST', '/household/recurring', { token: zed, body: rent })).status === 403);
    check('知らないキーは 400', (await call('POST', '/household/recurring', { token: aki, body: { ...rent, lastPostedMonth: '2099-01' } })).status === 400);

    const list = await call('GET', '/household/recurring?groupId=h1', { token: aki });
    check('一覧は引き落とし日の順', list.body.items.map((i) => i.name).join(',') === '電気代,家賃', list.body.items);

    console.log('recurring API: 更新・削除');
    check('他の世帯の人は更新できない', (await call('PATCH', `/household/recurring/${utilId}`, { token: zed, body: { amount: 1 } })).status === 403);
    const upd = await call('PATCH', `/household/recurring/${utilId}`, { token: aki, body: { amount: 9800 } });
    check('金額だけ更新', upd.status === 200 && upd.body.item.amount === 9800 && upd.body.item.name === '電気代', upd.body);
    const toShared = await call('PATCH', `/household/recurring/${rentId}`, { token: aki, body: { payment: 'shared' } });
    check('共通に切り替えると立替者を外す', toShared.status === 200 && toShared.body.item.payerLineId === null, toShared.body);
    const back = await call('PATCH', `/household/recurring/${rentId}`, { token: aki, body: { payment: 'advance', payerLineId: 'Uaki' } });
    check('立替に戻す', back.status === 200 && back.body.item.payerLineId === 'Uaki', back.body);
    check('立替者なしの立替は 400', (await call('PATCH', `/household/recurring/${rentId}`, { token: aki, body: { payment: 'advance', payerLineId: null } })).status === 400);
    check('空の更新は 400', (await call('PATCH', `/household/recurring/${rentId}`, { token: aki, body: {} })).status === 400);
    check('無い項目は 404', (await call('PATCH', '/household/recurring/nope', { token: aki, body: { amount: 1 } })).status === 404);

    console.log('recurring: 毎日の計上');
    // 作成日を 9/1 にして、9 月の引き落とし日から計上されるようにする
    await db.doc(`recurringExpenses/${rentId}`).update({ startDate: '2026-09-01' });
    await db.doc(`recurringExpenses/${utilId}`).update({ startDate: '2026-09-01' });

    const s1 = await postDueRecurringExpenses(db, new Date('2026-09-09T22:00:00Z')); // JST 9/10 7:00
    check('9/10 は電気代だけ計上', s1.posted === 1 && s1.failed === 0, s1);
    const e1 = await db.doc(`expenses/recurring_${utilId}_202609`).get();
    check(
      '電気代は共同費として入る',
      e1.exists && e1.get('status') === 'shared' && e1.get('amount') === 9800 && e1.get('date') === '2026-09-10' && e1.get('groupId') === 'h1' && e1.get('lineGroupId') === 'C_home',
      e1.data()
    );
    const s2 = await postDueRecurringExpenses(db, new Date('2026-09-10T00:00:00Z'));
    check('同じ日にもう一度動いても増えない', s2.posted === 0, s2);

    const s3 = await postDueRecurringExpenses(db, new Date('2026-09-28T21:10:00Z')); // JST 9/29（27 日の実行が漏れた想定）
    check('実行が遅れても同じ月なら家賃を計上', s3.posted === 1, s3);
    const e2 = await db.doc(`expenses/recurring_${rentId}_202609`).get();
    check(
      '家賃は Aki の未精算の立替として入る（日付は引き落とし日）',
      e2.exists && e2.get('status') === 'advance_pending' && e2.get('advanceBy') === 'Uaki' && e2.get('date') === '2026-09-27' && e2.get('payerDisplayName') === 'Aki',
      e2.data()
    );
    const summary = await getAdvanceSummaryByUser('C_home', true);
    const akiAdv = summary.find((s) => s.userId === 'Uaki');
    check('LINE の立替一覧（lineGroupId 基準）に家賃が入る', akiAdv && akiAdv.totalAdvanced === 120000, summary);

    // 同時に 2 回動いても 1 件
    await db.doc(`recurringExpenses/${utilId}`).update({ lastPostedMonth: '2026-09' });
    const [c1, c2] = await Promise.all([
      postDueRecurringExpenses(db, new Date('2026-10-10T00:00:00Z')),
      postDueRecurringExpenses(db, new Date('2026-10-10T00:00:00Z')),
    ]);
    check('同時に 2 回動いても 10 月分は 1 件', c1.posted + c2.posted === 1, { c1, c2 });

    // 無効にした項目は計上しない
    await call('PATCH', `/household/recurring/${rentId}`, { token: aki, body: { active: false } });
    const s4 = await postDueRecurringExpenses(db, new Date('2026-10-27T00:00:00Z'));
    const e3 = await db.doc(`expenses/recurring_${rentId}_202610`).get();
    check('無効にした家賃は 10 月に計上しない', !e3.exists && s4.posted === 0, s4);

    // 計上した明細は項目を消しても残る
    const del = await call('DELETE', `/household/recurring/${utilId}`, { token: aki });
    check('削除', del.status === 200);
    check('削除後も計上済みの明細は残る', (await db.doc(`expenses/recurring_${utilId}_202609`).get()).exists);
    check('他の世帯の人は削除できない', (await call('DELETE', `/household/recurring/${rentId}`, { token: zed })).status === 403);
  } finally {
    server.close();
  }

  console.log(`\nrecurring emulator: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
