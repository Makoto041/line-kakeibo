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
const { applyExpenseChange, decideSetCategory } = require('../dist/expenseActions');
const lineClient = require('../dist/line/client');
const { handlePostback } = require('../dist/line/postback');

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

const MEMBERS_ONLY = '変更できるのは、世帯のメンバーだけです';
const NOT_SELECTABLE = 'このカテゴリには変更できません';

/**
 * LINE グループ C_line1 で、userId の人が postback のボタンを押す（本物の handlePostback。Firestore はエミュレータ）
 *
 * LINE への返信とプロフィールの取得だけを差し替え、押し終わったら元に戻す
 * （後の精算の通知のテストは、LINE に送れないこと〔502〕を確かめるため）。
 */
async function pressPostback(payload, userId) {
  const origReply = lineClient.replyWithPushFallback;
  const origGetLineClient = lineClient.getLineClient;
  const origLog = console.log;
  const origWarn = console.warn;
  const replies = [];
  lineClient.replyWithPushFallback = async (_replyToken, _to, messages) => {
    replies.push(messages);
    return 'reply';
  };
  lineClient.getLineClient = () => ({
    getProfile: async () => ({ displayName: 'プロフィール名' }),
    getGroupMemberProfile: async () => ({ displayName: 'プロフィール名' }),
  });
  console.log = () => {};
  console.warn = () => {};
  try {
    await handlePostback({
      type: 'postback',
      replyToken: 'reply-token',
      source: { type: 'group', groupId: 'C_line1', userId },
      postback: { data: JSON.stringify(payload) },
    });
  } finally {
    lineClient.replyWithPushFallback = origReply;
    lineClient.getLineClient = origGetLineClient;
    console.log = origLog;
    console.warn = origWarn;
  }
  const only = replies.length === 1 && replies[0].length === 1 ? replies[0][0] : undefined;
  return {
    replies,
    text: only && only.type === 'text' ? only.text : undefined,
    flex: only && only.type === 'flex' ? only : undefined,
  };
}

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

      // LINE の OK（postback の confirm。Web と同じ applyExpenseChange + decideConfirm で、世帯のメンバーかも同じく確かめる）
      for (const [who, userId] of [['メンバー外', 'Ustranger'], ['脱退者', 'Uleft']]) {
        const r = await pressPostback({ action: 'confirm', expenseId: 'e_line_manual_postback' }, userId);
        const d = (await db.doc('expenses/e_line_manual_postback').get()).data();
        check(`LINE の OK: ${who}は「${MEMBERS_ONLY}」で、書かない`, r.text === MEMBERS_ONLY && d.status === undefined && d.confirmed === false && d.includeInTotal === false, { replies: r.replies, doc: d });
      }
      const okByLine = await pressPostback({ action: 'confirm', expenseId: 'e_line_manual_postback' }, 'Ubob');
      const viaLine = (await db.doc('expenses/e_line_manual_postback').get()).data();
      const pick = (d) => ({ status: d.status, includeInTotal: d.includeInTotal, confirmed: d.confirmed, amount: d.amount, category: d.category, advanceBy: d.advanceBy });
      check('LINE の OK（メンバー）は Web の確認と同じ内容を書き、カードを返す', !!okByLine.flex && JSON.stringify(pick(viaLine)) === JSON.stringify(pick(doc)), { web: pick(doc), line: pick(viaLine) });
      const legacyByLine = await pressPostback({ action: 'confirm', expenseId: 'e_legacy' }, 'Ualice');
      check('LINE の OK: lineGroupId だけの旧形式は、登録した本人でも確定できない', legacyByLine.text === MEMBERS_ONLY && (await db.doc('expenses/e_legacy').get()).get('confirmed') === false, legacyByLine.replies);

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

    // ---------------- 支払った人・支出区分・立替（LINE の［自分が払った］［除外］［自分が立替］［取り消す］） ----------------
    console.log('\nLINE の postback（handlePostback）: set_payer・set_split・set_advance は世帯のメンバーだけ');
    {
      const read = async (id) => (await db.doc(`expenses/${id}`).get()).data();
      const outsiders = [['メンバー外', 'Ustranger'], ['脱退者', 'Uleft']];
      await db.doc('expenses/pay_card').set({ lineId: 'gmail-auto-system', payerId: 'gmail-auto-system', groupId: 'g1', lineGroupId: 'C_line1', amount: 2231, description: 'NIKUNOHANAMASA', date: '2026-09-20', category: '食費', status: 'shared', inputSource: 'gmail_auto', includeInTotal: true, confirmed: true });

      // ［自分が払った］
      const byBob = await pressPostback({ action: 'set_payer', expenseId: 'pay_card' }, 'Ubob');
      const doc = await read('pay_card');
      check('［自分が払った］メンバーが押すと支払った人がその人になる（名前はメンバー文書の Bob。LINE のプロフィール名ではない）', !!byBob.flex && doc.payerId === 'Ubob' && doc.payerDisplayName === 'Bob' && doc.status === 'shared' && doc.amount === 2231, doc);
      for (const [who, userId] of outsiders) {
        const r = await pressPostback({ action: 'set_payer', expenseId: 'pay_card' }, userId);
        check(`［自分が払った］${who}は「${MEMBERS_ONLY}」で、書かない`, r.text === MEMBERS_ONLY && (await read('pay_card')).payerId === 'Ubob', r.replies);
      }
      const legacyPayer = await pressPostback({ action: 'set_payer', expenseId: 'e_legacy' }, 'Ualice');
      const legacyAfterPayer = await read('e_legacy');
      check('［自分が払った］lineGroupId だけの旧形式は、登録した本人でも変えられない', legacyPayer.text === MEMBERS_ONLY && legacyAfterPayer.confirmed === false && legacyAfterPayer.status === undefined, legacyPayer.replies);
      // 作成者のメンバー文書の名前が仮名「作成者」のまま（世帯 g5 の Hana）なら、LINE のプロフィール名を使う
      await db.doc('expenses/pay_g5').set({ lineId: 'Uivan', payerId: 'Uivan', payerDisplayName: 'Ivan', groupId: 'g5', lineGroupId: 'C_line5', amount: 500, description: 'x', date: '2026-09-20', category: '食費', status: 'shared', includeInTotal: true, confirmed: true });
      const byHana = await pressPostback({ action: 'set_payer', expenseId: 'pay_g5' }, 'Uhana');
      const g5Doc = await read('pay_g5');
      check('［自分が払った］メンバー文書の名前が仮名「作成者」なら、LINE のプロフィール名を使う', !!byHana.flex && g5Doc.payerId === 'Uhana' && g5Doc.payerDisplayName === 'プロフィール名', g5Doc);
      const onAdvance = await pressPostback({ action: 'set_payer', expenseId: 'adv_private' }, 'Ualice');
      const advDoc = await read('adv_private');
      check('［自分が払った］立替なら立て替えた人も押した人にする（立替のまま）', !!onAdvance.flex && advDoc.status === 'advance_pending' && advDoc.advanceBy === 'Ualice' && advDoc.payerId === 'Ualice' && advDoc.payerDisplayName === 'Alice', advDoc);

      // 支出区分（［除外］［戻す］。旧UIの personal も）
      for (const [who, userId] of outsiders) {
        const r = await pressPostback({ action: 'set_split', expenseId: 'pay_card', to: 'personal' }, userId);
        check(`［除外］${who}は「${MEMBERS_ONLY}」で、書かない`, r.text === MEMBERS_ONLY && (await read('pay_card')).status === 'shared', r.replies);
      }
      const oldUi = await pressPostback({ action: 'personal', expenseId: 'pay_card' }, 'Ustranger');
      check(`旧UIの［個人］もメンバー外は「${MEMBERS_ONLY}」で、書かない`, oldUi.text === MEMBERS_ONLY && (await read('pay_card')).status === 'shared', oldUi.replies);
      const legacySplit = await pressPostback({ action: 'set_split', expenseId: 'e_legacy', to: 'personal' }, 'Ualice');
      check('［除外］lineGroupId だけの旧形式は、登録した本人でも変えられない', legacySplit.text === MEMBERS_ONLY && (await read('e_legacy')).status === undefined, legacySplit.replies);
      const split = await pressPostback({ action: 'set_split', expenseId: 'pay_card', to: 'personal' }, 'Ubob');
      const splitDoc = await read('pay_card');
      check('［除外］メンバーは除外にできる', !!split.flex && splitDoc.status === 'personal' && splitDoc.includeInTotal === false, splitDoc);
      const back = await pressPostback({ action: 'set_split', expenseId: 'pay_card', to: 'shared' }, 'Ualice');
      const backDoc = await read('pay_card');
      check('［戻す］メンバーは共同費に戻せる', !!back.flex && backDoc.status === 'shared' && backDoc.includeInTotal === true, backDoc);

      // ［自分が立替］［取り消す］
      const advanced = await pressPostback({ action: 'set_advance', expenseId: 'pay_card', to: 'on' }, 'Ubob');
      const fullDoc = await read('pay_card');
      check('［自分が立替］で全額の立替になる（押した人が立替・支払い。名前はメンバー文書）', !!advanced.flex && fullDoc.status === 'advance_pending' && fullDoc.advanceFull === true && fullDoc.advanceBy === 'Ubob' && fullDoc.payerId === 'Ubob' && fullDoc.payerDisplayName === 'Bob', fullDoc);
      for (const [who, userId] of outsiders) {
        for (const to of ['on', 'off']) {
          const r = await pressPostback({ action: 'set_advance', expenseId: 'pay_card', to }, userId);
          const d = await read('pay_card');
          check(`［${to === 'on' ? '自分が立替' : '取り消す'}］${who}は「${MEMBERS_ONLY}」で、書かない`, r.text === MEMBERS_ONLY && d.status === 'advance_pending' && d.advanceBy === 'Ubob', r.replies);
        }
      }
      const legacyAdvance = await pressPostback({ action: 'set_advance', expenseId: 'e_legacy', to: 'on' }, 'Ualice');
      check('［自分が立替］lineGroupId だけの旧形式は、登録した本人でも変えられない', legacyAdvance.text === MEMBERS_ONLY && (await read('e_legacy')).status === undefined, legacyAdvance.replies);
      const cleared = await pressPostback({ action: 'set_advance', expenseId: 'pay_card', to: 'off' }, 'Ualice');
      const clearedDoc = await read('pay_card');
      check('［取り消す］メンバーは立替を取り消せる（共同費に戻し、支払った人は変えない）', !!cleared.flex && clearedDoc.status === 'shared' && !('advanceBy' in clearedDoc) && !('advanceFull' in clearedDoc) && clearedDoc.payerId === 'Ubob', clearedDoc);

      // 精算済み
      const onSettled = await pressPostback({ action: 'set_payer', expenseId: 'e_settled' }, 'Ualice');
      check('［自分が払った］立替で精算済みは「精算済みのため変更できません」で、変えない', onSettled.text === '精算済みのため変更できません' && (await read('e_settled')).payerId === 'Ubob', onSettled.replies);
    }

    // ---------------- カテゴリの変更（LINE の set_category。中項目を辞書で決め直す） ----------------
    console.log('\nカテゴリの変更（postback と同じ applyExpenseChange + decideSetCategory。大項目が変わるときは中項目を決め直す）');
    {
      const read = async (id) => (await db.doc(`expenses/${id}`).get()).data();
      // Gmail 取込と同じく usedAt は Date で書く（読むと Timestamp）
      const gmailDoc = (description, usedAt) => ({
        lineId: 'gmail-auto-system', payerId: 'gmail-auto-system', groupId: 'g1', lineGroupId: 'C_line1', amount: 980, description,
        date: '2026-10-20', category: 'その他', status: 'shared', inputSource: 'gmail_auto', gmailMessageId: `m_${description}`,
        usedAt, includeInTotal: true, confirmed: true,
      });
      const lunchAt = new Date('2026-10-20T12:30:00+09:00');
      await db.doc('expenses/cat_gmail').set(gmailDoc('ラーメン山田', lunchAt));
      await db.doc('expenses/cat_gmail_midnight').set(gmailDoc('ラーメン山田', new Date('2026-10-20T00:00:00+09:00')));
      await db.doc('expenses/cat_line').set({ lineId: 'Ualice', payerId: 'Ualice', groupId: 'g1', lineGroupId: 'C_line1', amount: 1200, description: 'ランチ', date: '2026-10-20', category: 'その他', inputSource: 'line_text', includeInTotal: false, confirmed: false });

      const r1 = await applyExpenseChange('cat_gmail', decideSetCategory('食費'));
      const d1 = await read('cat_gmail');
      check('Gmail 取込の 12:30 の飲食店を食費にすると、中項目に昼ご飯を書く（返信用のレコードも同じ）', d1.category === '食費' && d1.subCategory === '昼ご飯' && r1 && r1.record && r1.record.subCategory === '昼ご飯', { doc: d1.subCategory, record: r1 && r1.record && r1.record.subCategory });
      check('usedAt は Timestamp で読め、書き方は変わらない', d1.usedAt instanceof Timestamp && d1.usedAt.toMillis() === lunchAt.getTime());

      await applyExpenseChange('cat_gmail_midnight', decideSetCategory('食費'));
      check('usedAt が 00:00 ちょうど（時刻なし）なら時刻を当てず外食', (await read('cat_gmail_midnight')).subCategory === '外食', (await read('cat_gmail_midnight')).subCategory);

      const r2 = await applyExpenseChange('cat_line', decideSetCategory('食費'));
      const d2 = await read('cat_line');
      check('LINE 手入力の「ランチ」を食費にすると昼ご飯（未確認なら共同費・確認済みにもする）', d2.subCategory === '昼ご飯' && d2.category === '食費' && d2.status === 'shared' && d2.confirmed === true && r2.record.subCategory === '昼ご飯', d2);

      // 大項目が同じなら中項目に触らない（手で選んだ中項目を辞書で上書きしない）
      await db.doc('expenses/cat_gmail').update({ subCategory: 'カフェ' });
      await applyExpenseChange('cat_gmail', decideSetCategory('食費'));
      check('大項目が同じなら中項目は変えない', (await read('cat_gmail')).subCategory === 'カフェ', (await read('cat_gmail')).subCategory);

      // 決まらなければ消す
      const r3 = await applyExpenseChange('cat_gmail', decideSetCategory('日用品'));
      const d3 = await read('cat_gmail');
      check('中項目の無い大項目にすると、文書から subCategory が消える', d3.category === '日用品' && !('subCategory' in d3), d3);
      check('返信用のレコードにも古い中項目が残らない（キーは undefined）', r3 && r3.record && 'subCategory' in r3.record && r3.record.subCategory === undefined && r3.record.category === '日用品');
      const r4 = await applyExpenseChange('cat_gmail', decideSetCategory('食費'));
      check('中項目の無い支出で、決まった値を書く（日用品 → 食費。12:30 なので昼ご飯）', (await read('cat_gmail')).subCategory === '昼ご飯' && r4.record.subCategory === '昼ご飯');

      // 精算済みでも変えられる
      await db.doc('expenses/cat_settled').set({ lineId: 'Ubob', payerId: 'Ubob', groupId: 'g1', lineGroupId: 'C_line1', amount: 3000, description: '映画館', date: '2026-10-01', category: 'その他', subCategory: '外食', status: 'advance_settled', advanceBy: 'Ubob', includeInTotal: true, confirmed: true });
      const r5 = await applyExpenseChange('cat_settled', decideSetCategory('娯楽費'));
      const d5 = await read('cat_settled');
      check('精算済みでも大項目・中項目を変える（娯楽費 → 娯楽・映画。status は変えない）', r5 && r5.record && d5.category === '娯楽' && d5.subCategory === '映画' && d5.status === 'advance_settled', d5);
    }

    // ---------------- LINE の postback（handlePostback）: カテゴリの選択・変更の認可と入力検証（#266） ----------------
    console.log('\nLINE の postback: show_category_select・set_category は世帯のメンバーだけ、カテゴリは一覧にあるものだけ');
    {
      const read = async (id) => (await db.doc(`expenses/${id}`).get()).data();
      await db.doc('expenses/pb_cat').set({ lineId: 'Ualice', payerId: 'Ualice', groupId: 'g1', lineGroupId: 'C_line1', amount: 1200, description: 'ランチ', date: '2026-10-20', category: 'その他', inputSource: 'line_text', includeInTotal: false, confirmed: false });
      await db.doc('expenses/pb_personal').set({ lineId: 'Ualice', payerId: 'Ualice', amount: 300, description: 'ランチ', date: '2026-10-20', category: 'その他', inputSource: 'line_text', includeInTotal: false, confirmed: false });
      const outsiders = [
        ['メンバー外', 'Ustranger'],
        ['脱退者', 'Uleft'],
        ['別の世帯のメンバー', 'Ucarol'],
        ['文書 ID が衝突する人（x_Umallory）', 'x_Umallory'],
      ];

      // カテゴリ選択のカルーセル
      for (const [who, userId] of outsiders) {
        const r = await pressPostback({ action: 'show_category_select', expenseId: 'pb_cat', source: 'text' }, userId);
        check(`show_category_select: ${who}にはカルーセルを返さず「${MEMBERS_ONLY}」`, r.text === MEMBERS_ONLY && !r.flex, r.replies);
      }
      const legacyShow = await pressPostback({ action: 'show_category_select', expenseId: 'e_legacy', source: 'text' }, 'Ualice');
      check('show_category_select: lineGroupId だけの旧形式は、登録した本人にもカルーセルを返さない', legacyShow.text === MEMBERS_ONLY && !legacyShow.flex, legacyShow.replies);
      const shown = await pressPostback({ action: 'show_category_select', expenseId: 'pb_cat', source: 'text' }, 'Ubob');
      check('show_category_select: メンバー（登録者でない Bob）にはカルーセルを返す', !!shown.flex && shown.flex.contents.type === 'carousel', shown.replies);

      // カテゴリの変更（認可）
      for (const [who, userId] of outsiders) {
        const r = await pressPostback({ action: 'set_category', expenseId: 'pb_cat', category: '食費' }, userId);
        const d = await read('pb_cat');
        check(`set_category: ${who}は「${MEMBERS_ONLY}」で、書かない`, r.text === MEMBERS_ONLY && d.category === 'その他' && d.confirmed === false && d.status === undefined && !('subCategory' in d), { replies: r.replies, doc: d });
      }
      const legacySet = await pressPostback({ action: 'set_category', expenseId: 'e_legacy', category: '日用品' }, 'Ualice');
      check('set_category: lineGroupId だけの旧形式は、登録した本人でも変えられない', legacySet.text === MEMBERS_ONLY && (await read('e_legacy')).category === '食費', legacySet.replies);
      const personalOther = await pressPostback({ action: 'set_category', expenseId: 'pb_personal', category: '食費' }, 'Ubob');
      check('set_category: 世帯の無い個人の支出は、登録した本人でなければ変えられない', personalOther.text === MEMBERS_ONLY && (await read('pb_personal')).category === 'その他', personalOther.replies);

      // カテゴリの変更（入力検証。メンバーが押しても一覧に無い値は書かない）
      const invalid = [
        ['数値', 1],
        ['オブジェクト', { name: '食費' }],
        ['配列', ['食費']],
        ['一覧に無い名前', '推し活'],
        ['長すぎる値', 'あ'.repeat(300)],
        ['揃えれば一覧にあるが上限を超える長さ', '食費'.padStart(40, ' ')],
      ];
      for (const [label, category] of invalid) {
        const r = await pressPostback({ action: 'set_category', expenseId: 'pb_cat', category }, 'Ubob');
        const d = await read('pb_cat');
        check(`set_category: ${label}は「${NOT_SELECTABLE}」で、書かない`, r.text === NOT_SELECTABLE && d.category === 'その他' && d.confirmed === false, { replies: r.replies, doc: d });
      }

      // メンバーなら変えられる
      const bySet = await pressPostback({ action: 'set_category', expenseId: 'pb_cat', category: '食費' }, 'Ubob');
      const d = await read('pb_cat');
      check('set_category: メンバーは変えられる（中項目を決め、確認済み・共同費にする。カードを返す）', !!bySet.flex && d.category === '食費' && d.subCategory === '昼ご飯' && d.status === 'shared' && d.includeInTotal === true && d.confirmed === true, d);
      const byAlias = await pressPostback({ action: 'set_category', expenseId: 'pb_cat', category: '医療費' }, 'Ualice');
      check('set_category: カルーセルの旧名（医療費）は正準名（医療・健康）で保存する', !!byAlias.flex && (await read('pb_cat')).category === '医療・健康');
      const personalOwner = await pressPostback({ action: 'set_category', expenseId: 'pb_personal', category: '食費' }, 'Ualice');
      check('set_category: 世帯の無い個人の支出は、登録した本人なら変えられる', !!personalOwner.flex && (await read('pb_personal')).category === '食費');

      // 支出 ID が文書 ID として不正なら何もしない（Firestore に渡すと例外になる値。確かめずに渡すと、ここで例外になる）
      for (const [label, expenseId] of [['a/b/c', 'a/b/c'], ['数値', 123], ['巨大な文字列', 'x'.repeat(100000)]]) {
        const replyCounts = [];
        for (const action of ['set_category', 'confirm', 'show_category_select', 'set_payer', 'set_split', 'set_advance', 'edit']) {
          replyCounts.push((await pressPostback({ action, expenseId, category: '食費', to: 'personal' }, 'Ubob')).replies.length);
        }
        check(`支出 ID が ${label} なら、どの action でも返信せず、例外にもならない`, replyCounts.every((n) => n === 0), replyCounts);
      }
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

    // ---------------- カテゴリのルール ----------------
    console.log('\nGET・POST /household/category-rules');
    {
      const noTok = await call('GET', '/household/category-rules?groupId=g1');
      check('トークン無しは 401', noTok.status === 401);
      const stranger = await call('GET', '/household/category-rules?groupId=g1', { token: tokens.stranger });
      check('メンバー外は読めない（403）', stranger.status === 403);
      const left = await call('GET', '/household/category-rules?groupId=g1', { token: tokens.left });
      check('脱退した人は読めない（403）', left.status === 403);
      const empty = await call('GET', '/household/category-rules?groupId=g1', { token: tokens.alice });
      check('最初は空のルールと上限が返る', empty.status === 200 && empty.body.rules.length === 0 && Object.keys(empty.body.examples).length === 0 && empty.body.limits.maxRules === 50 && empty.body.limits.maxKeywordLength === 30, empty.body);

      const body = {
        groupId: 'g1',
        rules: [{ keyword: ' ドンキ ', category: '日用品' }, { keyword: 'ﾄﾞﾝｷ', category: '食費' }, { keyword: 'Switch\n', category: '娯楽' }],
        examples: { '医療・健康': ['ジムのプロテイン', ' ジムのプロテイン '], 食費: [] },
      };
      const noTokPost = await call('POST', '/household/category-rules', { body });
      check('POST はトークン無しだと 401', noTokPost.status === 401);
      const strangerPost = await call('POST', '/household/category-rules', { token: tokens.stranger, body });
      check('メンバー外は保存できない（403）', strangerPost.status === 403);
      check('メンバー外の保存は書き込まない', (await db.doc('groups/g1').get()).get('categoryRules') === undefined);

      const saved = await call('POST', '/household/category-rules', { token: tokens.alice, body });
      check('メンバーは保存できる（200）', saved.status === 200, saved.body);
      check('整えて返す（空白・改行を除き、照合用に同じ言葉は 1 つ）', saved.body.rules.length === 2 && saved.body.rules[0].keyword === 'ドンキ' && saved.body.rules[1].keyword === 'Switch', saved.body.rules);
      check('例は重複を除き、空のカテゴリは持たない', JSON.stringify(saved.body.examples) === JSON.stringify({ '医療・健康': ['ジムのプロテイン'] }), saved.body.examples);
      const stored = (await db.doc('groups/g1').get()).get('categoryRules');
      check('groups/g1.categoryRules に保存し、更新した人を残す', stored && stored.rules.length === 2 && stored.updatedBy === 'Ualice' && stored.updatedAt, stored);
      const again = await call('GET', '/household/category-rules?groupId=g1', { token: tokens.bob });
      check('世帯のもうひとりも同じ内容を読める', again.status === 200 && again.body.rules.length === 2 && again.body.examples['医療・健康'][0] === 'ジムのプロテイン', again.body);

      const badCases = {
        'カテゴリが一覧にない': { rules: [{ keyword: 'a', category: 'なぞ' }], examples: {} },
        '言葉が空': { rules: [{ keyword: ' \n ', category: '食費' }], examples: {} },
        '言葉が長すぎる': { rules: [{ keyword: 'あ'.repeat(31), category: '食費' }], examples: {} },
        'ルールが 51 件': { rules: Array.from({ length: 51 }, (_, i) => ({ keyword: `k${i}`, category: '食費' })), examples: {} },
        '例が 6 件': { rules: [], examples: { 食費: ['a', 'b', 'c', 'd', 'e', 'f'] } },
        '例が長すぎる': { rules: [], examples: { 食費: ['あ'.repeat(41)] } },
        'rules が配列でない': { rules: 'x', examples: {} },
        'examples が無い': { rules: [] },
      };
      for (const [label, payload] of Object.entries(badCases)) {
        const bad = await call('POST', '/household/category-rules', { token: tokens.alice, body: { groupId: 'g1', ...payload } });
        check(`${label}は 400`, bad.status === 400, bad.body);
      }
      const unchanged = (await db.doc('groups/g1').get()).get('categoryRules');
      check('断った保存は書き込まない', unchanged.rules.length === 2);
      const badGroup = await call('POST', '/household/category-rules', { token: tokens.alice, body: { groupId: ['g1'], rules: [], examples: {} } });
      check('groupId が文字列でなければ 400', badGroup.status === 400);

      const cleared = await call('POST', '/household/category-rules', { token: tokens.alice, body: { groupId: 'g1', rules: [], examples: {} } });
      check('空にして保存できる', cleared.status === 200 && cleared.body.rules.length === 0, cleared.body);
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
