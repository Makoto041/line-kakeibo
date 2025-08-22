# Vercel環境変数設定手順

## 重要: このアプリケーションを動作させるためには、以下の環境変数の設定が必要です。

### 1. Firebaseコンソールで必要な情報を取得

1. [Firebase Console](https://console.firebase.google.com/)にアクセス
2. プロジェクト「line-kakeibo-0410」を選択
3. 左側メニューの歯車アイコン → プロジェクトの設定
4. 「全般」タブの下部にある「マイアプリ」セクションから以下を取得：
   - **apiKey**: `AIza...` で始まる文字列
   - **appId**: `1:440748785600:web:...` のような形式

### 2. Vercelプロジェクトで環境変数を設定

1. [Vercel Dashboard](https://vercel.com/dashboard)にアクセス
2. 「line-kakeibo」プロジェクトを選択
3. 「Settings」タブを開く
4. 左側メニューから「Environment Variables」を選択
5. 以下の環境変数を追加：

| 環境変数名 | 値 | 説明 |
|-----------|-----|------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebaseから取得したapiKey | **必須** |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebaseから取得したappId | **必須** |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `line-kakeibo-0410.firebaseapp.com` | そのまま使用 |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `line-kakeibo-0410` | そのまま使用 |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `line-kakeibo-0410.appspot.com` | そのまま使用 |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `440748785600` | そのまま使用 |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | `G-PLNC7GY160` | そのまま使用 |

### 3. デプロイを再実行

1. Vercelプロジェクトの「Deployments」タブを開く
2. 最新のデプロイメントの「...」メニューから「Redeploy」を選択
3. 「Use existing Build Cache」のチェックを**外す**（重要）
4. 「Redeploy」ボタンをクリック

### 4. 動作確認

1. デプロイ完了後、サイトにアクセス
2. エラー画面が表示されずに、正常にアプリケーションが表示されることを確認
3. LINEのURLパラメータ付きでアクセスした場合も正常に動作することを確認

## トラブルシューティング

### エラー画面が表示される場合
- ブラウザの開発者ツール（F12）のコンソールタブを確認
- 「Firebase configuration error」が表示されている場合は、環境変数の設定を再確認

### 環境変数が反映されない場合
1. Vercelのキャッシュをクリア：
   - Deployments → Redeploy → 「Use existing Build Cache」のチェックを外す
2. ブラウザのキャッシュをクリア：
   - Ctrl+Shift+R（Windows）または Cmd+Shift+R（Mac）でハードリロード

### Firebaseの認証情報が不明な場合
- Firebase Consoleのプロジェクト設定から確認
- 必要に応じて新しいWebアプリを追加して認証情報を生成

## セキュリティ注意事項

- `NEXT_PUBLIC_`プレフィックスが付いた環境変数はクライアントサイドで参照可能です
- APIキーは公開されますが、Firebaseのセキュリティルールで適切に保護してください
- 本番環境では必ずHTTPSを使用してください
