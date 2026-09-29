/**
 * LINE webhook の Express app（関数 `webhook` の本体）
 *
 * 本文サイズ制限 → 署名検証 → イベントの振り分け。/health とエラーハンドラもここに置く。
 */

import express, { Express, Request, Response } from "express";
import { middleware, SignatureValidationFailed, JSONParseError } from "@line/bot-sdk";
import { isGeminiAvailable } from "../geminiCategoryClassifier";
import { errorMessage } from "../logSafe";
import { getLineClient, replyText } from "./client";
import { handleJoin, handleLeave, handleMemberJoined, handleMemberLeft } from "./groupEvents";
import { handlePostback } from "./postback";
import { handleTextMessage } from "./textMessage";

export const webhookApp: Express = express();

// ============================================
// LINE Webhook: 本文サイズ制限 → 署名検証
// ============================================

// 画像OCRは廃止済みで、Webhook のイベントJSONは数KB程度。10MB は過大だったため 1MB に絞る。
const WEBHOOK_BODY_LIMIT = "1mb";
const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * 本文サイズの上限チェック（署名の HMAC 計算より前に弾く）
 *
 * Cloud Functions では関数フレームワークが先に本文を読み、req.rawBody に入れている。
 * その場合 express.raw() は何もしないため、rawBody の長さでここで判定する。
 */
const limitWebhookBody = (req: Request, res: Response, next: express.NextFunction) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const size = Buffer.isBuffer(rawBody)
    ? rawBody.length
    : Number(req.headers["content-length"] || 0);
  if (size > WEBHOOK_BODY_LIMIT_BYTES) {
    console.warn(`Rejected webhook request: body too large (${size} bytes)`);
    return res.status(413).end();
  }
  return next();
};

/**
 * LINE 署名検証（fail-closed）
 *
 * デプロイ時の関数解析では Secret が注入されないため、モジュール読み込み時に
 * middleware() を作ると "no channel secret" で落ちる。そこでリクエスト時に生成する。
 * 実行時に LINE_CHANNEL_SECRET が無ければ、署名を検証できないので必ず拒否する。
 */
let lineSignatureMiddleware: ReturnType<typeof middleware> | null = null;
let lineSignatureSecret: string | null = null;

const verifyLineSignature = (req: Request, res: Response, next: express.NextFunction) => {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelSecret) {
    console.error("LINE_CHANNEL_SECRET is not configured; rejecting webhook request (fail-closed)");
    return res.status(503).end();
  }
  if (!lineSignatureMiddleware || lineSignatureSecret !== channelSecret) {
    lineSignatureMiddleware = middleware({ channelSecret });
    lineSignatureSecret = channelSecret;
  }
  return lineSignatureMiddleware(req, res, next);
};

// /webhook だけ生の本文（Buffer）で受ける。JSON のパースは署名検証の後に
// LINE SDK の middleware が行う。ローカル実行（rawBody が無い環境）でも
// ここで読んだ Buffer がそのまま署名検証に使われる。
webhookApp.use(
  "/webhook",
  limitWebhookBody,
  express.raw({ type: "*/*", limit: WEBHOOK_BODY_LIMIT }),
  verifyLineSignature
);

// Webhook endpoint
webhookApp.post("/webhook", async (req: Request, res: Response) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    console.log("Received webhook events:", events.length);

    // Process events sequentially to avoid reply token issues and resource conflicts
    for (const event of events) {
      try {

        if (event.type === "message" && event.message.type === "image") {
          // レシートOCR機能は廃止済み（replyMessageは無料）
          try {
            await replyText(event.replyToken, "画像からの読み取り機能は終了しました。\nテキストで入力してください。\n例:「500 ランチ」「6/29 4800 家賃」");
          } catch (replyError) {
            console.warn("Failed to send OCR discontinued notice:", replyError);
          }
        } else if (event.type === "message" && event.message.type === "text") {
          // テキストメッセージの処理
          // 注: handleTextMessage内でreplyMessage（無料）を使用するため、ここでは送信しない
          // エラー時のユーザー通知もhandleTextMessage内で行う（エラーpushの重複を防ぐ）
          //
          // 重要: 必ず await する。2nd-gen関数(Cloud Run)は HTTP 応答(res.end)後に
          // インスタンスのCPUが凍結されるため、fire-and-forgetだと返信前に処理が止まり、
          // 解凍時には replyToken が失効して返信が届かない。await して応答前に返信を送る。
          await handleTextMessage(event).catch(error => {
            console.error("Text processing error:", error);
          });
        } else if (event.type === "postback") {
          // Postbackイベント処理
          await handlePostback(event).catch(error => {
            console.error("Postback processing error:", error);
          });
        } else if (event.type === "join") {
          await handleJoin(event);
        } else if (event.type === "memberJoined") {
          await handleMemberJoined(event);
        } else if (event.type === "memberLeft") {
          await handleMemberLeft(event);
        } else if (event.type === "leave") {
          handleLeave(event);
        } else {
          console.log("Unhandled event type:", event.type);
        }

      } catch (error) {
        console.error("Event processing error:", error);

        // Send error response to LINE if possible and reply token is available
        if (
          event.replyToken &&
          (error as Error).message !== "Invalid reply token"
        ) {
          try {
            await replyText(event.replyToken, "申し訳ございませんが、一時的なエラーが発生しました。しばらく後でお試しください。");
          } catch (replyError) {
            console.error("Failed to send error reply:", replyError);
          }
        }
      }
    }

    // Send 200 response after processing all events
    res.status(200).end();
  } catch (error) {
    console.error("Webhook handler error", error);
    res.status(500).end();
  }
});

webhookApp.get("/health", async (_req: Request, res: Response) => {
  try {
    // 認証情報（LINE_CHANNEL_TOKEN / LINE_CHANNEL_SECRET）が無ければ
    // "LINE credentials not configured" を投げる
    const client = getLineClient();

    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "2.0.0",
      services: {
        lineClient: !!client,
        credentials: !!process.env.LINE_CHANNEL_TOKEN,
        geminiApi: isGeminiAvailable(),
      },
    });
  } catch (error) {
    console.error("Health check failed:", error);
    res.status(500).json({
      status: "unhealthy",
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

// 注: 以前ここにあった認証なしの /classification-stats と /test-classification
// （誰でも Gemini を呼べるデバッグ用エンドポイント）は削除した。

// Webhook app のエラーハンドラ（スタックトレースを返さない）
webhookApp.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  if (err instanceof SignatureValidationFailed) {
    console.warn("LINE webhook signature validation failed");
    return res.status(401).end();
  }
  if (err instanceof JSONParseError) {
    console.warn("LINE webhook body is not valid JSON");
    return res.status(400).end();
  }
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  if (status === 413) {
    console.warn("Rejected webhook request: body too large");
    return res.status(413).end();
  }
  console.error("Unhandled webhook app error:", errorMessage(err));
  return res.status(500).end();
});
