import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { getAuth } from "firebase-admin/auth";
import { getOrCreateAppUidForLineId } from "../linkUserResolver";
import { applyWebCorsHeaders } from "../webOrigins";

// ============================================
// LIFF ログイン → Firebase カスタムトークン発行
// ============================================
//
// Web(LIFF) から受け取った LINE ID トークンを LINE の verify API で検証し、
// 検証済みの LINE userId(sub) に対応する appUid で Firebase カスタムトークンを発行する。
// これにより Web は「URL の lineId を信用する」旧方式をやめ、
// auth.currentUser.uid = appUid / claims.lineId = 検証済み LINE userId で本人特定できる。
export const authRouter = express.Router();

// CORS: Web オリジンのみ許可（webOrigins.ts。/household と共通）。既定は本番 Vercel と localhost、
// このプロジェクトの Vercel プレビュー。追加/変更は環境変数 WEB_ORIGINS（カンマ区切り）で上書き可能。
const authCors = (req: Request, res: Response, next: express.NextFunction) => {
  if (applyWebCorsHeaders(req, res, { methods: "POST, OPTIONS", allowHeaders: "Content-Type" })) {
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  return next();
};

authRouter.use(authCors);

// 認証系のレート制限（総当り抑止）
const authLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";

/**
 * POST /auth/line
 * Body: { idToken: string }  … LIFF の ID トークン
 * Response: { customToken: string }  … Firebase カスタムトークン
 * 失敗時は 401 { error }。生のトークンは絶対にログ出力しない。
 */
authRouter.post("/line", authLimiter as any, async (req: Request, res: Response) => {
  try {
    const idToken = (req.body && req.body.idToken) as unknown;
    if (!idToken || typeof idToken !== "string") {
      return res.status(400).json({ error: "idToken is required" });
    }

    const channelId = process.env.LINE_LIFF_CHANNEL_ID;
    if (!channelId) {
      console.error("LINE_LIFF_CHANNEL_ID is not configured");
      return res.status(503).json({ error: "Auth is not configured" });
    }

    // LINE で ID トークンを検証（AbortController でタイムアウト）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    let verifyData: {
      iss?: string;
      sub?: string;
      aud?: string | string[];
      exp?: number;
    };
    try {
      const body = new URLSearchParams({
        id_token: idToken,
        client_id: channelId,
      });
      const verifyResponse = await fetch(LINE_VERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
      if (!verifyResponse.ok) {
        console.warn(`LINE ID token verify failed: HTTP ${verifyResponse.status}`);
        return res.status(401).json({ error: "Invalid ID token" });
      }
      verifyData = (await verifyResponse.json()) as typeof verifyData;
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === "AbortError") {
        console.warn("LINE ID token verify timed out (5s)");
      } else {
        console.warn("LINE ID token verify request error");
      }
      return res.status(401).json({ error: "Invalid ID token" });
    } finally {
      clearTimeout(timeoutId);
    }

    // クレーム検証: aud=channelId / iss=LINE / exp 未経過 / sub 必須
    const nowSec = Math.floor(Date.now() / 1000);
    const audOk = Array.isArray(verifyData.aud)
      ? verifyData.aud.includes(channelId)
      : verifyData.aud === channelId;
    if (
      !audOk ||
      verifyData.iss !== "https://access.line.me" ||
      typeof verifyData.exp !== "number" ||
      verifyData.exp < nowSec ||
      !verifyData.sub
    ) {
      console.warn("LINE ID token claim validation failed");
      return res.status(401).json({ error: "Invalid ID token" });
    }

    const sub = verifyData.sub;
    const appUid = await getOrCreateAppUidForLineId(sub);
    if (!appUid) {
      console.error("Failed to resolve appUid for verified LINE user");
      return res.status(500).json({ error: "Failed to resolve user" });
    }

    // uid=appUid, custom claim lineId=検証済み LINE userId でトークン発行
    const customToken = await getAuth().createCustomToken(appUid, { lineId: sub });
    return res.status(200).json({ customToken });
  } catch (error) {
    // 生トークンを含めないよう message のみログ
    console.error("Auth /line error:", (error as Error).message);
    return res.status(401).json({ error: "Authentication failed" });
  }
});
