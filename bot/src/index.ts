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
import { handleGmailPubSub, isStaleGmailEvent, renewWatch } from "./gmail";
import { authRouter } from "./auth/lineAuth";
import { householdRouter, householdErrorHandler } from "./householdApi";
import { postDueRecurringExpenses } from "./recurringExpenses";
import { sendDueSettlementSummaries } from "./settlementSummary";
import { buildSettlementSummaryMessages } from "./line/settlementSummaryMessage";
import { getLineClient } from "./line/client";
import { errorFields } from "./logSafe";

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
    console.error("Firebase initialization error", errorFields(error));
  }
}

// Local development only (not in Cloud Functions)
if (require.main === module) {
  app.listen(port, () => {
    console.log("Bot server listening", { port });
  });
}

// Cloud Functions exports
//
// メモリ: どの関数もこのファイルを読み込み、全関数の依存（特に googleapis）を起動時に読み込む。
// そのため何もしない関数でも cold start の直後に 256MiB の上限を超えることがあった
// （syncUserLinks・gmailPubSubHandler で発生）。全関数を 512MiB にしている。
// 下げる場合は、関数ごとに依存を遅延読み込みするなどしてから cold start 時の使用量を計測する。
export const webhook = onRequest(
  {
    region: "asia-northeast1",
    // 画像OCRは廃止済みだが、上の「メモリ」のとおり 512MiB より下げない。
    memory: "512MiB",
    // 1 回の配信に含まれるイベントは直列に処理して待つ。1 イベントの最悪ケースは
    // プロフィール取得のリトライ（最大 ~30 秒）+ カテゴリ分類（Jev 3 秒 + 失敗時の Gemini 8 秒で打ち切り）
    // + Firestore + 返信で ~45 秒。LINE API 劣化時に数イベントの配信が来ても途中で打ち切られて
    // 残りのイベントが保存されない、ということが無いよう 300 秒の余裕を持たせる
    // （540 秒はハング時の課金を 9 分まで伸ばすだけなので下げる）。
    timeoutSeconds: 300,
    // 悪用・暴走時のスケール上限。cpu を指定していない（1 vCPU 未満）ため
    // 1 インスタンスの同時実行数は 1 で、同時に処理できるリクエストは最大 10。
    maxInstances: 10,
    invoker: "public",
    // GITHUB_TOKEN: LINEフィードバックGitHub Issue自動作成に使用（issueCreator）。
    // TYPESAFE_API_KEY: カテゴリ分類のメイン（Jev）。GEMINI_API_KEY は分類の退避先とフィードバック解析。
    secrets: ["LINE_CHANNEL_TOKEN", "LINE_CHANNEL_SECRET", "TYPESAFE_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN"],
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
    memory: "512MiB",
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
 *
 * 失敗したら Pub/Sub が同じ通知を再送する（`retry: true`。2nd gen は 10〜600 秒の指数バックオフで、最大 24 時間）。
 * 取込は 1 通でも失敗すると historyId を進めずに投げるので（gmail/handler.ts の processNewEmails）、
 * 以前の再送なし（`retry` 未指定 = false）では、次に INBOX へ何か届くまでやり直されなかった。
 * 12 時間より古い通知は処理せずに捨てる（`isStaleGmailEvent`。投げないので再送も止まる）。
 * 取込は保存してある historyId からの全範囲を処理するので、捨てた通知の範囲は次の新しい通知で処理される。
 *
 * 注意: 既存の関数で `retry` を新しく有効にするデプロイは、非対話（CI）では firebase-tools が
 * 「Pass the --force option to deploy functions with a failure policy」で止める。初回だけオーナーが、
 * マージ済みの master の .env の無いクリーンな checkout で `npm ci` → `npm -w bot run build` をしてから、
 * 普通のターミナルで `firebase deploy --only functions:gmailPubSubHandler --project line-kakeibo-0410` を実行し、
 * 確認に yes と答える（エージェントは実行しない。手順は docs/SETUP.md §7）。
 */
export const gmailPubSubHandler = onMessagePublished(
  {
    topic: "gmail-notifications",
    region: "asia-northeast1",
    memory: "512MiB",
    retry: true,
    // 再送のたびに、止まっている historyId からの範囲をまとめてやり直す（1 通あたり分類 最大 ~11 秒 + Firestore + LINE）。
    // 範囲が大きくなっても途中で打ち切られない（打ち切りも失敗として再送される）よう 300 秒にする
    timeoutSeconds: 300,
    maxInstances: 3,
    secrets: [
      "LINE_CHANNEL_TOKEN",
      "LINE_CHANNEL_SECRET",
      "TYPESAFE_API_KEY",
      "GEMINI_API_KEY",
      "GMAIL_CLIENT_ID",
      "GMAIL_CLIENT_SECRET",
    ],
  },
  async (event) => {
    // 古さは Pub/Sub の publishTime（publish したときに Pub/Sub が付け、再送でも変わらない）で測る。
    // CloudEvent の time は Eventarc の文書では「イベントの生成時刻」で、publish 時刻と同じかを確かめられないため使わない。
    // `|| event.time` は防御だけ: firebase-functions（7.4.0）の Message は publishTime を必ず埋める
    // （無ければ受け取った時刻）ので、本番でこの経路は通らない
    if (isStaleGmailEvent(event.data.message.publishTime || event.time, new Date())) {
      console.warn("Gmail Pub/Sub event is older than 12 hours; dropping it (the next notification processes the range)");
      return;
    }
    const data = event.data.message.data;
    await handleGmailPubSub(data);
  }
);

/**
 * Gmail Watch自動更新（6日ごと）
 *
 * 失敗したら Cloud Scheduler が 2 回までやり直す（`retryCount`。ジョブは増えないので、スケジュールの無料枠は変わらない）。
 * やり直しても失敗すると、次の実行は 6 日後で、その前に watch が切れる（docs/GMAIL_AUTO_SPEC.md §11.2）。
 *
 * 失敗は、例外の種類を errorFields でログに出してから、固定文の Error で投げる（firebase-functions は投げた例外の
 * message をログに出すため。Gmail API・Firestore のエラーの文言を残さない。docs/SECURITY_OPERATIONS.md §9）。
 */
export const renewGmailWatch = onSchedule(
  {
    schedule: "0 3 */6 * *", // 6日ごとの午前3時
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 60,
    memory: "512MiB",
    maxInstances: 2,
    retryCount: 2,
    secrets: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"],
  },
  async () => {
    console.log("Renewing Gmail Watch...");
    try {
      await renewWatch();
    } catch (error) {
      console.error("Failed to renew Gmail Watch", errorFields(error));
      throw Object.assign(new Error("Gmail Watch renewal failed"), { name: "GmailWatchRenewalError" });
    }
    console.log("Gmail Watch renewed successfully");
  }
);

/**
 * 毎日のバッチ（固定費の自動計上・期間の精算サマリー）
 *
 * - 毎朝 9:10（JST）に、引き落とし日を迎えた固定費を明細に入れる（recurringExpenses.ts）。
 *   同じ月に 2 回は入らない。LINE への通知は送らない（無料枠の push 数を使わない）。
 * - 期間の起算日（例: 15日起算なら毎月 15 日）には、締まった期間の精算サマリーを LINE グループへ
 *   メンション付きで送る（settlementSummary.ts。同じ期間は 1 回だけ）。
 * Cloud Scheduler の無料枠（3 ジョブ）を使い切っているため、スケジュールは増やさずここにまとめる。
 * 関数名を変えると CI のデプロイが本番関数の削除確認で失敗するため、名前は postRecurringExpenses のまま。
 *
 * 失敗（一覧の読み取りなどの例外・失敗した件数がある）は、固定文の Error で投げる（Cloud Scheduler が 1 回やり直す）。
 * 例外は種類を errorFields で、件数はオブジェクトでログに出す（firebase-functions は投げた例外の message をログに出すため。
 * docs/SECURITY_OPERATIONS.md §9）。
 */
export const postRecurringExpenses = onSchedule(
  {
    // 精算サマリーのメンション通知が早朝に鳴らないよう 9 時台にする（固定費の計上はいつでもよい）
    schedule: "10 9 * * *",
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 1,
    retryCount: 1,
    // 精算サマリーの送信（line/client.ts は両方そろっていないとクライアントを作らない）
    secrets: ["LINE_CHANNEL_TOKEN", "LINE_CHANNEL_SECRET"],
  },
  async () => {
    let summary: Awaited<ReturnType<typeof postDueRecurringExpenses>>;
    let settlement: Awaited<ReturnType<typeof sendDueSettlementSummaries>>;
    try {
      const db = getFirestore();
      summary = await postDueRecurringExpenses(db);
      console.log("Recurring expenses", summary);

      // 固定費の計上に失敗しても、精算サマリーは判定する（どちらも冪等なのでリトライで重複しない）
      settlement = await sendDueSettlementSummaries(db, {
        build: buildSettlementSummaryMessages,
        push: async (to, messages, retryKey) => {
          try {
            await getLineClient().pushMessage({ to, messages }, retryKey);
          } catch (error) {
            // 409: 同じ X-Line-Retry-Key で送信済み（前回の実行で届いている）
            if ((error as { status?: unknown }).status === 409) return;
            throw error;
          }
        },
      });
      console.log("Settlement summaries", settlement);
    } catch (error) {
      // 一覧の読み取り（固定費・精算サマリーの対象）など、1 件ごとの失敗として数えられない例外
      console.error("Daily batch failed", errorFields(error));
      throw Object.assign(new Error("Daily batch failed"), { name: "DailyBatchError" });
    }

    if (summary.failed > 0 || settlement.failed > 0) {
      console.error("Daily batch: some items failed", { recurring: summary.failed, settlementSummary: settlement.failed });
      throw Object.assign(new Error("Daily batch: some items failed"), { name: "DailyBatchError" });
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
// LINE通知を送信するためLINE認証情報、カテゴリ分類のためTYPESAFE_API_KEY（Jev）とGEMINI_API_KEY（退避先）も必要
// LINE_LIFF_CHANNEL_ID は /auth/line の ID トークン検証に使用
export const api = onRequest(
  {
    region: "us-central1",
    // 上の「メモリ」参照（未指定だと既定の 256MiB で、使用率が上限の近くにあった）。
    memory: "512MiB",
    // 管理 API と LIFF ログイン用。cpu 未指定（1 vCPU 未満）のため同時実行は 1/インスタンスで、
    // 同時に処理できるリクエストは最大 5（家計簿の利用規模では十分）。
    maxInstances: 5,
    secrets: ["ADMIN_SECRET", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "LINE_CHANNEL_TOKEN", "LINE_CHANNEL_SECRET", "TYPESAFE_API_KEY", "GEMINI_API_KEY", "LINE_LIFF_CHANNEL_ID"],
  },
  gmailApp
);

export default app;
