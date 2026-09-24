#!/usr/bin/env node
/**
 * 世帯メンバー（groupMembers）の管理スクリプト。
 *
 * 家計簿の世帯はオーナーとパートナーの 2 名で固定する運用とし、bot は LINE グループでの
 * 発言や招待コードでメンバーを追加しない。メンバーシップ（isActive == true）は
 * firestore.rules / storage.rules の Web アクセス権そのものなので、追加・無効化は
 * このスクリプトで管理者が明示的に行う。
 *
 * 既定は dry-run（何も書き換えない）。書き換えるには --apply を付ける。
 *
 * 使い方:
 *   # 一覧（lineId は伏せ字。--show-ids で全体を表示）
 *   node scripts/manage-group-members.mjs list [--show-ids]
 *
 *   # 許可した lineId 以外の有効なメンバーを無効化（isActive:false）する
 *   node scripts/manage-group-members.mjs deactivate-unknown --group <groupId> --keep <lineId>,<lineId> [--apply]
 *
 *   # 1 件を無効化する
 *   node scripts/manage-group-members.mjs deactivate --group <groupId> --line-id <lineId> [--apply]
 *
 *   # メンバーを追加（または再有効化）する。有効なメンバーが既に 2 名なら拒否する。
 *   node scripts/manage-group-members.mjs add --group <groupId> --line-id <lineId> --name <表示名> [--apply]
 *
 * 認証: gcloud のオーナー権限アクセストークンで Firestore REST API を呼ぶ（ルールを
 * バイパスする）。事前に `gcloud auth login` 済みであること。
 *   環境変数 FIREBASE_PROJECT_ID（既定 line-kakeibo-0410）、GCLOUD_BIN（既定 gcloud）
 *
 * 補足: 無効化はドキュメントを削除せず isActive:false / leftAt / deactivatedReason を
 * 書く（履歴として残す）。ルールは isActive == true だけを有効とみなすので、無効化した
 * 時点で Web の閲覧・編集・レシート操作ができなくなる。
 */
import { execFileSync } from 'node:child_process';

const HOUSEHOLD_MAX_MEMBERS = 2; // bot/src/firestore.ts の HOUSEHOLD_MAX_MEMBERS と揃える
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'line-kakeibo-0410';
const GCLOUD = process.env.GCLOUD_BIN || 'gcloud';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// ------------------------------------------------------------------ 引数
const [command, ...rest] = process.argv.slice(2);
function opt(name) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = rest[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const has = (name) => rest.includes(`--${name}`);
const APPLY = has('apply');
const SHOW_IDS = has('show-ids');

function usage(msg) {
  if (msg) console.error(`エラー: ${msg}\n`);
  console.error('使い方: node scripts/manage-group-members.mjs <list|deactivate-unknown|deactivate|add> [options]');
  console.error('詳細はスクリプト冒頭のコメント、または docs/SECURITY_OPERATIONS.md を参照してください。');
  process.exit(2);
}

// ------------------------------------------------------------------ REST
let authHeaders = null;
function headers() {
  if (!authHeaders) {
    const token = execFileSync(GCLOUD, ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
    authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }
  return authHeaders;
}
async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: headers() });
  if (res.status === 404 && (init.method || 'GET') === 'GET') return null;
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${path} -> HTTP ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}
async function listAll(collection) {
  const out = [];
  let pageToken = '';
  do {
    const q = `?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const page = await api(`/${collection}${q}`);
    out.push(...(page?.documents || []));
    pageToken = page?.nextPageToken || '';
  } while (pageToken);
  return out;
}
/**
 * 指定フィールドだけを更新する（updateMask 付き PATCH）。
 * clear に渡したフィールドは updateMask に含めて本文に入れないことで削除される。
 */
async function patch(path, fields, clear = []) {
  const mask = [...Object.keys(fields), ...clear]
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join('&');
  return api(`${path}?${mask}`, { method: 'PATCH', body: JSON.stringify({ fields }) });
}

const docId = (doc) => doc.name.split('/').pop();
const str = (doc, field) => doc.fields?.[field]?.stringValue ?? null;
const isActive = (doc) => doc.fields?.isActive?.booleanValue === true;
/** ログに個人識別子をそのまま出さない */
const mask = (s) => (!s ? '(なし)' : SHOW_IDS ? s : `${s.slice(0, 6)}…${s.slice(-4)}`);
const memberDocId = (groupId, lineId) => `${groupId}_${lineId}`;

async function deactivate(doc, reason) {
  const label = `${str(doc, 'groupId')} / ${mask(str(doc, 'lineId'))} (${str(doc, 'displayName') ?? '-'})`;
  if (!APPLY) {
    console.log(`  [dry-run] 無効化予定: ${label}`);
    return;
  }
  await patch(`/groupMembers/${encodeURIComponent(docId(doc))}`, {
    isActive: { booleanValue: false },
    leftAt: { timestampValue: new Date().toISOString() },
    deactivatedReason: { stringValue: reason },
  });
  console.log(`  無効化しました: ${label}`);
}

// ------------------------------------------------------------------ コマンド
async function cmdList() {
  const members = await listAll('groupMembers');
  const groups = new Map((await listAll('groups')).map((g) => [docId(g), g]));
  const byGroup = new Map();
  for (const m of members) {
    const g = str(m, 'groupId') ?? '(groupId なし)';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(m);
  }
  for (const [groupId, list] of byGroup) {
    const g = groups.get(groupId);
    const active = list.filter(isActive).length;
    console.log(`\nグループ ${groupId}  「${g ? str(g, 'name') ?? '' : '(groups に無い)'}」  LINE: ${mask(g ? str(g, 'lineGroupId') : null)}`);
    console.log(`  有効なメンバー: ${active} 名` + (active > HOUSEHOLD_MAX_MEMBERS ? `  ← 上限 ${HOUSEHOLD_MAX_MEMBERS} 名を超えています` : ''));
    for (const m of list) {
      const idOk = docId(m) === memberDocId(str(m, 'groupId'), str(m, 'lineId'));
      console.log(
        `  ${isActive(m) ? '有効  ' : '無効  '} ${mask(str(m, 'lineId'))}  ${str(m, 'displayName') ?? '-'}` +
          (idOk ? '' : '  ← ドキュメントIDが決定的IDではない（migrate-group-members.mjs を実行）')
      );
    }
  }
  if (!SHOW_IDS) console.log('\n（lineId は伏せ字です。--keep に指定する値を確認するには --show-ids を付けてください）');
}

async function cmdDeactivateUnknown() {
  const groupId = opt('group');
  const keep = (opt('keep') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!groupId) usage('--group を指定してください');
  if (keep.length === 0) usage('--keep に残すメンバーの lineId をカンマ区切りで指定してください');
  if (keep.length > HOUSEHOLD_MAX_MEMBERS) usage(`--keep は ${HOUSEHOLD_MAX_MEMBERS} 名までです（世帯は2名固定）`);

  const members = (await listAll('groupMembers')).filter((m) => str(m, 'groupId') === groupId);
  const missingKeep = keep.filter((id) => !members.some((m) => str(m, 'lineId') === id && isActive(m)));
  if (missingKeep.length) {
    console.warn(`警告: --keep のうち有効なメンバーとして存在しないもの: ${missingKeep.map(mask).join(', ')}`);
  }
  const targets = members.filter((m) => isActive(m) && !keep.includes(str(m, 'lineId')));
  console.log(`グループ ${groupId}: 有効 ${members.filter(isActive).length} 名 / 無効化対象 ${targets.length} 名`);
  for (const m of targets) await deactivate(m, 'admin_unknown_member');
  if (!APPLY && targets.length) console.log('\n[dry-run] --apply を付けると実行します。');
}

async function cmdDeactivate() {
  const groupId = opt('group');
  const lineId = opt('line-id');
  if (!groupId || !lineId) usage('--group と --line-id を指定してください');
  const doc = await api(`/groupMembers/${encodeURIComponent(memberDocId(groupId, lineId))}`);
  if (!doc) {
    console.log('該当するメンバーシップはありません。');
    return;
  }
  if (!isActive(doc)) {
    console.log('既に無効です。');
    return;
  }
  await deactivate(doc, 'admin_manual');
  if (!APPLY) console.log('\n[dry-run] --apply を付けると実行します。');
}

async function cmdAdd() {
  const groupId = opt('group');
  const lineId = opt('line-id');
  const name = opt('name');
  if (!groupId || !lineId || !name) usage('--group / --line-id / --name を指定してください');
  if (!/^U[0-9a-f]{32}$/.test(lineId)) usage('--line-id は LINE の userId（U + 32 桁の16進数）を指定してください');

  const group = await api(`/groups/${encodeURIComponent(groupId)}`);
  if (!group) usage(`グループ ${groupId} が存在しません`);

  const members = (await listAll('groupMembers')).filter((m) => str(m, 'groupId') === groupId && isActive(m));
  const others = members.filter((m) => str(m, 'lineId') !== lineId);
  if (others.length >= HOUSEHOLD_MAX_MEMBERS) {
    console.error(
      `拒否: 有効なメンバーが既に ${others.length} 名います（上限 ${HOUSEHOLD_MAX_MEMBERS} 名）。` +
        '先に deactivate で入れ替え対象を無効化してください。'
    );
    process.exit(1);
  }
  const label = `${groupId} / ${mask(lineId)} (${name})`;
  const existing = await api(`/groupMembers/${encodeURIComponent(memberDocId(groupId, lineId))}`);
  const action = !existing ? '追加' : isActive(existing) ? '表示名の更新' : '再有効化';
  if (!APPLY) {
    console.log(`[dry-run] ${action}予定: ${label}\n--apply を付けると実行します。`);
    return;
  }
  const fields = {
    groupId: { stringValue: groupId },
    lineId: { stringValue: lineId },
    displayName: { stringValue: name },
    isActive: { booleanValue: true },
  };
  // 再有効化では元の joinedAt を残す
  if (!existing) fields.joinedAt = { timestampValue: new Date().toISOString() };
  // 再有効化では無効化時の記録（leftAt / deactivatedReason）を消す
  await patch(
    `/groupMembers/${encodeURIComponent(memberDocId(groupId, lineId))}`,
    fields,
    existing ? ['leftAt', 'deactivatedReason'] : []
  );
  console.log(`${action}しました: ${label}`);
}

switch (command) {
  case 'list':
    await cmdList();
    break;
  case 'deactivate-unknown':
    await cmdDeactivateUnknown();
    break;
  case 'deactivate':
    await cmdDeactivate();
    break;
  case 'add':
    await cmdAdd();
    break;
  default:
    usage(command ? `不明なコマンド: ${command}` : undefined);
}
