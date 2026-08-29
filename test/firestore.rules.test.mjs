// Firestore セキュリティルールのユニットテスト（参考・任意実行）。
// テスト用ツール（firebase-tools / @firebase/rules-unit-testing）は依存肥大化・
// 監査影響を避けるため package.json には含めていない。実行する場合はアドホックに:
//   npm i -D @firebase/rules-unit-testing firebase-tools
//   npx firebase emulators:exec --only firestore "node test/firestore.rules.test.mjs"
// （Java + Firestore エミュレータが必要。リポジトリ直下の firestore.rules を読み込んで検証する）
// 本ルールはこのテスト23ケース（未認証拒否 / 他人の lineId 拒否 / lineId 不一致 create 拒否 等）
// が全て pass することを確認済み。
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs,
} from 'firebase/firestore';

// emulators:exec はリポジトリ直下（firebase.json のある場所）で実行される。
const RULES = 'firestore.rules';
const EMU = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.error('  FAIL-', name, '\n       ', e.message); }
}

const env = await initializeTestEnvironment({
  projectId: 'demo-kakeibo',
  firestore: { rules: readFileSync(RULES, 'utf8'), host: EMU[0], port: Number(EMU[1]) },
});

// ルールを無効化してシードデータを投入。
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'expenses/expA'), { lineId: 'A', amount: 100, date: '2026-08-01' });
  await setDoc(doc(db, 'expenses/expB'), { lineId: 'B', amount: 200, date: '2026-08-01' });
  await setDoc(doc(db, 'expenses/expG'), { lineId: 'B', lineGroupId: 'G1', amount: 300, date: '2026-08-01' });
  await setDoc(doc(db, 'budgetSettings/A'), { monthlyBudget: 1000 });
  await setDoc(doc(db, 'budgetSettings/B'), { monthlyBudget: 2000 });
  await setDoc(doc(db, 'linkTokens/t1'), { lineId: 'A' });
  await setDoc(doc(db, 'userLinks/appuid-A'), { lineId: 'A' });
});

const unauth = env.unauthenticatedContext().firestore();
// サインイン済み（lineId カスタムクレームあり）。
const userA = env.authenticatedContext('appuid-A', { lineId: 'A' }).firestore();
const userB = env.authenticatedContext('appuid-B', { lineId: 'B' }).firestore();
// 匿名フォールバック: サインイン済みだが lineId クレームなし。
const anon = env.authenticatedContext('anon-uid', {}).firestore();

console.log('Firestore rules tests:');

// --- 契約で必須の3ケース -------------------------------------------------
await test('(a) unauthenticated read of expenses is DENIED', async () => {
  await assertFails(getDoc(doc(unauth, 'expenses/expA')));
});
await test('(b) userA (lineId=A) can read own expense', async () => {
  await assertSucceeds(getDoc(doc(userA, 'expenses/expA')));
});
await test('(b) userA canNOT read userB expense (lineId=B)', async () => {
  await assertFails(getDoc(doc(userA, 'expenses/expB')));
});
await test('(c) create with mismatched lineId is DENIED', async () => {
  await assertFails(setDoc(doc(userA, 'expenses/newX'), { lineId: 'B', amount: 5, date: '2026-08-02' }));
});

// --- 追加ケース ----------------------------------------------------------
await test('create with own lineId is ALLOWED', async () => {
  await assertSucceeds(setDoc(doc(userA, 'expenses/newA'), { lineId: 'A', amount: 5, date: '2026-08-02' }));
});
await test('anonymous (no lineId claim) canNOT read a personal expense', async () => {
  await assertFails(getDoc(doc(anon, 'expenses/expA')));
});
await test('group expense readable by signed-in non-owner (documented limitation)', async () => {
  await assertSucceeds(getDoc(doc(userA, 'expenses/expG')));
});
await test('owner can update own expense', async () => {
  await assertSucceeds(updateDoc(doc(userA, 'expenses/expA'), { amount: 111 }));
});
await test('non-owner canNOT update expense', async () => {
  await assertFails(updateDoc(doc(userA, 'expenses/expB'), { amount: 999 }));
});
await test('owner canNOT reassign ownership (change lineId)', async () => {
  await assertFails(updateDoc(doc(userA, 'expenses/expA'), { lineId: 'B' }));
});
await test('owner can delete own expense', async () => {
  await assertSucceeds(deleteDoc(doc(userA, 'expenses/expA')));
});
await test('non-owner canNOT delete expense', async () => {
  await assertFails(deleteDoc(doc(userA, 'expenses/expB')));
});
await test('query where lineId==A succeeds for userA', async () => {
  await assertSucceeds(getDocs(query(collection(userA, 'expenses'), where('lineId', '==', 'A'))));
});
await test('query where lineGroupId==G1 succeeds for signed-in user', async () => {
  await assertSucceeds(getDocs(query(collection(userA, 'expenses'), where('lineGroupId', '==', 'G1'))));
});
await test('budgetSettings: userA reads own (doc id == lineId)', async () => {
  await assertSucceeds(getDoc(doc(userA, 'budgetSettings/A')));
});
await test('budgetSettings: userA canNOT read B doc', async () => {
  await assertFails(getDoc(doc(userA, 'budgetSettings/B')));
});
await test('budgetSettings: userA can write own doc', async () => {
  await assertSucceeds(setDoc(doc(userA, 'budgetSettings/A'), { monthlyBudget: 1234 }));
});
await test('budgetSettings: userA canNOT write B doc', async () => {
  await assertFails(setDoc(doc(userA, 'budgetSettings/B'), { monthlyBudget: 9 }));
});
await test('linkTokens: signed-in read DENIED (admin-only)', async () => {
  await assertFails(getDoc(doc(userA, 'linkTokens/t1')));
});
await test('linkTokens: signed-in write DENIED (admin-only)', async () => {
  await assertFails(setDoc(doc(userA, 'linkTokens/t2'), { lineId: 'A' }));
});
await test('userLinks: user can read own (uid match)', async () => {
  await assertSucceeds(getDoc(doc(userA, 'userLinks/appuid-A')));
});
await test('userLinks: user canNOT read other uid', async () => {
  await assertFails(getDoc(doc(userB, 'userLinks/appuid-A')));
});
await test('default-deny: unknown collection read DENIED', async () => {
  await assertFails(getDoc(doc(userA, 'userCustomCategories/x')));
});

await env.cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
