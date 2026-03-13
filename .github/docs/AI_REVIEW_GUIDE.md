# AI Code Review & Claude Code 統合ガイド

## 概要

このプロジェクトでは、Claude CodeとMCPを使用した自動コードレビュー＆Issue作成システムを導入しています。

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Actions Workflow                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. [Claude Code] コード生成                                 │
│     ├─ Issue コメント `/claude <task>` でトリガー          │
│     ├─ ワークフロー手動実行でもOK                           │
│     └─ 新しいブランチ＋PRを自動作成                         │
│                                                              │
│  2. [Claude API] AIコードレビュー                           │
│     ├─ PRの差分を取得                                       │
│     ├─ Claude Sonnet 4 でレビュー                           │
│     └─ GitHub MCPでコメント投稿                             │
│                                                              │
│  3. [GitHub MCP] Issue自動作成                              │
│     ├─ 重大な問題を検出                                     │
│     ├─ Issueを自動作成                                      │
│     └─ PRにリンクを追加                                     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## 使い方

### 方法1: Issueコメントでトリガー

任意のIssueで以下のようにコメント：

```
/claude ユーザー認証機能を追加
```

→ Claude Codeが自動的にコードを生成してPRを作成します

### 方法2: ワークフロー手動実行

1. GitHubリポジトリの「Actions」タブに移動
2. 「Claude Code Full Workflow」を選択
3. 「Run workflow」をクリック
4. タスク内容を入力して実行

### 方法3: 通常のPR作成

通常通りPRを作成すると、自動的にAIレビューが実行されます

## レビュー観点

Claude APIによるレビューでは、以下の観点で分析されます：

- 🐛 **バグリスク**: 潜在的なバグや論理エラー
- 🔒 **セキュリティ**: セキュリティ脆弱性や機密情報の漏洩
- 🚀 **パフォーマンス**: 効率の悪いコードやボトルネック
- 📖 **可読性**: コードの可読性や保守性
- ✨ **ベストプラクティス**: TypeScript/React/Node.jsのベストプラクティス

## Issue自動作成

レビュー結果に以下のキーワードが含まれる場合、自動的にIssueが作成されます：

- 🔴 重大な問題
- セキュリティ脆弱性
- Critical issues
- Security vulnerability

作成されるIssueには以下のラベルが自動付与されます：

- `ai-review`
- `critical`
- `needs-attention`

## 必要な環境変数

GitHub Actions Secretsに以下を設定してください：

```bash
ANTHROPIC_API_KEY=sk-ant-xxx...  # Claude API Key
GITHUB_TOKEN=ghp_xxx...          # GitHub Personal Access Token (自動設定済み)
```

### Anthropic API Keyの取得方法

1. https://console.anthropic.com/ にアクセス
2. 「API Keys」から新しいキーを作成
3. GitHubリポジトリの Settings > Secrets and variables > Actions
4. 「New repository secret」で `ANTHROPIC_API_KEY` を追加

## ファイル構成

```
.github/
├── scripts/
│   ├── package.json           # スクリプト用依存関係
│   ├── mcp-review.js          # MCP統合レビュースクリプト
│   └── codex-review.js        # (旧) OpenAI版レビュー
├── workflows/
│   ├── claude-code-workflow.yml  # 統合ワークフロー
│   ├── ai-review-mcp.yml         # PR用AIレビュー
│   └── codex-review.yml          # (旧) OpenAI版
└── docs/
    └── AI_REVIEW_GUIDE.md        # このファイル
```

## 実行例

### Issueコメントからの実行

```
Issue #123: ユーザー管理機能の改善

Comment: /claude ユーザープロファイル編集機能を追加して
```

↓

```
✅ Claude Code has created PR #124
[View Pull Request](https://github.com/owner/repo/pull/124)
```

↓

```
PR #124: [Claude Code] ユーザープロファイル編集機能を追加

🤖 Claude Code Review
...詳細なレビュー内容...

⚠️ 重大な問題が検出されたため、Issue #125 を作成しました
```

## トラブルシューティング

### Claude API エラー

```
Error: ANTHROPIC_API_KEY is not set
```

→ GitHub Secrets に `ANTHROPIC_API_KEY` が設定されているか確認

### レビューが実行されない

- ワークフローファイルの権限設定を確認
- PRが `pull_request` イベントでトリガーされているか確認

### Issue作成が動作しない

- GitHub Token の `issues: write` 権限を確認
- レビュー内容に重大な問題のキーワードが含まれているか確認

## カスタマイズ

### レビュー基準の変更

[`.github/scripts/mcp-review.js`](..scripts/mcp-review.js) の `reviewPrompt` を編集

### Issue作成条件の変更

同じく `mcp-review.js` の `hasCriticalIssues` 正規表現を編集

### 使用モデルの変更

```javascript
model: "claude-sonnet-4-20250514"  // 他のモデルに変更可能
```

## 参考リンク

- [Claude API Documentation](https://docs.anthropic.com/)
- [MCP Documentation](https://modelcontextprotocol.io/)
- [GitHub Actions Documentation](https://docs.github.com/actions)
- [Anthropic Claude Code](https://github.com/anthropics/claude-code)

---

<sub>Last updated: 2025-10-25</sub>
