# Git Flow CI/CDセットアップガイド

## 概要

このプロジェクトではGit Flowに基づくCI/CDパイプラインを構築しています：

- **develop**: 開発環境（プレビューデプロイ）
- **master**: 本番環境（自動デプロイ）

## ブランチ戦略

### 1. 基本フロー
```
feature/* → develop → master
```

### 2. 作業フロー
1. `develop`ブランチから`feature/*`ブランチを作成
2. 機能開発後、`develop`へのPRを作成
3. PRマージで開発環境にデプロイ
4. 動作確認後、`master`へのPRを作成
5. PRマージで本番環境に自動デプロイ

## GitHub Secretsの設定

以下のシークレットをGitHubリポジトリ設定で追加してください：

### Firebase関連
```
FIREBASE_SERVICE_ACCOUNT_LINE_KAKEIBO_0410
FIREBASE_TOKEN
```

**取得方法:**
```bash
# Firebase Service Account (JSON)
firebase projects:list
firebase serviceaccount:export line-kakeibo-0410.json --project line-kakeibo-0410

# Firebase Token
firebase login:ci
```

### Vercel関連
```
VERCEL_TOKEN
VERCEL_ORG_ID  
VERCEL_PROJECT_ID
```

**取得方法:**
1. Vercel Dashboard → Settings → Tokens
2. プロジェクト設定でOrg IDとProject IDを確認

### 通知関連（オプション）
```
SLACK_WEBHOOK_URL
```

## 環境の設定

### 1. GitHub Environments
GitHubリポジトリで以下の環境を作成：
- `production` (保護設定推奨)

### 2. Vercel設定
- 本番環境: `master`ブランチ
- プレビュー環境: `develop`ブランチ

### 3. Firebase設定
- 本番環境: デフォルトプロジェクト
- 開発環境: `develop`チャンネル

## デプロイフロー

### 開発環境 (develop)
1. PR作成時: プレビューデプロイ + コード品質チェック
2. マージ時: 開発環境に自動デプロイ

### 本番環境 (master)
1. PR作成時: コード品質チェック
2. マージ時: 本番環境に自動デプロイ + Slack通知

## ワークフロー詳細

### deploy-develop.yml
- トリガー: `develop`ブランチへのpush/PR
- 処理: Lint → Build → Firebase/Vercel Preview Deploy

### deploy-production.yml  
- トリガー: `master`ブランチへのpush
- 処理: Lint → Build → Firebase Functions/Hosting + Vercel Production Deploy

### pr-checks.yml
- トリガー: 全てのPR
- 処理: コード品質チェック + プレビューデプロイ + バンドルサイズ分析

## 使用方法

### 新機能開発
```bash
git checkout develop
git pull origin develop
git checkout -b feature/new-feature

# 開発作業...

git add .
git commit -m "feat: 新機能を追加"
git push origin feature/new-feature

# develop へのPR作成
```

### 本番リリース
```bash
# developで動作確認済み後
git checkout master
git pull origin master
git checkout -b release/v1.0.0

# 必要に応じてバージョン更新など

git add .
git commit -m "release: v1.0.0"
git push origin release/v1.0.0

# master へのPR作成
```

## トラブルシューティング

### デプロイ失敗時
1. GitHub Actions のログを確認
2. 環境変数・シークレットの設定確認
3. Vercel/Firebase の設定確認

### 権限エラー
- Firebase Service Accountの権限確認
- Vercel Tokenの有効期限確認

## 監視とメンテナンス

- GitHub Actions の実行ログ監視
- デプロイ時間の監視
- 失敗率の監視
- 定期的なシークレット更新