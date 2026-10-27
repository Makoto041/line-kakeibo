/**
 * Gmail 取込の状態（system/gmailState）の統合テスト（Firestore エミュレータ）
 *
 * watch の登録・更新（registerWatch / renewWatch。管理 API の register-watch も registerWatch）が、
 * 保存してある historyId を watch の応答（= 今のメールボックスの位置）で上書きしないことを確かめる。
 * 上書きすると、取込が失敗して historyId が止まっている間の範囲が二度と処理されない。
 * watch の応答の historyId が使えない形なら書かないこと（保存値が使える形なら残し、そうでなければ何も書かずに投げる）も確かめる。
 * あわせて、watch の登録・更新が連携中のアカウントのアドレス（getProfile）を保存し、取込（handleGmailPubSub）が
 * 通知の emailAddress と照合して、違うアカウントの通知では historyId を更新しないこと、保存してあるアドレスが古いだけ
 * （getProfile が通知と同じ）なら保存値を書き直して処理を続けることを確かめる（#280）。
 * 取込が保存する historyId が、通知の値ではなく常にメールボックスの現在位置（history.list の応答の historyId）であること、
 * 現在位置が保存値以下なら進めないこと（#298）、現在位置が保存値より前なら書かないこと、保存してある historyId が使えない形なら
 * getProfile の現在位置に置き換えること（トランザクションの中で、保存値がまだ使えない形のときだけ。#300）も確かめる。
 * Gmail API は呼ばない（dist/gmail/auth の getGmailClient を偽物に差し替える）。
 *
 * emulator-household-api.js と同じ形で実行する（npm -w bot run test:emulator から続けて動く）。
 * 本番のプロジェクトには接続しない（demo-* 以外は即終了）。
 */
// 手元のシェルに本物の鍵があると、カテゴリ・中項目の Jev が本物の API を呼ぶため消す
delete process.env.TYPESAFE_API_KEY;
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
  // getProfile が応答を返す直前に呼ぶ（その間に watch の更新・revoke が gmailState を書き換えるのを再現する。#300）
  beforeProfileReply: null,
  // 取込（handler.ts）の history.list。メッセージは返さない（historyId の更新だけを見る）
  historyListCalls: 0,
  // history.list の応答の historyId（メールボックスの現在位置。取込はこれを保存する。#298）。
  // 既定は、このテストの通知の historyId のどれとも違う値（watchHistoryId とも別にする）
  mailboxHistoryId: '1000000',
  // 次からの history.list が返す現在位置と、返すまでの待ち時間（同時実行のテスト。空なら mailboxHistoryId をすぐ返す）
  listQueue: [],
  listDelayMs: {},
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
      if (fakeGmail.beforeProfileReply) await fakeGmail.beforeProfileReply();
      return { data: { emailAddress: fakeGmail.profileAddress, historyId: fakeGmail.watchHistoryId } };
    },
    history: {
      list: async () => {
        fakeGmail.historyListCalls++;
        if (fakeGmail.listQueue.length > 0) {
          const historyId = fakeGmail.listQueue.shift();
          await new Promise((resolve) => setTimeout(resolve, fakeGmail.listDelayMs[historyId] || 0));
          return { data: { history: [], historyId } };
        }
        return { data: { history: [], historyId: fakeGmail.mailboxHistoryId } };
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

function resetFake({
  historyId = '500',
  error = null,
  profileAddress = 'linked@example.com',
  profileError = null,
  mailboxHistoryId = '1000000',
} = {}) {
  fakeGmail.mailboxHistoryId = mailboxHistoryId;
  fakeGmail.watchHistoryId = historyId;
  fakeGmail.watchError = error;
  fakeGmail.watchCalls = [];
  fakeGmail.stopCalls = 0;
  fakeGmail.profileAddress = profileAddress;
  fakeGmail.profileError = profileError;
  fakeGmail.profileCalls = 0;
  fakeGmail.beforeProfileReply = null;
  fakeGmail.historyListCalls = 0;
  fakeGmail.listQueue = [];
  fakeGmail.listDelayMs = {};
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

  console.log('registerWatch: watch の応答の historyId が使えない形（先頭ゼロ）');
  {
    await clearFirestore();
    resetFake({ historyId: '000500' });
    let r = await quietly(() => registerWatch());
    check('保存値なし: 投げ、gmailState を作らない', r instanceof Error && r.name === 'GmailWatchHistoryIdError' && (await readState()) === null, String(r));

    await clearFirestore();
    await seedState({ historyId: 'broken', note: 'keep-me' });
    r = await quietly(() => registerWatch());
    let doc = await readState();
    check(
      '保存値も使えない形: 投げ、gmailState を変えない',
      r instanceof Error && doc.historyId === 'broken' && doc.watchExpiration === OLD_EXPIRATION && doc.updatedAt.toMillis() === OLD_UPDATED_AT.toMillis() && doc.emailAddress === undefined,
      { r: String(r), doc }
    );

    await clearFirestore();
    await seedState({ historyId: '100', note: 'keep-me' });
    r = await quietly(() => registerWatch());
    doc = await readState();
    check(
      '保存値 100: 投げず、historyId を残し、watchExpiration・アドレスは更新する',
      r === 'ok' && doc.historyId === '100' && doc.watchExpiration === expectedExpiration && doc.emailAddress === 'linked@example.com' && doc.note === 'keep-me',
      { r: String(r), doc }
    );
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

    // 古いアカウントの watch（revoke が止められなかった〔watchStopped: false〕・revoke をせずに認可し直した）の通知。
    // historyId は古いメールボックスの大きな値
    resetFake({ historyId: '700', profileAddress: 'new@example.com' });
    let r = await quietly(() => handleGmailPubSub(notification('old@example.com', 999999)));
    let doc = await readState();
    check('古いアカウントの通知: 投げない（ack）', r === 'ok', String(r));
    check('古いアカウントの通知: history.list を呼ばない', fakeGmail.historyListCalls === 0, fakeGmail.historyListCalls);
    check('古いアカウントの通知: getProfile で確かめるのは 1 回だけ', fakeGmail.profileCalls === 1, fakeGmail.profileCalls);
    check(
      '古いアカウントの通知: historyId もアドレスも変えない（新しいアカウントの位置が先へ飛ばない）',
      doc.historyId === '700' && doc.emailAddress === 'new@example.com',
      doc
    );

    // 新しいアカウントの通知（大文字小文字が違っても同じアカウント）
    fakeGmail.mailboxHistoryId = '850';
    r = await quietly(() => handleGmailPubSub(notification('New@Example.com', 800)));
    doc = await readState();
    check(
      '新しいアカウントの通知: 処理して historyId を応答の現在位置（"850"。文字列）まで進める（通知の 800 ではない）',
      r === 'ok' && fakeGmail.historyListCalls === 1 && doc.historyId === '850',
      { r: String(r), doc }
    );

    // アドレスが保存されていない（この照合の前に登録した watch）: 照合せず以前どおり処理する
    await clearFirestore();
    await seedState({ historyId: '100' });
    resetFake({ mailboxHistoryId: '350' });
    r = await quietly(() => handleGmailPubSub(notification('someone@example.com', '300')));
    doc = await readState();
    check(
      'アドレスが保存されていない: 以前どおり処理して historyId を応答の現在位置（350）まで進める',
      r === 'ok' && fakeGmail.historyListCalls === 1 && doc.historyId === '350',
      { r: String(r), doc }
    );
  }

  console.log('取込: 保存してあるアドレスが古い（プライマリアドレスの変更）ときは追従する');
  {
    // 保存値は変更前のアドレス。連携中のアカウント（トークン）と通知は新しいアドレス
    await clearFirestore();
    await seedState({ historyId: '100', emailAddress: 'old-primary@example.com' });
    resetFake({ profileAddress: 'new-primary@example.com', mailboxHistoryId: '350' });
    let r = await quietly(() => handleGmailPubSub(notification('New-Primary@example.com', '300')));
    let doc = await readState();
    check('getProfile を 1 回呼び、保存値を新しいアドレスに書き直す', fakeGmail.profileCalls === 1 && doc.emailAddress === 'new-primary@example.com', doc);
    check(
      'そのまま処理して historyId を応答の現在位置（350）まで進める（watchExpiration は変えない）',
      r === 'ok' && fakeGmail.historyListCalls === 1 && doc.historyId === '350' && doc.watchExpiration === OLD_EXPIRATION,
      { r: String(r), doc }
    );

    // 書き直した後は、新しいアドレスの通知は getProfile なしで一致する
    resetFake({ profileAddress: 'new-primary@example.com', mailboxHistoryId: '450' });
    r = await quietly(() => handleGmailPubSub(notification('new-primary@example.com', '400')));
    doc = await readState();
    check('書き直した後: getProfile を呼ばずに処理する（現在位置 450 まで進める）', r === 'ok' && fakeGmail.profileCalls === 0 && doc.historyId === '450', { r: String(r), doc });

    // 本当に別のアカウントの通知（getProfile も通知と違う）→ 読み飛ばす
    resetFake({ profileAddress: 'new-primary@example.com' });
    r = await quietly(() => handleGmailPubSub(notification('someone-else@example.com', 999999)));
    doc = await readState();
    check(
      '別のアカウントの通知: 投げず、history.list を呼ばず、historyId もアドレスも変えない',
      r === 'ok' && fakeGmail.profileCalls === 1 && fakeGmail.historyListCalls === 0 && doc.historyId === '450' && doc.emailAddress === 'new-primary@example.com',
      { r: String(r), doc }
    );

    // getProfile の一時的な失敗 → 投げて再送させる
    resetFake({ profileAddress: 'new-primary@example.com', profileError: Object.assign(new Error('Backend Error'), { code: 503 }) });
    r = await quietly(() => handleGmailPubSub(notification('someone-else@example.com', 999999)));
    doc = await readState();
    check(
      'getProfile が失敗: 投げて再送させ、historyId もアドレスも変えない',
      r instanceof Error && fakeGmail.historyListCalls === 0 && doc.historyId === '450' && doc.emailAddress === 'new-primary@example.com',
      { r: String(r), doc }
    );
  }

  console.log('取込: 保存する historyId は常にメールボックスの現在位置（history.list の応答の historyId。通知の値は使わない。#298）');
  {
    // 連携中のアカウントのアドレスで偽った通知（照合は通る）。historyId は極端に大きい
    await clearFirestore();
    await seedState({ historyId: '100', emailAddress: 'linked@example.com' });
    resetFake({ mailboxHistoryId: '700' });
    let r = await quietly(() => handleGmailPubSub(notification('linked@example.com', '18446744073709551615')));
    let doc = await readState();
    check('偽の通知（極端に大きい）: 投げずに、現在位置（700）で保存する', r === 'ok' && fakeGmail.historyListCalls === 1 && doc.historyId === '700', { r: String(r), doc });

    // 正当な通知（数値。Gmail の形）も、保存するのは応答の現在位置（文字列）
    resetFake({ mailboxHistoryId: '850' });
    r = await quietly(() => handleGmailPubSub(notification('linked@example.com', 800)));
    doc = await readState();
    check('そのあとの正当な通知（800）: 通知の値ではなく、応答の現在位置（"850"。文字列）まで進む', r === 'ok' && doc.historyId === '850', { r: String(r), doc });

    // 応答に historyId が無い（null）: 進めない
    resetFake({ mailboxHistoryId: null });
    r = await quietly(() => handleGmailPubSub(notification('linked@example.com', '900')));
    doc = await readState();
    check('応答に historyId が無い: 投げず、historyId を進めない（通知の 900 へも進めない）', r === 'ok' && fakeGmail.historyListCalls === 1 && doc.historyId === '850', { r: String(r), doc });

    // 偽の通知の値が、保存値と現在位置の間・保存値より小さい・ゼロ: どれも保存するのは現在位置
    for (const [label, historyId, position] of [
      ['保存値（850）と現在位置（1000）の間', '900', '1000'],
      ['保存値（1000）より小さい', '1', '1100'],
      ['ゼロ', '0', '1200'],
      ['ゼロ（数値）', 0, '1250'],
    ]) {
      resetFake({ mailboxHistoryId: position });
      r = await quietly(() => handleGmailPubSub(notification('linked@example.com', historyId)));
      doc = await readState();
      check(`偽の通知（${label}）: 現在位置（${position}）を保存する`, r === 'ok' && fakeGmail.historyListCalls === 1 && doc.historyId === position, { r: String(r), doc });
    }

    // 現在位置が保存値以下: 進めない（巻き戻さない）
    resetFake({ mailboxHistoryId: '1250' });
    r = await quietly(() => handleGmailPubSub(notification('linked@example.com', '1300')));
    doc = await readState();
    check('現在位置 = 保存値（1250）: 保存値を変えない（通知の 1300 へも進めない）', r === 'ok' && doc.historyId === '1250', { r: String(r), doc });
    resetFake({ mailboxHistoryId: '1200' });
    r = await quietly(() => handleGmailPubSub(notification('linked@example.com', '18446744073709551615')));
    doc = await readState();
    check('現在位置（1200）< 保存値（1250）: 巻き戻さない', r === 'ok' && doc.historyId === '1250', { r: String(r), doc });

    // 同時に走った 2 つの取込: 小さい現在位置が後から書いても巻き戻らず、大きい方が残る（トランザクションと前進のみ）
    resetFake();
    fakeGmail.listQueue = ['1500', '1400'];
    fakeGmail.listDelayMs = { 1500: 0, 1400: 300 };
    // ログを止めるのは 1 回だけにする（quietly を重ねると、先に終わった方が止めたままの console を戻してしまう）
    r = await quietly(() =>
      Promise.all([
        handleGmailPubSub(notification('linked@example.com', '1500')),
        handleGmailPubSub(notification('linked@example.com', '1400')),
      ])
    );
    doc = await readState();
    check(
      '同時に走った取込（現在位置 1500 が先に、1400 が後に書く）: 1500 が残る',
      r === 'ok' && fakeGmail.historyListCalls === 2 && doc.historyId === '1500',
      { r: String(r), doc }
    );
  }

  console.log('取込: 先頭ゼロ・桁あふれの historyId は使わない（大小の比較をすり抜けて長い文字列が保存されないように）');
  {
    await clearFirestore();
    await seedState({ historyId: '1000', emailAddress: 'linked@example.com' });
    for (const [label, historyId] of [
      ['長いゼロ埋め', '0'.repeat(100000) + '1005'],
      ['先頭ゼロ', '01005'],
      ['21 桁', '100000000000000000000'],
    ]) {
      resetFake({ mailboxHistoryId: '1010' });
      const r = await quietly(() => handleGmailPubSub(notification('linked@example.com', historyId)));
      const doc = await readState();
      check(
        `通知が${label}: 投げずに捨て、history.list を呼ばず、historyId を変えない`,
        r === 'ok' && fakeGmail.historyListCalls === 0 && doc.historyId === '1000',
        { r: String(r), historyListCalls: fakeGmail.historyListCalls, historyId: String(doc.historyId).slice(0, 24) }
      );
    }

    // すでに先頭ゼロの値が保存されていたら、取込は history.list を呼ばず、getProfile の現在位置に置き換えて終える（#300）。
    // 置き換える値は連携中のアカウントの getProfile で決まるので、照合が合わない通知でも置き換える（アドレスは変えない）
    await clearFirestore();
    await seedState({ historyId: '0001000', emailAddress: 'linked@example.com' });
    resetFake({ historyId: '1500', mailboxHistoryId: '1600' });
    let r = await quietly(() => handleGmailPubSub(notification('someone-else@example.com', '1600')));
    let doc = await readState();
    check(
      '先頭ゼロで保存された値: 取込は投げず、history.list を呼ばず、getProfile を 1 回呼んでその現在位置（"1500"）に置き換える',
      r === 'ok' && fakeGmail.historyListCalls === 0 && fakeGmail.profileCalls === 1 && doc.historyId === '1500',
      { r: String(r), historyListCalls: fakeGmail.historyListCalls, profileCalls: fakeGmail.profileCalls, doc: doc.historyId }
    );
    check(
      '先頭ゼロで保存された値: historyId と updatedAt のほか（emailAddress・watchExpiration）は変えない',
      doc.emailAddress === 'linked@example.com' && doc.watchExpiration === OLD_EXPIRATION && doc.updatedAt.toMillis() > OLD_UPDATED_AT.toMillis(),
      doc
    );
    resetFake({ mailboxHistoryId: '1600' });
    r = await quietly(() => handleGmailPubSub(notification('linked@example.com', '1600')));
    doc = await readState();
    check('置き換えた後: 取込が再開し、現在位置（1600）まで進む', r === 'ok' && fakeGmail.historyListCalls === 1 && doc.historyId === '1600', { r: String(r), doc });

    // getProfile が失敗: 投げず、保存値を変えない（次の通知か watch の更新で直る）
    await clearFirestore();
    await seedState({ historyId: '0001000', emailAddress: 'linked@example.com' });
    resetFake({ historyId: '1500', profileError: Object.assign(new Error('Backend Error'), { code: 503 }) });
    r = await quietly(() => handleGmailPubSub(notification('linked@example.com', '1600')));
    doc = await readState();
    check('先頭ゼロで保存された値・getProfile が失敗: 投げず、history.list を呼ばず、保存値を変えない', r === 'ok' && fakeGmail.historyListCalls === 0 && doc.historyId === '0001000', { r: String(r), doc: doc.historyId });

    // watch の更新でも直る（resolveWatchHistoryId の replaced。以前からの直し方）
    resetFake({ historyId: '500' });
    const state = await renewWatch();
    doc = await readState();
    check('先頭ゼロで保存された値: watch の更新でも応答の値（500）に置き換わる', doc.historyId === '500' && state.historyId === '500', { doc: doc.historyId, state });

    // getProfile を待つ間に watch の更新が先に置き換えた: トランザクションで読み直し、使える形なので上書きしない
    await clearFirestore();
    await seedState({ historyId: '0001000', emailAddress: 'linked@example.com' });
    resetFake({ historyId: '1500' });
    fakeGmail.beforeProfileReply = () => gmailStateRef().set({ historyId: '700' }, { merge: true });
    r = await quietly(() => handleGmailPubSub(notification('linked@example.com', '1600')));
    doc = await readState();
    check('getProfile の間に watch の更新が 700 に置き換えた: getProfile の 1500 で上書きしない', r === 'ok' && doc.historyId === '700', { r: String(r), doc: doc.historyId });

    // getProfile を待つ間に /gmail/revoke が文書を消した: 作り直さない
    await clearFirestore();
    await seedState({ historyId: '0001000', emailAddress: 'linked@example.com' });
    resetFake({ historyId: '1500' });
    fakeGmail.beforeProfileReply = () => gmailStateRef().delete();
    r = await quietly(() => handleGmailPubSub(notification('linked@example.com', '1600')));
    check('getProfile の間に revoke が文書を消した: gmailState を作り直さない', r === 'ok' && (await readState()) === null, { r: String(r), doc: await readState() });

    // 2 つの取込が同時に置き換えようとしても、書くのは 1 回（後の方は使える形を読んで書かない）
    await clearFirestore();
    await seedState({ historyId: '0001000', emailAddress: 'linked@example.com' });
    resetFake({ historyId: '1500' });
    let profileReplies = 0;
    fakeGmail.beforeProfileReply = async () => {
      // 1 回目の応答は 1500、2 回目は 1700（Gmail の位置が進んだ）。2 回目の書き込みは 1 回目より後になるよう待たせる
      profileReplies++;
      if (profileReplies === 2) {
        fakeGmail.watchHistoryId = '1700';
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };
    r = await quietly(() =>
      Promise.all([handleGmailPubSub(notification('linked@example.com', '1600')), handleGmailPubSub(notification('linked@example.com', '1601'))])
    );
    doc = await readState();
    check(
      '同時に 2 つの取込が置き換えようとした: 先に書いた 1500 が残る（後の 1700 は、使える形を読んで書かない）',
      r === 'ok' && fakeGmail.profileCalls === 2 && doc.historyId === '1500',
      { r: String(r), profileCalls: fakeGmail.profileCalls, doc: doc.historyId }
    );
  }

  console.log('取込: 現在位置が保存値より前（保存値がこのメールボックスの位置でない）なら書かない（#300）');
  {
    await clearFirestore();
    await seedState({ historyId: '18446744073709551615', emailAddress: 'linked@example.com' });
    resetFake({ mailboxHistoryId: '18446744073709551614' });
    let r = await quietly(() => handleGmailPubSub(notification('linked@example.com', '1600')));
    let doc = await readState();
    check(
      '保存値 uint64 の最大値・現在位置がその 1 つ前: 投げず、保存値を変えない',
      r === 'ok' && fakeGmail.historyListCalls === 1 && doc.historyId === '18446744073709551615',
      { r: String(r), doc: doc.historyId }
    );
    // 404 の経路（getProfile の現在位置 < 保存値）も書かない
    await clearFirestore();
    await seedState({ historyId: '9000', emailAddress: 'linked@example.com' });
    resetFake({ historyId: '5000' });
    fakeGmail.listQueue = [];
    const realList = fakeGmail.users.history.list;
    fakeGmail.users.history.list = async () => {
      fakeGmail.historyListCalls++;
      throw Object.assign(new Error('Requested entity was not found.'), { code: 404 });
    };
    try {
      r = await quietly(() => handleGmailPubSub(notification('linked@example.com', '1600')));
    } finally {
      fakeGmail.users.history.list = realList;
    }
    doc = await readState();
    check('404・getProfile の現在位置（5000）< 保存値（9000）: 投げず、保存値を変えない', r === 'ok' && fakeGmail.profileCalls === 1 && doc.historyId === '9000', { r: String(r), doc: doc.historyId });
  }

  console.log(`\ngmail import emulator: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
