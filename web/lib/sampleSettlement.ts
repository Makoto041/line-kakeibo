import dayjs from 'dayjs';
import type { SettlementResponse } from './householdContract';
import { SAMPLE_GROUP_ID, SAMPLE_MEMBERS, getSampleExpenses } from './sampleData';
import { buildLocalSettlementResponse } from './settlementView';

/** ゲスト用のサンプル精算（サンプル支出から、サーバーと同じ式で導出する） */
export function getSampleSettlement(): SettlementResponse {
  return buildLocalSettlementResponse({
    groupId: SAMPLE_GROUP_ID,
    members: SAMPLE_MEMBERS,
    expenses: getSampleExpenses(),
    asOf: dayjs().toISOString(),
  });
}
