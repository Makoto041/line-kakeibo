import { findAppUidByLineId, createUserLink } from './firestore';
import { getAuth } from 'firebase-admin/auth';
import { errorFields, maskId } from './logSafe';

/**
 * LINE UserIdからappUidを取得する
 * 理想設計準拠: 1:1マッピングでuserLinksドキュメントを検索
 */
export async function getAppUidByLineId(lineId: string): Promise<string | null> {
  try {
    console.log('Resolving appUid for the LINE user', { user: maskId(lineId) });
    
    // 新しい1:1マッピング構造で検索
    const appUid = await findAppUidByLineId(lineId);
    
    if (appUid) {
      console.log('Found existing appUid', { appUid: maskId(appUid), user: maskId(lineId) });
      return appUid;
    }
    
    console.log('No existing appUid found', { user: maskId(lineId) });
    return null;
  } catch (error) {
    console.error('Error resolving appUid from lineId', errorFields(error));
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
    console.log('Creating new anonymous user', { user: maskId(lineId) });
    
    const auth = getAuth();
    const userRecord = await auth.createUser({
      // 匿名ユーザーとして作成
    });
    
    appUid = userRecord.uid;
    console.log('Created new appUid', { appUid: maskId(appUid), user: maskId(lineId) });
    
    // userLinksドキュメントを作成
    await createUserLink(appUid, lineId);
    
    return appUid;
  } catch (error) {
    console.error('Error getting or creating appUid for lineId', errorFields(error));
    return null;
  }
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
      console.error('Failed to resolve or create appUid', { user: maskId(lineId) });
      return null;
    }
    
    console.log('Resolved appUid for the expense', { appUid: maskId(appUid), user: maskId(lineId) });
    return appUid;
  } catch (error) {
    console.error('Error resolving appUid for expense', errorFields(error));
    return null;
  }
}