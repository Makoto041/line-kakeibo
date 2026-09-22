# GitHub Workflows

## 概要

このディレクトリには、line-kakeibo プロジェクトの CI/CD・自動テスト・デプロイの GitHub Actions ワークフローが含まれています。

## ワークフロー一覧

### 🚀 デプロイ

#### `deploy-production.yml`
**本番環境デプロイ**（手動専用）

- `workflow_dispatch` のみ。**push では走らない**（#147 で二重デプロイ防止のため変更）
- 通常の本番反映は `ci-cd.yml` の `deploy-bot` が担当

#### `deploy-develop.yml`
**開発環境デプロイ**

- `develop` ブランチ向け。現在は使われていない（最終実行 2025-10）

#### `vercel-deploy.yml`
**Vercelデプロイ**

- Vercel専用デプロイワークフロー
- プレビュー環境の管理

#### `preview.yml`
**PRプレビュー環境**

- PR作成時にプレビュー環境を自動デプロイ
- コメントにプレビューURLを投稿

### ✅ テスト & チェック

#### `ci-cd.yml`
**CI/CDパイプライン**

- TypeScript型チェック
- ESLint
- ユニットテスト
- ビルド検証

#### `pr-checks.yml`
**PR品質チェック**

- コードフォーマット
- 依存関係の脆弱性スキャン
- ビルドサイズチェック

#### `code-review.yml`
**静的コード解析**

- ESLint詳細レポート
- 複雑度分析

## セットアップ

### 必要な環境変数

リポジトリの Secrets:

```bash
# Vercel用
VERCEL_TOKEN=xxx...
VERCEL_ORG_ID=team_xxx...
VERCEL_PROJECT_ID=prj_xxx...
```

`production-bot` environment の Secrets:

```bash
# Firebase デプロイ用のサービスアカウント鍵（JSON）
GCP_SA_KEY={"type":"service_account",...}
```

旧構成の `FIREBASE_TOKEN`（`firebase login:ci`）は非推奨で、現在どのワークフローも使っていません。
`FIREBASE_PROJECT_ID` は任意で、未設定なら `line-kakeibo-0410` にフォールバックします。

### ローカル検証

```bash
# bot のビルドとスモークテスト
npm -w bot test

# Firestore ルールのテスト（52ケース / JDK 21 が必要）
npx firebase emulators:exec --only firestore --project demo-kakeibo \
  "node test/firestore.rules.test.mjs"
```

## トラブルシューティング

### ワークフローが実行されない

- `.github/workflows/*.yml` の構文を確認
- GitHub Actions の権限設定を確認
- Secretsが正しく設定されているか確認

### 実行が失敗する

```bash
# ログ確認
gh run view <run-id> --log

# 再実行
gh run rerun <run-id>
```

### デプロイエラー

- Firebase/Vercelの認証情報を確認
- ビルドログを確認
- 依存関係のバージョンを確認

## ベストプラクティス

### ワークフローの命名

- 明確で分かりやすい名前
- 目的が一目で分かる

### シークレット管理

- 定期的なローテーション
- 最小権限の原則
- 環境ごとに分離

### エラーハンドリング

```yaml
- name: Deploy
  continue-on-error: true  # エラーでも続行

- name: Notify on failure
  if: failure()  # 失敗時のみ実行
```

## 参考リンク

- [GitHub Actions Documentation](https://docs.github.com/actions)
- [Vercel CLI Documentation](https://vercel.com/docs/cli)
- [Firebase CLI Documentation](https://firebase.google.com/docs/cli)

## ライセンス

このプロジェクトのライセンスに従います。

---

<sub>Last updated: 2026-08-30</sub>
