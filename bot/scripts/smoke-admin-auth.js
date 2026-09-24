/**
 * 管理 API 認証ヘルパーのスモークテスト
 *
 *   node bot/scripts/smoke-admin-auth.js
 */
const { secretsMatch, parseBearerToken, isAdminAuthorized } = require('../dist/adminAuth');

let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// テスト用のダミー値（本物の秘密値ではない）
const SECRET = 'dummy-admin-secret-for-smoke';

console.log('parseBearerToken');
check('ヘッダーが無ければ空', parseBearerToken(undefined) === '');
check('文字列以外は空', parseBearerToken(['Bearer x']) === '');
check('Bearer 以外のスキームは空', parseBearerToken(`Basic ${SECRET}`) === '');
check('トークンの無い Bearer は空', parseBearerToken('Bearer ') === '');
check('スキーム名は大文字小文字を区別しない', parseBearerToken(`bearer ${SECRET}`) === SECRET);
check('前後の空白は落とす', parseBearerToken(`Bearer   ${SECRET}  `) === SECRET);

console.log('\nsecretsMatch');
check('完全一致は true', secretsMatch(SECRET, SECRET) === true);
check('長さの違う値は false（例外にならない）', secretsMatch(`${SECRET}x`, SECRET) === false);
check('短い値も false', secretsMatch('d', SECRET) === false);
check('空文字は false', secretsMatch('', SECRET) === false);

console.log('\nisAdminAuthorized');
check('ヘッダーが無ければ拒否', isAdminAuthorized(undefined, SECRET) === false);
check('正しい Bearer は許可', isAdminAuthorized(`Bearer ${SECRET}`, SECRET) === true);
check('小文字 bearer も許可', isAdminAuthorized(`bearer ${SECRET}`, SECRET) === true);
check('末尾に空白があっても許可', isAdminAuthorized(`Bearer ${SECRET} \t`, SECRET) === true);
check('秘密値側の末尾改行は無視する', isAdminAuthorized(`Bearer ${SECRET}`, `${SECRET}\n`) === true);
check('長さの違う値は拒否', isAdminAuthorized(`Bearer ${SECRET}-longer`, SECRET) === false);
check('1文字違いは拒否', isAdminAuthorized(`Bearer ${SECRET.slice(0, -1)}X`, SECRET) === false);
check('ヘッダーに秘密値だけ（スキーム無し）は拒否', isAdminAuthorized(SECRET, SECRET) === false);
check('秘密値が未設定なら常に拒否', isAdminAuthorized('Bearer ', '') === false &&
  isAdminAuthorized(`Bearer ${SECRET}`, undefined) === false &&
  isAdminAuthorized(`Bearer ${SECRET}`, '   ') === false);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
