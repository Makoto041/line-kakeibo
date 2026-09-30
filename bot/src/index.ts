/**
 * Cloud Functions のエントリポイント
 *
 * ここでは初期化と関数の定義（名前・リージョン・Secret・スケジュール）だけを行う。
 * CI は関数名でデプロイするため、export の名前と設定を変えると本番の関数が
 * 作り直し・削除される。処理本体は各モジュールにある:
 *   - line/webhookApp.ts … LINE webhook（関数 webhook）
 *   - gmail/adminRouter.ts / auth/lineAuth.ts / householdApi.ts … 関数 api の /gmail /auth /household
 */
import express from "express";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import dotenv from "dotenv";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onMessagePublished } from "firebase-functions/v2/pubsub";
import { webhookApp } from "./line/webhookApp";
import { gmailRouter } from "./gmail/adminRouter";
import { handleGmailPubSub, renewWatch } from "./gmail";
import { authRouter } from "./auth/lineAuth";
import { householdRouter, householdErrorHandler } from "./householdApi";
// Money Forward Me Import
import { postDueRecurringExpenses } from "./recurringExpenses";

dotenv.config();

const app = webhookApp;
const port = process.env.PORT || 8080;

// Firebase Admin setup
if (!getApps().length) {
  try {
    // Use Application Default Credentials for Cloud Functions
    initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID || "line-kakeibo-0410",
    });
    console.log("Firebase Admin SDK initialized successfully");
  } catch (error) {
    console.error("Firebase initialization error:", error);
  }
}

// Local development only (not in Cloud Functions)
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Bot server listening on port ${port}`);
  });
}

// Cloud Functions exports
export const webhook = onRequest(
  {
    region: "asia-northeast1",
    // 画像OCRは廃止済み。全関数が同じエントリポイントで googleapis 等を読み込むため
    // メモリは据え置き（下げる場合はコールドスタート時の使用量を計測してから）。
    memory: "512MiB",
    // 1 回の配信に含まれるイベントは直列に処理して待つ。1 イベントの最悪ケースは
    // プロフィール取得のリトライ（最大 ~30 秒）+ Gemini 分類（8 秒で打ち切り）+ Firestore
    // + 返信で ~40 秒。LINE API 劣化時に数イベントの配信が来ても途中で打ち切られて
    // 残りのイベントが保存されない、ということが無いよう 300 秒の余裕を持たせる
    // （540 秒はハング時の課金を 9 分まで伸ばすだけなので下げる）。
    timeoutSeconds: 300,
    // 悪用・暴走時のスケール上限。cpu を指定していない（1 vCPU 未満）ため
    // 1 インスタンスの同時実行数は 1 で、同時に処理できるリクエストは最大 10。
    maxInstances: 10,
    invoker: "public",
    // GITHUB_TOKEN: LINEフィードバックGitHub Issue自動作成に使用（issueCreator）。
    secrets: ["LINE_CHANNEL_TOKEN", "LINE_CHANNEL_SECRET", "GEMINI_API_KEY", "GITHUB_TOKEN"],
  },
  app
);

// 何もしないトリガー（syncUserLinks.ts のコメント参照）。export から外すと CI の
// デプロイが本番関数の削除確認で失敗するため残す。
export { syncUserLinks } from "./syncUserLinks";

// 【廃止】MoneyForward CSV 取込。送信先の /api/mf/import がどこにも存在せず、送信先の
// 設定（API_BASE_URL / MFKAKEIBO_TOKEN）も渡していなかったため、一度も機能していなかった。
// 処理は削除し、関数名だけを何もしない関数として残す（export から外すと CI の非対話
// デプロイが本番関数の削除確認で失敗するため）。本番の関数はオーナーが
// `firebase functions:delete importMoneyForward --region asia-northeast1` で削除し、
// その後この export を消す。
export const importMoneyForward = onSchedule(
  {
    schedule: "0 5 * * *",
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 1,
  },
  async () => {
    // 意図的に何もしない（上記コメント参照）。
  }
);

// ============================================
// Gmail自動取得
// ============================================

/**
 * Gmail Pub/Subハンドラー
 * Gmailから新着メール通知を受け取り、カード利用通知を処理
 */
export const gmailPubSubHandler = onMessagePublished(
  {
    topic: "gmail-notifications",
    region: "asia-northeast1",
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 3,
    secrets: [
      "LINE_CHANNEL_TOKEN",
      "LINE_CHANNEL_SECRET",
      "GEMINI_API_KEY",
      "GMAIL_CLIENT_ID",
      "GMAIL_CLIENT_SECRET",
    ],
  },
  async (event) => {
    const data = event.data.message.data;
    await handleGmailPubSub(data);
  }
);

/**
 * Gmail Watch自動更新（6日ごと）
 */
export const renewGmailWatch = onSchedule(
  {
    schedule: "0 3 */6 * *", // 6日ごとの午前3時
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 2,
    secrets: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"],
  },
  async () => {
    console.log("Renewing Gmail Watch...");
    await renewWatch();
    console.log("Gmail Watch renewed successfully");
  }
);

/**
 * 固定費（家賃・光熱費など）の自動計上
 *
 * 毎朝 6:10（JST）に、引き落とし日を迎えた固定費を明細に入れる（recurringExpenses.ts）。
 * 同じ月に 2 回は入らない。LINE への通知は送らない（無料枠の push 数を使わない）。
 */
export const postRecurringExpenses = onSchedule(
  {
    schedule: "10 6 * * *",
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 120,
    memory: "256MiB",
    maxInstances: 1,
    retryCount: 1,
  },
  async () => {
    const summary = await postDueRecurringExpenses(getFirestore());
    console.log("Recurring expenses", summary);
    if (summary.failed > 0) {
      throw new Error(`recurring: ${summary.failed} item(s) failed`);
    }
  }
);

// ============================================
// 管理 API・LIFF ログイン・世帯 API（関数 api）
// ============================================

const gmailApp = express();
gmailApp.use(express.json());
gmailApp.use("/gmail", gmailRouter);
gmailApp.use("/auth", authRouter);
gmailApp.use("/household", householdRouter, householdErrorHandler);

// Gmail API を Firebase Functions としてエクスポート（LINE webhook とは分離）
// LINE通知を送信するためLINE認証情報、カテゴリ分類のためGEMINI_API_KEYも必要
// LINE_LIFF_CHANNEL_ID は /auth/line の ID トークン検証に使用
export const api = onRequest(
  {
    region: "us-central1",
    // 管理 API と LIFF ログイン用。cpu 未指定（1 vCPU 未満）のため同時実行は 1/インスタンスで、
    // 同時に処理できるリクエストは最大 5（家計簿の利用規模では十分）。
    maxInstances: 5,
    secrets: ["ADMIN_SECRET", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "LINE_CHANNEL_TOKEN", "LINE_CHANNEL_SECRET", "GEMINI_API_KEY", "LINE_LIFF_CHANNEL_ID"],
  },
  gmailApp
);

export default app;
