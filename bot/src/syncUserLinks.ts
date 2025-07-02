import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';

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
    timeoutSeconds: 60
  },
  async (event) => {
    try {
      const data = event.data?.data();
      if (!data) {
        console.log('No data in expense document');
        return;
      }

      const { userId: lineId, appUid } = data;
      
      console.log('Processing expense with lineId:', lineId, 'appUid:', appUid);
      
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
          console.log(`Added lineId ${lineId} to userLinks/${appUid}`);
        } else {
          console.log(`LineId ${lineId} already exists in userLinks/${appUid}`);
        }
      });
      
    } catch (error) {
      console.error('Error in syncUserLinks function:', error);
      // Cloud Functionsではエラーを投げずにログに記録
      // 実際のexpense作成処理には影響しないようにする
    }
  }
);