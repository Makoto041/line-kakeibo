import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';
import { maskId } from './logSafe';

// Initialize Firebase Admin SDK if not already initialized
if (!getApps().length) {
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || 'line-kakeibo-0410'
  });
}

const db = getFirestore();

export const syncUserLinks = onDocumentCreated(
  {
    document: 'expenses/{expenseId}',
    region: 'asia-northeast1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 3,
  },
  async (event) => {
    try {
      const data = event.data?.data();
      if (!data) {
        console.log('No data in expense document');
        return;
      }

      const { lineId, appUid } = data;
      
      console.log(`Processing expense with lineId: ${maskId(lineId)}, appUid: ${maskId(appUid)}`);
      
      // appUidが設定されていない場合はスキップ
      if (!appUid) {
        console.log('No appUid found, skipping userLinks sync');
        return;
      }

      const ref = db.doc(`userLinks/${appUid}`);
      
      // トランザクションでuserLinksドキュメントを更新
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        
        let lineIds: string[] = [];
        if (snap.exists) {
          const existingData = snap.data();
          lineIds = existingData?.lineIds || [];
        }
        
        // lineIdが既に配列に含まれていない場合のみ追加
        if (!lineIds.includes(lineId)) {
          lineIds.push(lineId);
          
          const updateData = {
            lineIds,
            updatedAt: new Date(),
            ...(snap.exists ? {} : { createdAt: new Date() })
          };
          
          transaction.set(ref, updateData, { merge: true });
          console.log(`Added lineId ${maskId(lineId)} to userLinks/${maskId(appUid)}`);
        } else {
          console.log(`LineId ${maskId(lineId)} already exists in userLinks/${maskId(appUid)}`);
        }
      });
      
    } catch (error) {
      console.error('Error in syncUserLinks function:', error);
      // Cloud Functionsではエラーを投げずにログに記録
      // 実際のexpense作成処理には影響しないようにする
    }
  }
);