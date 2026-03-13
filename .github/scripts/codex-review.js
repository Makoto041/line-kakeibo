import OpenAI from "openai";
import { Octokit } from "@octokit/rest";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const prNumber = process.env.PR_NUMBER;

// 1️⃣ 差分を取得
const { data: diff } = await octokit.pulls.get({
  owner,
  repo,
  pull_number: prNumber,
  mediaType: { format: "diff" },
});

// 2️⃣ OpenAI(GPT-4o-mini)にレビュー依頼
const completion = await openai.chat.completions.create({
  model: "gpt-4o-mini", // コスト効率の良いモデル
  messages: [
    {
      role: "system",
      content: "あなたは厳格なシニアエンジニアで、Pull Requestのコードレビューを担当しています。バグ、セキュリティ、パフォーマンス、可読性の観点から詳細に分析してください。",
    },
    {
      role: "user",
      content: `以下のGitHub PR差分をレビューして、改善点を指摘してください。重大な問題には🔴、軽微な問題には🟡を付けてください。\n\n${diff}`,
    },
  ],
  temperature: 0.3,
});

// 3️⃣ レビュー内容をコメント投稿
const reviewComment = completion.choices[0].message.content;

await octokit.issues.createComment({
  owner,
  repo,
  issue_number: prNumber,
  body: `🤖 **Codex Review Summary**\n\n${reviewComment}`,
});

// 4️⃣ Issue化のルール（例：TODOや危険ワードを検出）
if (/重大|セキュリティ|バグ|TODO/i.test(reviewComment)) {
  await octokit.issues.create({
    owner,
    repo,
    title: `AI Review: 修正が必要な項目`,
    body: reviewComment,
    labels: ["ai-review", "codex"],
  });
}

console.log("✅ Codex AI Review complete");
