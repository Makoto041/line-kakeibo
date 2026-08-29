// Firestore セキュリティルールのユニットテスト（参考・任意実行）。
// テスト用ツール（firebase-tools / @firebase/rules-unit-testing）は依存肥大化・
// 監査影響を避けるため package.json には含めていない。実行する場合はアドホックに:
//   npm i --no-save @firebase/rules-unit-testing firebase-tools
//   npx firebase emulators:exec --only firestore --project demo-kakeibo "node test/firestore.rules.test.mjs"
// （Java 21 以上 + Firestore エミュレータが必要。リポジトリ直下の firestore.rules を読み込んで検証する）
//
// シードは本番のデータ形状に合わせている:
//   - グループ支出は groupId（groups のドキュメントID）と lineGroupId を両方持つ
//   - Gmail 自動取込は lineId が固定のシステムユーザー 'gmail-auto-system'
//   - groupMembers のドキュメントIDは `${groupId}_${lineId}`（決定的）
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
  const group = { groupId: 'G1', lineGroupId: 'L1' };

  // 個人支出
  await setDoc(doc(db, 'expenses/expA'), { lineId: 'A', amount: 100, date: '2026-08-01' });
  await setDoc(doc(db, 'expenses/expB'), { lineId: 'B', amount: 200, date: '2026-08-01' });
  await setDoc(doc(db, 'expenses/expADel'), { lineId: 'A', amount: 150, date: '2026-08-01' });
  // グループ支出（人が登録したもの）
  await setDoc(doc(db, 'expenses/expG'), { lineId: 'B', ...group, amount: 300, date: '2026-08-01' });
  // グループ支出（Gmail 自動取込）
  await setDoc(doc(db, 'expenses/expGmail'), { lineId: 'gmail-auto-system', ...group, amount: 400, date: '2026-08-01' });
  await setDoc(doc(db, 'expenses/expGmailDel'), { lineId: 'gmail-auto-system', ...group, amount: 450, date: '2026-08-01' });
  // グループに属さない Gmail 支出（緩和がグループ限定であることの確認用）
  await setDoc(doc(db, 'expenses/expGmailSolo'), { lineId: 'gmail-auto-system', amount: 500, date: '2026-08-01' });
  // groupId を持たず lineGroupId だけを持つ支出。
  // 本番データには存在しないが、メンバー未登録の利用者が LINE グループで登録すると
  // 生まれうる形。メンバーであっても読めないこと（= 所有者限定になること）を固定する。
  await setDoc(doc(db, 'expenses/expLegacy'), { lineId: 'B', lineGroupId: 'L1', amount: 600, date: '2026-08-01' });

  await setDoc(doc(db, 'groups/G1'), { createdBy: 'B', inviteCode: 'INV123', lineGroupId: 'L1' });

  // 決定的ID: `${groupId}_${lineId}`
  await setDoc(doc(db, 'groupMembers/G1_A'), { groupId: 'G1', lineId: 'A', displayName: 'A', isActive: true });
  await setDoc(doc(db, 'groupMembers/G1_B'), { groupId: 'G1', lineId: 'B', displayName: 'B', isActive: true });
  // 脱退済み（将来 isActive:false を使うようになったときのため）
  await setDoc(doc(db, 'groupMembers/G1_D'), { groupId: 'G1', lineId: 'D', displayName: 'D', isActive: false });

  await setDoc(doc(db, 'budgetSettings/A'), { monthlyBudget: 1000 });
  await setDoc(doc(db, 'budgetSettings/B'), { monthlyBudget: 2000 });
  await setDoc(doc(db, 'linkTokens/t1'), { lineId: 'A' });
  await setDoc(doc(db, 'userLinks/appuid-A'), { lineId: 'A' });
});

const unauth = env.unauthenticatedContext().firestore();
// サインイン済み（lineId カスタムクレームあり）＝ LINE 本人確認済み。
const userA = env.authenticatedContext('appuid-A', { lineId: 'A' }).firestore(); // G1 のメンバー
const userB = env.authenticatedContext('appuid-B', { lineId: 'B' }).firestore(); // G1 のメンバー
const userC = env.authenticatedContext('appuid-C', { lineId: 'C' }).firestore(); // LINE ユーザーだがメンバーではない
const userD = env.authenticatedContext('appuid-D', { lineId: 'D' }).firestore(); // isActive:false のメンバー
// 匿名フォールバック: サインイン済みだが lineId クレームなし。
const anon = env.authenticatedContext('anon-uid', {}).firestore();

console.log('Firestore rules tests:');

// --- 認証の基本 -----------------------------------------------------------
await test('未認証は支出を読めない', async () => {
  await assertFails(getDoc(doc(unauth, 'expenses/expA')));
});
await test('匿名（lineId クレームなし）は個人支出を読めない', async () => {
  await assertFails(getDoc(doc(anon, 'expenses/expA')));
});
await test('本人は自分の支出を読める', async () => {
  await assertSucceeds(getDoc(doc(userA, 'expenses/expA')));
});
await test('他人の個人支出は読めない', async () => {
  await assertFails(getDoc(doc(userA, 'expenses/expB')));
});

// --- 作成 -----------------------------------------------------------------
await test('自分の lineId なら作成できる', async () => {
  await assertSucceeds(setDoc(doc(userA, 'expenses/newA'), { lineId: 'A', amount: 5, date: '2026-08-02' }));
});
await test('他人の lineId では作成できない', async () => {
  await assertFails(setDoc(doc(userA, 'expenses/newX'), { lineId: 'B', amount: 5, date: '2026-08-02' }));
});

// --- グループ支出の read: メンバー限定 -------------------------------------
await test('メンバーはグループ支出を読める', async () => {
  await assertSucceeds(getDoc(doc(userA, 'expenses/expG')));
});
await test('メンバーは Gmail 取込のグループ支出を読める', async () => {
  await assertSucceeds(getDoc(doc(userA, 'expenses/expGmail')));
});
await test('★ 非メンバーの LINE ユーザーはグループ支出を読めない', async () => {
  await assertFails(getDoc(doc(userC, 'expenses/expG')));
});
await test('★ 脱退済み（isActive:false）メンバーはグループ支出を読めない', async () => {
  await assertFails(getDoc(doc(userD, 'expenses/expG')));
});
await test('匿名はグループ支出を読めない', async () => {
  await assertFails(getDoc(doc(anon, 'expenses/expG')));
});
await test('groupId を持たない支出はメンバーでも読めない（所有者限定になる）', async () => {
  await assertFails(getDoc(doc(userA, 'expenses/expLegacy')));
});

// --- 更新 -----------------------------------------------------------------
await test('本人は自分の支出を更新できる', async () => {
  await assertSucceeds(updateDoc(doc(userA, 'expenses/expA'), { amount: 111 }));
});
await test('他人の個人支出は更新できない', async () => {
  await assertFails(updateDoc(doc(userA, 'expenses/expB'), { amount: 999 }));
});
await test('所有権の付け替え（lineId 変更）はできない', async () => {
  await assertFails(updateDoc(doc(userA, 'expenses/expA'), { lineId: 'B' }));
});
await test('メンバーは他人が登録したグループ支出を更新できる', async () => {
  await assertSucceeds(updateDoc(doc(userA, 'expenses/expG'), { amount: 301 }));
});
await test('メンバーは Gmail 取込のグループ支出を更新できる', async () => {
  await assertSucceeds(updateDoc(doc(userA, 'expenses/expGmail'), { amount: 401 }));
});
await test('グループ支出の更新でも所有権は付け替えられない', async () => {
  await assertFails(updateDoc(doc(userA, 'expenses/expGmail'), { lineId: 'A' }));
});
await test('★ 非メンバーはグループ支出を更新できない', async () => {
  await assertFails(updateDoc(doc(userC, 'expenses/expG'), { amount: 999 }));
});
await test('匿名はグループ支出を更新できない', async () => {
  await assertFails(updateDoc(doc(anon, 'expenses/expG'), { amount: 777 }));
});

// --- 削除 -----------------------------------------------------------------
await test('本人は自分の支出を削除できる', async () => {
  await assertSucceeds(deleteDoc(doc(userA, 'expenses/expADel')));
});
await test('他人の個人支出は削除できない', async () => {
  await assertFails(deleteDoc(doc(userA, 'expenses/expB')));
});
await test('メンバーは Gmail 取込のグループ支出を削除できる', async () => {
  await assertSucceeds(deleteDoc(doc(userA, 'expenses/expGmailDel')));
});
await test('人が登録したグループ支出は他メンバーでも削除できない', async () => {
  await assertFails(deleteDoc(doc(userA, 'expenses/expG')));
});
await test('グループ外の Gmail 支出は削除できない', async () => {
  await assertFails(deleteDoc(doc(userA, 'expenses/expGmailSolo')));
});
await test('★ 非メンバーは Gmail 取込のグループ支出を削除できない', async () => {
  await assertFails(deleteDoc(doc(userC, 'expenses/expGmail')));
});

// --- web が実際に投げるクエリ形 --------------------------------------------
await test('クエリ: 自分の支出（where lineId==自分）', async () => {
  await assertSucceeds(getDocs(query(collection(userA, 'expenses'), where('lineId', '==', 'A'))));
});
await test('クエリ: グループ支出（where groupId==G1）をメンバーが取得', async () => {
  await assertSucceeds(getDocs(query(collection(userA, 'expenses'), where('groupId', '==', 'G1'))));
});
await test('★ クエリ: グループ支出を非メンバーが取得すると拒否', async () => {
  await assertFails(getDocs(query(collection(userC, 'expenses'), where('groupId', '==', 'G1'))));
});
// list はクエリ制約からの証明が必要なため、ルールが見る groupId を制約しない
// クエリ（lineGroupId 指定）は拒否される。web はこの形では引かない。
await test('クエリ: lineGroupId 指定はメンバーでも拒否（ルールが groupId を見るため）', async () => {
  await assertFails(getDocs(query(collection(userA, 'expenses'), where('lineGroupId', '==', 'L1'))));
});
await test('クエリ: 自分のメンバーシップ（where lineId==自分）', async () => {
  await assertSucceeds(getDocs(query(collection(userA, 'groupMembers'), where('lineId', '==', 'A'))));
});
await test('クエリ: メンバー一覧（where groupId==G1）をメンバーが取得', async () => {
  await assertSucceeds(getDocs(query(collection(userA, 'groupMembers'), where('groupId', '==', 'G1'))));
});
await test('★ クエリ: メンバー一覧を非メンバーが取得すると拒否', async () => {
  await assertFails(getDocs(query(collection(userC, 'groupMembers'), where('groupId', '==', 'G1'))));
});
// groups の read はパスのワイルドカードで判定するため getDoc 専用。
// list はドキュメントIDをクエリ制約から証明できないので必ず拒否される。
await test('クエリ: groups の list はメンバーでも拒否（getDoc 専用の条件のため）', async () => {
  await assertFails(getDocs(query(collection(userA, 'groups'), where('lineGroupId', '==', 'L1'))));
});

// --- groups / groupMembers ------------------------------------------------
await test('メンバーは groups を読める', async () => {
  await assertSucceeds(getDoc(doc(userA, 'groups/G1')));
});
await test('★ 非メンバーは groups（inviteCode を含む）を読めない', async () => {
  await assertFails(getDoc(doc(userC, 'groups/G1')));
});
await test('匿名は groups を読めない', async () => {
  await assertFails(getDoc(doc(anon, 'groups/G1')));
});
await test('メンバーは同じグループの他メンバーを読める', async () => {
  await assertSucceeds(getDoc(doc(userA, 'groupMembers/G1_B')));
});
await test('★ 非メンバーは他人のメンバーシップを読めない', async () => {
  await assertFails(getDoc(doc(userC, 'groupMembers/G1_A')));
});
await test('★ 権限昇格: 自分をグループに追加できない', async () => {
  await assertFails(setDoc(doc(userC, 'groupMembers/G1_C'), { groupId: 'G1', lineId: 'C', isActive: true }));
});
await test('★ メンバーでもメンバーシップは書き換えられない（Admin SDK 専用）', async () => {
  await assertFails(updateDoc(doc(userA, 'groupMembers/G1_A'), { displayName: 'X' }));
});
await test('★ groups はクライアントから作成できない', async () => {
  await assertFails(setDoc(doc(userC, 'groups/G2'), { createdBy: 'C', inviteCode: 'X' }));
});

// --- 設定系 ---------------------------------------------------------------
await test('設定: 自分のドキュメント（doc id == lineId）を読める', async () => {
  await assertSucceeds(getDoc(doc(userA, 'budgetSettings/A')));
});
await test('設定: 他人のドキュメントは読めない', async () => {
  await assertFails(getDoc(doc(userA, 'budgetSettings/B')));
});
await test('設定: 自分のドキュメントに書ける', async () => {
  await assertSucceeds(setDoc(doc(userA, 'budgetSettings/A'), { monthlyBudget: 1234 }));
});
await test('設定: 他人のドキュメントには書けない', async () => {
  await assertFails(setDoc(doc(userA, 'budgetSettings/B'), { monthlyBudget: 9 }));
});

// --- Admin SDK 専用コレクション --------------------------------------------
await test('linkTokens はクライアントから読めない', async () => {
  await assertFails(getDoc(doc(userA, 'linkTokens/t1')));
});
await test('linkTokens はクライアントから書けない', async () => {
  await assertFails(setDoc(doc(userA, 'linkTokens/t2'), { lineId: 'A' }));
});
await test('userLinks: 本人の appUid のドキュメントは読める', async () => {
  await assertSucceeds(getDoc(doc(userA, 'userLinks/appuid-A')));
});
await test('userLinks: 他人の appUid のドキュメントは読めない', async () => {
  await assertFails(getDoc(doc(userB, 'userLinks/appuid-A')));
});
await test('★ userLinks: クライアントからは書けない（appUid 解決の汚染防止）', async () => {
  await assertFails(setDoc(doc(userA, 'userLinks/appuid-A'), { lineIds: ['A', 'B'] }));
});
await test('default-deny: 未定義コレクションは読めない', async () => {
  await assertFails(getDoc(doc(userA, 'userCustomCategories/x')));
});

await env.cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
