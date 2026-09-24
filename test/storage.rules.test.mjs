// Cloud Storage セキュリティルールのユニットテスト（CI の pr-checks でも実行する）。
// storage.rules は cross-service rules で Firestore の expenses / groupMembers を参照するため、
// Firestore と Storage の両エミュレータが必要:
//   npm i --no-save @firebase/rules-unit-testing firebase-tools@15
//   npx firebase emulators:exec --only firestore,storage --project demo-kakeibo \
//     "node test/firestore.rules.test.mjs && node test/storage.rules.test.mjs"
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc } from 'firebase/firestore';

const FS = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
const ST = (process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.error('  FAIL-', name, '\n       ', e.message); }
}

const env = await initializeTestEnvironment({
  projectId: 'demo-kakeibo',
  // Firestore 側のルールも読み込む（シードは withSecurityRulesDisabled で行う）。
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: FS[0], port: Number(FS[1]) },
  storage: { rules: readFileSync('storage.rules', 'utf8'), host: ST[0], port: Number(ST[1]) },
});

const group = { groupId: 'SG1', lineGroupId: 'SL1' };
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'expenses/sGroup'), { lineId: 'B', ...group, amount: 300, date: '2026-08-01' });
  await setDoc(doc(db, 'expenses/sGmail'), { lineId: 'gmail-auto-system', ...group, amount: 400, date: '2026-08-01' });
  await setDoc(doc(db, 'expenses/sPersonalA'), { lineId: 'A', amount: 100, date: '2026-08-01' });
  await setDoc(doc(db, 'expenses/sByD'), { lineId: 'D', ...group, amount: 500, date: '2026-08-01' });
  await setDoc(doc(db, 'groupMembers/SG1_A'), { groupId: 'SG1', lineId: 'A', isActive: true });
  await setDoc(doc(db, 'groupMembers/SG1_B'), { groupId: 'SG1', lineId: 'B', isActive: true });
  await setDoc(doc(db, 'groupMembers/SG1_D'), { groupId: 'SG1', lineId: 'D', isActive: false });
  // 別の世帯（SG2）の有効メンバー E
  await setDoc(doc(db, 'groupMembers/SG2_E'), { groupId: 'SG2', lineId: 'E', isActive: true });
  // groupId を持たず lineGroupId だけを持つ旧形式の支出（登録者は脱退済みの D）
  await setDoc(doc(db, 'expenses/sLegacyD'), { lineId: 'D', lineGroupId: 'SL1', amount: 600, date: '2026-08-01' });

  // 既存ファイル（読み取り・削除の検証用）
  const st = ctx.storage();
  const jpeg = { contentType: 'image/jpeg' };
  await st.ref('receipts/sGroup/existing.jpg').put(new Uint8Array([1, 2, 3]), jpeg);
  await st.ref('receipts/sGroup/toDelete.jpg').put(new Uint8Array([1, 2, 3]), jpeg);
  await st.ref('receipts/sPersonalA/existing.jpg').put(new Uint8Array([1, 2, 3]), jpeg);
  await st.ref('receipts/sByD/existing.jpg').put(new Uint8Array([1, 2, 3]), jpeg);
  await st.ref('other/file.jpg').put(new Uint8Array([1, 2, 3]), jpeg);
});

const storageOf = (uid, claims) =>
  (claims ? env.authenticatedContext(uid, claims) : env.unauthenticatedContext()).storage();
const userA = storageOf('appuid-A', { lineId: 'A' }); // SG1 の有効メンバー
const userB = storageOf('appuid-B', { lineId: 'B' }); // SG1 の有効メンバー
const userC = storageOf('appuid-C', { lineId: 'C' }); // メンバーではない LINE ユーザー
const userD = storageOf('appuid-D', { lineId: 'D' }); // isActive:false の元メンバー
const userE = storageOf('appuid-E', { lineId: 'E' }); // 別の世帯（SG2）の有効メンバー
const anon = storageOf('anon-uid', {});
const unauth = storageOf(null, null);

const bytes = (n) => new Uint8Array(n);
// UploadTask は thenable なので Promise に包んで assert に渡す。
const put = (st, path, data, contentType) =>
  Promise.resolve(st.ref(path).put(data, contentType ? { contentType } : undefined));
const get = (st, path) => st.ref(path).getDownloadURL();
const del = (st, path) => st.ref(path).delete();

console.log('Storage rules tests:');

// --- アップロード（create） -------------------------------------------------
await test('有効メンバーはグループ支出にレシートを上げられる（JPEG）', async () => {
  await assertSucceeds(put(userA, 'receipts/sGroup/a.jpg', bytes(1024), 'image/jpeg'));
});
await test('有効メンバーは Gmail 取込のグループ支出にも上げられる（WebP / PNG / HEIC）', async () => {
  await assertSucceeds(put(userA, 'receipts/sGmail/a.webp', bytes(10), 'image/webp'));
  await assertSucceeds(put(userB, 'receipts/sGmail/b.png', bytes(10), 'image/png'));
  await assertSucceeds(put(userB, 'receipts/sGmail/c.heic', bytes(10), 'image/heic'));
});
await test('有効メンバーは HEIF も上げられる', async () => {
  await assertSucceeds(put(userA, 'receipts/sGroup/d.heif', bytes(10), 'image/heif'));
});
await test('個人支出は所有者が上げられる', async () => {
  await assertSucceeds(put(userA, 'receipts/sPersonalA/a.jpg', bytes(10), 'image/jpeg'));
});
await test('★ 非メンバーはグループ支出に上げられない', async () => {
  await assertFails(put(userC, 'receipts/sGroup/c.jpg', bytes(10), 'image/jpeg'));
});
await test('★ 脱退済みメンバーは上げられない（自分が登録した支出でも）', async () => {
  await assertFails(put(userD, 'receipts/sGroup/d.jpg', bytes(10), 'image/jpeg'));
  await assertFails(put(userD, 'receipts/sByD/d.jpg', bytes(10), 'image/jpeg'));
});
await test('★ 別の世帯のメンバーはグループ支出に上げられない', async () => {
  await assertFails(put(userE, 'receipts/sGroup/e.jpg', bytes(10), 'image/jpeg'));
});
await test('★ 非メンバー・脱退済み・別世帯は既存のレシートを上書き（update）できない', async () => {
  await assertFails(put(userC, 'receipts/sGroup/existing.jpg', bytes(10), 'image/jpeg'));
  await assertFails(put(userD, 'receipts/sGroup/existing.jpg', bytes(10), 'image/jpeg'));
  await assertFails(put(userE, 'receipts/sGroup/existing.jpg', bytes(10), 'image/jpeg'));
});
await test('★ lineGroupId だけを持つ旧形式の支出には、登録した本人（脱退済み）でも上げられない', async () => {
  await assertFails(put(userD, 'receipts/sLegacyD/d.jpg', bytes(10), 'image/jpeg'));
});
await test('★ 他人の個人支出には上げられない', async () => {
  await assertFails(put(userB, 'receipts/sPersonalA/b.jpg', bytes(10), 'image/jpeg'));
});
await test('★ 存在しない支出のパスには上げられない（画像ホスティングの悪用防止）', async () => {
  await assertFails(put(userA, 'receipts/noSuchExpense/a.jpg', bytes(10), 'image/jpeg'));
});
await test('★ 匿名・未認証は上げられない', async () => {
  await assertFails(put(anon, 'receipts/sGroup/anon.jpg', bytes(10), 'image/jpeg'));
  await assertFails(put(unauth, 'receipts/sGroup/unauth.jpg', bytes(10), 'image/jpeg'));
});
await test('★ SVG / GIF / 画像以外は上げられない', async () => {
  await assertFails(put(userA, 'receipts/sGroup/x.svg', bytes(10), 'image/svg+xml'));
  await assertFails(put(userA, 'receipts/sGroup/x.gif', bytes(10), 'image/gif'));
  await assertFails(put(userA, 'receipts/sGroup/x.html', bytes(10), 'text/html'));
});
await test('5MB ちょうどは上げられる', async () => {
  await assertSucceeds(put(userA, 'receipts/sGroup/max.jpg', bytes(5 * 1024 * 1024), 'image/jpeg'));
});
await test('★ 5MB を超えると上げられない', async () => {
  await assertFails(put(userA, 'receipts/sGroup/big.jpg', bytes(5 * 1024 * 1024 + 1), 'image/jpeg'));
});
await test('★ receipts 以外のパスには上げられない', async () => {
  await assertFails(put(userA, 'other/a.jpg', bytes(10), 'image/jpeg'));
});

// --- 読み取り（get / list） -------------------------------------------------
await test('有効メンバーはグループ支出のレシートを取得できる', async () => {
  await assertSucceeds(get(userB, 'receipts/sGroup/existing.jpg'));
});
await test('個人支出のレシートは所有者が取得できる', async () => {
  await assertSucceeds(get(userA, 'receipts/sPersonalA/existing.jpg'));
});
await test('★ 非メンバーはレシートを取得できない', async () => {
  await assertFails(get(userC, 'receipts/sGroup/existing.jpg'));
});
await test('★ 脱退済みメンバーは他人のレシートを取得できない', async () => {
  await assertFails(get(userD, 'receipts/sGroup/existing.jpg'));
});
await test('★ 別の世帯のメンバーはレシートを取得できない', async () => {
  await assertFails(get(userE, 'receipts/sGroup/existing.jpg'));
});
await test('★ 他人の個人支出のレシートは取得できない', async () => {
  await assertFails(get(userB, 'receipts/sPersonalA/existing.jpg'));
});
await test('★ 匿名はレシートを取得できない', async () => {
  await assertFails(get(anon, 'receipts/sGroup/existing.jpg'));
});
await test('★ レシートフォルダの列挙（list）はメンバーでもできない', async () => {
  await assertFails(userA.ref('receipts/sGroup').listAll());
});

// --- 削除 -----------------------------------------------------------------
await test('★ 非メンバーはレシートを削除できない', async () => {
  await assertFails(del(userC, 'receipts/sGroup/toDelete.jpg'));
});
await test('★ 脱退済みメンバーはレシートを削除できない', async () => {
  await assertFails(del(userD, 'receipts/sByD/existing.jpg'));
});
await test('★ 別の世帯のメンバーはレシートを削除できない', async () => {
  await assertFails(del(userE, 'receipts/sGroup/toDelete.jpg'));
});
await test('有効メンバーはレシートを削除できる', async () => {
  await assertSucceeds(del(userA, 'receipts/sGroup/toDelete.jpg'));
});

await env.cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
