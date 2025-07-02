import express, { Express, Request, Response } from "express";
import { Client, middleware } from "@line/bot-sdk";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import dayjs from "dayjs";
import dotenv from "dotenv";
import { onRequest } from "firebase-functions/v2/https";
import { parseReceipt } from "./parser";
import { saveExpense, getExpenses } from "./firestore";
import { parseTextExpense } from "./textParser";
import {
  isLineUserLinked,
  generateLinkToken,
  storeLinkToken,
} from "./userLinks";
import { resolveAppUidForExpense, getAppUidByLineId } from "./linkUserResolver";

dotenv.config();

const app: Express = express();
const port = process.env.PORT || 8080;

// LINE Bot setup
console.log("LINE_CHANNEL_TOKEN loaded:", !!process.env.LINE_CHANNEL_TOKEN);
console.log("LINE_CHANNEL_SECRET loaded:", !!process.env.LINE_CHANNEL_SECRET);

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_TOKEN || "dummy-token-for-build",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "dummy-secret-for-build",
};

let client: Client;
try {
  client = new Client(config);
} catch (error) {
  console.warn(
    "LINE Client initialization failed during build, using dummy client"
  );
  // Create a dummy client for build analysis
  client = {} as Client;
}

// Firebase Admin setup
if (!getApps().length) {
  try {
    // Use Application Default Credentials for Cloud Functions
    initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID || "line-kakeibo-0410",
    });
  } catch (error) {
    console.warn("Firebase initialization error:", error);
  }
}

// Google Cloud Vision setup
let visionClient: ImageAnnotatorClient | null = null;
try {
  // Use Application Default Credentials
  visionClient = new ImageAnnotatorClient();
} catch (error) {
  console.warn("Vision API initialization error:", error);
}

app.use("/webhook", middleware(config));

// Helper function to check if user needs to link account
async function checkAndHandleUnlinkedUser(
  lineUserId: string,
  replyToken: string
): Promise<boolean> {
  try {
    const isLinked = await isLineUserLinked(lineUserId);

    if (!isLinked) {
      // Generate magic link for account linking
      const token = generateLinkToken();
      await storeLinkToken(lineUserId, token);

      const webAppUrl = "https://web-makoto041s-projects.vercel.app";
      const magicLink = `${webAppUrl}/link?lineId=${encodeURIComponent(
        lineUserId
      )}&token=${token}`;

      await client.replyMessage(replyToken, {
        type: "text",
        text: `アカウント連携が必要です！🔗\n\n以下のリンクをクリックしてGoogleアカウントと連携してください：\n\n${magicLink}\n\n連携後、再度メッセージを送信してください。`,
      });

      return false; // User needs to link account
    }

    return true; // User is already linked
  } catch (error) {
    console.error("Error checking user link status:", error);
    return true; // Continue with normal flow on error
  }
}

// Webhook endpoint
app.post("/webhook", async (req: Request, res: Response) => {
  // Immediately send 200 response
  res.status(200).end();

  try {
    const events = req.body.events;

    // Process events asynchronously without blocking response
    setImmediate(async () => {
      for (const event of events) {
        try {
          if (event.type === "message" && event.message.type === "image") {
            await handleImageMessage(event);
          } else if (
            event.type === "message" &&
            event.message.type === "text"
          ) {
            await handleTextMessage(event);
          } else if (event.type === "join") {
            await handleJoin(event);
          } else if (event.type === "memberJoined") {
            await handleMemberJoined(event);
          } else {
            console.log("Unhandled event type:", event.type);
          }
        } catch (error) {
          console.error("Event processing error:", error);
        }
      }
    });
  } catch (error) {
    console.error("Webhook handler error", error);
  }
});

async function handleImageMessage(event: any) {
  try {
    // Check if user needs to link account first
    const isLinked = await checkAndHandleUnlinkedUser(
      event.source.userId,
      event.replyToken
    );
    if (!isLinked) {
      return; // User needs to link account, magic link sent
    }

    const messageId = event.message.id;

    try {
      const stream = await client.getMessageContent(messageId);

      let buffer = Buffer.alloc(0);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      // OCR processing
      if (!visionClient) {
        try {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "OCR機能が利用できません。設定を確認してください。",
          });
        } catch (replyError) {
          console.error("Reply error:", replyError);
        }
        return;
      }

      try {
        const [result] = await visionClient.textDetection({
          image: { content: buffer },
        });

        const detectedText = result.textAnnotations?.[0]?.description || "";

        if (detectedText) {
          // Parse receipt
          const parsedData = parseReceipt(detectedText);

          // 理想設計準拠: appUidを解決または作成
          const appUid = await resolveAppUidForExpense(event.source.userId);
          
          if (!appUid) {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "ユーザー情報の処理でエラーが発生しました。しばらく後でお試しください。",
            });
            return;
          }

          // 理想設計準拠: Expense作成
          const expense = {
            appUid: appUid,
            lineId: event.source.userId,
            amount: parsedData.total,
            description: parsedData.storeName || "レシート",
            date: dayjs().format("YYYY-MM-DD"),
            category: "その他",
            confirmed: false,
            ocrText: detectedText,
            items: parsedData.items,
          };

          try {
            const expenseId = await saveExpense(expense);
            console.log(`Expense saved with ID: ${expenseId} for appUid: ${appUid}`);

            // Reply to user
            const replyText = `レシートを読み込みました！📝\n金額: ¥${parsedData.total.toLocaleString()}\n店舗: ${parsedData.storeName}\n\nWebアプリで確認・編集できます。`;

            await client.replyMessage(event.replyToken, {
              type: "text",
              text: replyText,
            });
          } catch (saveError) {
            console.error("Save expense error:", saveError);
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "データの保存に失敗しました。もう一度お試しください。",
            });
          }
        } else {
          try {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "レシートの文字を読み取れませんでした。別の画像をお試しください。",
            });
          } catch (replyError) {
            console.error("Reply error:", replyError);
          }
        }
      } catch (ocrError) {
        console.error("OCR error:", ocrError);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "OCR処理に失敗しました。画像を確認してもう一度お試しください。",
        });
      }
    } catch (contentError) {
      console.error("Get message content error:", contentError);
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "画像の取得に失敗しました。もう一度お試しください。",
      });
    }
  } catch (error) {
    console.error("Image processing error:", error);
    try {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "エラーが発生しました。もう一度お試しください。",
      });
    } catch (replyError) {
      console.error("Final reply error:", replyError);
    }
  }
}

async function handleTextMessage(event: any) {
  try {
    // Check if user needs to link account first
    const isLinked = await checkAndHandleUnlinkedUser(
      event.source.userId,
      event.replyToken
    );
    if (!isLinked) {
      return; // User needs to link account, magic link sent
    }

    const text = event.message.text.trim();

    // ① レシート一覧コマンド
    if (text === "家計簿") {
      try {
        // 理想設計準拠: appUidベースでexpenses取得
        const appUid = await getAppUidByLineId(event.source.userId);
        if (!appUid) {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "ユーザー情報が見つかりません。アカウント連携を確認してください。",
          });
          return;
        }

        const expenses = await getExpenses(appUid, 10);
        const replyText =
          expenses.length > 0
            ? "📊 最近の支出:\n" +
              expenses
                .map(
                  (e, i) =>
                    `${i + 1}. ${e.description} - ¥${e.amount.toLocaleString()} (${e.date})`
                )
                .join("\n")
            : "📋 まだ支出の登録がありません。\nレシート画像を送信するか「500 ランチ」のようにテキストで入力してください。";

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: replyText,
        });
      } catch (error) {
        console.error("Error fetching expenses:", error);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "データの取得に失敗しました。しばらく後でお試しください。",
        });
      }
      return;
    }

    // ② テキスト登録
    const parsed = parseTextExpense(text);
    if (!parsed) {
      try {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "💡 金額が見つかりませんでした。\n例: 「500 ランチ」「1200 交通費」",
        });
      } catch (error) {
        console.error("Error sending reply:", error);
      }
      return;
    }

    try {
      // 理想設計準拠: appUidを解決または作成
      const appUid = await resolveAppUidForExpense(event.source.userId);
      
      if (!appUid) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "ユーザー情報の処理でエラーが発生しました。しばらく後でお試しください。",
        });
        return;
      }

      // 理想設計準拠: Expense作成
      const expense = {
        appUid: appUid,
        lineId: event.source.userId,
        amount: parsed.amount,
        description: parsed.description,
        date: parsed.date,
        category: "その他",
        confirmed: true, // テキスト入力は確認済みとする
        ocrText: "",
        items: [],
      };

      const expenseId = await saveExpense(expense);
      console.log(`Text expense saved with ID: ${expenseId} for appUid: ${appUid}`);

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `✅ 登録しました！\n${parsed.description} - ¥${parsed.amount.toLocaleString()} (${parsed.date})`,
      });
    } catch (error) {
      console.error("Error saving expense:", error);
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "データの保存に失敗しました。もう一度お試しください。",
      });
    }
  } catch (error) {
    console.error("Text message handling error:", error);
  }
}

async function handleJoin(event: any) {
  try {
    console.log("Bot joined group:", event);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "グループに追加いただきありがとうございます！🎉\nレシート家計簿ボットです。\n\n📸 レシート画像を送信すると自動で支出を記録\n💬 「500 ランチ」のようにテキストでも記録可能\n📊 「家計簿」で最近の支出一覧を表示\n\nお気軽にお使いください！",
    });
  } catch (error) {
    console.error("Join event handling error:", error);
  }
}

async function handleMemberJoined(event: any) {
  try {
    console.log("Member joined event:", event);
    // ボット以外のメンバーが追加された場合の処理
    if (event.joined.members.some((member: any) => member.type === "user")) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "ようこそ！👋\nレシート家計簿ボットをご利用いただけます。\n「家計簿」と送信すると使い方をご確認いただけます。",
      });
    }
  } catch (error) {
    console.error("Member joined event handling error:", error);
  }
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).send("OK");
});

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
    memory: "256MiB",
    timeoutSeconds: 300,
    invoker: "public",
    secrets: ["LINE_CHANNEL_TOKEN", "LINE_CHANNEL_SECRET"],
  },
  app
);

// Export the syncUserLinks function
export { syncUserLinks } from "./syncUserLinks";

export default app;