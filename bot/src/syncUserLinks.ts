import { onDocumentCreated } from 'firebase-functions/v2/firestore';

/**
 * 【無効化済み】expenses 作成時に userLinks/{appUid} へ lineIds を追記していたトリガー。
 *
 * 旧実装は、クライアントも書ける expenses ドキュメントの `appUid`（呼び出し元が自由に
 * 決められる値）をそのままパスに使って `userLinks/${appUid}` へ Admin SDK で書き込んで
 * いた。firestore.rules は userLinks へのクライアント書き込みを禁止しているのに、この
 * トリガーを経由すると任意の userLinks 文書を作成・汚染できてしまう（SEC-16）。
 *
 * userLinks は `/auth/line`（linkUserResolver.getOrCreateAppUidForLineId →
 * firestore.createUserLink）が appUid ↔ lineId を 1 対 1 で管理しており、このトリガーが
 * 書く `lineIds` 配列はどこからも参照されていない。そのため書き込みを完全に止める。
 *
 * 関数そのものを export から外すと、CI の非対話 `firebase deploy` が「本番にだけ存在する
 * 関数」の削除確認で失敗するため、関数の削除は別途（手動で `firebase functions:delete
 * syncUserLinks`）行う前提で、ここでは何もしない関数として残す。
 */
export const syncUserLinks = onDocumentCreated(
  {
    document: 'expenses/{expenseId}',
    region: 'asia-northeast1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 3,
  },
  async () => {
    // 意図的に何もしない（上記コメント参照）。
  }
);
