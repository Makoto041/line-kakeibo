/**
 * LINE 支出のグループ所属決定（resolveExpenseGroupScope）と世帯メンバーの判定（isHouseholdMember）のスモークテスト
 *
 *   node bot/scripts/smoke-expense-group-scope.js
 */
const { isHouseholdMember, resolveExpenseGroupScope } = require('../dist/expenseGroupScope');

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

console.log('isHouseholdMember（モデルを呼んでよいか。#245）');
check('世帯の LINE グループの有効メンバーはメンバー', isHouseholdMember(household, 'Lhouse') === true);
check('LINE グループ: 所属なしはメンバーでない', isHouseholdMember(null, 'Lhouse') === false);
check('LINE グループ: 別の LINE グループに紐づくグループのメンバーはメンバーでない', isHouseholdMember(other, 'Lhouse') === false);
check('LINE グループ: 自作グループ（lineGroupId なし）のメンバーはメンバーでない', isHouseholdMember(personalGroup, 'Lhouse') === false);
check('個人チャット: LINE グループに紐づくグループのメンバーはメンバー', isHouseholdMember(household, null) === true);
check('個人チャット: 自作グループ（「グループ作成」）だけのメンバーはメンバーでない', isHouseholdMember(personalGroup, null) === false);
check('個人チャット: 所属なしはメンバーでない', isHouseholdMember(null, undefined) === false);
check('id の無いグループはメンバーでない', isHouseholdMember({ lineGroupId: 'Lhouse' }, 'Lhouse') === false);
check('lineGroupId が空文字のグループはメンバーでない', isHouseholdMember({ id: 'G4', lineGroupId: '' }, null) === false);

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
