/**
 * LINE 支出のグループ所属決定（resolveExpenseGroupScope）のスモークテスト
 *
 *   node bot/scripts/smoke-expense-group-scope.js
 */
const { resolveExpenseGroupScope } = require('../dist/expenseGroupScope');

let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const household = { id: 'G1', lineGroupId: 'Lhouse' };
const other = { id: 'G2', lineGroupId: 'Lother' };
const personalGroup = { id: 'G3' };

console.log('resolveExpenseGroupScope');
let r = resolveExpenseGroupScope(household, 'Lhouse');
check('世帯の LINE グループの有効メンバーは groupId / lineGroupId を両方持つ',
  r.groupId === 'G1' && r.lineGroupId === 'Lhouse', JSON.stringify(r));

r = resolveExpenseGroupScope(null, 'Lhouse');
check('非メンバー（activeGroup なし）は lineGroupId を付けない（LINE 集計に入らない）',
  r.groupId === undefined && r.lineGroupId === undefined, JSON.stringify(r));

r = resolveExpenseGroupScope(other, 'Lhouse');
check('別の LINE グループに紐づくグループのメンバーは世帯の LINE 集計に入らない',
  r.groupId === undefined && r.lineGroupId === undefined, JSON.stringify(r));

r = resolveExpenseGroupScope(personalGroup, 'Lhouse');
check('LINE グループに紐づかない自作グループのメンバーも世帯の LINE 集計に入らない',
  r.groupId === undefined && r.lineGroupId === undefined, JSON.stringify(r));

r = resolveExpenseGroupScope(household, null);
check('個人チャット: 所属グループの支出になり lineGroupId は付けない',
  r.groupId === 'G1' && r.lineGroupId === undefined, JSON.stringify(r));

r = resolveExpenseGroupScope(null, undefined);
check('個人チャット・所属なし: どちらも付けない',
  r.groupId === undefined && r.lineGroupId === undefined, JSON.stringify(r));

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
