/**
 * Gmail 連携の管理 API（関数 `api` の /gmail/*）
 *
 * OAuth のコールバック以外は `Authorization: Bearer <ADMIN_SECRET>` が必要。
 */

import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { isAdminAuthorized } from "../adminAuth";
import { errorFields } from "../logSafe";
import {
  getAuthUrl,
  handleOAuthCallback,
  registerWatch,
  getWatchStatus,
  processLatestEmail,
  isGmailAuthConfigured,
  getGmailClient,
  forceProcessMessage,
  gmailTokenRef,
  gmailStateRef,
  revokeGmailTokenOnGoogle,
} from "./index";
import type { GoogleRevokeResult } from "./index";

/**
 * Admin認証ミドルウェア
 * `Authorization: Bearer <ADMIN_SECRET>` ヘッダーでのみ認証する。
 *
 * クエリパラメータ（?adminSecret=）での受け付けは廃止した。URL はアクセスログや
 * ブラウザ履歴に残り、秘密値が漏れる経路になるため。
 */
const requireAdminAuth = (req: Request, res: Response, next: express.NextFunction) => {
  // 前後の空白・改行は落として比較する（Secret 登録時に末尾改行が混入しても、
  // 改行を載せられないヘッダーで認証できるように）
  const adminSecret = process.env.ADMIN_SECRET?.trim();

  // ADMIN_SECRETが設定されていない場合はアクセスを拒否
  if (!adminSecret) {
    console.error("ADMIN_SECRET is not configured");
    return res.status(503).json({ error: "Admin API is not configured" });
  }

  // 比較は定数時間（adminAuth.ts の secretsMatch）
  if (!isAdminAuthorized(req.headers.authorization, adminSecret)) {
    if (req.query && "adminSecret" in req.query) {
      // 値は出さない。旧手順（クエリ渡し）のままの呼び出しに気付けるようにだけ記録する
      console.warn("Unauthorized admin API access: adminSecret query parameter is no longer accepted");
    } else {
      console.warn("Unauthorized admin API access attempt");
    }
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

// Gmail API 専用の Express Router（セキュリティのため分離）
export const gmailRouter = express.Router();

// Admin API用のrate limiter
const adminApiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Gmail OAuth2認証URL取得エンドポイント
 * 初回セットアップ時に使用
 * stateパラメータを生成してCSRF攻撃を防止
 * Admin認証が必要
 */
gmailRouter.get("/auth", adminApiLimiter as any, requireAdminAuth, async (_req, res) => {
  try {
    const authUrl = await getAuthUrl(); // async - stateを生成・保存
    res.json({
      authUrl,
      note: "This URL is valid for 10 minutes. State parameter provides CSRF protection.",
    });
  } catch (error) {
    console.error("Failed to generate auth URL", errorFields(error));
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Gmail OAuth2コールバックエンドポイント
 * Google からのリダイレクトで呼ばれるため Admin 認証は掛けない。
 *
 * セキュリティ:
 * - stateパラメータを検証（CSRF攻撃防止）
 * - state は Admin 認証済みの /gmail/auth でだけ発行される（adminVerified フラグ）
 */
const gmailCallbackLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

// コールバックはGoogleからリダイレクトされるためAdmin認証不要
// stateパラメータによるCSRF保護で代替（handleOAuthCallback内で検証）
gmailRouter.get("/callback", gmailCallbackLimiter as any, async (req, res) => {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;

    if (!code) {
      return res.status(400).json({ error: "Authorization code required" });
    }

    if (!state) {
      return res.status(400).json({ error: "State parameter required for security validation" });
    }

    await handleOAuthCallback(code, state);
    res.send("Gmail OAuth2 authentication successful! You can close this window.");
  } catch (error) {
    console.error("OAuth callback failed", errorFields(error));
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Gmail Watch登録エンドポイント
 * Admin認証が必要
 */
gmailRouter.post("/register-watch", adminApiLimiter as any, requireAdminAuth, async (_req, res) => {
  try {
    const isConfigured = await isGmailAuthConfigured();
    if (!isConfigured) {
      return res.status(400).json({
        error: "Gmail OAuth2 not configured. Please run /gmail/auth first.",
      });
    }

    const watchState = await registerWatch();
    res.json({
      success: true,
      historyId: watchState.historyId,
      expiresAt: new Date(watchState.watchExpiration).toISOString(),
    });
  } catch (error) {
    console.error("Failed to register watch", errorFields(error));
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Gmail Watch状態確認エンドポイント
 * Admin認証が必要
 */
gmailRouter.get("/status", adminApiLimiter as any, requireAdminAuth, async (_req, res) => {
  try {
    const status = await getWatchStatus();
    const isConfigured = await isGmailAuthConfigured();

    // デバッグ: Firestoreのトークンスコープを確認
    const tokenDoc = await gmailTokenRef().get();
    const tokenData = tokenDoc.exists ? tokenDoc.data() : null;

    res.json({
      oauthConfigured: isConfigured,
      tokenScope: tokenData?.scope || 'unknown',
      ...status,
    });
  } catch (error) {
    console.error("Failed to get watch status", errorFields(error));
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * トークンを強制リフレッシュ（デバッグ用）
 */
gmailRouter.post("/refresh-token", adminApiLimiter as any, requireAdminAuth, async (_req, res) => {
  try {
    const tokenDoc = await gmailTokenRef().get();
    const tokenData = tokenDoc.data();

    if (!tokenData?.refresh_token) {
      return res.status(400).json({ error: "No refresh token found" });
    }

    // 強制的にexpiry_dateを過去にしてリフレッシュをトリガー
    await gmailTokenRef().update({
      expiry_date: 0,
    });

    res.json({ success: true, message: "Token marked as expired. Next API call will refresh it." });
  } catch (error) {
    console.error("Failed to refresh token", errorFields(error));
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Google 側の失効を確かめられなかったときの案内（トークンはもう消えているので、やり直しても Google には送られない） */
const MANUAL_GOOGLE_REVOKE_GUIDE =
  "Google did not confirm the token revocation. Remove this app manually from the Google account: " +
  "Security > Third-party apps & services (https://myaccount.google.com/connections). " +
  "Retrying this request does not revoke it on Google, because the stored token has been deleted.";

/** 応答に載せる Google 側の失効の結果。トークンが保存されていなかった（何も送っていない）ときは googleRevoked: null */
function googleRevokeFields(google: GoogleRevokeResult | null) {
  if (!google) {
    return { googleRevoked: null };
  }
  return {
    googleRevoked: google.revoked,
    googleRevoke: { refreshToken: google.refreshToken, accessToken: google.accessToken },
  };
}

/**
 * トークンを完全に削除して再認証を可能にする
 * 古いスコープでのトークンをクリアする場合・アカウントを切り替える場合・トークンが漏れた場合に使用
 * Admin認証が必要
 *
 * 1. Google 側で失効させる（refresh_token → access_token。auth.ts の revokeGmailTokenOnGoogle）
 * 2. Firestore のトークン（system/gmailToken）を消す（Google 側の失効に失敗しても消す。取込にもう使わせない）
 * 3. watch の状態（system/gmailState）を消す
 *
 * 応答（HTTP の状態）:
 * - 200 success: true … 1〜3 がすべて済んだ。トークンが保存されていなかったときも（googleRevoked: null。Google へは送らない）
 * - 200 success: false・googleRevoked: false … 2・3 は済んだが、Google が失効を受け付けなかった（2xx 以外・タイムアウト・通信の失敗）。
 *   やり直しても Google へは送られない（トークンはもう無い）ので、Google アカウントから手動で外す（message で案内する）
 * - 500 watchStateCleared: false … 3 に失敗した。やり直す（googleRevoked も返す。false なら手動で外す案内も error に入れる）
 */
gmailRouter.delete("/revoke", adminApiLimiter as any, requireAdminAuth, async (_req, res) => {
  let google: GoogleRevokeResult | null | undefined;
  try {
    const tokenDoc = await gmailTokenRef().get();
    google = await revokeGmailTokenOnGoogle(tokenDoc.data());

    // Firestoreからトークンを削除
    await gmailTokenRef().delete();

    // watch の状態（historyId）も消す。watch の登録は保存してある historyId を残すため、
    // 消えていないと、次に認可したアカウントが前のアカウントの位置から取り込もうとする。
    // 失敗は握り潰さず応答で返す（トークンはもう消えているので、同じリクエストをやり直せばよい）
    try {
      await gmailStateRef().delete();
    } catch (stateError) {
      console.warn("Failed to delete Gmail watch state on revoke", {
        errorName: stateError instanceof Error ? stateError.name : typeof stateError,
      });
      return res.status(500).json({
        success: false,
        watchStateCleared: false,
        ...googleRevokeFields(google),
        error:
          "Token deleted, but failed to delete system/gmailState. Retry DELETE /api/gmail/revoke." +
          (google && !google.revoked ? ` ${MANUAL_GOOGLE_REVOKE_GUIDE}` : ""),
      });
    }

    if (google && !google.revoked) {
      return res.json({
        success: false,
        watchStateCleared: true,
        ...googleRevokeFields(google),
        message: `Token deleted from Firestore. ${MANUAL_GOOGLE_REVOKE_GUIDE} Then re-authenticate via /api/gmail/auth`,
      });
    }

    res.json({
      success: true,
      watchStateCleared: true,
      ...googleRevokeFields(google),
      message: google
        ? "Token revoked on Google and deleted. Please re-authenticate via /api/gmail/auth"
        : "No stored token, so nothing was sent to Google. Please re-authenticate via /api/gmail/auth",
    });
  } catch (error) {
    console.error("Failed to revoke token", errorFields(error));
    res.status(500).json({
      error: (error as Error).message,
      ...(google !== undefined ? googleRevokeFields(google) : {}),
    });
  }
});

/**
 * テスト用: 最新のメールを手動で処理
 * Admin認証が必要
 */
gmailRouter.post("/process-latest", adminApiLimiter as any, requireAdminAuth, async (_req, res) => {
  try {
    const result = await processLatestEmail();
    res.json(result);
  } catch (error) {
    console.error("Failed to process latest email", errorFields(error));
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * テスト用: 過去のメールを強制的に再処理（重複チェックをスキップ）
 * Admin認証が必要
 */
gmailRouter.post("/test-process", adminApiLimiter as any, requireAdminAuth, async (_req, res) => {
  try {
    const gmail = await getGmailClient();

    // SMBCカードからのメールを検索
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 5,
      q: 'from:vpass.ne.jp OR from:smbc-card.com',
    });

    const messages = listResponse.data.messages || [];
    if (messages.length === 0) {
      return res.json({ success: false, message: "No SMBC card emails found in inbox" });
    }

    // 最初のメールの内容を取得して表示（処理はしない）
    const msg = messages[0];
    if (!msg.id) {
      return res.json({ success: false, message: "Message ID not found" });
    }

    const messageResponse = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });

    const message = messageResponse.data;
    const rawHeaders = message.payload?.headers || [];
    const headers = rawHeaders
      .filter((h): h is { name: string; value: string } =>
        h.name !== null && h.name !== undefined &&
        h.value !== null && h.value !== undefined
      );

    const from = headers.find((h: { name: string; value: string }) => h.name.toLowerCase() === 'from')?.value || '';
    const subject = headers.find((h: { name: string; value: string }) => h.name.toLowerCase() === 'subject')?.value || '';
    const date = headers.find((h: { name: string; value: string }) => h.name.toLowerCase() === 'date')?.value || '';

    // body抽出（簡易版）
    let body = '';
    if (message.payload?.body?.data) {
      body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    } else if (message.payload?.parts) {
      for (const part of message.payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          body = Buffer.from(part.body.data, 'base64').toString('utf-8');
          break;
        }
      }
    }

    // 機密情報をマスク（カード番号、メールアドレス等）
    const sanitizeBody = (text: string): string => {
      return text
        // カード番号（4桁-4桁-4桁-4桁 または 連続16桁）
        .replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '****-****-****-****')
        // 下4桁以外をマスク（**** 1234 形式）
        .replace(/\b\d{12,15}(\d{4})\b/g, '************$1')
        // メールアドレス
        .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '***@***.***')
        // 電話番号（日本形式）
        .replace(/\b0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{4}\b/g, '***-****-****')
        // 口座番号（7-8桁の数字）
        .replace(/\b\d{7,8}\b/g, '********');
    };

    res.json({
      success: true,
      emailCount: messages.length,
      latestEmail: {
        id: msg.id,
        from,
        subject,
        date,
        bodyPreview: sanitizeBody(body.substring(0, 500)),
      }
    });
  } catch (error) {
    console.error("Failed to test process", errorFields(error));
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * テスト用: 指定したメッセージIDを強制処理（重複チェックをスキップしてLINE通知も送信）
 * Admin認証が必要
 */
gmailRouter.post("/force-process/:messageId", adminApiLimiter as any, requireAdminAuth, async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!messageId) {
      return res.status(400).json({ error: "messageId is required" });
    }
    const result = await forceProcessMessage(messageId as string);
    res.json(result);
  } catch (error) {
    console.error("Failed to force process", errorFields(error));
    res.status(500).json({ error: (error as Error).message });
  }
});
