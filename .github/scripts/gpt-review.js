#!/usr/bin/env node

/**
 * ChatGPT (GPT-4o) Code Review Script
 *
 * このスクリプトは、最新のGPT-4oを使用して:
 * 1. PRの差分を取得
 * 2. 構造化されたコードレビューを実施
 * 3. GitHubにコメント＆Issue作成
 *
 * 環境変数:
 * - OPENAI_API_KEY: OpenAI API Key
 * - GITHUB_TOKEN: GitHub Personal Access Token
 * - GITHUB_REPOSITORY: owner/repo
 * - PR_NUMBER: Pull Request番号
 */

import OpenAI from "openai";
import { Octokit } from "@octokit/rest";

// 環境変数チェック
const requiredEnvVars = ["OPENAI_API_KEY", "GITHUB_TOKEN", "GITHUB_REPOSITORY", "PR_NUMBER"];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Error: ${envVar} is not set`);
    process.exit(1);
  }
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const prNumber = parseInt(process.env.PR_NUMBER, 10);

console.log(`🔍 ChatGPT reviewing PR #${prNumber} in ${owner}/${repo}`);

// ========================================
// Step 1: PRの詳細情報を取得
// ========================================
console.log("📥 Fetching PR details...");

const { data: pr } = await octokit.pulls.get({
  owner,
  repo,
  pull_number: prNumber,
});

const { data: files } = await octokit.pulls.listFiles({
  owner,
  repo,
  pull_number: prNumber,
});

// PRの基本情報
const prInfo = {
  title: pr.title,
  description: pr.body || "No description provided",
  author: pr.user.login,
  branch: `${pr.head.ref} → ${pr.base.ref}`,
  additions: pr.additions,
  deletions: pr.deletions,
  filesChanged: files.length,
};

console.log(`📊 PR Stats: +${prInfo.additions}/-${prInfo.deletions} lines, ${prInfo.filesChanged} files`);

// ファイル差分をテキスト形式で構築
let diffText = `# Pull Request #${prNumber}: ${prInfo.title}\n\n`;
diffText += `**Author**: ${prInfo.author}\n`;
diffText += `**Branch**: ${prInfo.branch}\n`;
diffText += `**Changes**: +${prInfo.additions}/-${prInfo.deletions} lines in ${prInfo.filesChanged} files\n\n`;
diffText += `## Description\n${prInfo.description}\n\n`;
diffText += `## Changed Files\n\n`;

for (const file of files) {
  diffText += `### ${file.filename} (+${file.additions}/-${file.deletions})\n`;
  if (file.patch) {
    diffText += `\`\`\`diff\n${file.patch}\n\`\`\`\n\n`;
  } else {
    diffText += `*Binary file or too large to display*\n\n`;
  }
}

// ========================================
// Step 2: ChatGPT (GPT-4o) でレビュー
// ========================================
console.log("🤖 Analyzing code with ChatGPT (GPT-4o)...");

const systemPrompt = `あなたは経験豊富なシニアソフトウェアエンジニアです。
GitHub Pull Requestのコードレビューを担当しています。

レビューは以下の構造化された形式で行ってください：

## 📊 総合評価
- **品質スコア**: X/10 (理由を簡潔に)
- **マージ推奨度**: ✅推奨 / ⚠️条件付き / ❌非推奨

## 🔍 詳細レビュー

### 🐛 バグリスク
- 発見された問題点を箇条書き
- ファイル名:行数を明記
- 重大度: 🔴高 / 🟡中 / 🟢低

### 🔒 セキュリティ
- セキュリティ上の懸念点
- 機密情報の取り扱い
- 認証・認可の問題

### 🚀 パフォーマンス
- パフォーマンス上の問題
- 非効率なアルゴリズムやクエリ
- メモリ使用の懸念

### 📖 可読性・保守性
- コードの可読性
- 命名規則
- コメント・ドキュメント

### ✨ ベストプラクティス
- TypeScript/JavaScript/React等の規約
- デザインパターンの適用
- テストカバレッジ

## 💡 改善提案
具体的な改善案をコードスニペット付きで提示

## ✅ 良かった点
ポジティブなフィードバックも忘れずに

---
重大な問題がある場合は、最後に「⚠️ CRITICAL ISSUES DETECTED」と記載してください。`;

const userPrompt = `以下のPull Requestを詳細にレビューしてください。
プロジェクトは「line-kakeibo」という家計簿管理アプリで、LINE Bot + TypeScript + React + Firebase を使用しています。

${diffText}`;

const completion = await openai.chat.completions.create({
  model: "gpt-4o", // 最新のGPT-4oを使用
  messages: [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ],
  temperature: 0.3, // より一貫性のある分析のため低めに設定
  max_tokens: 4096,
});

const reviewContent = completion.choices[0].message.content;

console.log("✅ Code review completed");
console.log(`📝 Tokens used: ${completion.usage.total_tokens}`);

// ========================================
// Step 3: PRにレビューコメント投稿
// ========================================
console.log("💬 Posting review comment...");

const commentBody = `## 🤖 ChatGPT Code Review (GPT-4o)

${reviewContent}

---
<details>
<summary>📊 Review Metadata</summary>

- **Model**: ${completion.model}
- **Tokens**: ${completion.usage.total_tokens} (prompt: ${completion.usage.prompt_tokens}, completion: ${completion.usage.completion_tokens})
- **Generated**: ${new Date().toISOString()}
- **Reviewer**: ChatGPT (GPT-4o)

</details>`;

await octokit.issues.createComment({
  owner,
  repo,
  issue_number: prNumber,
  body: commentBody,
});

console.log("✅ Review comment posted");

// ========================================
// Step 4: 重大な問題がある場合はIssue作成
// ========================================
const hasCriticalIssues =
  /⚠️ CRITICAL ISSUES DETECTED|🔴|重大|セキュリティ脆弱性|security vulnerability|critical bug/i.test(
    reviewContent
  );

if (hasCriticalIssues) {
  console.log("🚨 Critical issues detected, creating GitHub Issue...");

  // 重大な問題を抽出
  const criticalLines = reviewContent
    .split("\n")
    .filter((line) => /🔴|重大|critical|security|脆弱性/i.test(line));

  const issueBody = `## 🚨 ChatGPT Code Review で重大な問題が検出されました

PR #${prNumber} のレビュー中に、以下の重大な問題が見つかりました:

### 🔴 検出された問題
${criticalLines.slice(0, 10).join("\n")}

${criticalLines.length > 10 ? `\n...他${criticalLines.length - 10}件` : ""}

---

### 📋 関連情報
- **PR**: #${prNumber} - ${prInfo.title}
- **ブランチ**: ${prInfo.branch}
- **作成者**: @${prInfo.author}
- **変更量**: +${prInfo.additions}/-${prInfo.deletions} lines

### 🔗 完全なレビュー
[PR #${prNumber} のレビューコメントを確認](${pr.html_url})

---

### 🛠️ 推奨アクション
1. レビューコメントの詳細を確認
2. 指摘された問題を修正
3. 修正後、このIssueをクローズ

---
<sub>🤖 Auto-generated by ChatGPT (GPT-4o) | ${new Date().toISOString()}</sub>`;

  const issue = await octokit.issues.create({
    owner,
    repo,
    title: `🚨 [GPT Review] PR #${prNumber}: 重大な問題が検出されました`,
    body: issueBody,
    labels: ["gpt-review", "critical", "needs-attention"],
    assignees: [prInfo.author],
  });

  console.log(`✅ Issue created: #${issue.data.number}`);

  // PRにIssueへのリンクを追加
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `⚠️ **重大な問題が検出されたため、Issue #${issue.data.number} を作成しました。詳細を確認してください。**`,
  });
} else {
  console.log("✅ No critical issues detected");
}

// ========================================
// Step 5: レビューサマリーをコンソール出力
// ========================================
console.log("\n" + "=".repeat(60));
console.log("📊 Review Summary");
console.log("=".repeat(60));
console.log(`PR #${prNumber}: ${prInfo.title}`);
console.log(`Author: ${prInfo.author}`);
console.log(`Files changed: ${prInfo.filesChanged}`);
console.log(`Lines: +${prInfo.additions}/-${prInfo.deletions}`);
console.log(`Critical issues: ${hasCriticalIssues ? "🔴 YES" : "✅ NO"}`);
console.log(`Tokens used: ${completion.usage.total_tokens}`);
console.log("=".repeat(60));
console.log("\n🎉 ChatGPT Code Review complete!");
