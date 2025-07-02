# セットアップガイド

LINEレシート家計簿の詳細なセットアップ手順です。

## 📋 前提条件

### 必要なツール・アカウント

| ツール | バージョン | 用途 |
|--------|------------|------|
| Node.js | 18 LTS以上 | 開発環境 |
| npm/pnpm/yarn | 最新版 | パッケージ管理 |
| Firebase CLI | 最新版 | デプロイ |
| Git | 任意 | バージョン管理 |

### 必要なアカウント

- Google Cloud/Firebase アカウント
- LINE Developers アカウント

## 🔧 1. 開発環境準備

### Node.js インストール
```bash
# macOS (Homebrew使用)
brew install nvm
nvm install 18
nvm use 18

# Windows
# https://nodejs.org/ からLTS版をダウンロード

# バージョン確認
node -v  # v18.x.x以上
npm -v
```

### Firebase CLI インストール
```bash
npm install -g firebase-tools
firebase --version
```

### パッケージマネージャー（pnpm推奨）
```bash
npm install -g pnpm
pnpm --version
```

## 🔥 2. Firebase/Google Cloud設定

### 2-1. Firebase プロジェクト作成

1. [Firebase Console](https://console.firebase.google.com/) を開く
2. 「プロジェクトを追加」をクリック
3. プロジェクト名: `line-kakeibo` （任意）
4. Google Analyticsは任意で設定

### 2-2. Firestore設定

1. Firebase Console > Firestore Database
2. 「データベースの作成」
3. **「本番環境モード」** を選択
4. ロケーション: `asia-northeast1` （東京）を推奨

### 2-3. Authentication設定

1. Firebase Console > Authentication
2. 「始める」をクリック
3. Sign-in method タブ
4. 「匿名」を有効化

### 2-4. Google Cloud Vision API設定

1. [Google Cloud Console](https://console.cloud.google.com/) を開く
2. Firebase プロジェクトを選択
3. 「APIとサービス」> 「ライブラリ」
4. 「Vision API」を検索して有効化
5. 「認証情報」> 「認証情報を作成」> 「サービスアカウント」
6. サービスアカウント名: `vision-api-user`
7. 役割: `Cloud Vision API User` を追加
8. 「完了」後、作成したサービスアカウントをクリック
9. 「キー」タブ > 「キーを追加」> 「新しいキーを作成」
10. JSON形式でダウンロード
11. ダウンロードしたファイルを `bot/vision-key.json` として保存

## 📱 3. LINE Bot設定

### 3-1. チャネル作成

1. [LINE Developers](https://developers.line.biz/) にログイン
2. プロバイダーを選択（なければ作成）
3. 「新しいチャネルを作成」
4. 「Messaging API」を選択
5. 必要情報を入力：
   - チャネル名: `LINEレシート家計簿`
   - チャネル説明: `レシート画像から家計簿を作成`
   - 大業種: `個人`
   - 小業種: `個人（その他）`

### 3-2. チャネル設定

1. 作成したチャネルの「Messaging API設定」タブ
2. **チャネルシークレット** をコピー
3. **チャネルアクセストークン（長期）** を発行してコピー
4. **Webhook設定**:
   - Webhookの利用: `有効`
   - Webhook URL: 後で設定（開発時は ngrok URL）
5. **応答設定**:
   - 応答メッセージ: `無効`
   - Webhook: `有効`

### 3-3. 友達追加

1. チャネルの「Messaging API設定」
2. QRコードをスキャンしてBotを友達追加（テスト用）

## 🛠️ 4. プロジェクトセットアップ

### 4-1. リポジトリ準備

```bash
cd line-kakeibo

# ルートでFirebase初期化
firebase login
firebase init

# 選択項目:
# ✅ Functions: Configure a Cloud Functions directory
# ✅ Firestore: Configure security rules and indexes files  
# ✅ Hosting: Configure files for Firebase Hosting

# プロジェクト選択: 作成したFirebaseプロジェクト
# Functions設定: bot (既存フォルダ使用)
# Hosting設定: web (既存フォルダ使用)
```

### 4-2. 依存関係インストール

```bash
# Bot
cd bot
pnpm install

# Web  
cd ../web
pnpm install
```

### 4-3. 環境変数設定

ルートディレクトリの `.env` ファイルを編集：

```bash
# Firebase設定の取得
# Firebase Console > プロジェクトの設定 > 全般 > マイアプリ
# 「設定」アイコンをクリックして設定情報を確認
```

## 🧪 5. ローカル開発

### 5-1. Bot開発・テスト

```bash
cd bot

# 開発サーバー起動
pnpm run dev
# → http://localhost:3000 で起動

# 別ターミナルでngrok起動
npx ngrok http 3000
# 表示された https://xxx.ngrok-free.app をコピー
```

### 5-2. LINE Webhook URL設定

1. LINE Developers > チャネル > Messaging API設定
2. Webhook URL: `https://xxx.ngrok-free.app/webhook`
3. 「確認」ボタンでテスト（成功すれば OK）

### 5-3. Web開発

```bash
cd web
pnpm run dev
# → http://localhost:3001 で起動
```

### 5-4. 動作確認

1. LINEでBotにレシート画像を送信
2. Bot が「レシートを読み込みました」とレスポンス
3. Webアプリでダッシュボード・支出一覧を確認

## 🚀 6. 本番デプロイ

### 6-1. Bot（Cloud Functions）

```bash
cd bot
pnpm run build

# Firebase Functions にデプロイ
firebase deploy --only functions

# デプロイ完了後、表示されるURLをコピー
# 例: https://us-central1-line-kakeibo.cloudfunctions.net/app
```

### 6-2. LINE Webhook URL更新

1. LINE Developers > Webhook URL を本番URLに更新
2. `https://us-central1-line-kakeibo.cloudfunctions.net/app/webhook`

### 6-3. Web（Firebase Hosting）

```bash
cd web
pnpm run build

# Firebase Hosting にデプロイ
firebase deploy --only hosting

# デプロイ完了後、URLが表示される
# 例: https://line-kakeibo.web.app
```

### 6-4. 全体デプロイ

```bash
# ルートディレクトリで一括デプロイ
firebase deploy
```

## 🔒 7. セキュリティ設定

### 7-1. Firestoreルール適用

開発中は全許可ルールですが、本番では適切なルールに変更：

```bash
# firestore.rules を編集後
firebase deploy --only firestore:rules
```

### 7-2. 環境変数の本番設定

```bash
# Cloud Functions の環境変数設定
firebase functions:config:set line.channel_secret="実際の値"
firebase functions:config:set line.channel_token="実際の値"
firebase functions:config:set firebase.project_id="実際の値"

# 設定反映
firebase deploy --only functions
```

## 🐛 8. トラブルシューティング

### よくある問題

#### Bot がレスポンスしない
```bash
# ログ確認
firebase functions:log

# Webhook URL確認
curl -X POST https://your-functions-url/webhook

# LINE Webhook テスト機能を使用
```

#### OCR が機能しない
- Vision API が有効化されているか確認
- サービスアカウントキーが正しい場所にあるか確認
- `GOOGLE_APPLICATION_CREDENTIALS` 環境変数が正しいか確認

#### Web アプリでデータが表示されない
- Firebase の設定情報が正しいか確認
- Firestore ルールがアクセスを許可しているか確認
- ブラウザの開発者ツールでエラーを確認

#### ビルドエラー
```bash
# キャッシュクリア
rm -rf node_modules package-lock.json
npm install

# TypeScript エラー
npx tsc --noEmit
```

### ログ確認方法

```bash
# Cloud Functions ログ
firebase functions:log --only=yourFunctionName

# リアルタイムログ
firebase functions:log --follow

# Firestore ログ（Cloud Console）
# Google Cloud Console > Logging > ログエクスプローラー
```

## 📊 9. 運用・メンテナンス

### 定期的なタスク

```bash
# 依存関係更新確認
pnpm outdated

# セキュリティ監査
pnpm audit

# Firebase プロジェクト使用量確認
firebase projects:list
```

### バックアップ

```bash
# Firestore エクスポート
gcloud firestore export gs://your-bucket/backup-$(date +%Y%m%d)

# プロジェクト設定バックアップ
firebase use --add  # 複数環境対応
```

---

これで完全なセットアップが完了です！🎉

問題が発生した場合は、ログを確認し、各設定項目を再度確認してください。