/**
 * /household API の統合テスト（Firestore・Auth エミュレータ + 実際の Express ルーター）
 *
 * ビルド済みの dist/householdApi.js のルーターを、index.ts の `api` と同じ形
 * （express.json() → app.use("/household", householdRouter, householdErrorHandler)）で素の express に載せ、
 * Auth エミュレータで発行した ID トークンで叩く。本番のプロジェクトには接続しない（demo-* 以外は即終了）。
 *
 * 実行例（firebase-tools は依存に入れず、リポジトリ外に `npm i --no-save` するかグローバルに入れて PATH に置く）:
 *   npm -w bot run test:emulator
 *   （= ビルドしてから firebase --config scripts/firebase.emulator.json emulators:exec --only firestore,auth \
 *       --project demo-kakeibo "node scripts/emulator-household-api.js"。ポートは --config で指定した
 *       bot/scripts/firebase.emulator.json の Firestore 18080 / Auth 19099）
 *
 * サンドボックスなどでプロキシ環境変数があると gRPC がエミュレータへ届かないので、
 * HTTP_PROXY / HTTPS_PROXY / JAVA_TOOL_OPTIONS を外して実行する。
 */
const express = require('express');
const http = require('http');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

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

initializeApp({ projectId });

const { householdRouter, householdErrorHandler } = require('../dist/householdApi');
const { applyExpenseChange, decideConfirm, decideSetAdvance, decideSetPayer } = require('../dist/expenseActions');
const { readActiveMember } = require('../dist/householdMembers');

const ORIGIN = 'https://line-kakeibo.vercel.app';
const EVIL_ORIGIN = 'https://evil.example.com';

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}
const sameMembers = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

// ------------------------------------------------------------
// エミュレータの準備
// ------------------------------------------------------------

async function clearEmulators() {
  const fs = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  const au = await fetch(`http://${authHost}/emulator/v1/projects/${projectId}/accounts`, { method: 'DELETE' });
  if (!fs.ok || !au.ok) throw new Error(`failed to clear emulators (${fs.status}/${au.status})`);
}

/** カスタムトークン（エミュレータでは署名なし）→ Auth エミュレータで ID トークンに交換 */
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

async function anonymousIdToken() {
  const res = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  const body = await res.json();
  if (!body.idToken) throw new Error(`anonymous signUp failed: ${res.status}`);
  return body.idToken;
}

const ts = (iso) => Timestamp.fromDate(new Date(iso));

async function seed(db) {
  const batch = db.batch();
  const set = (path, data) => batch.set(db.doc(path), data);

  // 世帯 g1（LINE グループ C_line1 に紐づく）: Alice と Bob が有効、Left は脱退済み
  set('groups/g1', { name: 'LINEグループ test', inviteCode: '111111', createdBy: 'Ualice', lineGroupId: 'C_line1' });
  set('groupMembers/g1_Ualice', { groupId: 'g1', lineId: 'Ualice', displayName: 'Alice', isActive: true, joinedAt: ts('2026-01-01T00:00:00Z') });
  set('groupMembers/g1_Ubob', { groupId: 'g1', lineId: 'Ubob', displayName: 'Bob', isActive: true, joinedAt: ts('2026-01-02T00:00:00Z') });
  set('groupMembers/g1_Uleft', { groupId: 'g1', lineId: 'Uleft', displayName: 'Left', isActive: false, joinedAt: ts('2026-01-03T00:00:00Z') });

  // 世帯 g1_x のメンバー Umallory。文書 ID `g1_x_Umallory` は「lineId が x_Umallory の人の g1 の文書 ID」と
  // 同じ文字列になるので、ID だけで判定すると g1 に入れてしまう
  set('groups/g1_x', { name: 'collision', inviteCode: '444444', createdBy: 'Umallory' });
  set('groupMembers/g1_x_Umallory', { groupId: 'g1_x', lineId: 'Umallory', displayName: 'Mallory', isActive: true, joinedAt: ts('2026-01-01T00:00:00Z') });

  // 世帯 g4（LINE グループなし）: Frank と Gina（立替の印を外す操作のレート制限を確かめる）
  set('groups/g4', { name: 'limit', inviteCode: '555555', createdBy: 'Ufrank' });
  set('groupMembers/g4_Ufrank', { groupId: 'g4', lineId: 'Ufrank', displayName: 'Frank', isActive: true, joinedAt: ts('2026-01-01T00:00:00Z') });
  set('groupMembers/g4_Ugina', { groupId: 'g4', lineId: 'Ugina', displayName: 'Gina', isActive: true, joinedAt: ts('2026-01-02T00:00:00Z') });

  // 世帯 g2（LINE グループなし）: Carol だけ
  set('groups/g2', { name: 'solo', inviteCode: '222222', createdBy: 'Ucarol' });
  set('groupMembers/g2_Ucarol', { groupId: 'g2', lineId: 'Ucarol', displayName: 'Carol', isActive: true, joinedAt: ts('2026-01-01T00:00:00Z') });

  const base = { date: '2026-09-12', category: '食費', confirmed: false, createdAt: ts('2026-09-12T01:00:00Z'), updatedAt: ts('2026-09-12T01:00:00Z') };
  // 確認の対象
  set('expenses/e_line_manual', { ...base, lineId: 'Ualice', payerId: 'Ualice', groupId: 'g1', lineGroupId: 'C_line1', amount: 2480, description: 'スーパー', includeInTotal: false });
  set('expenses/e_line_manual_postback', { ...base, lineId: 'Ualice', payerId: 'Ualice', groupId: 'g1', lineGroupId: 'C_line1', amount: 2480, description: 'スーパー', includeInTotal: false });
  // 以前の Gmail 取込（pending・未確認で保存されていた）と、現在の Gmail 取込（shared・確認済み）
  set('expenses/e_gmail', { ...base, lineId: 'gmail-auto-system', payerId: 'gmail-auto-system', groupId: 'g1', amount: 720, description: '交通費', status: 'pending', includeInTotal: true, inputSource: 'gmail_auto' });
  set('expenses/e_gmail_shared', { ...base, lineId: 'gmail-auto-system', payerId: 'gmail-auto-system', groupId: 'g1', amount: 980, description: 'コンビニ', status: 'shared', confirmed: true, includeInTotal: true, inputSource: 'gmail_auto' });
  set('expenses/e_personal', { ...base, lineId: 'Ualice', payerId: 'Ualice', amount: 500, description: 'コーヒー', includeInTotal: false });
  set('expenses/e_legacy', { ...base, lineId: 'Ualice', payerId: 'Ualice', lineGroupId: 'C_line1', amount: 900, description: '旧形式', includeInTotal: false });
  set('expenses/e_settled', { ...base, lineId: 'Ubob', payerId: 'Ubob', groupId: 'g1', lineGroupId: 'C_line1', amount: 3000, description: '旅行', status: 'advance_settled', advanceBy: 'Ubob', includeInTotal: true, confirmed: true });

  // 立替の印が残っている支出（LINE グループ C_line1）: Alice 12,400 / Bob 4,000
  set('expenses/adv_a1', { ...base, lineId: 'Ualice', payerId: 'Ualice', groupId: 'g1', lineGroupId: 'C_line1', amount: 10000, description: '家具', status: 'advance_pending', advanceBy: 'Ualice', includeInTotal: true, confirmed: true, createdAt: ts('2026-09-10T01:00:00Z') });
  set('expenses/adv_a2', { ...base, lineId: 'Ualice', payerId: 'Ualice', groupId: 'g1', lineGroupId: 'C_line1', amount: 2400, description: '日用品', status: 'advance_pending', advanceBy: 'Ualice', includeInTotal: true, confirmed: true, createdAt: ts('2026-09-11T01:00:00Z') });
  set('expenses/adv_b1', { ...base, lineId: 'Ubob', payerId: 'Ubob', groupId: 'g1', lineGroupId: 'C_line1', amount: 4000, description: '外食', status: 'advance_pending', advanceBy: 'Ubob', includeInTotal: true, confirmed: true, createdAt: ts('2026-09-12T01:00:00Z') });
  // 全額で返す立替（advanceFull）は期間の精算で返すので、以前の立替の一覧に入らない
  set('expenses/adv_full', { ...base, lineId: 'Ubob', payerId: 'Ubob', groupId: 'g1', lineGroupId: 'C_line1', amount: 2610, description: 'ゆで太郎', status: 'advance_pending', advanceBy: 'Ubob', advanceFull: true, includeInTotal: true, confirmed: true });
  // 個人チャットで登録した立替（groupId だけ）は LINE グループ基準の一覧に入らない（以前の LINE の「精算」と同じ）
  set('expenses/adv_private', { ...base, lineId: 'Ubob', payerId: 'Ubob', groupId: 'g1', amount: 777, description: '個人チャット', status: 'advance_pending', advanceBy: 'Ubob', includeInTotal: true, confirmed: true });

  // 世帯 g5（LINE グループ C_line5 に紐づく）: 作成者 Hana のメンバー文書は仮名「作成者」のまま（createGroup の既定）
  set('groups/g5', { name: 'LINEグループ placeholder', inviteCode: '666666', createdBy: 'Uhana', lineGroupId: 'C_line5' });
  set('groupMembers/g5_Uhana', { groupId: 'g5', lineId: 'Uhana', displayName: '作成者', isActive: true, joinedAt: ts('2026-01-01T00:00:00Z') });
  set('groupMembers/g5_Uivan', { groupId: 'g5', lineId: 'Uivan', displayName: 'Ivan', isActive: true, joinedAt: ts('2026-01-02T00:00:00Z') });
  set('expenses/adv_i1', { ...base, lineId: 'Uivan', payerId: 'Uivan', userDisplayName: 'Ivan', groupId: 'g5', lineGroupId: 'C_line5', amount: 6000, description: '家電', status: 'advance_pending', advanceBy: 'Uivan', includeInTotal: true, confirmed: true });

  // g2 の立替（Carol だけ）
  set('expenses/adv_c1', { ...base, lineId: 'Ucarol', payerId: 'Ucarol', groupId: 'g2', amount: 3000, description: 'solo', status: 'advance_pending', advanceBy: 'Ucarol', includeInTotal: true, confirmed: true });
  await batch.commit();

  // 世帯 g3: 立替の印が 501 件（batch の上限を超える）
  await db.doc('groups/g3').set({ name: 'many', inviteCode: '333333', createdBy: 'Udave' });
  await db.doc('groupMembers/g3_Udave').set({ groupId: 'g3', lineId: 'Udave', displayName: 'Dave', isActive: true, joinedAt: ts('2026-01-01T00:00:00Z') });
  await db.doc('groupMembers/g3_Ueve').set({ groupId: 'g3', lineId: 'Ueve', displayName: 'Eve', isActive: true, joinedAt: ts('2026-01-02T00:00:00Z') });
  for (let start = 0; start < 501; start += 250) {
    const b = db.batch();
    for (let i = start; i < Math.min(start + 250, 501); i++) {
      b.set(db.doc(`expenses/many_${String(i).padStart(3, '0')}`), { ...base, lineId: 'Udave', payerId: 'Udave', groupId: 'g3', amount: 1, description: 'x', status: 'advance_pending', advanceBy: 'Udave', includeInTotal: true, confirmed: true });
    }
    await b.commit();
  }
}

// ------------------------------------------------------------
// テスト本体
// ------------------------------------------------------------

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

  // 認証前の上限（300 回/分）は接続元（X-Forwarded-For の末尾、無ければ req.ip）単位。X-Forwarded-For を付けない
  // 要求は 127.0.0.1 として共有する（Bearer トークンの無い要求は数えない）。
  // テストはおよそ 1 分以内に終わるので、Bearer 付きの要求は合計 300 回未満に抑えること（最後に確かめる）。
  // 上限に掛かると、確かめたい内容と関係の無い 429 で FAIL になるため、想定外の 429 も最後にまとめて報告する。
  let bearerRequests = 0;
  const unexpected429 = [];

  async function call(method, path, { token, body, rawBody, origin = ORIGIN, headers = {}, allow429 = false } = {}) {
    const h = { ...headers };
    // X-Forwarded-For を付けた要求は別の接続元として数えられるので、127.0.0.1 の予算には入れない
    if (token && !h['X-Forwarded-For']) bearerRequests++;
    if (origin) h.Origin = origin;
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined || rawBody !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers: h,
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && !allow429) unexpected429.push(`${method} ${path}`);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, headers: res.headers, body: json };
  }
  const acao = (r) => r.headers.get('access-control-allow-origin');

  /** fetch は URL の %2E%2E を .. として正規化してしまうので、パスをそのまま送る */
  function rawPost(path, token, body) {
    bearerRequests++;
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }

  const tokens = {
    alice: await idTokenFor('uid-alice', { lineId: 'Ualice' }),
    bob: await idTokenFor('uid-bob', { lineId: 'Ubob' }),
    carol: await idTokenFor('uid-carol', { lineId: 'Ucarol' }),
    dave: await idTokenFor('uid-dave', { lineId: 'Udave' }),
    left: await idTokenFor('uid-left', { lineId: 'Uleft' }),
    stranger: await idTokenFor('uid-stranger', { lineId: 'Ustranger' }),
    collider: await idTokenFor('uid-collider', { lineId: 'x_Umallory' }),
    frank: await idTokenFor('uid-frank', { lineId: 'Ufrank' }),
    gina: await idTokenFor('uid-gina', { lineId: 'Ugina' }),
    ivan: await idTokenFor('uid-ivan', { lineId: 'Uivan' }),
    noLineId: await idTokenFor('uid-nolineid'),
    anonymous: await anonymousIdToken(),
  };
  const tokensIssuedAt = Date.now();

  try {
    // ---------------- CORS ----------------
    console.log('CORS');
    {
      const r = await call('OPTIONS', '/household/legacy-advances?groupId=g1', { headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
      check('プリフライトは 204', r.status === 204);
      check('許可オリジンに ACAO', acao(r) === ORIGIN);
      check('Vary: Origin', r.headers.get('vary') === 'Origin');
      check('Authorization を許可', (r.headers.get('access-control-allow-headers') || '').includes('Authorization'));
      check('GET, POST, PATCH, DELETE, OPTIONS を許可', r.headers.get('access-control-allow-methods') === 'GET, POST, PATCH, DELETE, OPTIONS');
      check('Allow-Credentials は付けない', r.headers.get('access-control-allow-credentials') === null);
      check('X-Content-Type-Options: nosniff', r.headers.get('x-content-type-options') === 'nosniff');
      const evil = await call('OPTIONS', '/household/legacy-advances?groupId=g1', { origin: EVIL_ORIGIN });
      check('許可外のオリジンは ACAO なし', evil.status === 204 && acao(evil) === null);
    }

    // ---------------- 認証 ----------------
    console.log('\n認証');
    {
      const r = await call('GET', '/household/legacy-advances?groupId=g1');
      check('トークン無しは 401 unauthenticated', r.status === 401 && r.body && r.body.error === 'unauthenticated', r.body);
      check('401 にも CORS ヘッダー', acao(r) === ORIGIN);
      check('Cache-Control: no-store', r.headers.get('cache-control') === 'no-store');
      check('401 にも X-Content-Type-Options: nosniff', r.headers.get('x-content-type-options') === 'nosniff');
      const bad = await call('GET', '/household/legacy-advances?groupId=g1', { token: 'not-a-jwt' });
      check('不正なトークンは 401', bad.status === 401 && bad.body.error === 'unauthenticated');
      const basic = await call('GET', '/household/legacy-advances?groupId=g1', { headers: { Authorization: `Basic ${tokens.alice}` } });
      check('Bearer 以外は 401', basic.status === 401);
      const anon = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.anonymous });
      check('匿名ユーザーは 403', anon.status === 403 && anon.body.error === 'forbidden', anon.body);
      const noLine = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.noLineId });
      check('lineId クレームの無いカスタムトークンは 403', noLine.status === 403, noLine.body);
    }

    // ---------------- 精算の表示 ----------------
    console.log('\nGET /household/legacy-advances');
    {
      const stranger = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.stranger });
      check('メンバー外は 403', stranger.status === 403 && stranger.body.error === 'forbidden' && acao(stranger) === ORIGIN);
      const left = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.left });
      check('脱退者（isActive:false）は 403', left.status === 403);
      const other = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.carol });
      check('他の世帯のメンバーは 403', other.status === 403);
      const collider = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.collider });
      check('文書 ID が一致しても中身の groupId・lineId が違えば 403', collider.status === 403 && collider.body.error === 'forbidden', collider.body);
      const missing = await call('GET', '/household/legacy-advances?groupId=nope', { token: tokens.alice });
      check('存在しない世帯（メンバーでもない）は 403', missing.status === 403);
      const arr = await call('GET', '/household/legacy-advances?groupId=g1&groupId=g2', { token: tokens.alice });
      check('groupId が配列なら 400', arr.status === 400 && arr.body.error === 'invalid_request', arr.body);
      const none = await call('GET', '/household/legacy-advances', { token: tokens.alice });
      check('groupId が無ければ 400', none.status === 400);
      const reserved = await call('GET', '/household/legacy-advances?groupId=__x__', { token: tokens.alice });
      check('予約 ID（__x__）は 400', reserved.status === 400);
      const long = await call('GET', `/household/legacy-advances?groupId=${'a'.repeat(129)}`, { token: tokens.alice });
      check('129 文字の groupId は 400', long.status === 400);

      const r = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.alice });
      const v = r.body;
      check('メンバーは 200', r.status === 200, v);
      check('対象は LINE グループの以前の立替 3 件（全額の立替・個人チャット分・精算済みは含まない）', sameMembers(v.expenseIds, ['adv_a1', 'adv_a2', 'adv_b1']), v.expenseIds);
      check('items は createdAt 降順', v.items.map((i) => i.id).join(',') === 'adv_b1,adv_a2,adv_a1', v.items.map((i) => i.id));
      check('items のフィールドは必要なものだけ', JSON.stringify(Object.keys(v.items[0]).sort()) === JSON.stringify(['advanceBy', 'advanceByName', 'amount', 'category', 'date', 'description', 'id']), Object.keys(v.items[0]));
      check('立替にした人と金額', v.items[0].advanceBy === 'Ubob' && v.items[0].amount === 4000 && v.items[2].advanceBy === 'Ualice', v.items);
      check('asOf は ISO 8601', typeof v.asOf === 'string' && !Number.isNaN(Date.parse(v.asOf)));
      check('応答にトークンや内部フィールドを含まない', !JSON.stringify(v).includes('lineGroupId') && !JSON.stringify(v).includes('C_line1'));
    }

    // ---------------- 確認 ----------------
    console.log('\nPOST /household/expenses/:id/actions');
    {
      const noTok = await call('POST', '/household/expenses/e_line_manual/actions', { body: { action: 'confirm' } });
      check('トークン無しは 401', noTok.status === 401 && acao(noTok) === ORIGIN);
      const stranger = await call('POST', '/household/expenses/e_line_manual/actions', { token: tokens.stranger, body: { action: 'confirm' } });
      check('メンバー外は 403', stranger.status === 403 && stranger.body.error === 'forbidden');
      const left = await call('POST', '/household/expenses/e_line_manual/actions', { token: tokens.left, body: { action: 'confirm' } });
      check('脱退者は 403', left.status === 403);
      const unchanged = (await db.doc('expenses/e_line_manual').get()).data();
      check('拒否されたときは書き込まない', unchanged.status === undefined && unchanged.confirmed === false && unchanged.includeInTotal === false);

      const badAction = await call('POST', '/household/expenses/e_line_manual/actions', { token: tokens.bob, body: { action: 'set_split', to: 'personal' } });
      check('confirm 以外の action は 400', badAction.status === 400 && badAction.body.error === 'invalid_request');
      const arrBody = await call('POST', '/household/expenses/e_line_manual/actions', { token: tokens.bob, body: ['confirm'] });
      check('配列の body は 400', arrBody.status === 400);
      const noBody = await call('POST', '/household/expenses/e_line_manual/actions', { token: tokens.bob });
      check('body 無しは 400', noBody.status === 400);
      const broken = await call('POST', '/household/expenses/e_line_manual/actions', { token: tokens.bob, rawBody: '{"action":' });
      check('壊れた JSON は 400 invalid_request', broken.status === 400 && broken.body && broken.body.error === 'invalid_request', broken.body);
      check('JSON の解析エラーにも CORS ヘッダー', acao(broken) === ORIGIN);
      const reservedId = await call('POST', '/household/expenses/__foo__/actions', { token: tokens.bob, body: { action: 'confirm' } });
      check('予約 ID の支出は 400', reservedId.status === 400);
      const dotId = await rawPost('/household/expenses/%2E%2E/actions', tokens.bob, { action: 'confirm' });
      check('.. の支出 ID は 400', dotId.status === 400 && dotId.body.error === 'invalid_request', dotId);
      const slashId = await call('POST', '/household/expenses/a%2Fb/actions', { token: tokens.bob, body: { action: 'confirm' } });
      check('/ を含む支出 ID は 400', slashId.status === 400, slashId.status);
      const notFound = await call('POST', '/household/expenses/no_such/actions', { token: tokens.bob, body: { action: 'confirm' } });
      check('存在しない支出は 404', notFound.status === 404 && notFound.body.error === 'not_found');

      // Bob（入力者ではないメンバー）が Alice の LINE 手入力を確認
      const ok = await call('POST', '/household/expenses/e_line_manual/actions', { token: tokens.bob, body: { action: 'confirm' } });
      check('メンバーは 200', ok.status === 200 && ok.body.ok === true, ok.body);
      const e = ok.body.expense || {};
      check('応答: status=shared・計上・確認済み', e.id === 'e_line_manual' && e.status === 'shared' && e.includeInTotal === true && e.confirmed === true && e.advanceBy === null && e.category === '食費', e);
      check('応答の updatedAt は ISO 8601', typeof e.updatedAt === 'string' && !Number.isNaN(Date.parse(e.updatedAt)));
      const doc = (await db.doc('expenses/e_line_manual').get()).data();
      check('文書: status=shared, includeInTotal=true, confirmed=true', doc.status === 'shared' && doc.includeInTotal === true && doc.confirmed === true);
      check('文書: updatedAt を更新し、他のフィールドは変えない', doc.updatedAt.toMillis() > Date.parse('2026-09-12T01:00:00Z') && doc.amount === 2480 && doc.lineId === 'Ualice' && doc.description === 'スーパー');

      // LINE の OK（postback が呼ぶのと同じ applyExpenseChange + decideConfirm、authorize なし）と同じ結果か
      await applyExpenseChange('e_line_manual_postback', decideConfirm());
      const viaLine = (await db.doc('expenses/e_line_manual_postback').get()).data();
      const pick = (d) => ({ status: d.status, includeInTotal: d.includeInTotal, confirmed: d.confirmed, amount: d.amount, category: d.category, advanceBy: d.advanceBy });
      check('LINE の OK と同じ内容を書く', JSON.stringify(pick(viaLine)) === JSON.stringify(pick(doc)), { web: pick(doc), line: pick(viaLine) });

      const again = await call('POST', '/household/expenses/e_line_manual/actions', { token: tokens.alice, body: { action: 'confirm' } });
      check('確認済みをもう一度確認しても 200（冪等）', again.status === 200 && again.body.expense.status === 'shared');

      const gmail = await call('POST', '/household/expenses/e_gmail/actions', { token: tokens.alice, body: { action: 'confirm' } });
      check('以前の Gmail 取込（pending）→ shared', gmail.status === 200 && gmail.body.expense.status === 'shared' && gmail.body.expense.includeInTotal === true);
      const gmailShared = await call('POST', '/household/expenses/e_gmail_shared/actions', { token: tokens.alice, body: { action: 'confirm' } });
      check('現在の Gmail 取込（shared・確認済み）は 200 で変えない', gmailShared.status === 200 && gmailShared.body.expense.status === 'shared' && gmailShared.body.expense.includeInTotal === true && gmailShared.body.expense.confirmed === true, gmailShared.body);

      const settled = await call('POST', '/household/expenses/e_settled/actions', { token: tokens.alice, body: { action: 'confirm' } });
      check('精算済みは 200 で status を変えない', settled.status === 200 && settled.body.expense.status === 'advance_settled' && settled.body.expense.advanceBy === 'Ubob', settled.body);

      const personalOther = await call('POST', '/household/expenses/e_personal/actions', { token: tokens.bob, body: { action: 'confirm' } });
      check('他人の個人支出は 403', personalOther.status === 403);
      const personalOwner = await call('POST', '/household/expenses/e_personal/actions', { token: tokens.alice, body: { action: 'confirm' } });
      check('自分の個人支出は 200', personalOwner.status === 200 && personalOwner.body.expense.status === 'shared');
      const legacy = await call('POST', '/household/expenses/e_legacy/actions', { token: tokens.alice, body: { action: 'confirm' } });
      check('lineGroupId だけの旧形式は 403（所有者でも）', legacy.status === 403);
    }

    // ---------------- 支払った人を自分にする（LINE の［自分が払った］） ----------------
    console.log('\n［自分が払った］（postback と同じ applyExpenseChange + decideSetPayer + メンバー確認）');
    {
      // postback.ts の handleSetPayer と同じ組み立て（authorize でメンバー文書を読み、その名前を使う）
      const setPayer = async (expenseId, userId) => {
        let name = '';
        return applyExpenseChange(expenseId, (data) => decideSetPayer({ lineId: userId, displayName: name || 'User_x' })(data), {
          authorize: async (data, tx) => {
            const member = await readActiveMember(db, data.groupId, userId, tx);
            name = member ? member.displayName : '';
            return member !== null;
          },
        });
      };
      await db.doc('expenses/pay_card').set({ lineId: 'gmail-auto-system', payerId: 'gmail-auto-system', groupId: 'g1', lineGroupId: 'C_line1', amount: 2231, description: 'NIKUNOHANAMASA', date: '2026-09-20', category: '食費', status: 'shared', inputSource: 'gmail_auto', includeInTotal: true, confirmed: true });
      const byBob = await setPayer('pay_card', 'Ubob');
      const doc = (await db.doc('expenses/pay_card').get()).data();
      check('メンバーが押すと支払った人がその人になる（名前はメンバー文書）', byBob && byBob.record && doc.payerId === 'Ubob' && doc.payerDisplayName === 'Bob' && doc.status === 'shared' && doc.amount === 2231, doc);
      const byStranger = await setPayer('pay_card', 'Ustranger');
      const byLeft = await setPayer('pay_card', 'Uleft');
      check('メンバー外・脱退者は forbidden で書かない', byStranger && byStranger.forbidden === true && byLeft && byLeft.forbidden === true && (await db.doc('expenses/pay_card').get()).get('payerId') === 'Ubob');
      const onAdvance = await setPayer('adv_private', 'Ualice');
      const advDoc = (await db.doc('expenses/adv_private').get()).data();
      check('立替なら立て替えた人も押した人にする（立替のまま）', onAdvance && onAdvance.record && advDoc.status === 'advance_pending' && advDoc.advanceBy === 'Ualice' && advDoc.payerId === 'Ualice', advDoc);

      // ［自分が立替］（postback と同じ applyExpenseChange + decideSetAdvance + メンバー確認）
      const setAdvance = async (expenseId, userId) =>
        applyExpenseChange(expenseId, (data) => decideSetAdvance({ lineId: userId, displayName: 'Bob' })(data), {
          authorize: async (data, tx) => (await readActiveMember(db, data.groupId, userId, tx)) !== null,
        });
      const advanced = await setAdvance('pay_card', 'Ubob');
      const fullDoc = (await db.doc('expenses/pay_card').get()).data();
      check('［自分が立替］で全額の立替になる（押した人が立替・支払い）', advanced && advanced.record && fullDoc.status === 'advance_pending' && fullDoc.advanceFull === true && fullDoc.advanceBy === 'Ubob' && fullDoc.payerId === 'Ubob', fullDoc);
      const strangerAdvance = await setAdvance('pay_card', 'Ustranger');
      check('メンバー外は立替にできない', strangerAdvance && strangerAdvance.forbidden === true);
      const onSettled = await setPayer('e_settled', 'Ualice');
      check('立替で精算済みは変えない', onSettled && onSettled.reject && (await db.doc('expenses/e_settled').get()).get('payerId') === 'Ubob', onSettled);
    }

    // ---------------- 以前の立替を精算済みにする ----------------
    console.log('\nPOST /household/legacy-advances/settle');
    {
      const noTok = await call('POST', '/household/legacy-advances/settle', { body: { groupId: 'g1', expectedExpenseIds: [] } });
      check('トークン無しは 401', noTok.status === 401);
      // 入力検証（400）は認可より前。上限（成功 5 回/分・lineId 単位）とは関係なく left で送る
      const badIds = await call('POST', '/household/legacy-advances/settle', { token: tokens.left, body: { groupId: 'g1', expectedExpenseIds: 'adv_a1' } });
      check('expectedExpenseIds が配列でなければ 400', badIds.status === 400);
      const badElem = await call('POST', '/household/legacy-advances/settle', { token: tokens.left, body: { groupId: 'g1', expectedExpenseIds: ['adv_a1', 42] } });
      check('文字列以外の要素は 400', badElem.status === 400);
      const tooLongBad = await call('POST', '/household/legacy-advances/settle', { token: tokens.left, body: { groupId: 'g1', expectedExpenseIds: [...Array.from({ length: 501 }, (_, i) => `x${i}`), 'a/b'] } });
      check('件数が多くても不正な要素があれば 400', tooLongBad.status === 400);
      const tooLongLeft = await call('POST', '/household/legacy-advances/settle', { token: tokens.left, body: { groupId: 'g1', expectedExpenseIds: Array.from({ length: 501 }, (_, i) => `x${i}`) } });
      check('501 件の expectedExpenseIds でもメンバー確認を先に行う（脱退者は 403）', tooLongLeft.status === 403, tooLongLeft.body);
      const badGroup = await call('POST', '/household/legacy-advances/settle', { token: tokens.left, body: { groupId: ['g1'], expectedExpenseIds: [] } });
      check('groupId が文字列でなければ 400', badGroup.status === 400);
      const stranger = await call('POST', '/household/legacy-advances/settle', { token: tokens.stranger, body: { groupId: 'g1', expectedExpenseIds: ['adv_a1', 'adv_a2', 'adv_b1'] } });
      check('メンバー外は 403', stranger.status === 403);

      const stale = await call('POST', '/household/legacy-advances/settle', { token: tokens.alice, body: { groupId: 'g1', expectedExpenseIds: ['adv_a1', 'adv_a2'] } });
      check('表示と対象がずれていれば 409 stale', stale.status === 409 && stale.body.error === 'stale', stale.body && stale.body.error);
      check('stale には最新の一覧が付く', stale.body.current && sameMembers(stale.body.current.expenseIds, ['adv_a1', 'adv_a2', 'adv_b1']));
      check('409 にも CORS ヘッダー', acao(stale) === ORIGIN);
      const staleExtra = await call('POST', '/household/legacy-advances/settle', { token: tokens.alice, body: { groupId: 'g1', expectedExpenseIds: ['adv_a1', 'adv_a2', 'adv_b1', 'adv_private'] } });
      check('余分な ID があっても 409 stale', staleExtra.status === 409 && staleExtra.body.error === 'stale');
      check('stale のときは書き込まない', (await db.doc('expenses/adv_a1').get()).get('status') === 'advance_pending');

      const ok = await call('POST', '/household/legacy-advances/settle', { token: tokens.bob, body: { groupId: 'g1', expectedExpenseIds: ['adv_b1', 'adv_a1', 'adv_a2', 'adv_a1'] } });
      check('一致すれば 200（重複 ID は除く）', ok.status === 200 && ok.body.ok === true && ok.body.settled === 3 && ok.body.skipped === 0, ok.body);
      const settledDocs = await Promise.all(['adv_a1', 'adv_a2', 'adv_b1'].map(async (id) => (await db.doc(`expenses/${id}`).get()).data()));
      check('対象は advance_settled・精算日時付き', settledDocs.every((d) => d.status === 'advance_settled' && d.advanceSettledAt), settledDocs);
      check('支払った人・金額は変えない', settledDocs[0].payerId === 'Ualice' && settledDocs[0].amount === 10000 && settledDocs[2].payerId === 'Ubob');
      check('全額の立替には触れない（期間の精算で返す）', (await db.doc('expenses/adv_full').get()).get('status') === 'advance_pending');

      const staleEmpty = await call('POST', '/household/legacy-advances/settle', { token: tokens.alice, body: { groupId: 'g1', expectedExpenseIds: ['adv_a1', 'adv_a2', 'adv_b1'] } });
      check('精算済みにしたあとの画面から送ると 409 stale（current は 0 件）', staleEmpty.status === 409 && staleEmpty.body.error === 'stale' && staleEmpty.body.current && staleEmpty.body.current.expenseIds.length === 0, staleEmpty.body);
      const nothing = await call('POST', '/household/legacy-advances/settle', { token: tokens.alice, body: { groupId: 'g1', expectedExpenseIds: [] } });
      check('以前の立替が無く画面も 0 件なら 409 nothing_to_settle', nothing.status === 409 && nothing.body.error === 'nothing_to_settle', nothing.body);
      const after = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.alice });
      check('精算済みにしたあとの一覧は 0 件', after.status === 200 && after.body.items.length === 0, after.body);

      // LINE グループの無い世帯は groupId 基準（1 人だけの世帯でも精算済みにできる）
      const solo = await call('GET', '/household/legacy-advances?groupId=g2', { token: tokens.carol });
      check('groupId 基準の一覧', solo.status === 200 && sameMembers(solo.body.expenseIds, ['adv_c1']), solo.body);
      const soloClear = await call('POST', '/household/legacy-advances/settle', { token: tokens.carol, body: { groupId: 'g2', expectedExpenseIds: ['adv_c1'] } });
      check('1 人だけの世帯でも精算済みにできる', soloClear.status === 200 && soloClear.body.settled === 1 && (await db.doc('expenses/adv_c1').get()).get('status') === 'advance_settled', soloClear.body);

      // 作成者の仮名「作成者」は名前として返さない（立替の記録の名前を使う）
      const placeholder = await call('GET', '/household/legacy-advances?groupId=g5', { token: tokens.ivan });
      check('立替にした人の名前は支出に記録された名前', placeholder.status === 200 && placeholder.body.items[0].advanceByName === 'Ivan' && !JSON.stringify(placeholder.body).includes('作成者'), placeholder.body);
    }

    // ---------------- 500 件超 ----------------
    console.log('\n以前の立替が 500 件を超える世帯');
    {
      const r = await call('GET', '/household/legacy-advances?groupId=g3', { token: tokens.dave });
      check('GET は 501 件を返す', r.status === 200 && r.body.expenseIds.length === 501);
      const s = await call('POST', '/household/legacy-advances/settle', { token: tokens.dave, body: { groupId: 'g3', expectedExpenseIds: r.body.expenseIds.slice(0, 500) } });
      check('精算済みにする操作は 409 too_many', s.status === 409 && s.body.error === 'too_many', s.body);
      const echoed = await call('POST', '/household/legacy-advances/settle', { token: tokens.dave, body: { groupId: 'g3', expectedExpenseIds: r.body.expenseIds } });
      check('GET の 501 件をそのまま送っても 400 ではなく 409 too_many', echoed.status === 409 && echoed.body.error === 'too_many', echoed.body);
      const staleMany = await call('POST', '/household/legacy-advances/settle', { token: tokens.alice, body: { groupId: 'g1', expectedExpenseIds: Array.from({ length: 501 }, (_, i) => `x${i}`) } });
      check('501 件を送ったが現在は 500 件以下なら 409 stale（最新の内容付き）', staleMany.status === 409 && staleMany.body.error === 'stale' && staleMany.body.current && Array.isArray(staleMany.body.current.expenseIds), staleMany.body && staleMany.body.error);
    }

    // ---------------- 精算の通知（LINE） ----------------
    console.log('\nGET /household/settlement-summary・POST /household/settlement-summary/send');
    {
      const stranger = await call('GET', '/household/settlement-summary?groupId=g1', { token: tokens.stranger });
      check('メンバー外は 403', stranger.status === 403);
      const bad = await call('GET', '/household/settlement-summary?groupId=a%2Fb', { token: tokens.alice });
      check('不正な groupId は 400', bad.status === 400);
      const noCollect = await call('GET', '/household/settlement-summary?groupId=g1', { token: tokens.alice });
      check('集金するメンバーが未指定なら reason=no_collect_from', noCollect.status === 200 && noCollect.body.reason === 'no_collect_from' && noCollect.body.closed === null, noCollect.body);
      const noLine = await call('GET', '/household/settlement-summary?groupId=g4', { token: tokens.frank });
      check('LINE グループに紐づかなければ reason=no_line_group', noLine.status === 200 && noLine.body.reason === 'no_line_group', noLine.body);

      await db.doc('groups/g1').set({ splitSettings: { collectFromLineId: 'Ualice' } }, { merge: true });
      const ready = await call('GET', '/household/settlement-summary?groupId=g1', { token: tokens.bob });
      const v = ready.body || {};
      const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      check('送れる世帯は reason=null・起算日（既定 1 日）・期間', ready.status === 200 && v.reason === null && v.startDay === 1 && v.current && v.current.endDate === today && v.current.startDate === `${today.slice(0, 8)}01`, v);
      check('締まった期間は今の期間の前日まで', v.closed && v.closed.endDate < v.current.startDate && v.closed.startDate.endsWith('-01'), v.closed);
      check('締まった期間はまだ送っていない', v.closedSentAt === null);
      await db.doc(`system/settlementSummary_g1_${v.closed.endDate}`).set({ groupId: 'g1', endDate: v.closed.endDate, sentAt: Timestamp.now() });
      const sent = await call('GET', '/household/settlement-summary?groupId=g1', { token: tokens.bob });
      check('送った印があれば送った時刻（ISO 8601）', typeof sent.body.closedSentAt === 'string' && !Number.isNaN(Date.parse(sent.body.closedSentAt)), sent.body);

      const badPeriod = await call('POST', '/household/settlement-summary/send', { token: tokens.alice, body: { groupId: 'g1', period: 'all' } });
      check('period が closed / current 以外は 400', badPeriod.status === 400 && badPeriod.body.error === 'invalid_request');
      const strangerSend = await call('POST', '/household/settlement-summary/send', { token: tokens.stranger, body: { groupId: 'g1', period: 'closed' } });
      check('メンバー外は送れない（403）', strangerSend.status === 403);
      const unavailable = await call('POST', '/household/settlement-summary/send', { token: tokens.frank, body: { groupId: 'g4', period: 'closed' } });
      check('送れない世帯は 409 unavailable（理由付き）', unavailable.status === 409 && unavailable.body.error === 'unavailable' && unavailable.body.reason === 'no_line_group', unavailable.body);
      // このテストでは LINE の認証情報が無いので送信は失敗する（502。送れなかったときは印を書き換えない）
      const origError = console.error;
      console.error = () => {};
      let failedSend;
      try {
        failedSend = await call('POST', '/household/settlement-summary/send', { token: tokens.alice, body: { groupId: 'g1', period: 'current' } });
      } finally {
        console.error = origError;
      }
      check('LINE に送れなければ 502 line_failed', failedSend.status === 502 && failedSend.body.error === 'line_failed', failedSend.body);
    }

    // ---------------- レート制限 ----------------
    console.log('\nレート制限（lineId 単位。全体 60 回/分、以前の立替を精算済みにする操作は成功だけを数えて 5 回/分）');
    {
      const addAdvance = (i) => db.doc(`expenses/lim_${i}`).set({ lineId: 'Ufrank', payerId: 'Ufrank', groupId: 'g4', amount: 100 * (i + 1), description: `lim ${i}`, date: '2026-09-22', category: '食費', status: 'advance_pending', advanceBy: 'Ufrank', includeInTotal: true, confirmed: true, createdAt: ts('2026-09-22T01:00:00Z') });

      // 失敗（409 stale）は枠を使わない
      await addAdvance(0);
      const failures = [];
      for (let i = 0; i < 3; i++) {
        failures.push((await call('POST', '/household/legacy-advances/settle', { token: tokens.frank, body: { groupId: 'g4', expectedExpenseIds: ['nope'] } })).status);
      }
      check('失敗（409）は 429 にならない', failures.every((st) => st === 409), failures);

      const statuses = [];
      for (let i = 0; i < 5; i++) {
        if (i > 0) await addAdvance(i);
        const r = await call('POST', '/household/legacy-advances/settle', { token: tokens.frank, body: { groupId: 'g4', expectedExpenseIds: [`lim_${i}`] } });
        statuses.push(r.status);
      }
      check('失敗 3 回の後でも成功は 5 回まで通る', statuses.every((st) => st === 200), statuses);
      await addAdvance(5);
      const limited = await call('POST', '/household/legacy-advances/settle', { token: tokens.frank, body: { groupId: 'g4', expectedExpenseIds: ['lim_5'] }, allow429: true });
      check('6 回目は 429 rate_limited', limited.status === 429 && limited.body && limited.body.error === 'rate_limited', limited.status);
      check('429 にも CORS ヘッダー', acao(limited) === ORIGIN);
      check('429 にも X-Content-Type-Options: nosniff', limited.headers.get('x-content-type-options') === 'nosniff');
      check('429 のときは書き込まない', (await db.doc('expenses/lim_5').get()).get('status') === 'advance_pending');
      const other = await call('POST', '/household/legacy-advances/settle', { token: tokens.gina, body: { groupId: 'g4', expectedExpenseIds: ['lim_5'] } });
      check('他のユーザーは制限されない', other.status === 200, other.status);

      // 全ルート共通の上限は失敗も数える（メンバー外が 403 を連打しても 60 回/分で止まる）
      const seen = [];
      for (let i = 0; i < 61 && seen[seen.length - 1] !== 429; i++) {
        seen.push((await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.stranger, allow429: true })).status);
      }
      check('403 の連打も 60 回/分で 429', seen[seen.length - 1] === 429 && seen.slice(0, -1).every((st) => st === 403), `${seen.length} 回目 ${seen[seen.length - 1]}`);
      const strangerClear = await call('POST', '/household/legacy-advances/settle', { token: tokens.stranger, body: { groupId: 'g1', expectedExpenseIds: [] }, allow429: true });
      check('上限に達すると精算済みにする操作も 429', strangerClear.status === 429);
    }

    // ---------------- 未定義のルート ----------------
    {
      const r = await call('GET', '/household/unknown', { token: tokens.alice });
      check('未定義のルートは 404 JSON', r.status === 404 && r.body && r.body.error === 'not_found');
    }

    // ---------------- 認証前の上限（接続元単位） ----------------
    console.log('\n認証前の上限（接続元 IP 単位。X-Forwarded-For の末尾をキーにする）');
    {
      // 不正なトークン（誰でも送れる）の連打。前段が足す X-Forwarded-For の末尾で接続元を見分ける
      const attacker = '203.0.113.50';
      const flood = [];
      // 拒否のたびに出る警告（household: ID token rejected）は 300 行になるので数えるだけにする
      const origWarn = console.warn;
      let floodWarnings = 0;
      console.warn = () => floodWarnings++;
      try {
        for (let i = 0; i < 301; i++) {
          flood.push((await call('GET', '/household/legacy-advances?groupId=g1', { token: 'not-a-jwt', headers: { 'X-Forwarded-For': attacker }, allow429: true })).status);
        }
      } finally {
        console.warn = origWarn;
      }
      check('429 になった要求はトークンを検証しない（警告は 300 回だけ）', floodWarnings === 300, floodWarnings);
      check('同じ接続元は 300 回まで 401、301 回目は 429', flood.slice(0, 300).every((st) => st === 401) && flood[300] === 429, `${flood.filter((st) => st === 401).length}×401, last ${flood[300]}`);
      const spoofed = await call('GET', '/household/legacy-advances?groupId=g1', { token: 'not-a-jwt', headers: { 'X-Forwarded-For': `198.51.100.9, ${attacker}` }, allow429: true });
      check('前に別の IP を足しても同じ接続元として 429（末尾は詐称できない）', spoofed.status === 429, spoofed.status);
      const neighbour = await call('GET', '/household/legacy-advances?groupId=g1', { token: 'not-a-jwt', headers: { 'X-Forwarded-For': `${attacker}, 198.51.100.10` } });
      check('末尾が違う接続元は別に数える（401）', neighbour.status === 401, neighbour.status);
      const legit = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.alice, headers: { 'X-Forwarded-For': '198.51.100.20' } });
      check('他の利用者は締め出されない（200）', legit.status === 200, legit.status);
      const direct = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.alice });
      check('X-Forwarded-For の無い要求（req.ip）も締め出されない', direct.status === 200, direct.status);
    }

    // ---------------- 失効したトークン ----------------
    console.log('\n失効したトークン（verifyIdToken の checkRevoked）');
    {
      const before = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.bob });
      check('失効前は 200', before.status === 200, before.status);
      // 失効時刻は秒単位で、auth_time がそれより前のトークンだけが失効扱いになる
      const wait = tokensIssuedAt + 1100 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      await getAuth().revokeRefreshTokens('uid-bob');
      const revoked = await call('GET', '/household/legacy-advances?groupId=g1', { token: tokens.bob });
      check('revokeRefreshTokens 後の古いトークンは 401', revoked.status === 401 && revoked.body.error === 'unauthenticated' && acao(revoked) === ORIGIN, revoked.body);
      await getAuth().updateUser('uid-gina', { disabled: true });
      const disabled = await call('GET', '/household/legacy-advances?groupId=g4', { token: tokens.gina });
      check('無効化したユーザーのトークンは 401', disabled.status === 401 && disabled.body.error === 'unauthenticated', disabled.body);
    }
    // ---------------- 要求数の予算 ----------------
    console.log('\n要求数の予算（127.0.0.1 の認証前の上限 300 回/分）');
    check(`Bearer 付きの要求は 300 回未満（${bearerRequests} 回）`, bearerRequests < 300);
    check('想定外の 429 が無い', unexpected429.length === 0, unexpected429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(failed === 0 ? `\nALL PASSED (${passed})` : `\n${failed} FAILED / ${passed} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
