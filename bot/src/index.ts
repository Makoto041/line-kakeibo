import express, { Express, Request, Response } from "express";
import { Client, middleware } from "@line/bot-sdk";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import dayjs from "dayjs";
import dotenv from "dotenv";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { parseReceipt } from "./parser";
import {
  saveExpense,
  getExpenses,
  getExpensesSummary,
  createGroup,
  joinGroup,
  getUserGroups,
  getGroupMembers,
  getGroupExpenses,
  findOrCreateLineGroup,
  getGroupByLineGroupId,
  saveUserSettings,
  getUserSettings,
  // 立替機能
  getPendingAdvances,
  getAdvanceSummaryByUser,
  calculateSettlement,
  settleAdvances,
  AdvanceSummary,
} from "./firestore";
import { parseTextExpense } from "./textParser";
import { resolveAppUidForExpense } from "./linkUserResolver";
import { getClassificationStats, classifyExpenseWithGemini, isGeminiAvailable, findCategoryWithGemini } from "./geminiCategoryClassifier";
// Money Forward Me Import
import { importMoneyForward } from "./importMoneyForward";

// 新機能: 画像最適化とOCR精度向上
import {
  optimizeImageForOCR,
  enhanceImageForOCR,
  assessImageQuality,
  getOptimalSettings,
} from "./imageOptimizer";
import {
  enhancedParseReceipt,
  autoClassifyCategory,
  assessOCRConfidence,
} from "./enhancedParser";
import {
  recordCostMetrics,
  ProcessingTimer,
  generateWeeklyReport,
  CostMetrics,
} from "./costMonitor";

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
    console.log("Firebase Admin SDK initialized successfully");
  } catch (error) {
    console.error("Firebase initialization error:", error);
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

// Express JSON middleware for parsing request bodies
app.use(express.json({ limit: '10mb' }));

app.use("/webhook", middleware(config));

// No longer needed - LINE ID only authentication

// Webhook endpoint
app.post("/webhook", async (req: Request, res: Response) => {
  try {
    const events = req.body.events;
    console.log("Received webhook events:", events.length);

    // Process events sequentially to avoid reply token issues and resource conflicts
    for (const event of events) {
      try {
        console.log("Processing event:", event.type);

        if (event.type === "message" && event.message.type === "image") {
          // 即座に受信確認レスポンス
          const targetId = event.source.type === "group" ? event.source.groupId : event.source.userId;
          await client.pushMessage(targetId, {
            type: "text",
            text: "📸 画像を受信しました！処理中です...",
          });
          
          // バックグラウンドで処理実行（ノンブロッキング）
          handleImageMessage(event).catch(error => {
            console.error("Image processing error:", error);
            // エラー時もユーザーに通知
            client.pushMessage(targetId, {
              type: "text",
              text: "❌ 画像処理中にエラーが発生しました。もう一度お試しください。",
            }).catch(console.error);
          });
        } else if (event.type === "message" && event.message.type === "text") {
          // テキスト処理も即座レスポンス
          const targetId = event.source.type === "group" ? event.source.groupId : event.source.userId;
          
          // 金額らしきテキストかチェック
          const hasAmount = /\d+/.test(event.message.text);
          if (hasAmount) {
            await client.pushMessage(targetId, {
              type: "text",
              text: "💬 テキストを受信しました！処理中です...",
            });
          }
          
          // バックグラウンドで処理実行
          handleTextMessage(event).catch(error => {
            console.error("Text processing error:", error);
            if (hasAmount) {
              client.pushMessage(targetId, {
                type: "text",
                text: "❌ テキスト処理中にエラーが発生しました。もう一度お試しください。",
              }).catch(console.error);
            }
          });
        } else if (event.type === "postback") {
          // Postbackイベント処理
          console.log("Processing postback event");
          await handlePostback(event).catch(error => {
            console.error("Postback processing error:", error);
          });
        } else if (event.type === "join") {
          await handleJoin(event);
        } else if (event.type === "memberJoined") {
          await handleMemberJoined(event);
        } else {
          console.log("Unhandled event type:", event.type);
        }

        console.log("Successfully processed event:", event.type);
      } catch (error) {
        console.error("Event processing error:", error);

        // Send error response to LINE if possible and reply token is available
        if (
          event.replyToken &&
          (error as Error).message !== "Invalid reply token"
        ) {
          try {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "申し訳ございませんが、一時的なエラーが発生しました。しばらく後でお試しください。🙏",
            });
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

async function handleImageMessage(event: any) {
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB limit
  const MAX_PROCESSING_TIME = 30000; // 30 seconds

  try {
    // Immediately acknowledge image received
    try {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "画像を受信しました！レシートを解析中です...⏳",
      });
    } catch (replyError) {
      console.error("Failed to send immediate reply for image:", replyError);
    }

    // Process image in background (don't await)
    processImageInBackground(event, MAX_IMAGE_SIZE, MAX_PROCESSING_TIME).catch(
      (error) => {
        console.error("Background image processing failed:", error);

        // Send error notification to the source where message came from
        const targetId =
          event.source.type === "group"
            ? event.source.groupId
            : event.source.userId;
        client
          .pushMessage(targetId, {
            type: "text",
            text: "画像処理でエラーが発生しました。もう一度お試しください。",
          })
          .catch((pushError) =>
            console.error("Failed to send error notification:", pushError)
          );
      }
    );
  } catch (error) {
    console.error("Image message handling error:", error);
  }
}

async function processImageInBackground(
  event: any,
  MAX_IMAGE_SIZE: number,
  MAX_PROCESSING_TIME: number
) {
  // コスト監視用タイマー開始
  const processingTimer = new ProcessingTimer();

  try {
    console.log("Starting background image processing...");

    const messageId = event.message.id;

    try {
      // Get image content with size monitoring
      console.log("Starting image download...");
      const stream = await client.getMessageContent(messageId);
      let buffer = Buffer.alloc(0);
      let totalSize = 0;

      for await (const chunk of stream) {
        totalSize += chunk.length;

        // Check size limit
        if (totalSize > MAX_IMAGE_SIZE) {
          throw new Error(
            `Image too large: ${totalSize} bytes (max: ${MAX_IMAGE_SIZE} bytes)`
          );
        }

        buffer = Buffer.concat([buffer, chunk]);
      }

      console.log(`Image downloaded successfully: ${totalSize} bytes`);

      // 新機能: 画像品質チェック
      const qualityCheck = await assessImageQuality(buffer);
      if (!qualityCheck.isGoodQuality) {
        console.log("Image quality issues detected:", qualityCheck.issues);

        // 品質問題があっても処理は続行するが、ユーザーにフィードバック
        const targetId =
          event.source.type === "group"
            ? event.source.groupId
            : event.source.userId;
        await client.pushMessage(targetId, {
          type: "text",
          text: `📸 画像を受信しましたが、以下の点で改善できます：\n${qualityCheck.recommendations.join(
            "\n"
          )}\n\n処理を続行しています...`,
        });
      }

      // 新機能: 画像最適化パイプライン (コスト削減 60-70%)
      console.log("=== STARTING IMAGE OPTIMIZATION ===");
      const optimizationSettings = getOptimalSettings();
      const optimizedImage = await optimizeImageForOCR(
        buffer,
        optimizationSettings
      );

      console.log(
        `Compression achieved: ${optimizedImage.compressionRatio.toFixed(
          1
        )}% reduction`
      );
      console.log(
        `Original: ${(optimizedImage.originalSize / 1024 / 1024).toFixed(
          2
        )}MB → Optimized: ${(
          optimizedImage.optimizedSize /
          1024 /
          1024
        ).toFixed(2)}MB`
      );

      // 新機能: OCR精度向上のための画像強化
      console.log("=== STARTING IMAGE ENHANCEMENT ===");
      const enhancedBuffer = await enhanceImageForOCR(optimizedImage.buffer);

      // OCR processing
      if (!visionClient) {
        await client.pushMessage(event.source.userId, {
          type: "text",
          text: "OCR機能が利用できません。設定を確認してください。",
        });
        return;
      }

      // 最適化された画像でVision API呼び出し (大幅なコスト削減)
      console.log("Starting optimized OCR processing...");
      const ocrPromise = visionClient.textDetection({
        image: { content: enhancedBuffer }, // 最適化された画像を使用
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("OCR processing timeout")),
          MAX_PROCESSING_TIME
        )
      );

      const [result] = (await Promise.race([
        ocrPromise,
        timeoutPromise,
      ])) as any;

      const detectedText = result.textAnnotations?.[0]?.description || "";

      if (detectedText) {
        // 新機能: 高度なレシート解析エンジンと自動カテゴリー分類
        console.log("=== USING ENHANCED RECEIPT PARSER ===");
        const parsedData = enhancedParseReceipt(detectedText);

        // OCR信頼度評価
        const confidenceResult = assessOCRConfidence(detectedText, parsedData);
        const confidenceScore = confidenceResult.confidence;
        console.log(
          `OCR Confidence Score: ${(confidenceScore * 100).toFixed(1)}%`
        );
        if (confidenceResult.issues.length > 0) {
          console.log("OCR Issues:", confidenceResult.issues);
        }

        // 低信頼度の場合、フォールバック処理
        if (confidenceScore < 0.5) {
          console.log("Low confidence score, using fallback parser");
          const fallbackData = parseReceipt(detectedText);
          // より良い結果を採用
          if (fallbackData.total > parsedData.total) {
            Object.assign(parsedData, fallbackData);
          }
        }

        // Determine group context and user display name
        let activeGroup = null;
        let userDisplayName = null; // Will be set based on context
        let lineGroupId = null;

        // Check if this is from a LINE group
        if (event.source.type === "group") {
          lineGroupId = event.source.groupId;
          console.log(`Group context detected: ${lineGroupId}`);

          // Try multiple methods to get user profile
          try {
            console.log(`=== IMAGE PROFILE DEBUG: Trying to get user profile from LINE group. GroupId: ${lineGroupId}, UserId: ${event.source.userId} ===`);
            
            // Method 1: Try getGroupMemberProfile with retry
            let profile = null;
            let attempt = 0;
            const maxAttempts = 3;
            
            while (attempt < maxAttempts && !profile) {
              attempt++;
              console.log(`Profile fetch attempt ${attempt}/${maxAttempts}`);
              
              try {
                const profilePromise = client.getGroupMemberProfile(
                  lineGroupId,
                  event.source.userId
                );
                const timeout = attempt === 1 ? 3000 : 5000; // Longer timeout for retries
                const timeoutPromise = new Promise((_, reject) =>
                  setTimeout(() => reject(new Error(`Profile timeout (attempt ${attempt})`)), timeout)
                );
                profile = await Promise.race([profilePromise, timeoutPromise]);
                console.log(`Group member profile obtained on attempt ${attempt}:`, profile);
                break;
              } catch (groupProfileError) {
                console.warn(`getGroupMemberProfile failed on attempt ${attempt}:`, groupProfileError);
                
                if (attempt === maxAttempts) {
                  // Method 2: Try regular getProfile as final fallback
                  try {
                    console.log("Trying individual getProfile as final fallback");
                    const individualProfilePromise = client.getProfile(event.source.userId);
                    const timeoutPromise = new Promise((_, reject) =>
                      setTimeout(() => reject(new Error("Individual profile timeout")), 5000)
                    );
                    profile = await Promise.race([individualProfilePromise, timeoutPromise]);
                    console.log("Individual profile obtained as final fallback:", profile);
                  } catch (individualProfileError) {
                    console.warn("getProfile also failed:", individualProfileError);
                  }
                } else {
                  // Wait before retry
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }
              }
            }

            if (profile && (profile as any).displayName) {
              userDisplayName = (profile as any).displayName;
              console.log(`User display name set to: ${userDisplayName}`);
            } else {
              // グループでプロファイル取得に失敗した場合はエラーとして処理
              console.error(`GROUP PROFILE ERROR: Failed to get user profile for group member ${event.source.userId}`);
              const targetId = event.source.groupId;
              await client.pushMessage(targetId, {
                type: "text",
                text: "⚠️ ユーザー情報の取得に失敗しました。\n\nしばらく待ってから再度お試しください。\n\n問題が継続する場合は、LINEアプリを再起動してください。"
              });
              return; // 処理を中断
            }

            // Find or create group for this LINE group
            const groupId = await findOrCreateLineGroup(
              lineGroupId,
              event.source.userId,
              userDisplayName
            );
            const groups = await getUserGroups(event.source.userId);
            activeGroup = groups.find((g) => g.id === groupId);
            console.log("Successfully set up LINE group context");
          } catch (error) {
            console.error("Failed to get any user profile:", error);
            
            // グループでプロファイル取得に失敗した場合はエラーとして処理
            const targetId = event.source.groupId;
            await client.pushMessage(targetId, {
              type: "text",
              text: "⚠️ ユーザー情報の取得に失敗しました。\n\nしばらく待ってから再度お試しください。\n\n問題が継続する場合は、LINEアプリを再起動してください。"
            });
            return; // 処理を中断
          }
        } else {
          // Individual chat
          console.log("Individual chat context detected");

          // Try to get profile with retry logic
          let profile = null;
          let attempt = 0;
          const maxAttempts = 3;

          while (attempt < maxAttempts && !profile) {
            attempt++;
            console.log(`=== IMAGE PROFILE DEBUG: Individual profile attempt ${attempt}/${maxAttempts}. UserId: ${event.source.userId} ===`);

            try {
              const timeout = attempt === 1 ? 3000 : 5000; // Longer timeout for retries
              const profilePromise = client.getProfile(event.source.userId);
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Profile timeout (attempt ${attempt})`)), timeout)
              );

              profile = (await Promise.race([
                profilePromise,
                timeoutPromise,
              ])) as any;

              if (profile && (profile as any).displayName) {
                userDisplayName = (profile as any).displayName;
                console.log(`Individual user display name: ${userDisplayName} (attempt ${attempt})`);
                break;
              }
            } catch (profileError) {
              console.warn(`Individual profile fetch failed on attempt ${attempt}:`, profileError);

              if (attempt < maxAttempts) {
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
          }

          // プロファイル取得に完全に失敗した場合はエラーとして処理
          if (!profile || !(profile as any).displayName) {
            console.error(`INDIVIDUAL PROFILE ERROR: Failed to get user profile after ${maxAttempts} attempts for ${event.source.userId}`);
            const targetId = event.source.userId;
            await client.pushMessage(targetId, {
              type: "text",
              text: "⚠️ ユーザー情報の取得に失敗しました。\n\nしばらく待ってから再度お試しください。\n\n問題が継続する場合は、LINEアプリを再起動してください。"
            });
            return; // 処理を中断（データは書き込まない）
          }

          // Check if user has any groups
          const userGroups = await getUserGroups(event.source.userId);
          activeGroup = userGroups.length > 0 ? userGroups[0] : null;
        }

        // Resolve appUid for this lineId
        console.log(
          `=== APPUID DEBUG: Resolving appUid for lineId: ${event.source.userId} ===`
        );
        let appUid = null;
        try {
          appUid = await resolveAppUidForExpense(event.source.userId);
          console.log(`=== APPUID DEBUG: Resolved appUid: ${appUid} ===`);
        } catch (appUidError) {
          console.error("Failed to resolve appUid:", appUidError);
          // フォールバックとしてlineIdを使用
          appUid = event.source.userId;
          console.log(`=== APPUID DEBUG: Using lineId as fallback appUid: ${appUid} ===`);
        }
        
        if (!appUid) {
          console.error("Failed to resolve appUid for expense creation, using lineId");
          appUid = event.source.userId;
        }

        // userDisplayNameのチェックは既にリトライ処理内で行っているため、ここでは不要
        console.log(`=== IMAGE FINAL USER DEBUG: Final userDisplayName: ${userDisplayName} ===`);

        // Get category using AI classification
        let defaultCategory = "その他";
        try {
          console.log(
            `=== CATEGORY DEBUG RECEIPT: Getting category for receipt ===`
          );

          // レシート画像の場合、商品名と店舗名からカテゴリーをAIで推測
          const itemsText = parsedData.items.map((i) => i.name).join(", ");
          const descriptionForAI = itemsText || parsedData.storeName || "レシート";

          console.log(`=== GEMINI CATEGORY: Classifying "${descriptionForAI}" ===`);

          // Gemini + ユーザーデフォルトを並列取得
          const [geminiResult, userSettingsResult] = await Promise.allSettled([
            classifyExpenseWithGemini(event.source.userId, descriptionForAI),
            getUserSettings(event.source.userId)
          ]);

          // Gemini結果を優先使用（閾値0.4で精度向上）
          if (geminiResult.status === 'fulfilled') {
            const result = geminiResult.value;
            if (result && result.category && result.confidence >= 0.4) {
              defaultCategory = result.category;
              console.log(
                `=== GEMINI CATEGORY SUCCESS: ${defaultCategory} (confidence: ${result.confidence}) ===`
              );
            }
          }

          // Geminiが失敗またはlow confidenceの場合、ユーザーデフォルトまたはルールベースを使用
          if (defaultCategory === "その他") {
            if (userSettingsResult.status === 'fulfilled') {
              const userSettings = userSettingsResult.value;
              if (userSettings?.defaultCategory) {
                defaultCategory = userSettings.defaultCategory;
                console.log(
                  `=== CATEGORY DEBUG RECEIPT: Using user default category: ${defaultCategory} ===`
                );
              } else {
                // フォールバック: ルールベース分類
                const autoCategory = autoClassifyCategory(
                  itemsText,
                  parsedData.storeName
                );
                if (autoCategory !== "その他") {
                  defaultCategory = autoCategory;
                  console.log(
                    `=== AUTO CATEGORY: Classified as ${autoCategory} based on rules ===`
                  );
                }
              }
            }
          }
        } catch (error) {
          console.log(
            "=== CATEGORY DEBUG RECEIPT: Failed to classify category, using default:",
            error
          );
        }

        // Create expense object
        const expense = {
          lineId: event.source.userId,
          appUid: appUid,
          groupId: activeGroup?.id,
          lineGroupId,
          userDisplayName,
          amount: parsedData.total,
          description: parsedData.storeName || "レシート",
          date: dayjs().format("YYYY-MM-DD"),
          category: defaultCategory,
          confirmed: false,
          payerId: event.source.userId, // デフォルトは入力者
          payerDisplayName: userDisplayName,
          ocrText: detectedText,
          items: parsedData.items,
        };

        // Save expense
        console.log(`=== SAVING EXPENSE WITH APPUID: ${expense.appUid} ===`);
        const expenseId = await saveExpense(expense);
        console.log(
          `Expense saved with ID: ${expenseId} for lineId: ${event.source.userId}, appUid: ${expense.appUid}`
        );

        // Send final result to the source where message came from
        const targetId =
          event.source.type === "group"
            ? event.source.groupId
            : event.source.userId;
        const isGroupContext = event.source.type === "group";

        // Generate appropriate URL based on context
        let webAppUrl;
        if (isGroupContext && lineGroupId) {
          // For group context, include lineGroupId parameter
          webAppUrl = `https://line-kakeibo.vercel.app?lineId=${encodeURIComponent(
            event.source.userId
          )}&lineGroupId=${encodeURIComponent(lineGroupId)}`;
        } else {
          // For personal context, only include lineId
          webAppUrl = `https://line-kakeibo.vercel.app?lineId=${encodeURIComponent(
            event.source.userId
          )}`;
        }

        const contextText = isGroupContext
          ? "👥 グループの家計簿に追加されました"
          : "個人の家計簿に追加されました";
        const replyText = `✅ レシート登録完了！📝\n金額: ¥${parsedData.total.toLocaleString()}\n店舗: ${
          parsedData.storeName
        }\n\n${contextText}\n\nWebアプリで確認・編集：\n${webAppUrl}`;

        await client.pushMessage(targetId, {
          type: "text",
          text: replyText,
        });

        // 新機能: コストメトリクスの記録
        const costMetrics: CostMetrics = {
          timestamp: new Date(),
          visionApiCalls: 1,
          processingTimeMs: processingTimer.elapsed(),
          imageSizeKB: totalSize / 1024,
          optimizedSizeKB: optimizedImage.optimizedSize / 1024,
          compressionRatio: optimizedImage.compressionRatio,
          ocrSuccess: true,
          confidenceScore: confidenceScore,
        };
        recordCostMetrics(costMetrics);
        console.log(
          `=== COST METRICS RECORDED: Processing time ${processingTimer.elapsed()}ms, Saved ${optimizedImage.compressionRatio.toFixed(
            1
          )}% ===`
        );
      } else {
        const targetId =
          event.source.type === "group"
            ? event.source.groupId
            : event.source.userId;
        await client.pushMessage(targetId, {
          type: "text",
          text: "レシートの文字を読み取れませんでした。別の画像をお試しください。",
        });

        // 失敗時のメトリクス記録
        const costMetrics: CostMetrics = {
          timestamp: new Date(),
          visionApiCalls: 1,
          processingTimeMs: processingTimer.elapsed(),
          imageSizeKB: totalSize / 1024,
          optimizedSizeKB: optimizedImage.optimizedSize / 1024,
          compressionRatio: optimizedImage.compressionRatio,
          ocrSuccess: false,
          confidenceScore: 0,
          errorType: "no_text_detected",
        };
        recordCostMetrics(costMetrics);
      }
    } catch (error) {
      console.error("Background image processing error:", error);
      throw error; // Re-throw to trigger error notification
    }
  } catch (error) {
    console.error("Background image processing error:", error);
    throw error; // Re-throw to trigger error notification
  }
}

async function handleTextMessage(event: any) {
  try {
    const text = event.message.text.trim();
    console.log(
      `=== TEXT MESSAGE DEBUG: Received text: "${text}" from user: ${event.source.userId} ===`
    );

    // ① レシート一覧コマンド
    console.log(
      `=== COMMAND CHECK: Checking if text equals "家計簿": ${
        text === "家計簿"
      } ===`
    );
    if (text === "家計簿") {
      console.log(`=== COMMAND MATCHED: Processing 家計簿 command ===`);
      try {
        // Get expenses data quickly with timeout using optimized function
        const expensesPromise = getExpensesSummary(event.source.userId, 3); // Only 3 items for maximum speed
        const timeoutPromise = new Promise(
          (_, reject) =>
            setTimeout(() => reject(new Error("Expenses fetch timeout")), 5000) // Increased timeout for better reliability
        );

        const expenses = (await Promise.race([
          expensesPromise,
          timeoutPromise,
        ])) as any;

        const isGroupContext = event.source.type === "group";

        // Generate appropriate URL based on context
        let webAppUrl;
        if (isGroupContext && event.source.groupId) {
          // For group context, include lineGroupId parameter
          webAppUrl = `https://line-kakeibo.vercel.app?lineId=${encodeURIComponent(
            event.source.userId
          )}&lineGroupId=${encodeURIComponent(event.source.groupId)}`;
        } else {
          // For personal context, only include lineId
          webAppUrl = `https://line-kakeibo.vercel.app?lineId=${encodeURIComponent(
            event.source.userId
          )}`;
        }

        const contextText = isGroupContext
          ? "👥 グループの家計簿"
          : "個人の家計簿";

        let replyText: string;
        if (expenses.length > 0) {
          // Calculate total for quick summary
          const total = expenses.reduce(
            (sum: number, e: any) => sum + (e.amount || 0),
            0
          );

          replyText =
            `📊 ${contextText}の最近の支出:\n` +
            expenses
              .map(
                (e: any, i: number) =>
                  `${i + 1}. ${e.description} - ¥${e.amount.toLocaleString()}`
              )
              .join("\n") +
            `\n\n💰 合計: ¥${total.toLocaleString()}\n\n${
              isGroupContext
                ? "👥 グループメンバーの全支出を確認できます"
                : "個人の全支出を確認できます"
            }\nWebアプリ：\n${webAppUrl}`;
        } else {
          replyText = `📋 ${contextText}にまだ支出がありません\n\n💡 使い方:\n• レシート画像を送信\n• 「500 ランチ」のようにテキスト入力\n\n${
            isGroupContext
              ? "👥 グループメンバーの支出が自動で集計されます"
              : "個人の家計簿を管理できます"
          }\nWebアプリ：\n${webAppUrl}`;
        }

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: replyText,
        });
      } catch (error) {
        console.error("Error fetching expenses:", error);

        // Fallback response
        try {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text:
              `📊 家計簿\n\n現在データを読み込み中です...\n${
                event.source.type === "group"
                  ? "👥 グループ全体の支出が確認できます"
                  : "個人の支出が確認できます"
              }\nWebアプリで詳細を確認してください：\nhttps://line-kakeibo.vercel.app?lineId=` +
              encodeURIComponent(event.source.userId) +
              (event.source.type === "group" && event.source.groupId
                ? `&lineGroupId=${encodeURIComponent(event.source.groupId)}`
                : ""),
          });
        } catch (replyError) {
          console.error("Failed to send fallback reply:", replyError);
        }
      }
      return;
    }

    // ② カテゴリー設定・表示コマンド
    const isCategoryCommand =
      text === "カテゴリー" ||
      text.startsWith("カテゴリー ") ||
      text.startsWith("カテゴリー　");
    console.log(
      `=== COMMAND CHECK: Checking category command - exact: ${
        text === "カテゴリー"
      }, half-space: ${text.startsWith(
        "カテゴリー "
      )}, full-space: ${text.startsWith(
        "カテゴリー　"
      )}, result: ${isCategoryCommand} ===`
    );
    if (isCategoryCommand) {
      console.log(
        `=== CATEGORY COMMAND MATCHED: Processing category command ===`
      );

      // カテゴリー一覧表示
      if (text === "カテゴリー") {
        console.log(`=== CATEGORY LIST: Showing available categories ===`);
        const validCategories = [
          "食費",
          "日用品",
          "交通費",
          "医療費",
          "娯楽費",
          "衣服費",
          "教育費",
          "通信費",
          "その他",
        ];

        // 現在のデフォルトカテゴリーを取得
        let currentCategory = "未設定";
        try {
          const userSettings = await getUserSettings(event.source.userId);
          if (userSettings?.defaultCategory) {
            currentCategory = userSettings.defaultCategory;
          }
        } catch (error) {
          console.log("Failed to get current category setting:", error);
        }

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `📋 利用可能なカテゴリー:\n\n${validCategories
            .map((c) => "• " + c)
            .join(
              "\n"
            )}\n\n🔧 現在のデフォルト: ${currentCategory}\n\n💡 設定方法:\n「カテゴリー 食費」のように送信してください`,
        });
        return;
      }

      // カテゴリー設定
      let category = "";
      if (text.startsWith("カテゴリー ")) {
        category = text.replace("カテゴリー ", "").trim();
      } else if (text.startsWith("カテゴリー　")) {
        category = text.replace("カテゴリー　", "").trim();
      }
      console.log(
        `=== CATEGORY COMMAND: Extracted category: "${category}" ===`
      );
      if (!category) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "💡 カテゴリー名を指定してください。\n例: 「カテゴリー 食費」\n\n利用可能なカテゴリー:\n• 食費\n• 日用品\n• 交通費\n• 医療費\n• 娯楽費\n• 衣服費\n• 教育費\n• 通信費\n• その他",
        });
        return;
      }

      const validCategories = [
        "食費",
        "日用品",
        "交通費",
        "医療費",
        "娯楽費",
        "衣服費",
        "教育費",
        "通信費",
        "その他",
      ];

      if (!validCategories.includes(category)) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `❌ 「${category}」は有効なカテゴリーではありません。\n\n利用可能なカテゴリー:\n${validCategories
            .map((c) => "• " + c)
            .join("\n")}`,
        });
        return;
      }

      try {
        console.log(
          `=== CATEGORY DEBUG: Setting default category for user ${event.source.userId} to ${category} ===`
        );
        await saveUserSettings(event.source.userId, category);
        console.log(
          `=== CATEGORY DEBUG: Successfully saved category ${category} ===`
        );

        // Verify the setting was saved
        const verifySettings = await getUserSettings(event.source.userId);
        console.log(
          `=== CATEGORY DEBUG: Verification - Retrieved settings:`,
          verifySettings
        );

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `✅ デフォルトカテゴリーを「${category}」に設定しました！\n\n今後の支出入力は自動的に「${category}」カテゴリーになります。\n\n変更するには「カテゴリー [新しいカテゴリー]」と送信してください。`,
        });
      } catch (error) {
        console.error("Error saving user settings:", error);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "カテゴリーの設定に失敗しました。もう一度お試しください。",
        });
      }
      return;
    }

    // ③ グループ機能コマンド
    console.log(
      `=== COMMAND CHECK: Checking if text starts with "グループ作成 ": ${text.startsWith(
        "グループ作成 "
      )} ===`
    );
    if (text.startsWith("グループ作成 ")) {
      console.log(`=== COMMAND MATCHED: Processing グループ作成 command ===`);
      const groupName = text.replace("グループ作成 ", "").trim();
      if (!groupName) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "💡 グループ名を指定してください。\n例: 「グループ作成 田中夫婦の家計簿」",
        });
        return;
      }

      try {
        const groupId = await createGroup(groupName, event.source.userId);
        const groups = await getUserGroups(event.source.userId);
        const group = groups.find((g) => g.id === groupId);

        const replyText = `✅ グループ「${groupName}」を作成しました！\n\n📋 招待コード: ${group?.inviteCode}\n\n👫 このコードを共有して、パートナーを招待してください。\n\n使い方:\n「参加 ${group?.inviteCode} 表示名」で参加できます。`;

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: replyText,
        });
      } catch (error) {
        console.error("Error creating group:", error);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "グループの作成に失敗しました。もう一度お試しください。",
        });
      }
      return;
    }

    console.log(
      `=== COMMAND CHECK: Checking if text starts with "参加 ": ${text.startsWith(
        "参加 "
      )} ===`
    );
    if (text.startsWith("参加 ")) {
      console.log(`=== COMMAND MATCHED: Processing 参加 command ===`);
      const parts = text.replace("参加 ", "").trim().split(" ");
      if (parts.length < 2) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "💡 招待コードと表示名を指定してください。\n例: 「参加 ABC123 太郎」",
        });
        return;
      }

      const inviteCode = parts[0];
      const displayName = parts.slice(1).join(" ");

      try {
        const groupId = await joinGroup(
          inviteCode,
          event.source.userId,
          displayName
        );

        if (!groupId) {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ 無効な招待コードです。正しいコードを確認してください。",
          });
          return;
        }

        const members = await getGroupMembers(groupId);
        const memberNames = members.map((m) => m.displayName).join("、");

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `✅ グループに参加しました！\n\n👥 メンバー: ${memberNames}\n\n💰 これからの支出は共有され、誰が何を支払ったかが記録されます。`,
        });
      } catch (error) {
        console.error("Error joining group:", error);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "グループへの参加に失敗しました。もう一度お試しください。",
        });
      }
      return;
    }

    console.log(
      `=== COMMAND CHECK: Checking if text equals "グループ一覧": ${
        text === "グループ一覧"
      } ===`
    );
    if (text === "グループ一覧") {
      console.log(`=== COMMAND MATCHED: Processing グループ一覧 command ===`);
      try {
        const groups = await getUserGroups(event.source.userId);

        if (groups.length === 0) {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "📝 まだグループに参加していません。\n\n新しいグループを作成するか、招待コードで参加してください。\n\n• グループ作成 [名前]\n• 参加 [コード] [表示名]",
          });
          return;
        }

        let replyText = "👥 参加中のグループ:\n\n";
        for (const group of groups) {
          const members = await getGroupMembers(group.id!);
          const memberNames = members.map((m) => m.displayName).join("、");
          replyText += `📋 ${group.name}\n`;
          replyText += `👥 メンバー: ${memberNames}\n`;
          replyText += `🔑 招待コード: ${group.inviteCode}\n\n`;
        }

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: replyText,
        });
      } catch (error) {
        console.error("Error getting groups:", error);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "グループ情報の取得に失敗しました。",
        });
      }
      return;
    }

    // ④ 立替一覧コマンド
    if (text === "立替一覧" || text === "立替") {
      console.log(`=== COMMAND MATCHED: Processing 立替一覧 command ===`);
      try {
        // グループコンテキストが必要
        if (event.source.type !== "group") {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "💡 立替一覧はグループ内でのみ利用できます。\n\nLINEグループで「立替一覧」と送信してください。",
          });
          return;
        }

        const lineGroupId = event.source.groupId;
        const summaries = await getAdvanceSummaryByUser(lineGroupId, true);

        if (summaries.length === 0) {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "📝 未精算の立替はありません。\n\n支出登録時に「↩️ 立替」ボタンを押すと、立替として記録できます。",
          });
          return;
        }

        // サマリーを表示
        let replyText = "💰 未精算の立替一覧:\n\n";

        let totalAdvances = 0;
        for (const summary of summaries) {
          replyText += `👤 ${summary.userDisplayName}\n`;
          replyText += `   立替合計: ¥${summary.totalAdvanced.toLocaleString()}\n`;
          // 最近の3件のみ表示
          const recentExpenses = summary.expenses.slice(0, 3);
          for (const expense of recentExpenses) {
            replyText += `   • ${expense.description} ¥${expense.amount.toLocaleString()}\n`;
          }
          if (summary.expenses.length > 3) {
            replyText += `   ...他${summary.expenses.length - 3}件\n`;
          }
          replyText += "\n";
          totalAdvances += summary.totalAdvanced;
        }

        // 精算額を計算（2人の場合）
        if (summaries.length === 2) {
          const settlement = calculateSettlement(summaries);
          if (settlement) {
            replyText += `\n💸 精算額:\n`;
            replyText += `${settlement.fromUserName} → ${settlement.toUserName}\n`;
            replyText += `¥${settlement.amount.toLocaleString()}\n\n`;
            replyText += `「精算」と送信すると精算を完了できます。`;
          } else {
            replyText += `\n✅ 精算不要（差額なし）`;
          }
        }

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: replyText,
        });
      } catch (error) {
        console.error("Error getting advance list:", error);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "立替一覧の取得に失敗しました。",
        });
      }
      return;
    }

    // ⑤ 精算コマンド
    if (text === "精算") {
      console.log(`=== COMMAND MATCHED: Processing 精算 command ===`);
      try {
        // グループコンテキストが必要
        if (event.source.type !== "group") {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "💡 精算はグループ内でのみ利用できます。\n\nLINEグループで「精算」と送信してください。",
          });
          return;
        }

        const lineGroupId = event.source.groupId;
        const pendingAdvances = await getPendingAdvances(lineGroupId, true);

        if (pendingAdvances.length === 0) {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "📝 精算する立替がありません。",
          });
          return;
        }

        const summaries = await getAdvanceSummaryByUser(lineGroupId, true);

        // 精算額を計算
        let settlementText = "";
        if (summaries.length === 2) {
          const settlement = calculateSettlement(summaries);
          if (settlement) {
            settlementText = `\n\n💸 精算内容:\n${settlement.fromUserName} → ${settlement.toUserName}\n¥${settlement.amount.toLocaleString()}`;
          }
        }

        // 立替を精算済みにする（グループ検証付き）
        const expenseIds = pendingAdvances.map((e) => e.id!);
        const settleResult = await settleAdvances(expenseIds, lineGroupId, true);

        if (settleResult.settled === 0) {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "⚠️ 精算処理でエラーが発生しました。対象の立替が見つかりませんでした。",
          });
          return;
        }

        let resultText = `✅ 精算が完了しました！\n\n精算件数: ${settleResult.settled}件${settlementText}`;
        if (settleResult.skipped > 0) {
          resultText += `\n⚠️ ${settleResult.skipped}件はスキップされました`;
        }
        resultText += "\n\n次の立替からまた集計を開始します。";

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: resultText,
        });
      } catch (error) {
        console.error("Error settling advances:", error);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "精算処理に失敗しました。",
        });
      }
      return;
    }

    // ⑥ テキスト登録
    console.log(`=== TEXT PROCESSING: Trying to parse as expense text ===`);
    const parsed = await parseTextExpense(text);
    if (!parsed) {
      console.log(
        `=== TEXT PROCESSING: Failed to parse as expense, sending help message ===`
      );
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "💡 金額が見つかりませんでした。\n例: 「500 ランチ」「1200 交通費」",
      });
      return;
    }

    console.log(`=== TEXT PROCESSING: Successfully parsed expense:`, parsed);

    // 即座に処理中のメッセージを返す（Flex Messageは後で送信）
    // 注: replyTokenは既に「💬 テキストを受信しました！処理中です...」で使用済みの場合あり
    // そのため、ここでは追加のreplyMessageは送信しない

    // Process expense registration in background (don't await)
    processExpenseInBackground(event, parsed).catch((error) => {
      console.error("Background expense processing failed:", error);

      // Send error notification to the source where message came from
      const targetId =
        event.source.type === "group"
          ? event.source.groupId
          : event.source.userId;
      client
        .pushMessage(targetId, {
          type: "text",
          text: "⚠️ 支出の保存で問題が発生しました。データが正しく記録されていない可能性があります。",
        })
        .catch((pushError) =>
          console.error("Failed to send error notification:", pushError)
        );
    });
  } catch (error) {
    console.error("Text message handling error:", error);
  }
}

// ユーザー情報キャッシュ（メモリ内、15分TTL）
const userProfileCache = new Map<string, { profile: any; groups: any[]; timestamp: number }>();
const CACHE_TTL = 15 * 60 * 1000; // 15分

async function processExpenseInBackground(event: any, parsed: any) {
  try {
    console.log("Starting optimized background expense processing...");

    // 並列実行のためのプロミス配列
    const promises: Promise<any>[] = [];
    
    let activeGroup = null;
    let userDisplayName = null; // Will be set based on context
    let lineGroupId = null;
    let appUid = null;

    // Check if this is from a LINE group
    if (event.source.type === "group") {
      lineGroupId = event.source.groupId;
      
      // キャッシュチェック
      const cacheKey = `${event.source.userId}_${lineGroupId}`;
      const cached = userProfileCache.get(cacheKey);
      const now = Date.now();
      
      const hasCachedProfile = cached && (now - cached.timestamp < CACHE_TTL) && cached.profile.displayName;

      if (hasCachedProfile) {
        // キャッシュヒット - 高速化
        console.log("Using cached user profile (fast path)");
        userDisplayName = cached.profile.displayName;
        activeGroup = cached.groups[0] || null;
      }

      if (!hasCachedProfile) {
        // キャッシュミスまたは名前がない場合 - 並列取得
        console.log("Cache miss or invalid cache, fetching user profile (parallel)");

        // プロファイル取得を並列実行（リトライ機能付き）
        console.log(`=== PROFILE DEBUG: Starting profile fetch for group context. LineGroupId: ${lineGroupId}, UserId: ${event.source.userId} ===`);
        promises.push(
          (async () => {
            let profile = null;
            let attempt = 0;
            const maxAttempts = 2; // テキスト処理は高速性を優先して2回まで
            
            while (attempt < maxAttempts && !profile) {
              attempt++;
              console.log(`=== PROFILE DEBUG: Group profile attempt ${attempt}/${maxAttempts} ===`);
              
              try {
                const timeout = attempt === 1 ? 5000 : 8000; // Increased timeout for better reliability
                profile = await Promise.race([
                  client.getGroupMemberProfile(lineGroupId, event.source.userId),
                  new Promise((_, reject) => setTimeout(() => reject(new Error(`Group profile timeout (attempt ${attempt})`)), timeout))
                ]);
                console.log(`=== PROFILE DEBUG: getGroupMemberProfile SUCCESS on attempt ${attempt}:`, profile);
                break;
              } catch (groupError) {
                console.warn(`=== PROFILE DEBUG: getGroupMemberProfile FAILED on attempt ${attempt}:`, groupError);
                
                if (attempt === maxAttempts) {
                  // Final fallback: try individual getProfile
                  try {
                    console.log(`=== PROFILE DEBUG: Attempting final fallback getProfile ===`);
                    profile = await Promise.race([
                      client.getProfile(event.source.userId),
                      new Promise((_, reject) => setTimeout(() => reject(new Error("Individual profile timeout")), 6000)) // Increased timeout
                    ]);
                    console.log(`=== PROFILE DEBUG: getProfile SUCCESS:`, profile);
                  } catch (individualError) {
                    console.warn(`=== PROFILE DEBUG: getProfile ALSO FAILED:`, individualError);
                    // グループの場合はフォールバック名を返さないでエラーにする
                    return { type: 'profile', error: individualError, data: null };
                  }
                } else {
                  await new Promise(resolve => setTimeout(resolve, 500)); // Short wait between retries
                }
              }
            }
            
            return { type: 'profile', data: profile };
          })()
        );
        
        // グループ取得は後で（プロファイル取得後に実行）
        // promises.pushはせずに、プロファイル取得が完了した後に実行
      }
    } else {
      // Individual chat - キャッシュまたは並列取得
      const cacheKey = event.source.userId;
      const cached = userProfileCache.get(cacheKey);
      const now = Date.now();
      
      if (cached && (now - cached.timestamp < CACHE_TTL)) {
        console.log("Using cached individual user data (fast path)");
        activeGroup = cached.groups[0] || null;
        userDisplayName = cached.profile?.displayName;
        console.log(`=== CACHED PROFILE DEBUG: Using cached displayName: ${userDisplayName} ===`);
      } else {
        // 個人チャットの場合もプロファイルを取得（リトライ機能付き）
        console.log(`=== PROFILE DEBUG: Starting profile fetch for individual context. UserId: ${event.source.userId} ===`);
        promises.push(
          (async () => {
            let profile = null;
            let attempt = 0;
            const maxAttempts = 3; // 個人チャットでもリトライ

            while (attempt < maxAttempts && !profile) {
              attempt++;
              console.log(`=== PROFILE DEBUG: Individual profile attempt ${attempt}/${maxAttempts} ===`);

              try {
                const timeout = attempt === 1 ? 6000 : 10000; // Increased timeout for better reliability
                profile = await Promise.race([
                  client.getProfile(event.source.userId),
                  new Promise((_, reject) => setTimeout(() => reject(new Error(`Profile timeout (attempt ${attempt})`)), timeout))
                ]);
                console.log(`=== PROFILE DEBUG: Individual getProfile SUCCESS on attempt ${attempt}:`, profile);
                return { type: 'profile', data: profile };
              } catch (error) {
                console.warn(`=== PROFILE DEBUG: Individual getProfile FAILED on attempt ${attempt}:`, error);

                if (attempt < maxAttempts) {
                  // リトライ前に短い待機
                  await new Promise(resolve => setTimeout(resolve, 500));
                }
              }
            }

            // すべてのリトライが失敗した場合のみフォールバック
            const fallbackName = `User_${event.source.userId.slice(-6)}`;
            console.warn(`=== PROFILE DEBUG: All retry attempts failed for individual chat, using fallback: ${fallbackName} ===`);
            return { type: 'profile', error: new Error('All retries failed'), data: { displayName: fallbackName } };
          })()
        );
        
        promises.push(
          getUserGroups(event.source.userId)
            .then(groups => ({ type: 'groups', data: groups }))
            .catch(error => ({ type: 'groups', error, data: [] }))
        );
      }
    }

    // appUid解決も並列実行
    promises.push(
      resolveAppUidForExpense(event.source.userId)
        .then(uid => ({ type: 'appUid', data: uid }))
        .catch(error => ({ type: 'appUid', error, data: null }))
    );

    // 並列実行で結果を待つ
    let profileFetchError = null;
    if (promises.length > 0) {
      const results = await Promise.allSettled(promises);

      results.forEach(result => {
        if (result.status === 'fulfilled') {
          const { value } = result;
          switch (value.type) {
            case 'profile':
              if (!value.error && value.data && value.data.displayName) {
                userDisplayName = value.data.displayName;
              } else if (value.error) {
                // プロファイル取得エラーを記録
                profileFetchError = value.error;
                // フォールバック名は設定しない（エラーとして処理）
              }
              break;
            case 'groups':
              if (!value.error && value.data.length > 0) {
                activeGroup = value.data[0];
                // グループ情報からの名前は使用しない（LINEプロファイルを優先）
              }
              break;
            case 'appUid':
              if (!value.error) appUid = value.data;
              break;
          }
        }
      });

      // キャッシュ更新
      const cacheKey = event.source.type === "group"
        ? `${event.source.userId}_${lineGroupId}`
        : event.source.userId;

      userProfileCache.set(cacheKey, {
        profile: { displayName: userDisplayName },
        groups: activeGroup ? [activeGroup] : [],
        timestamp: Date.now()
      });
    }

    // グループコンテキストでプロファイル取得後にグループ操作を実行
    if (lineGroupId && userDisplayName && !activeGroup) {
      try {
        const groupId = await findOrCreateLineGroup(lineGroupId, event.source.userId, userDisplayName);
        const groups = await getUserGroups(event.source.userId);
        activeGroup = groups.find((g) => g.id === groupId) || null;
        console.log("Successfully set up LINE group after profile fetch");
      } catch (groupError) {
        console.error("Failed to setup group after profile fetch:", groupError);
      }
    }

    // フォールバック処理
    if (!appUid) {
      console.log("No appUid resolved, using lineId as fallback");
      appUid = event.source.userId;
    }
    
    // ユーザー表示名とプロファイル取得エラーのチェック
    if (!userDisplayName || profileFetchError) {
      // プロファイル取得に失敗した場合は、グループでも個人でもエラーとして処理
      const context = event.source.type === "group" ? "グループ" : "個人チャット";
      console.error(`PROFILE ERROR (${context}): Failed to get user profile for ${event.source.userId}`, profileFetchError);

      const targetId = event.source.type === "group" ? event.source.groupId : event.source.userId;
      await client.pushMessage(targetId, {
        type: "text",
        text: "⚠️ ユーザー情報の取得に失敗しました。\n\nしばらく待ってから再度お試しください。\n\n問題が継続する場合は、LINEアプリを再起動してください。"
      });
      return; // 処理を中断（データは書き込まない）
    }
    
    console.log(`=== FINAL USER DEBUG: Final userDisplayName: ${userDisplayName} ===`);

    // カテゴリ分類を並列実行（Gemini + ユーザーデフォルト）
    const [geminiResult, userSettingsResult] = await Promise.allSettled([
      classifyExpenseWithGemini(event.source.userId, parsed.description),
      getUserSettings(event.source.userId)
    ]);

    let finalCategory = "その他";
    
    // Gemini結果を優先使用（閾値0.4で精度向上）
    if (geminiResult.status === 'fulfilled') {
      const result = geminiResult.value;
      if (result && result.category && result.confidence >= 0.4) {
        finalCategory = result.category;
        console.log(`Fast Gemini classification: ${finalCategory} (confidence: ${result.confidence})`);
      }
    }
    
    // Geminiが失敗またはlow confidenceの場合、ユーザーデフォルトを使用
    if (finalCategory === "その他" && userSettingsResult.status === 'fulfilled') {
      const userSettings = userSettingsResult.value;
      if (userSettings?.defaultCategory) {
        finalCategory = userSettings.defaultCategory;
        console.log(`Using user default category: ${finalCategory}`);
      }
    }

    // Create expense object with payment method
    const expense = {
      lineId: event.source.userId,
      appUid: appUid,
      groupId: activeGroup?.id,
      lineGroupId,
      userDisplayName,
      amount: parsed.amount,
      description: parsed.description,
      date: parsed.date,
      category: finalCategory,
      confirmed: false, // 未確認状態で保存（ボタンで確認）
      payerId: event.source.userId, // デフォルトは入力者
      payerDisplayName: userDisplayName,
      ocrText: "",
      items: [],
      // 新規追加: 入力元と支払い方法
      inputSource: 'line_text' as const,
      paymentMethod: parsed.paymentMethod,
    };

    // Save expense to database
    console.log(`=== SAVING TEXT EXPENSE WITH APPUID: ${expense.appUid} ===`);
    const expenseId = await saveExpense(expense);
    console.log(
      `Text expense saved with ID: ${expenseId} for lineId: ${event.source.userId}, appUid: ${expense.appUid}`
    );

    // Flex Messageで確認通知を送信
    const targetId = event.source.type === "group"
      ? event.source.groupId
      : event.source.userId;

    if (targetId) {
      const getCategoryEmoji = (category: string): string => {
        const emojiMap: Record<string, string> = {
          '食費': '🍽️',
          '日用品': '🛒',
          '交通費': '🚃',
          '医療費': '🏥',
          '娯楽費': '🎮',
          '衣服費': '👕',
          '教育費': '📚',
          '通信費': '📱',
          '光熱費': '💡',
          '住居費': '🏠',
          '保険': '🛡️',
          '税金': '📋',
          '貯蓄': '💰',
          '投資': '📈',
          '美容': '💅',
          'ペット': '🐶',
          '趣味': '🎨',
          '交際費': '🎁',
          'その他': '📦',
        };
        return emojiMap[category] || '📦';
      };

      const textExpenseInfo: TextExpenseInfo = {
        expenseId,
        description: parsed.description,
        amount: parsed.amount,
        category: finalCategory,
        categoryEmoji: getCategoryEmoji(finalCategory),
        date: parsed.date,
        paymentMethod: parsed.paymentMethod !== 'unknown'
          ? getPaymentMethodLabel(parsed.paymentMethod as PaymentMethod)
          : undefined,
        payerName: userDisplayName,
      };

      await sendTextExpenseNotification(targetId, textExpenseInfo);
    }

    console.log("Background expense processing completed successfully");
  } catch (error) {
    console.error("Background expense processing error:", error);
    throw error; // Re-throw to trigger error notification
  }
}

async function handleJoin(event: any) {
  try {
    console.log("Bot joined group:", event);

    const lineGroupId = event.source.groupId;
    if (!lineGroupId) {
      console.warn("No group ID found in join event");
      return;
    }

    // Add delay to ensure group is properly set up
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Send welcome message with error handling
    try {
      await client.pushMessage(lineGroupId, {
        type: "text",
        text: "家計簿ボットがグループに参加しました！🎉\n\n📸 レシート画像を送信すると支出を自動記録\n💬 「500 ランチ」のようにテキストでも記録\n📊 「家計簿」で支出一覧を表示\n\nグループメンバーの支出が自動的に共有されます👥",
      });

      console.log(
        `Bot successfully joined and sent welcome to LINE group: ${lineGroupId}`
      );
    } catch (messageError) {
      console.error("Failed to send welcome message:", messageError);
      // Don't throw error - bot should still remain in group
    }
  } catch (error) {
    console.error("Join event handling error:", error);
    // Don't throw error to prevent bot from appearing broken
  }
}

async function handleMemberJoined(event: any) {
  try {
    console.log("Member joined event:", event);

    const lineGroupId = event.source.groupId;
    if (!lineGroupId) {
      console.warn("No group ID found in member joined event");
      return;
    }

    // ボット以外のメンバーが追加された場合の処理
    if (event.joined?.members?.some((member: any) => member.type === "user")) {
      try {
        // Add small delay to ensure member is properly added
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Use pushMessage instead of replyMessage for better compatibility
        await client.pushMessage(lineGroupId, {
          type: "text",
          text: "新しいメンバーがグループに参加しました！👋\n家計簿ボットで支出を記録・共有できます。\n\n「家計簿」と送信すると使い方を確認できます。",
        });

        console.log(
          `Successfully sent welcome message for new member in group: ${lineGroupId}`
        );
      } catch (messageError) {
        console.error("Failed to send member welcome message:", messageError);
        // Don't throw error - this is not critical
      }
    }
  } catch (error) {
    console.error("Member joined event handling error:", error);
    // Don't throw error to prevent bot from appearing broken
  }
}

app.get("/health", async (_req: Request, res: Response) => {
  try {
    // Check if LINE client is properly initialized
    if (!client || typeof client.getProfile !== "function") {
      throw new Error("LINE client not properly initialized");
    }

    // Check environment variables
    if (!process.env.LINE_CHANNEL_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
      throw new Error("LINE credentials not configured");
    }

    // Check Vision API
    if (!visionClient) {
      console.warn("Vision API client not available");
    }

    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "2.0.0",
      services: {
        lineClient: !!client,
        visionClient: !!visionClient,
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

// Gemini分類統計エンドポイント
app.get("/classification-stats", async (_req: Request, res: Response) => {
  try {
    const stats = getClassificationStats();
    res.status(200).json({
      ...stats,
      geminiAvailable: isGeminiAvailable(),
      successRate: stats.totalAttempts > 0 
        ? Math.round((stats.geminiSuccessCount / stats.totalAttempts) * 100) 
        : 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Classification stats error:", error);
    res.status(500).json({
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Gemini分類テストエンドポイント
app.post("/test-classification", async (req: Request, res: Response) => {
  try {
    const { description, lineId } = req.body;
    
    if (!description) {
      return res.status(400).json({ error: "description is required" });
    }
    
    // テスト用のlineIdを設定（実際のユーザーIDまたはダミー）
    const testLineId = lineId || "test-user-12345";
    
    console.log(`=== CLASSIFICATION TEST: Testing "${description}" ===`);
    
    const result = await classifyExpenseWithGemini(testLineId, description);
    
    res.status(200).json({
      input: description,
      result: {
        category: result.category,
        confidence: result.confidence,
        reasoning: result.reasoning,
      },
      geminiAvailable: isGeminiAvailable(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Classification test error:", error);
    res.status(500).json({
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
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
    memory: "512MiB", // Increased from 256MiB to handle image processing
    timeoutSeconds: 540, // Increased from 300s to 540s (9 minutes max)
    invoker: "public",
    secrets: ["LINE_CHANNEL_TOKEN", "LINE_CHANNEL_SECRET", "GEMINI_API_KEY", "ADMIN_SECRET"],
  },
  app
);

// Export the syncUserLinks function
export { syncUserLinks } from "./syncUserLinks";

exports.importMoneyForward = onSchedule(
  {
    schedule: "0 5 * * *", // 毎朝5時
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  importMoneyForward
);

// ============================================
// Gmail自動取得機能（新規追加）
// ============================================

import { onMessagePublished } from "firebase-functions/v2/pubsub";
import {
  handleGmailPubSub,
  getAuthUrl,
  handleOAuthCallback,
  registerWatch,
  renewWatch,
  getWatchStatus,
  processLatestEmail,
  isGmailAuthConfigured,
} from "./gmail";
import {
  handlePostback,
  isPostbackEvent,
  isGmailPostback,
  isTextExpensePostback,
  sendTextExpenseNotification,
  TextExpenseInfo,
} from "./line";
import { getPaymentMethodLabel, PaymentMethod } from "./textParser";

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
    secrets: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"],
  },
  async () => {
    console.log("Renewing Gmail Watch...");
    await renewWatch();
    console.log("Gmail Watch renewed successfully");
  }
);

/**
 * Admin認証ミドルウェア
 * ADMIN_SECRET環境変数と照合してアクセスを制限
 * ヘッダー (X-Admin-Secret, Authorization: Bearer) またはクエリパラメータ (adminSecret) で認証
 */
const requireAdminAuth = (req: Request, res: Response, next: express.NextFunction) => {
  const adminSecret = process.env.ADMIN_SECRET;

  // ADMIN_SECRETが設定されていない場合はアクセスを拒否
  if (!adminSecret) {
    console.error("ADMIN_SECRET is not configured");
    return res.status(503).json({ error: "Admin API is not configured" });
  }

  // ヘッダーまたはクエリパラメータからシークレットを取得
  const authHeader = req.headers.authorization;
  const xAdminSecret = req.headers["x-admin-secret"] as string | undefined;
  const queryAdminSecret = req.query.adminSecret as string | undefined;

  let providedSecret: string | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    providedSecret = authHeader.substring(7);
  } else if (xAdminSecret) {
    providedSecret = xAdminSecret;
  } else if (queryAdminSecret) {
    providedSecret = queryAdminSecret;
  }

  if (!providedSecret || providedSecret !== adminSecret) {
    console.warn("Unauthorized admin API access attempt");
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

/**
 * Gmail OAuth2認証URL取得エンドポイント
 * 初回セットアップ時に使用
 * stateパラメータを生成してCSRF攻撃を防止
 * Admin認証が必要
 */
app.get("/gmail/auth", requireAdminAuth, async (_req, res) => {
  try {
    const authUrl = await getAuthUrl(); // async - stateを生成・保存
    res.json({
      authUrl,
      note: "This URL is valid for 10 minutes. State parameter provides CSRF protection.",
    });
  } catch (error) {
    console.error("Failed to generate auth URL:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Gmail OAuth2コールバックエンドポイント
 * Admin認証が必要（クエリパラメータ adminSecret で認証）
 *
 * セキュリティ:
 * - Admin認証（クエリパラメータ対応）
 * - stateパラメータを検証（CSRF攻撃防止）
 * - adminVerifiedフラグでAdmin認証済みフローを検証
 */
app.get("/gmail/callback", requireAdminAuth, async (req, res) => {
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
    console.error("OAuth callback failed:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Gmail Watch登録エンドポイント
 * Admin認証が必要
 */
app.post("/gmail/register-watch", requireAdminAuth, async (_req, res) => {
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
    console.error("Failed to register watch:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Gmail Watch状態確認エンドポイント
 * Admin認証が必要
 */
app.get("/gmail/status", requireAdminAuth, async (_req, res) => {
  try {
    const status = await getWatchStatus();
    const isConfigured = await isGmailAuthConfigured();

    res.json({
      oauthConfigured: isConfigured,
      ...status,
    });
  } catch (error) {
    console.error("Failed to get watch status:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * テスト用: 最新のメールを手動で処理
 * Admin認証が必要
 */
app.post("/gmail/process-latest", requireAdminAuth, async (_req, res) => {
  try {
    const result = await processLatestEmail();
    res.json(result);
  } catch (error) {
    console.error("Failed to process latest email:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

export default app;
