#!/usr/bin/env node
/**
 * groupMembers を決定的ドキュメントID（`${groupId}_${lineId}`）へ移行する。
 *
 * 背景:
 *   groupMembers は `.add()` の自動生成IDで作られていたため、セキュリティルールから
 *   「呼び出し元が当該グループのメンバーか」を決定的なパスで検証できなかった。
 *   ID を (groupId, lineId) から導出すれば、ルール内で
 *   `exists(/databases/$(db)/documents/groupMembers/$(groupId + '_' + myLineId()))`
 *   によるメンバー限定の判定ができる。
 *
 * 実行方法（既定は dry-run。実際に書き換えるには --apply を付ける）:
 *   ./google-cloud-sdk/bin/gcloud auth print-access-token > /dev/null   # 事前にログイン確認
 *   node scripts/migrate-group-members.mjs              # dry-run
 *   node scripts/migrate-group-members.mjs --apply      # 実行
 *
 * Firestore REST API をオーナー権限のアクセストークンで叩く（セキュリティルールを
 * バイパスする）。Admin SDK を使わないのは、この環境では
 * GOOGLE_APPLICATION_CREDENTIALS の指す鍵ファイルが存在しないため。
 *
 * 冪等。既に決定的IDへ移行済みのドキュメントは何もしない。
 */
import { execFileSync } from 'node:child_process';

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'line-kakeibo-0410';
const GCLOUD = process.env.GCLOUD_BIN || './google-cloud-sdk/bin/gcloud';
const APPLY = process.argv.includes('--apply');
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const token = execFileSync(GCLOUD, ['auth', 'print-access-token'], {
  encoding: 'utf8',
}).trim();

const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: authHeaders });
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${path} -> HTTP ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * ページングしてコレクション全件を取得する。
 * selectFields を渡すと、そのフィールドだけを取得する（不要な個人データを読まない）。
 */
async function listAll(collection, selectFields) {
  const out = [];
  let pageToken = '';
  const mask = (selectFields || [])
    .map((f) => `&mask.fieldPaths=${encodeURIComponent(f.fieldPath)}`)
    .join('');
  do {
    const q = `?pageSize=300${mask}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const page = await api(`/${collection}${q}`);
    out.push(...(page.documents || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return out;
}

const docId = (doc) => doc.name.split('/').pop();
const str = (doc, field) => doc.fields?.[field]?.stringValue ?? null;
/** ログに個人識別子をそのまま出さない */
const mask = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : '(なし)');

// ---------------------------------------------------------------- 移行本体
const members = await listAll('groupMembers');
console.log(`groupMembers: ${members.length} 件`);

const planned = [];
for (const doc of members) {
  const id = docId(doc);
  const groupId = str(doc, 'groupId');
  const lineId = str(doc, 'lineId');
  if (!groupId || !lineId) {
    console.log(`  SKIP  ${mask(id)} — groupId / lineId が欠けている（手動確認が必要）`);
    continue;
  }
  const targetId = `${groupId}_${lineId}`;
  if (id === targetId) {
    console.log(`  OK    ${mask(id)} — 移行済み`);
    continue;
  }
  planned.push({ oldId: id, targetId, fields: doc.fields });
  console.log(`  MOVE  ${mask(id)} -> ${mask(targetId)}`);
}

if (planned.length === 0) {
  console.log('\n移行対象はありません。');
} else if (!APPLY) {
  console.log(`\n[dry-run] ${planned.length} 件が移行対象です。--apply を付けると実行します。`);
} else {
  const existingIds = new Set(members.map(docId));
  for (const { oldId, targetId, fields } of planned) {
    if (existingIds.has(targetId)) {
      // 前回の実行が「新ID作成後・旧ID削除前」で中断した場合、移行先には既に
      // 正しい（場合によっては更新済みの）状態がある。ここで旧IDの内容を書き戻すと
      // displayName / isActive などを巻き戻してしまうため、上書きせず旧IDだけ消す。
      console.log(`  KEEP  ${mask(targetId)} は既に存在するため上書きしない`);
    } else {
      // 新IDで作成（フィールドはそのままコピー。joinedAt 等のタイムスタンプを作り直さない）
      await api(`/groupMembers/${encodeURIComponent(targetId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields }),
      });
      // 新ドキュメントの生成を確認してから旧ドキュメントを消す
      await api(`/groupMembers/${encodeURIComponent(targetId)}`);
    }
    await api(`/groupMembers/${encodeURIComponent(oldId)}`, { method: 'DELETE' });
    console.log(`  DONE  ${mask(oldId)} -> ${mask(targetId)}`);
  }
}

// ------------------------------------------------------- 移行後の検証（Phase 2 のゲート）
console.log('\n=== 検証 ===');
const after = await listAll('groupMembers');

// 1) 全ドキュメントが決定的IDになっているか
const stray = after.filter((d) => docId(d) !== `${str(d, 'groupId')}_${str(d, 'lineId')}`);
console.log(`[1] 決定的IDでないドキュメント: ${stray.length} 件` + (stray.length ? ' ← 要対応' : ' ✓'));

// 2) 同一 (groupId, lineId) の重複が無いか（重複はメンバー一覧の二重表示になる）
const seen = new Map();
for (const d of after) {
  const key = `${str(d, 'groupId')}_${str(d, 'lineId')}`;
  seen.set(key, (seen.get(key) || 0) + 1);
}
const dupes = [...seen.entries()].filter(([, n]) => n > 1);
console.log(`[2] 重複メンバー: ${dupes.length} 件` + (dupes.length ? ' ← 要対応' : ' ✓'));

// 3) グループ支出を持つ全 LINE ユーザーが「有効な」メンバードキュメントを持つか
//    これが満たされないまま Phase 2（ルール厳格化）を出すと、その利用者は
//    グループ家計簿が見えなくなる。Phase 2 の前提条件。
// 件数上限を切ると、上限を超えた分に未登録メンバーが紛れていても
// 「安全」と報告してしまう。ページングして全件を見る。
const expenses = await listAll('expenses', [
  { fieldPath: 'lineId' },
  { fieldPath: 'groupId' },
]);

// Phase 2 のルールは isActive == true のメンバーシップだけを有効とみなす。
// ここで無効なものまで「登録済み」と数えると、脱退扱いの利用者がゲートを
// 通過したのちルール側で拒否され、グループ家計簿が見えなくなる。
const bool = (doc, field) => doc.fields?.[field]?.booleanValue === true;
const memberIds = new Set(after.filter((d) => bool(d, 'isActive')).map(docId));
const needed = new Map(); // `${groupId}_${lineId}` -> 件数
for (const e of expenses) {
  const groupId = str(e, 'groupId');
  const lineId = str(e, 'lineId');
  // LINE 実ユーザーのみ対象。Gmail 取込のシステムユーザーはメンバーではない。
  if (!groupId || !lineId || !lineId.startsWith('U')) continue;
  const key = `${groupId}_${lineId}`;
  needed.set(key, (needed.get(key) || 0) + 1);
}
const missing = [...needed.keys()].filter((k) => !memberIds.has(k));
console.log(
  `[3] グループ支出を持つ LINE ユーザー: ${needed.size} 名 / 有効なメンバー登録なし: ${missing.length} 名` +
    (missing.length ? ' ← Phase 2 を出す前に要対応' : ' ✓')
);
for (const k of missing) console.log(`      未登録: ${mask(k)}`);

const ok = stray.length === 0 && dupes.length === 0 && missing.length === 0;
console.log(`\n判定: ${ok ? '✓ Phase 2（ルール厳格化）へ進めます' : '✗ 未解決の項目があります'}`);
process.exit(ok ? 0 : 1);
