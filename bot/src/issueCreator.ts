import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';

// Gemini APIクライアントの初期化
let genAI: GoogleGenerativeAI | null = null;

function getGeminiClient(): GoogleGenerativeAI | null {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('GEMINI_API_KEY not found in environment variables');
      return null;
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

export type RequirementType = '機能要件' | '非機能要件';

export interface FeedbackAnalysis {
  title: string;
  type: RequirementType;
  summary: string;
  details: string;
  acceptanceCriteria: string[];
}

export interface IssueCreationResult {
  success: boolean;
  issueUrl?: string;
  issueNumber?: number;
  title?: string;
  type?: RequirementType;
  message: string;
}

const GITHUB_REPO = 'Makoto041/line-kakeibo';

/**
 * Gemini APIでユーザーフィードバックを分析してIssue情報を生成する
 */
export async function analyzeFeedbackWithGemini(
  feedbackText: string
): Promise<FeedbackAnalysis | null> {
  try {
    const client = getGeminiClient();
    if (!client) {
      console.warn('Gemini client not available, using fallback analysis');
      return null;
    }

    const model = client.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `あなたはソフトウェア開発プロジェクトの要件アナリストです。LINE家計簿botのユーザーから寄せられた以下のフィードバック（要望・改善・不具合報告）を分析し、GitHub Issueとして起票するための情報をJSON形式で出力してください。

## 要件分類の定義
- 機能要件: 新機能の追加や既存機能の変更・修正に関する要望（例: 新しいコマンドの追加、集計機能の追加、不具合の修正）
- 非機能要件: パフォーマンス、UI/UX、信頼性、セキュリティ、運用・保守性などの品質に関する改善（例: 応答速度の改善、表示の見やすさ、エラー時の安定性）

## ユーザーのフィードバック
"${feedbackText}"

## 出力形式
必ずJSON形式のみで回答してください（他の説明文やMarkdown装飾は不要）:
{
  "title": "Issueのタイトル（50文字以内、内容が一目でわかる簡潔な日本語）",
  "type": "機能要件" または "非機能要件",
  "summary": "フィードバック内容の要約（1-2文）",
  "details": "要望の背景・詳細・想定される実装内容などの説明（複数文可）",
  "acceptanceCriteria": ["受け入れ条件1", "受け入れ条件2", "..."]
}

重要: typeは必ず「機能要件」または「非機能要件」のどちらかにしてください。acceptanceCriteriaは2〜5個の具体的な条件にしてください。`;

    // Gemini APIを呼び出し（タイムアウト付き）
    const geminiPromise = model.generateContent(prompt);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Gemini API timeout')), 15000)
    );

    const result = (await Promise.race([geminiPromise, timeoutPromise])) as any;
    const response = result.response;
    const text = response.text().trim();

    console.log(`Gemini Feedback Analysis - Input: "${feedbackText}", Response: ${text}`);

    // JSONレスポンスをパース（Markdownコードブロック形式の場合も対応）
    let jsonText = text;
    if (text.startsWith('```json') && text.endsWith('```')) {
      jsonText = text.replace(/^```json\s*\n/, '').replace(/\n\s*```$/, '').trim();
    } else if (text.startsWith('```') && text.endsWith('```')) {
      jsonText = text.replace(/^```\s*\n/, '').replace(/\n\s*```$/, '').trim();
    }

    const parsed = JSON.parse(jsonText);

    const type: RequirementType =
      parsed.type === '非機能要件' ? '非機能要件' : '機能要件';

    return {
      title: String(parsed.title || feedbackText.slice(0, 50)),
      type,
      summary: String(parsed.summary || feedbackText),
      details: String(parsed.details || feedbackText),
      acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria)
        ? parsed.acceptanceCriteria.map((c: unknown) => String(c))
        : [],
    };
  } catch (error) {
    console.error('Gemini feedback analysis error:', error);
    return null;
  }
}

/**
 * フィードバックテキストからフォールバックの分析結果を生成する
 * （Gemini APIが利用できない場合や解析に失敗した場合）
 */
function buildFallbackAnalysis(feedbackText: string): FeedbackAnalysis {
  return {
    title: feedbackText.length > 50 ? `${feedbackText.slice(0, 47)}...` : feedbackText,
    type: '機能要件',
    summary: feedbackText,
    details: feedbackText,
    acceptanceCriteria: ['ユーザーのフィードバック内容が解決されていること'],
  };
}

/**
 * Issue本文をMarkdown形式で構築する
 */
function buildIssueBody(analysis: FeedbackAnalysis, originalText: string): string {
  const criteriaList =
    analysis.acceptanceCriteria.length > 0
      ? analysis.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')
      : '- [ ] ユーザーのフィードバック内容が解決されていること';

  return [
    '## 概要',
    analysis.summary,
    '',
    '## 要件分類',
    analysis.type,
    '',
    '## 詳細',
    analysis.details,
    '',
    '### 元のフィードバック',
    `> ${originalText}`,
    '',
    '## 受け入れ条件',
    criteriaList,
    '',
    '---',
    '_このIssueはLINEユーザーからのフィードバックを元に自動起票されました（LINEユーザーからの自動起票）_',
  ].join('\n');
}

/**
 * ユーザーフィードバックからGitHub Issueを作成する
 */
export async function createIssueFromFeedback(
  feedbackText: string
): Promise<IssueCreationResult> {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    console.warn('GITHUB_TOKEN not found in environment variables');
    return {
      success: false,
      message:
        'GitHub連携が設定されていないため、Issueを作成できませんでした。\nフィードバックありがとうございます！内容は開発者に共有されるよう設定を確認します。',
    };
  }

  // Geminiでフィードバックを分析（失敗時はフォールバック）
  const analysis =
    (await analyzeFeedbackWithGemini(feedbackText)) ||
    buildFallbackAnalysis(feedbackText);

  try {
    const response = await axios.post(
      `https://api.github.com/repos/${GITHUB_REPO}/issues`,
      {
        title: analysis.title,
        body: buildIssueBody(analysis, feedbackText),
        labels: ['user-feedback', analysis.type],
      },
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        timeout: 15000,
      }
    );

    const issueUrl: string = response.data.html_url;
    const issueNumber: number = response.data.number;
    console.log(`GitHub Issue created: #${issueNumber} ${issueUrl}`);

    return {
      success: true,
      issueUrl,
      issueNumber,
      title: analysis.title,
      type: analysis.type,
      message: `✅ Issueを作成しました！\n${analysis.title}\n${analysis.type}\n${issueUrl}`,
    };
  } catch (error) {
    console.error('GitHub Issue creation error:', error);
    if (axios.isAxiosError(error)) {
      console.error('GitHub API response:', error.response?.status, error.response?.data);
    }
    return {
      success: false,
      title: analysis.title,
      type: analysis.type,
      message:
        '❌ Issueの作成に失敗しました。\n時間をおいてもう一度お試しください。',
    };
  }
}
