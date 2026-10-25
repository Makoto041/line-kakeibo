import axios from 'axios';
import { generateJson, isGeminiConfigured, ThinkingLevel } from './geminiClient';
import { errorMessage, errorName } from './logSafe';

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
 * フィードバックの本文の上限（文字数。#260）
 *
 * 本文は全文を Gemini のプロンプトに入れ、公開リポジトリの Issue に載せる。長い本文で分類と同じ Gemini の無料枠を
 * 使い切らないよう、超えたら切らずに受け付けない（Gemini も GitHub も呼ばない）。
 */
export const FEEDBACK_MAX_LENGTH = 1000;

/** 本文の文字数（コードポイント単位。絵文字も 1 文字と数える） */
export function feedbackLength(text: string): number {
  return Array.from(text).length;
}

/** 本文が上限を超えたときの返信 */
export const FEEDBACK_TOO_LONG_MESSAGE = `内容が長すぎます。${FEEDBACK_MAX_LENGTH.toLocaleString('ja-JP')} 文字以内で送ってください。`;

/**
 * Gemini APIでユーザーフィードバックを分析してIssue情報を生成する
 */
export async function analyzeFeedbackWithGemini(
  feedbackText: string
): Promise<FeedbackAnalysis | null> {
  if (!isGeminiConfigured()) {
    console.warn('Gemini client not available, using fallback analysis');
    return null;
  }
  try {
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

    // 要約と受け入れ条件の整理は分類より考える量が多いので LOW にする
    const parsed = await generateJson<Record<string, unknown>>(prompt, {
      timeoutMs: 15000,
      thinkingLevel: ThinkingLevel.LOW,
    });
    if (!parsed) return null;

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
    // 例外の文言（JSON.parse の SyntaxError など）には本文や応答の断片が入りうるので、名前だけを出す
    console.error('Gemini feedback analysis error', { errorName: errorName(error) });
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

// ============================================
// 公開 Issue に載せる文字列の無害化（#260）
//
// Issue は公開リポジトリに載る。本文（利用者の入力）と、それを元に Gemini が書いた文（プロンプトで誘導できる）で、
// 他人へのメンション・他の Issue / リポジトリへの参照（相互参照の通知）・HTML コメントでの隠し文・リンク先の偽装を
// 起こさないようにする。
// - 元の本文: 本文中のバッククォートの最長の連続より長いフェンスのコードブロックに入れる（中は解釈されない）
// - Gemini の結果（と、Gemini が使えないときの代わりの文）: HTML コメント・Markdown のリンク先を除き、
//   `@` / `#` / `GH-` / `://` / `www.` の直後にゼロ幅スペースを挟む。HTML タグは正規表現で除かず（除いた跡から新しいタグが
//   できるため。CodeQL js/incomplete-multi-character-sanitization）、1 文字ずつ無効にする: 本文の Markdown では `& < >` を
//   文字参照に（タグは文字として表示される）、タイトルからは `< >` を除く。本文ではバッククォート・チルダ・バックスラッシュを
//   エスケープし（コードブロックを開いて元の本文のフェンスを閉じさせない）、角括弧 `[ ]` もエスケープする（リンク・画像・
//   参照定義の構文を成立させない。リンク先の除去は、入れ子の角括弧や改行をまたぐ形で迂回できるため、エスケープを本線にする）。
//   項目ごとに長さの上限を付ける
// ============================================

/** メンション・参照・自動リンクを切るために挟むゼロ幅スペース */
const ZWSP = '\u200B';

/** Issue のタイトルの上限（文字数） */
export const ISSUE_TITLE_MAX_LENGTH = 80;
const ISSUE_SUMMARY_MAX_LENGTH = 500;
const ISSUE_DETAILS_MAX_LENGTH = 2000;
const ISSUE_CRITERION_MAX_LENGTH = 200;
const ISSUE_CRITERIA_MAX_COUNT = 5;
/** 無害化してタイトルが空になったときのタイトル */
const FALLBACK_ISSUE_TITLE = 'LINE からのフィードバック';

/** max 文字（コードポイント）を超えたら切って「…」を付ける */
function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/**
 * HTML コメント（中の隠し文ごと）・Markdown のリンク先（リンクと画像は表示する文字だけ残す）・参照リンクの定義を取り除く
 *
 * 1 回の置換では、除いた跡から新しいコメントができる（`<!<!---->--` → `<!--`）ので、変わらなくなるまで繰り返す
 * （置換のたびに短くなるので必ず止まる）。HTML タグはここでは扱わず、呼び出し側で `<` `>` を 1 文字ずつ無効にする。
 */
function stripHiddenMarkup(text: string): string {
  let current = text.replace(/\r\n?/g, '\n');
  let previous: string;
  do {
    previous = current;
    current = current.replace(/<!--[\s\S]*?(?:-->|$)/g, ''); // 閉じていないコメントは末尾まで
    current = current.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)?/g, '$1');
    current = current.replace(/^[ \t]*\[[^\]\n]*\]:.*$/gm, '');
  } while (current !== previous);
  return current;
}

/** メンション（@user・@org/team・owner/repo@sha）・Issue の参照（#1・owner/repo#1・GH-1）・自動リンク（https://・www.）を切る */
function neutralizeReferences(text: string): string {
  return text
    .replace(/@(?=[A-Za-z0-9_-])/g, `@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`)
    .replace(/\b(GH)-(?=\d)/gi, `$1-${ZWSP}`)
    .replace(/:\/\//g, `:${ZWSP}//`)
    .replace(/(www)\./gi, `$1${ZWSP}.`); // 前に \b を付けない（`_www.` も GitHub は自動リンクにする）
}

/** Issue のタイトル（1 行。タイトルは HTML として描画されないので文字参照にはせず、`<` `>` を除く） */
export function sanitizeIssueTitle(text: string): string {
  const oneLine = stripHiddenMarkup(text).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return neutralizeReferences(truncateChars(oneLine, ISSUE_TITLE_MAX_LENGTH)) || FALLBACK_ISSUE_TITLE;
}

/**
 * Issue の本文に Markdown として載せる文
 *
 * 角括弧をエスケープするので、リンク・画像・参照定義（入れ子の角括弧・改行をまたぐもの・リスト項目の中のものを含む）は
 * 成立しない（受け入れ条件の `- [ ] ` は、この関数の外で付ける）。
 */
export function sanitizeIssueMarkdown(text: string, maxLength: number, options: { multiline: boolean }): string {
  const stripped = stripHiddenMarkup(text);
  const shaped = options.multiline ? stripped.replace(/\n{3,}/g, '\n\n').trim() : stripped.replace(/\s+/g, ' ').trim();
  const escaped = truncateChars(shaped, maxLength)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[`~\\[\]]/g, (c) => `\\${c}`);
  return neutralizeReferences(escaped);
}

/** 元の本文を、本文中のバッククォートの最長の連続より長いフェンスのコードブロックに入れる */
export function fencedOriginalText(text: string): string {
  const longestRun = Array.from(text.matchAll(/`+/g)).reduce((max, m) => Math.max(max, m[0].length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text.replace(/\r\n?/g, '\n')}\n${fence}`;
}

/** 分析結果（Gemini・代わりの文）を、公開 Issue に載せられる形にする（種別はもともと 2 値に限っている） */
function sanitizeAnalysis(analysis: FeedbackAnalysis): FeedbackAnalysis {
  return {
    title: sanitizeIssueTitle(analysis.title),
    type: analysis.type,
    summary: sanitizeIssueMarkdown(analysis.summary, ISSUE_SUMMARY_MAX_LENGTH, { multiline: true }),
    details: sanitizeIssueMarkdown(analysis.details, ISSUE_DETAILS_MAX_LENGTH, { multiline: true }),
    acceptanceCriteria: analysis.acceptanceCriteria
      .map((c) => sanitizeIssueMarkdown(c, ISSUE_CRITERION_MAX_LENGTH, { multiline: false }))
      .filter((c) => c.length > 0)
      .slice(0, ISSUE_CRITERIA_MAX_COUNT),
  };
}

/**
 * Issue本文をMarkdown形式で構築する（analysis は sanitizeAnalysis 済み。元の本文はコードブロックに入れる）
 */
export function buildIssueBody(analysis: FeedbackAnalysis, originalText: string): string {
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
    fencedOriginalText(originalText),
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
 *
 * 送れる人（世帯のメンバー）と件数の制限は呼び出し側（line/commands/feedback.ts）で行う。
 * 本文の長さはここでも確かめ、上限を超えたら Gemini も GitHub も呼ばない。
 */
export async function createIssueFromFeedback(
  feedbackText: string
): Promise<IssueCreationResult> {
  if (feedbackLength(feedbackText) > FEEDBACK_MAX_LENGTH) {
    return { success: false, message: FEEDBACK_TOO_LONG_MESSAGE };
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    console.warn('GITHUB_TOKEN not found in environment variables');
    return {
      success: false,
      message:
        'GitHub連携が設定されていないため、Issueを作成できませんでした。\nフィードバックありがとうございます！内容は開発者に共有されるよう設定を確認します。',
    };
  }

  // Geminiでフィードバックを分析（失敗時はフォールバック）。どちらも公開 Issue に載せる前に無害化する
  const analysis = sanitizeAnalysis(
    (await analyzeFeedbackWithGemini(feedbackText)) ||
    buildFallbackAnalysis(feedbackText)
  );

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
      message: `Issueを作成しました。\n${analysis.title}\n${analysis.type}\n${issueUrl}`,
    };
  } catch (error) {
    // axios のエラーオブジェクトをそのまま出すと、リクエスト設定（Authorization ヘッダー＝
    // GITHUB_TOKEN）までログに残る。ステータスとメッセージだけを出す。
    if (axios.isAxiosError(error)) {
      console.error('GitHub Issue creation error:', error.response?.status ?? 'no response', error.message);
    } else {
      console.error('GitHub Issue creation error:', errorMessage(error));
    }
    return {
      success: false,
      title: analysis.title,
      type: analysis.type,
      message:
        'Issueの作成に失敗しました。\n時間をおいてもう一度お試しください。',
    };
  }
}
