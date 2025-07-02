import { findAppUidByLineId, createUserLink } from './firestore';
import { getAuth } from 'firebase-admin/auth';

/**
 * LINE UserIdからappUidを取得する
 * 理想設計準拠: 1:1マッピングでuserLinksドキュメントを検索
 */
export async function getAppUidByLineId(lineId: string): Promise<string | null> {
  try {
    console.log(`Resolving appUid for lineId: ${lineId}`);
    
    // 新しい1:1マッピング構造で検索
    const appUid = await findAppUidByLineId(lineId);
    
    if (appUid) {
      console.log(`Found existing appUid: ${appUid} for lineId: ${lineId}`);
      return appUid;
    }
    
    console.log(`No existing appUid found for lineId: ${lineId}`);
    return null;
  } catch (error) {
    console.error('Error resolving appUid from lineId:', error);
    return null;
  }
}

/**
 * LINE UserIdに対応するappUidを取得または作成する
 * 理想設計準拠: 存在しない場合は新しい匿名ユーザーを作成
 */
export async function getOrCreateAppUidForLineId(lineId: string): Promise<string | null> {
  try {
    // 既存のappUidを検索
    let appUid = await getAppUidByLineId(lineId);
    
    if (appUid) {
      return appUid;
    }
    
    // 存在しない場合は新しい匿名ユーザーを作成
    console.log(`Creating new anonymous user for lineId: ${lineId}`);
    
    const auth = getAuth();
    const userRecord = await auth.createUser({
      // 匿名ユーザーとして作成
    });
    
    appUid = userRecord.uid;
    console.log(`Created new appUid: ${appUid} for lineId: ${lineId}`);
    
    // userLinksドキュメントを作成
    await createUserLink(appUid, lineId);
    
    return appUid;
  } catch (error) {
    console.error('Error getting or creating appUid for lineId:', error);
    return null;
  }
}

/**
 * 複数のLINE UserIdからappUidのマップを取得する
 * 理想設計準拠: 1:1マッピングでバッチ処理
 */
export async function getAppUidsByLineIds(lineIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  
  try {
    // バッチで並列処理
    const promises = lineIds.map(async (lineId) => {
      const appUid = await getAppUidByLineId(lineId);
      if (appUid) {
        result.set(lineId, appUid);
      }
    });
    
    await Promise.all(promises);
    
    console.log(`Resolved ${result.size}/${lineIds.length} appUids`);
  } catch (error) {
    console.error('Error resolving multiple appUids:', error);
  }
  
  return result;
}

/**
 * LINE Botから送信される支出データを処理する際の appUid 解決
 * 理想設計準拠: 必要に応じて新規ユーザー作成も行う
 */
export async function resolveAppUidForExpense(lineId: string): Promise<string | null> {
  try {
    // 支出データ登録時は、必要に応じて新規ユーザーを作成
    const appUid = await getOrCreateAppUidForLineId(lineId);
    
    if (!appUid) {
      console.error(`Failed to resolve or create appUid for lineId: ${lineId}`);
      return null;
    }
    
    console.log(`Resolved appUid: ${appUid} for expense from lineId: ${lineId}`);
    return appUid;
  } catch (error) {
    console.error('Error resolving appUid for expense:', error);
    return null;
  }
}