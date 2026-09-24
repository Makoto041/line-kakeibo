// Firestore セキュリティルールのユニットテスト（CI の pr-checks でも実行する）。
// テスト用ツール（firebase-tools / @firebase/rules-unit-testing）は依存肥大化・
// 監査影響を避けるため package.json には含めていない。実行する場合はアドホックに:
//   npm i --no-save @firebase/rules-unit-testing firebase-tools@15
//   npx firebase emulators:exec --only firestore,storage --project demo-kakeibo \
//     "node test/firestore.rules.test.mjs && node test/storage.rules.test.mjs"
// （Java 21 以上 + エミュレータが必要。リポジトリ直下の firestore.rules を読み込んで検証する）
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
  doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, collection, query, where, getDocs,
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
  // 脱退済み（LINE グループからの退出で bot が isActive:false にする）
  await setDoc(doc(db, 'groupMembers/G1_D'), { groupId: 'G1', lineId: 'D', displayName: 'D', isActive: false });

  // 精算済み（立替を精算した）グループ支出
  await setDoc(doc(db, 'expenses/expSettled'), {
    lineId: 'B', ...group, amount: 1000, date: '2026-08-01', description: '立替',
    category: '食費', status: 'advance_settled', advanceBy: 'B', includeInTotal: true,
  });
  // web の編集対象を持つ、本番形状に近いグループ支出
  await setDoc(doc(db, 'expenses/expFull'), {
    lineId: 'B', ...group, amount: 700, date: '2026-08-03', description: 'スーパー',
    category: '食費', includeInTotal: false, status: 'pending', inputSource: 'line_text',
    createdAt: new Date('2026-08-03T00:00:00Z'),
  });
  // 既存データに上限を超える description が残っているケース
  await setDoc(doc(db, 'expenses/expLongDesc'), {
    lineId: 'gmail-auto-system', ...group, amount: 800, date: '2026-08-01',
    description: 'x'.repeat(2000), includeInTotal: true, inputSource: 'gmail_auto',
  });
  // 脱退済みメンバー D が登録したグループ支出
  await setDoc(doc(db, 'expenses/expByD'), { lineId: 'D', ...group, amount: 900, date: '2026-08-01' });

  await setDoc(doc(db, 'groups/G2'), { createdBy: 'C', inviteCode: 'INV999', lineGroupId: 'L2' });
  // 別の世帯（G2）の有効なメンバー E。G1 のデータには触れないこと（世帯をまたぐ権限の確認）
  await setDoc(doc(db, 'groupMembers/G2_E'), { groupId: 'G2', lineId: 'E', displayName: 'E', isActive: true });
  await setDoc(doc(db, 'expenses/expG2'), { lineId: 'E', groupId: 'G2', lineGroupId: 'L2', amount: 100, date: '2026-08-01' });
  // 脱退済みメンバー D が登録した、groupId を持たず lineGroupId だけを持つ旧形式の支出
  await setDoc(doc(db, 'expenses/expLegacyD'), { lineId: 'D', lineGroupId: 'L1', amount: 650, date: '2026-08-01' });
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
const userE = env.authenticatedContext('appuid-E', { lineId: 'E' }).firestore(); // 別の世帯（G2）の有効メンバー
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
await test('自分の lineId なら個人支出を作成できる', async () => {
  await assertSucceeds(setDoc(doc(userA, 'expenses/newA'), { lineId: 'A', amount: 5, date: '2026-08-02' }));
});
await test('★ 他人の lineId では作成できない（lineId 偽装）', async () => {
  await assertFails(setDoc(doc(userA, 'expenses/newX'), { lineId: 'B', amount: 5, date: '2026-08-02' }));
});
await test('匿名は作成できない', async () => {
  await assertFails(setDoc(doc(anon, 'expenses/newAnon'), { lineId: null, amount: 5, date: '2026-08-02' }));
});
await test('有効なメンバーは自分のグループに作成できる（lineGroupId 一致）', async () => {
  await assertSucceeds(setDoc(doc(userA, 'expenses/newAG'), {
    lineId: 'A', groupId: 'G1', lineGroupId: 'L1', amount: 1200, date: '2026-08-02',
    description: 'ランチ', category: '食費', includeInTotal: true, status: 'pending',
    createdAt: new Date(), updatedAt: new Date(),
  }));
});
await test('★ 非メンバーは他グループ（groupId 指定）に作成できない', async () => {
  await assertFails(setDoc(doc(userC, 'expenses/newCG'), { lineId: 'C', groupId: 'G1', amount: 5, date: '2026-08-02' }));
});
await test('★ 脱退済みメンバーはグループに作成できない', async () => {
  await assertFails(setDoc(doc(userD, 'expenses/newDG'), { lineId: 'D', groupId: 'G1', amount: 5, date: '2026-08-02' }));
});
await test('★ groupId なしで lineGroupId だけを持つ支出は作成できない（LINE 集計への注入防止）', async () => {
  await assertFails(setDoc(doc(userC, 'expenses/newCL'), {
    lineId: 'C', lineGroupId: 'L1', status: 'pending', amount: 50000, date: '2026-08-02',
  }));
});
await test('★ グループと一致しない lineGroupId では作成できない', async () => {
  await assertFails(setDoc(doc(userA, 'expenses/newAL2'), { lineId: 'A', groupId: 'G1', lineGroupId: 'L2', amount: 5, date: '2026-08-02' }));
});
await test('★ inputSource（gmail_auto の偽装）は作成時に書けない', async () => {
  await assertFails(setDoc(doc(userA, 'expenses/newAGm'), {
    lineId: 'A', amount: 5, date: '2026-08-02', description: '', inputSource: 'gmail_auto',
  }));
});
await test('★ 立替・精算系フィールド（status advance_settled / advanceBy）は作成時に書けない', async () => {
  await assertFails(setDoc(doc(userA, 'expenses/newAS'), { lineId: 'A', amount: 5, date: '2026-08-02', status: 'advance_settled' }));
  await assertFails(setDoc(doc(userA, 'expenses/newAAdv'), { lineId: 'A', amount: 5, date: '2026-08-02', advanceBy: 'A' }));
});
await test('★ appUid は作成時に書けない（userLinks 同期の悪用防止）', async () => {
  await assertFails(setDoc(doc(userA, 'expenses/newAUid'), { lineId: 'A', amount: 5, date: '2026-08-02', appUid: 'victim' }));
});
await test('★ 型・範囲の検証: 金額が文字列・負数・上限超過なら作成できない', async () => {
  await assertFails(setDoc(doc(userA, 'expenses/newAStr'), { lineId: 'A', amount: 'abc', date: '2026-08-02' }));
  await assertFails(setDoc(doc(userA, 'expenses/newANeg'), { lineId: 'A', amount: -1, date: '2026-08-02' }));
  await assertFails(setDoc(doc(userA, 'expenses/newABig'), { lineId: 'A', amount: 10000001, date: '2026-08-02' }));
});
await test('★ 型・範囲の検証: 日付の形式と文字列長', async () => {
  await assertFails(setDoc(doc(userA, 'expenses/newADate'), { lineId: 'A', amount: 5, date: '2026/08/02' }));
  await assertFails(setDoc(doc(userA, 'expenses/newADesc'), { lineId: 'A', amount: 5, date: '2026-08-02', description: 'x'.repeat(501) }));
  await assertFails(setDoc(doc(userA, 'expenses/newACat'), { lineId: 'A', amount: 5, date: '2026-08-02', category: 'x'.repeat(51) }));
});
await test('必須フィールド（amount / date）が無ければ作成できない', async () => {
  await assertFails(setDoc(doc(userA, 'expenses/newAMissing'), { lineId: 'A', amount: 5 }));
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

await test('web の編集ドロワーの保存（全フィールド送信）はメンバーに許可される', async () => {
  await assertSucceeds(updateDoc(doc(userA, 'expenses/expFull'), {
    amount: 750, description: 'スーパー（修正）', date: '2026-08-04', category: '日用品',
    includeInTotal: true, payerId: 'A', payerDisplayName: 'Aさん', updatedAt: new Date(),
  }));
});
await test('web の「合計に含める」トグルは許可される', async () => {
  await assertSucceeds(updateDoc(doc(userA, 'expenses/expGmail'), { includeInTotal: true, updatedAt: new Date() }));
});
await test('web のレシート添付（Firebase Storage の URL）は許可される', async () => {
  await assertSucceeds(updateDoc(doc(userA, 'expenses/expFull'), {
    receiptUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/receipts%2FexpFull%2Fa.jpg?alt=media&token=t',
    updatedAt: new Date(),
  }));
});
await test('★ 外部 URL をレシートとして埋め込めない', async () => {
  await assertFails(updateDoc(doc(userA, 'expenses/expFull'), { receiptUrl: 'https://evil.example.com/x.png' }));
});
await test('既存データの上限超え description に触れない編集は通る', async () => {
  await assertSucceeds(updateDoc(doc(userA, 'expenses/expLongDesc'), { includeInTotal: false, updatedAt: new Date() }));
});
await test('★ 不変フィールド: groupId / lineGroupId / createdAt / inputSource は変更できない', async () => {
  await assertFails(updateDoc(doc(userA, 'expenses/expFull'), { groupId: 'G2' }));
  await assertFails(updateDoc(doc(userA, 'expenses/expFull'), { lineGroupId: 'L2' }));
  await assertFails(updateDoc(doc(userA, 'expenses/expFull'), { createdAt: new Date() }));
  await assertFails(updateDoc(doc(userA, 'expenses/expFull'), { inputSource: 'gmail_auto' }));
});
await test('★ 不変フィールド: status / advanceBy / appUid は変更できない（bot 専用）', async () => {
  await assertFails(updateDoc(doc(userA, 'expenses/expFull'), { status: 'advance_pending' }));
  await assertFails(updateDoc(doc(userA, 'expenses/expFull'), { advanceBy: 'A' }));
  await assertFails(updateDoc(doc(userA, 'expenses/expA'), { appUid: 'x' }));
});
await test('★ groupId の削除（web から見えなくする）はできない', async () => {
  await assertFails(updateDoc(doc(userB, 'expenses/expFull'), { groupId: deleteField() }));
});
await test('★ 型の検証: 金額を文字列・負数にできない、日付の形式を崩せない', async () => {
  await assertFails(updateDoc(doc(userA, 'expenses/expFull'), { amount: 'abc' }));
  await assertFails(updateDoc(doc(userA, 'expenses/expFull'), { amount: -100 }));
  await assertFails(updateDoc(doc(userA, 'expenses/expFull'), { date: '8/4' }));
  await assertFails(updateDoc(doc(userA, 'expenses/expFull'), { description: 'x'.repeat(501) }));
});
await test('★ 脱退済みメンバーは自分が登録したグループ支出でも更新できない', async () => {
  await assertFails(updateDoc(doc(userD, 'expenses/expByD'), { amount: 1 }));
});

// --- 精算済みロック ---------------------------------------------------------
await test('★ 精算済み: 金額は変更できない', async () => {
  await assertFails(updateDoc(doc(userA, 'expenses/expSettled'), { amount: 1 }));
  await assertFails(updateDoc(doc(userB, 'expenses/expSettled'), { amount: 1 }));
});
await test('★ 精算済み: 日付は変更できない', async () => {
  await assertFails(updateDoc(doc(userB, 'expenses/expSettled'), { date: '2026-08-02' }));
});
await test('★ 精算済み: status を戻せない', async () => {
  await assertFails(updateDoc(doc(userB, 'expenses/expSettled'), { status: 'advance_pending' }));
});
// web の編集ドロワーは精算済みの支出では amount / date / payerId / payerDisplayName を送らない
// （web/app/expenses/page.tsx の handleEditSave）。
await test('精算済み: メモ・カテゴリの修正（web の送信形）は許可される', async () => {
  await assertSucceeds(updateDoc(doc(userA, 'expenses/expSettled'), {
    description: '立替（修正）', category: '日用品', includeInTotal: true, updatedAt: new Date(),
  }));
});
await test('精算済み: 金額・日付を同値で送っても（変更なし）許可される', async () => {
  await assertSucceeds(updateDoc(doc(userB, 'expenses/expSettled'), {
    amount: 1000, date: '2026-08-01', description: '立替（再修正）', updatedAt: new Date(),
  }));
});
await test('★ 精算済み: 支払者（payerId / payerDisplayName）は変更できない', async () => {
  await assertFails(updateDoc(doc(userA, 'expenses/expSettled'), { payerId: 'A' }));
  await assertFails(updateDoc(doc(userB, 'expenses/expSettled'), { payerDisplayName: 'Aさん' }));
});
await test('★ 精算済み: 登録した本人でも削除できない', async () => {
  await assertFails(deleteDoc(doc(userB, 'expenses/expSettled')));
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

await test('登録した本人（有効メンバー）は自分のグループ支出を削除できる', async () => {
  await assertSucceeds(deleteDoc(doc(userA, 'expenses/newAG')));
});
await test('★ 脱退済みメンバーは自分が登録したグループ支出でも削除できない', async () => {
  await assertFails(deleteDoc(doc(userD, 'expenses/expByD')));
});
await test('脱退済みメンバーも自分が登録した支出の read は残る（個人支出クエリの証明のため）', async () => {
  await assertSucceeds(getDoc(doc(userD, 'expenses/expByD')));
});
await test('★ 脱退済みメンバーは groups / 他メンバーを読めない', async () => {
  await assertFails(getDoc(doc(userD, 'groups/G1')));
  await assertFails(getDoc(doc(userD, 'groupMembers/G1_A')));
});

// --- lineGroupId だけを持つ旧形式の支出 -------------------------------------
await test('★ lineGroupId だけを持つ支出は、登録した本人（脱退済み）でも更新・削除できない', async () => {
  await assertFails(updateDoc(doc(userD, 'expenses/expLegacyD'), { amount: 1 }));
  await assertFails(deleteDoc(doc(userD, 'expenses/expLegacyD')));
});
await test('★ lineGroupId だけを持つ支出は、登録した本人（有効メンバー）でも更新できない', async () => {
  await assertFails(updateDoc(doc(userB, 'expenses/expLegacy'), { amount: 1 }));
});

// --- 別の世帯のメンバー -----------------------------------------------------
await test('別の世帯のメンバーは自分の世帯の支出を読める', async () => {
  await assertSucceeds(getDoc(doc(userE, 'expenses/expG2')));
  await assertSucceeds(getDocs(query(collection(userE, 'expenses'), where('groupId', '==', 'G2'))));
});
await test('★ 別の世帯のメンバーは G1 の支出を読めない・更新できない・削除できない', async () => {
  await assertFails(getDoc(doc(userE, 'expenses/expG')));
  await assertFails(updateDoc(doc(userE, 'expenses/expG'), { amount: 1 }));
  await assertFails(deleteDoc(doc(userE, 'expenses/expGmail')));
});
await test('★ 別の世帯のメンバーは G1 の支出を一覧できない', async () => {
  await assertFails(getDocs(query(collection(userE, 'expenses'), where('groupId', '==', 'G1'))));
});
await test('★ 別の世帯のメンバーは G1 に支出を作成できない', async () => {
  await assertFails(setDoc(doc(userE, 'expenses/newEG1'), { lineId: 'E', groupId: 'G1', lineGroupId: 'L1', amount: 5, date: '2026-08-02' }));
});
await test('★ 別の世帯のメンバーは G1 の groups / メンバーを読めない', async () => {
  await assertFails(getDoc(doc(userE, 'groups/G1')));
  await assertFails(getDocs(query(collection(userE, 'groupMembers'), where('groupId', '==', 'G1'))));
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

await test('設定: userSettings の自分のドキュメントに期間設定を保存できる', async () => {
  await assertSucceeds(setDoc(doc(userA, 'userSettings/A'), { dateSettings: { mode: 'monthly' } }, { merge: true }));
});
await test('★ 設定: 匿名は userSettings に書けない', async () => {
  await assertFails(setDoc(doc(anon, 'userSettings/anon-uid'), { x: 1 }));
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
