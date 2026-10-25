/**
 * Gmail 取込の状態（system/gmailState）の統合テスト（Firestore エミュレータ）
 *
 * watch の登録・更新（registerWatch / renewWatch。管理 API の register-watch も registerWatch）が、
 * 保存してある historyId を watch の応答（= 今のメールボックスの位置）で上書きしないことを確かめる。
 * 上書きすると、取込が失敗して historyId が止まっている間の範囲が二度と処理されない。
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
  },
};
const auth = require('../dist/gmail/auth');
auth.getGmailClient = async () => fakeGmail;

const { registerWatch, renewWatch, updateHistoryId, getWatchState, gmailStateRef } = require('../dist/gmail/watch');

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

function resetFake({ historyId = '500', error = null } = {}) {
  fakeGmail.watchHistoryId = historyId;
  fakeGmail.watchError = error;
  fakeGmail.watchCalls = [];
  fakeGmail.stopCalls = 0;
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

  console.log(`\ngmail import emulator: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
