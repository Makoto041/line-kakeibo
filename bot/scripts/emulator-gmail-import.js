/**
 * Gmail 取込の状態（system/gmailState）の統合テスト（Firestore エミュレータ）
 *
 * watch の登録・更新（registerWatch / renewWatch。管理 API の register-watch も registerWatch）が、
 * 保存してある historyId を watch の応答（= 今のメールボックスの位置）で上書きしないことを確かめる。
 * 上書きすると、取込が失敗して historyId が止まっている間の範囲が二度と処理されない。
 * あわせて、watch の登録・更新が連携中のアカウントのアドレス（getProfile）を保存し、取込（handleGmailPubSub）が
 * 通知の emailAddress と照合して、違うアカウントの通知では historyId を更新しないことを確かめる（#280）。
 * Gmail API は呼ばない（dist/gmail/auth の getGmailClient を偽物に差し替える）。
 *
 * emulator-household-api.js と同じ形で実行する（npm -w bot run test:emulator から続けて動く）。
 * 本番のプロジェクトには接続しない（demo-* 以外は即終了）。
 */
const { initializeApp, getApps } = require('firebase-admin/app');
const { Timestamp } = require('firebase-admin/firestore');

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

// Gmail API の偽物。watch.ts は auth の getGmailClient を呼ぶたびに exports から引くので、差し替えが効く
const fakeGmail = {
  watchHistoryId: '500',
  watchExpiration: String(Date.UTC(2026, 10, 2, 0, 0, 0)),
  watchError: null,
  watchCalls: [],
  stopCalls: 0,
  // getProfile が返す連携中のアカウントのアドレス（registerWatch が gmailState に保存する。#280）
  profileAddress: 'linked@example.com',
  profileError: null,
  profileCalls: 0,
  // 取込（handler.ts）の history.list。メッセージは返さない（historyId の更新だけを見る）
  historyListCalls: 0,
  users: {
    watch: async (params) => {
      fakeGmail.watchCalls.push(params);
      if (fakeGmail.watchError) throw fakeGmail.watchError;
      // 実際の API と同じく expiration は文字列（epoch ミリ秒）
      return { data: { historyId: fakeGmail.watchHistoryId, expiration: fakeGmail.watchExpiration } };
    },
    stop: async () => {
      fakeGmail.stopCalls++;
      return { data: {} };
    },
    getProfile: async () => {
      fakeGmail.profileCalls++;
      if (fakeGmail.profileError) throw fakeGmail.profileError;
      return { data: { emailAddress: fakeGmail.profileAddress, historyId: fakeGmail.watchHistoryId } };
    },
    history: {
      list: async () => {
        fakeGmail.historyListCalls++;
        return { data: { history: [] } };
      },
    },
  },
};
const auth = require('../dist/gmail/auth');
auth.getGmailClient = async () => fakeGmail;

const { registerWatch, renewWatch, updateHistoryId, getWatchState, gmailStateRef } = require('../dist/gmail/watch');
const { handleGmailPubSub } = require('../dist/gmail/handler');

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
  if (!res.ok) throw new Error(`failed to clear firestore emulator (${res.status})`);
}

const OLD_EXPIRATION = Date.UTC(2026, 9, 27, 0, 0, 0);
const OLD_UPDATED_AT = Timestamp.fromMillis(Date.UTC(2026, 9, 20, 0, 0, 0));

/** 取込が途中で止まっている状態を作る（historyId は最後に処理し終えた位置） */
async function seedState(fields) {
  await gmailStateRef().set({ watchExpiration: OLD_EXPIRATION, updatedAt: OLD_UPDATED_AT, ...fields });
}

async function readState() {
  const snap = await gmailStateRef().get();
  return snap.exists ? snap.data() : null;
}

function resetFake({ historyId = '500', error = null, profileAddress = 'linked@example.com', profileError = null } = {}) {
  fakeGmail.watchHistoryId = historyId;
  fakeGmail.watchError = error;
  fakeGmail.watchCalls = [];
  fakeGmail.stopCalls = 0;
  fakeGmail.profileAddress = profileAddress;
  fakeGmail.profileError = profileError;
  fakeGmail.profileCalls = 0;
  fakeGmail.historyListCalls = 0;
}

/** Pub/Sub の通知の本文（Gmail の形: `{ emailAddress, historyId }` の base64） */
const notification = (emailAddress, historyId) =>
  Buffer.from(JSON.stringify(emailAddress === undefined ? { historyId } : { emailAddress, historyId })).toString('base64');

/** ログを出さずに実行する（取込のログは確かめない。投げたら例外を返す） */
async function quietly(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    await fn();
    return 'ok';
  } catch (error) {
    return error;
  } finally {
    Object.assign(console, original);
  }
}

async function main() {
  await clearFirestore();
  const expectedExpiration = Number(fakeGmail.watchExpiration);

  console.log('registerWatch: 保存値が無い');
  {
    resetFake({ historyId: '500' });
    const state = await registerWatch();
    const doc = await readState();
    check('応答の historyId を入れる', doc && doc.historyId === '500', doc);
    check('watchExpiration を数値で入れる', doc && doc.watchExpiration === expectedExpiration, doc);
    check('戻り値は保存した状態', state.historyId === '500' && state.watchExpiration === expectedExpiration, state);
    const call = fakeGmail.watchCalls[0];
    check(
      'watch は INBOX と Pub/Sub トピックを指定して 1 回呼ぶ',
      fakeGmail.watchCalls.length === 1 &&
        call.userId === 'me' &&
        JSON.stringify(call.requestBody.labelIds) === '["INBOX"]' &&
        /\/topics\/gmail-notifications$/.test(call.requestBody.topicName),
      fakeGmail.watchCalls
    );
  }

  console.log('registerWatch: 取込が止まっている（保存値 < 応答）');
  {
    await clearFirestore();
    await seedState({ historyId: '100', note: 'keep-me' });
    resetFake({ historyId: '500' });
    const state = await registerWatch();
    const doc = await readState();
    check('保存してある historyId を残す（最新値で上書きしない）', doc.historyId === '100', doc);
    check('戻り値の historyId も残した値', state.historyId === '100', state);
    check('watchExpiration は更新する', doc.watchExpiration === expectedExpiration && state.watchExpiration === expectedExpiration, doc);
    check('updatedAt は更新する', doc.updatedAt.toMillis() > OLD_UPDATED_AT.toMillis(), doc.updatedAt.toMillis());
    check('ほかの項目は消さない（merge）', doc.note === 'keep-me', doc);
    check('getWatchState も残した値を返す', (await getWatchState()).historyId === '100');
  }

  console.log('registerWatch: 保存値 > 応答（巻き戻さない）');
  {
    await clearFirestore();
    await seedState({ historyId: '900' });
    resetFake({ historyId: '500' });
    const state = await registerWatch();
    const doc = await readState();
    check('保存値の方が大きくても巻き戻さない', doc.historyId === '900' && state.historyId === '900', doc);
  }

  console.log('registerWatch: 数値のまま保存された historyId');
  {
    await clearFirestore();
    await seedState({ historyId: 100 });
    resetFake({ historyId: '500' });
    const state = await registerWatch();
    const doc = await readState();
    check('数値の historyId も残す（型も変えない）', doc.historyId === 100 && state.historyId === '100', { doc: doc.historyId, state });
  }

  console.log('registerWatch: historyId が無い・使えない');
  {
    await clearFirestore();
    await seedState({});
    resetFake({ historyId: '500' });
    await registerWatch();
    check('watchExpiration だけのドキュメントには応答の値を入れる', (await readState()).historyId === '500');

    await clearFirestore();
    await seedState({ historyId: '' });
    await registerWatch();
    check('空文字は無し扱いで応答の値を入れる', (await readState()).historyId === '500');

    await clearFirestore();
    await seedState({ historyId: 'broken' });
    const state = await registerWatch();
    const doc = await readState();
    check('数値として読めない値は応答の値に置き換える', doc.historyId === '500' && state.historyId === '500', doc);
  }

  console.log('registerWatch: /gmail/revoke の後（gmailState を消した後）');
  {
    await clearFirestore();
    await seedState({ historyId: '100' });
    await gmailStateRef().delete();
    resetFake({ historyId: '700' });
    const state = await registerWatch();
    check('消した後は応答の値から始める', (await readState()).historyId === '700' && state.historyId === '700');
  }

  console.log('renewWatch（6 日ごとの更新）');
  {
    await clearFirestore();
    await seedState({ historyId: '100' });
    resetFake({ historyId: '500' });
    const state = await renewWatch();
    const doc = await readState();
    check('stop を呼ばない', fakeGmail.stopCalls === 0, fakeGmail.stopCalls);
    check('watch を 1 回呼ぶ', fakeGmail.watchCalls.length === 1, fakeGmail.watchCalls.length);
    check('保存してある historyId を残す', doc.historyId === '100' && state.historyId === '100', doc);
    check('watchExpiration は更新する', doc.watchExpiration === expectedExpiration, doc);

    await clearFirestore();
    await seedState({ historyId: '100' });
    resetFake({ historyId: '500', error: Object.assign(new Error('watch failed'), { code: 500 }) });
    let rejected = false;
    try {
      await renewWatch();
    } catch {
      rejected = true;
    }
    const after = await readState();
    check('watch が失敗したら投げる', rejected);
    check('watch が失敗しても stop は呼ばない（既存の watch は期限まで残る）', fakeGmail.stopCalls === 0, fakeGmail.stopCalls);
    check('watch が失敗したら gmailState を変えない', after.historyId === '100' && after.watchExpiration === OLD_EXPIRATION, after);
  }

  console.log('updateHistoryId（取込の完了）は watch の更新後も前進のみ');
  {
    await clearFirestore();
    await seedState({ historyId: '100' });
    resetFake({ historyId: '500' });
    await registerWatch();
    await updateHistoryId('50');
    check('古い通知では巻き戻さない', (await readState()).historyId === '100');
    await updateHistoryId('1000');
    check('取込を終えた位置へ進む', (await readState()).historyId === '1000');
    resetFake({ historyId: '800' });
    await renewWatch();
    check('その後の更新でも、取込の位置を応答の値で戻さない', (await readState()).historyId === '1000');
  }

  console.log('registerWatch と updateHistoryId が同時に走る');
  {
    await clearFirestore();
    await seedState({ historyId: '100' });
    resetFake({ historyId: '5000' });
    await Promise.all([registerWatch(), updateHistoryId('600')]);
    const doc = await readState();
    check('取込の位置（600）が残り、応答の値で上書きされない', doc.historyId === '600', doc);
    check('watchExpiration は更新される', doc.watchExpiration === expectedExpiration, doc);
  }

  console.log('registerWatch: 連携中のアカウントのアドレスを保存する（#280）');
  {
    await clearFirestore();
    resetFake({ historyId: '500', profileAddress: 'Linked@Example.com' });
    await registerWatch();
    let doc = await readState();
    check('初回: getProfile のアドレスを小文字で保存する', doc.emailAddress === 'linked@example.com' && doc.historyId === '500', doc);
    check('getWatchState もアドレスを返す', (await getWatchState()).emailAddress === 'linked@example.com');

    await clearFirestore();
    await seedState({ historyId: '100' });
    resetFake({ historyId: '500' });
    await renewWatch();
    doc = await readState();
    check(
      'この照合の前に登録した状態（アドレスなし）: 更新でアドレスを足し、historyId は残す',
      doc.emailAddress === 'linked@example.com' && doc.historyId === '100',
      doc
    );

    await clearFirestore();
    await seedState({ historyId: '100', emailAddress: 'linked@example.com' });
    resetFake({ historyId: '500', profileError: Object.assign(new Error('Backend Error'), { code: 503 }) });
    const r = await quietly(() => renewWatch());
    doc = await readState();
    check('getProfile が失敗したら投げる（watch は呼んだ後）', r instanceof Error && fakeGmail.watchCalls.length === 1, String(r));
    check(
      'getProfile が失敗したら gmailState を変えない',
      doc.historyId === '100' && doc.emailAddress === 'linked@example.com' && doc.watchExpiration === OLD_EXPIRATION,
      doc
    );
  }

  console.log('取込: 通知の emailAddress を連携中のアカウントと照合する（#280。Gmail は偽物）');
  {
    // アカウントの切替: revoke（gmailState を消す）→ 新しいアカウントで認可 → watch 登録
    await clearFirestore();
    await seedState({ historyId: '900000', emailAddress: 'old@example.com' });
    await gmailStateRef().delete();
    resetFake({ historyId: '700', profileAddress: 'new@example.com' });
    await registerWatch();
    check('切替後: 新しいアカウントの位置とアドレスで始める', (await readState()).historyId === '700' && (await readState()).emailAddress === 'new@example.com');

    // 古いアカウントの watch（revoke は stop しない）の通知。historyId は古いメールボックスの大きな値
    resetFake({ historyId: '700', profileAddress: 'new@example.com' });
    let r = await quietly(() => handleGmailPubSub(notification('old@example.com', 999999)));
    let doc = await readState();
    check('古いアカウントの通知: 投げない（ack）', r === 'ok', String(r));
    check('古いアカウントの通知: history.list を呼ばない', fakeGmail.historyListCalls === 0, fakeGmail.historyListCalls);
    check('古いアカウントの通知: historyId を更新しない（新しいアカウントの位置が先へ飛ばない）', doc.historyId === '700', doc);

    // 新しいアカウントの通知（大文字小文字が違っても同じアカウント）
    r = await quietly(() => handleGmailPubSub(notification('New@Example.com', 800)));
    doc = await readState();
    check('新しいアカウントの通知: 処理して historyId を進める', r === 'ok' && fakeGmail.historyListCalls === 1 && doc.historyId === 800, { r: String(r), doc });

    // アドレスが保存されていない（この照合の前に登録した watch）: 照合せず以前どおり処理する
    await clearFirestore();
    await seedState({ historyId: '100' });
    resetFake();
    r = await quietly(() => handleGmailPubSub(notification('someone@example.com', '300')));
    doc = await readState();
    check('アドレスが保存されていない: 以前どおり処理して historyId を進める', r === 'ok' && fakeGmail.historyListCalls === 1 && doc.historyId === '300', { r: String(r), doc });
  }

  console.log(`\ngmail import emulator: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
