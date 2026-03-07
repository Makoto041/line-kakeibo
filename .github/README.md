# GitHub Workflows & Scripts

## 概要

このディレクトリには、line-kakeiboプロジェクトのCI/CD、自動テスト、AIコードレビューなどのGitHub Actionsワークフローとスクリプトが含まれています。

## ワークフロー一覧

### 🤖 AI & Automation

#### `claude-code-workflow.yml` ⭐ NEW
**Claude Code統合ワークフロー**

- Issueコメント `/claude <task>` でコード生成
- 自動PR作成＋AIレビュー
- 重大な問題を検出してIssue自動作成

[詳細ドキュメント](./docs/AI_REVIEW_GUIDE.md)

#### `ai-review-mcp.yml` ⭐ NEW
**MCP統合AIコードレビュー**

- PR作成時に自動レビュー
- Claude Sonnet 4 による詳細分析
- GitHub MCPでコメント＆Issue作成

#### `codex-review.yml`
**OpenAI Codexレビュー** (旧版)

- OpenAI GPT-4o-miniでレビュー
- 基本的なコード品質チェック

### 🚀 デプロイ

#### `deploy-production.yml`
**本番環境デプロイ**

- `master`ブランチへのマージでトリガー
- Firebase Functions + Vercel Web
- 自動デプロイ＋ヘルスチェック

#### `deploy-develop.yml`
**開発環境デプロイ**

- `develop`ブランチへのマージでトリガー
- 開発環境への自動デプロイ

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

## スクリプト一覧

### `scripts/mcp-review.js` ⭐ NEW

**MCP統合AIレビュースクリプト**

Claude API + GitHub MCPを使用したコードレビュー自動化

**機能:**
- PR差分の取得
- Claude Sonnet 4による詳細分析
- レビューコメントの自動投稿
- 重大な問題のIssue自動作成

**使い方:**
```bash
cd .github/scripts
npm install
ANTHROPIC_API_KEY=sk-xxx \
GITHUB_TOKEN=ghp-xxx \
GITHUB_REPOSITORY=owner/repo \
PR_NUMBER=123 \
node mcp-review.js
```

### `scripts/codex-review.js`

**OpenAI Codexレビュースクリプト** (旧版)

OpenAI APIを使用したコードレビュー

## セットアップ

### 必要な環境変数

GitHub Actions Secrets に以下を設定：

```bash
# Claude Code用
ANTHROPIC_API_KEY=sk-ant-xxx...

# Vercel用
VERCEL_TOKEN=xxx...
VERCEL_ORG_ID=team_xxx...
VERCEL_PROJECT_ID=prj_xxx...

# Firebase用
FIREBASE_TOKEN=xxx...

# OpenAI用 (旧版使用時)
OPENAI_API_KEY=sk-xxx...
```

### ローカルテスト

```bash
# スクリプトのテスト
cd .github/scripts
npm install
npm run review

# ワークフローの構文チェック
act -l  # act (GitHub Actions local runner) が必要
```

## 使用例

### 1. Issueコメントでコード生成

```
Issue #100: ユーザー管理機能の追加

Comment: /claude ユーザープロファイル編集機能を実装して
```

→ Claude Codeが自動的にPR作成

### 2. 手動ワークフロー実行

1. Actions タブ → "Claude Code Full Workflow"
2. "Run workflow" → タスク入力
3. 実行

### 3. 通常のPR作成

PR作成 → 自動でAIレビューが実行

## トラブルシューティング

### ワークフローが実行されない

- `.github/workflows/*.yml` の構文を確認
- GitHub Actions の権限設定を確認
- Secretsが正しく設定されているか確認

### レビューが失敗する

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
- [Claude API Documentation](https://docs.anthropic.com/)
- [MCP Documentation](https://modelcontextprotocol.io/)
- [Vercel CLI Documentation](https://vercel.com/docs/cli)
- [Firebase CLI Documentation](https://firebase.google.com/docs/cli)

## ライセンス

このプロジェクトのライセンスに従います。

---

<sub>Last updated: 2025-10-25 | Maintained by Claude Code</sub>
