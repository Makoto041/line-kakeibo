import express, { Express, Request, Response } from "express";
import { Client, middleware } from "@line/bot-sdk";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import dayjs from "dayjs";
import dotenv from "dotenv";
import { onRequest } from "firebase-functions/v2/https";
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
  getUserSettings
} from "./firestore";
import { parseTextExpense } from "./textParser";
import { resolveAppUidForExpense } from './linkUserResolver';

// 新機能: 画像最適化とOCR精度向上
import { 
  optimizeImageForOCR, 
  enhanceImageForOCR, 
  assessImageQuality, 
  getOptimalSettings 
} from './imageOptimizer';
import { 
  enhancedParseReceipt, 
  autoClassifyCategory, 
  assessOCRConfidence 
} from './enhancedParser';
import { 
  recordCostMetrics, 
  ProcessingTimer,
  generateWeeklyReport,
  CostMetrics
} from './costMonitor';
// No longer needed for LINE ID only authentication

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
        
        console.log("Successfully processed event:", event.type);
      } catch (error) {
        console.error("Event processing error:", error);
        
        // Send error response to LINE if possible and reply token is available
        if (event.replyToken && (error as Error).message !== "Invalid reply token") {
          try {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "申し訳ございませんが、一時的なエラーが発生しました。しばらく後でお試しください。🙏"
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
    processImageInBackground(event, MAX_IMAGE_SIZE, MAX_PROCESSING_TIME).catch(error => {
      console.error("Background image processing failed:", error);
      
      // Send error notification to the source where message came from
      const targetId = event.source.type === 'group' ? event.source.groupId : event.source.userId;
      client.pushMessage(targetId, {
        type: "text",
        text: "画像処理でエラーが発生しました。もう一度お試しください。",
      }).catch(pushError => console.error("Failed to send error notification:", pushError));
    });

  } catch (error) {
    console.error("Image message handling error:", error);
  }
}

async function processImageInBackground(event: any, MAX_IMAGE_SIZE: number, MAX_PROCESSING_TIME: number) {
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
          throw new Error(`Image too large: ${totalSize} bytes (max: ${MAX_IMAGE_SIZE} bytes)`);
        }
        
        buffer = Buffer.concat([buffer, chunk]);
      }
      
      console.log(`Image downloaded successfully: ${totalSize} bytes`);

      // 新機能: 画像品質チェック
      const qualityCheck = await assessImageQuality(buffer);
      if (!qualityCheck.isGoodQuality) {
        console.log('Image quality issues detected:', qualityCheck.issues);
        
        // 品質問題があっても処理は続行するが、ユーザーにフィードバック
        const targetId = event.source.type === 'group' ? event.source.groupId : event.source.userId;
        await client.pushMessage(targetId, {
          type: "text",
          text: `📸 画像を受信しましたが、以下の点で改善できます：\n${qualityCheck.recommendations.join('\n')}\n\n処理を続行しています...`,
        });
      }

      // 新機能: 画像最適化パイプライン (コスト削減 60-70%)
      console.log("=== STARTING IMAGE OPTIMIZATION ===");
      const optimizationSettings = getOptimalSettings();
      const optimizedImage = await optimizeImageForOCR(buffer, optimizationSettings);
      
      console.log(`Compression achieved: ${optimizedImage.compressionRatio.toFixed(1)}% reduction`);
      console.log(`Original: ${(optimizedImage.originalSize / 1024 / 1024).toFixed(2)}MB → Optimized: ${(optimizedImage.optimizedSize / 1024 / 1024).toFixed(2)}MB`);

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
        setTimeout(() => reject(new Error('OCR processing timeout')), MAX_PROCESSING_TIME)
      );
      
      const [result] = await Promise.race([ocrPromise, timeoutPromise]) as any;

      const detectedText = result.textAnnotations?.[0]?.description || "";

      if (detectedText) {
        // 新機能: 高度なレシート解析エンジンと自動カテゴリー分類
        console.log("=== USING ENHANCED RECEIPT PARSER ===");
        const parsedData = enhancedParseReceipt(detectedText);
        
        // OCR信頼度評価
        const confidenceScore = assessOCRConfidence(parsedData);
        console.log(`OCR Confidence Score: ${(confidenceScore * 100).toFixed(1)}%`);
        
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
        let userDisplayName = "個人";
        let lineGroupId = null;
        
        // Check if this is from a LINE group
        if (event.source.type === 'group') {
          lineGroupId = event.source.groupId;
          
          // Get user profile from LINE to get display name with timeout
          try {
            console.log("Getting user profile from LINE group...");
            const profilePromise = client.getGroupMemberProfile(lineGroupId, event.source.userId);
            const profileTimeoutPromise = new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Profile fetch timeout')), 5000)
            );
            
            const profile = await Promise.race([profilePromise, profileTimeoutPromise]) as any;
            userDisplayName = profile.displayName;
            
            // Find or create group for this LINE group
            const groupId = await findOrCreateLineGroup(lineGroupId, event.source.userId, userDisplayName);
            const groups = await getUserGroups(event.source.userId);
            activeGroup = groups.find(g => g.id === groupId);
            console.log("Successfully set up LINE group context");
          } catch (profileError) {
            console.warn("Could not get user profile, using fallback:", profileError);
            userDisplayName = "メンバー";
            
            // Still try to create/find group with fallback name
            try {
              const groupId = await findOrCreateLineGroup(lineGroupId, event.source.userId, userDisplayName);
              const groups = await getUserGroups(event.source.userId);
              activeGroup = groups.find(g => g.id === groupId);
            } catch (groupError) {
              console.error("Failed to create group with fallback:", groupError);
            }
          }
        } else {
          // Individual chat - use existing group logic
          const userGroups = await getUserGroups(event.source.userId);
          activeGroup = userGroups.length > 0 ? userGroups[0] : null;
          
          if (activeGroup) {
            userDisplayName = activeGroup.memberInfo.displayName;
          }
        }

        // Resolve appUid for this lineId
        console.log(`=== APPUID DEBUG: Resolving appUid for lineId: ${event.source.userId} ===`);
        const appUid = await resolveAppUidForExpense(event.source.userId);
        console.log(`=== APPUID DEBUG: Resolved appUid: ${appUid} ===`);
        if (!appUid) {
          console.error('Failed to resolve appUid for expense creation');
          throw new Error('Unable to resolve user ID');
        }
        
        // Get user's default category or use auto-classification
        let defaultCategory = "その他";
        try {
          console.log(`=== CATEGORY DEBUG RECEIPT: Getting user settings for ${event.source.userId} ===`);
          const userSettings = await getUserSettings(event.source.userId);
          console.log(`=== CATEGORY DEBUG RECEIPT: Retrieved settings:`, userSettings);
          if (userSettings?.defaultCategory) {
            defaultCategory = userSettings.defaultCategory;
            console.log(`=== CATEGORY DEBUG RECEIPT: Using default category: ${defaultCategory} ===`);
          } else {
            // 新機能: 自動カテゴリー分類
            console.log(`=== AUTO CATEGORY CLASSIFICATION ===`);
            const autoCategory = autoClassifyCategory(parsedData);
            if (autoCategory !== "その他") {
              defaultCategory = autoCategory;
              console.log(`=== AUTO CATEGORY: Classified as ${autoCategory} based on items ===`);
            } else {
              console.log(`=== CATEGORY DEBUG RECEIPT: No default category found, using: ${defaultCategory} ===`);
            }
          }
        } catch (error) {
          console.log("=== CATEGORY DEBUG RECEIPT: Failed to get user settings, using default category:", error);
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
          ocrText: detectedText,
          items: parsedData.items,
        };

        // Save expense
        console.log(`=== SAVING EXPENSE WITH APPUID: ${expense.appUid} ===`);
        const expenseId = await saveExpense(expense);
        console.log(`Expense saved with ID: ${expenseId} for lineId: ${event.source.userId}, appUid: ${expense.appUid}`);

        // Send final result to the source where message came from
        const targetId = event.source.type === 'group' ? event.source.groupId : event.source.userId;
        const webAppUrl = `https://line-kakeibo-0410.web.app?lineId=${encodeURIComponent(event.source.userId)}`;
        const isGroupContext = event.source.type === 'group';
        const contextText = isGroupContext ? '👥 グループの家計簿に追加されました' : '個人の家計簿に追加されました';
        const replyText = `✅ レシート登録完了！📝\n金額: ¥${parsedData.total.toLocaleString()}\n店舗: ${parsedData.storeName}\n\n${contextText}\n\nWebアプリで確認・編集：\n${webAppUrl}`;

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
        console.log(`=== COST METRICS RECORDED: Processing time ${processingTimer.elapsed()}ms, Saved ${optimizedImage.compressionRatio.toFixed(1)}% ===`);
      } else {
        const targetId = event.source.type === 'group' ? event.source.groupId : event.source.userId;
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
          errorType: 'no_text_detected'
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
    console.log(`=== TEXT MESSAGE DEBUG: Received text: "${text}" from user: ${event.source.userId} ===`);

    // ① レシート一覧コマンド
    console.log(`=== COMMAND CHECK: Checking if text equals "家計簿": ${text === "家計簿"} ===`);
    if (text === "家計簿") {
      console.log(`=== COMMAND MATCHED: Processing 家計簿 command ===`);
      try {
        // Get expenses data quickly with timeout using optimized function
        const expensesPromise = getExpensesSummary(event.source.userId, 3); // Only 3 items for maximum speed
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Expenses fetch timeout')), 2000) // 2 second timeout
        );

        const expenses = await Promise.race([expensesPromise, timeoutPromise]) as any;
        
        const webAppUrl = `https://line-kakeibo-0410.web.app?lineId=${encodeURIComponent(event.source.userId)}`;
        const isGroupContext = event.source.type === 'group';
        const contextText = isGroupContext ? '👥 グループの家計簿' : '個人の家計簿';
        
        let replyText: string;
        if (expenses.length > 0) {
          // Calculate total for quick summary
          const total = expenses.reduce((sum: number, e: any) => sum + (e.amount || 0), 0);
          
          replyText = `📊 ${contextText}の最近の支出:\n` +
            expenses
              .map((e: any, i: number) => `${i + 1}. ${e.description} - ¥${e.amount.toLocaleString()}`)
              .join("\n") +
            `\n\n💰 合計: ¥${total.toLocaleString()}\n\n${isGroupContext ? '👥 グループメンバーの全支出を確認できます' : '個人の全支出を確認できます'}\nWebアプリ：\n${webAppUrl}`;
        } else {
          replyText = `📋 ${contextText}にまだ支出がありません\n\n💡 使い方:\n• レシート画像を送信\n• 「500 ランチ」のようにテキスト入力\n\n${isGroupContext ? '👥 グループメンバーの支出が自動で集計されます' : '個人の家計簿を管理できます'}\nWebアプリ：\n${webAppUrl}`;
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
            text: `📊 家計簿\n\n現在データを読み込み中です...\n${event.source.type === 'group' ? '👥 グループ全体の支出が確認できます' : '個人の支出が確認できます'}\nWebアプリで詳細を確認してください：\nhttps://line-kakeibo-0410.web.app?lineId=` + encodeURIComponent(event.source.userId),
          });
        } catch (replyError) {
          console.error("Failed to send fallback reply:", replyError);
        }
      }
      return;
    }

    // ② カテゴリー設定・表示コマンド
    const isCategoryCommand = text === "カテゴリー" || text.startsWith("カテゴリー ") || text.startsWith("カテゴリー　");
    console.log(`=== COMMAND CHECK: Checking category command - exact: ${text === "カテゴリー"}, half-space: ${text.startsWith("カテゴリー ")}, full-space: ${text.startsWith("カテゴリー　")}, result: ${isCategoryCommand} ===`);
    if (isCategoryCommand) {
      console.log(`=== CATEGORY COMMAND MATCHED: Processing category command ===`);
      
      // カテゴリー一覧表示
      if (text === "カテゴリー") {
        console.log(`=== CATEGORY LIST: Showing available categories ===`);
        const validCategories = [
          '食費', '日用品', '交通費', '医療費', '娯楽費', 
          '衣服費', '教育費', '通信費', 'その他'
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
          text: `📋 利用可能なカテゴリー:\n\n${validCategories.map(c => '• ' + c).join('\n')}\n\n🔧 現在のデフォルト: ${currentCategory}\n\n💡 設定方法:\n「カテゴリー 食費」のように送信してください`,
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
      console.log(`=== CATEGORY COMMAND: Extracted category: "${category}" ===`);
      if (!category) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "💡 カテゴリー名を指定してください。\n例: 「カテゴリー 食費」\n\n利用可能なカテゴリー:\n• 食費\n• 日用品\n• 交通費\n• 医療費\n• 娯楽費\n• 衣服費\n• 教育費\n• 通信費\n• その他",
        });
        return;
      }

      const validCategories = [
        '食費', '日用品', '交通費', '医療費', '娯楽費', 
        '衣服費', '教育費', '通信費', 'その他'
      ];

      if (!validCategories.includes(category)) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `❌ 「${category}」は有効なカテゴリーではありません。\n\n利用可能なカテゴリー:\n${validCategories.map(c => '• ' + c).join('\n')}`,
        });
        return;
      }

      try {
        console.log(`=== CATEGORY DEBUG: Setting default category for user ${event.source.userId} to ${category} ===`);
        await saveUserSettings(event.source.userId, category);
        console.log(`=== CATEGORY DEBUG: Successfully saved category ${category} ===`);
        
        // Verify the setting was saved
        const verifySettings = await getUserSettings(event.source.userId);
        console.log(`=== CATEGORY DEBUG: Verification - Retrieved settings:`, verifySettings);
        
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
    console.log(`=== COMMAND CHECK: Checking if text starts with "グループ作成 ": ${text.startsWith("グループ作成 ")} ===`);
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
        const group = groups.find(g => g.id === groupId);
        
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

    console.log(`=== COMMAND CHECK: Checking if text starts with "参加 ": ${text.startsWith("参加 ")} ===`);
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
        const groupId = await joinGroup(inviteCode, event.source.userId, displayName);
        
        if (!groupId) {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ 無効な招待コードです。正しいコードを確認してください。",
          });
          return;
        }

        const members = await getGroupMembers(groupId);
        const memberNames = members.map(m => m.displayName).join("、");
        
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

    console.log(`=== COMMAND CHECK: Checking if text equals "グループ一覧": ${text === "グループ一覧"} ===`);
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
          const memberNames = members.map(m => m.displayName).join("、");
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

    // ② テキスト登録
    console.log(`=== TEXT PROCESSING: Trying to parse as expense text ===`);
    const parsed = parseTextExpense(text);
    if (!parsed) {
      console.log(`=== TEXT PROCESSING: Failed to parse as expense, sending help message ===`);
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "💡 金額が見つかりませんでした。\n例: 「500 ランチ」「1200 交通費」",
      });
      return;
    }
    
    console.log(`=== TEXT PROCESSING: Successfully parsed expense:`, parsed);

    // Immediate acknowledgment - send success message to the source where message came from
    try {
      const targetId = event.source.type === 'group' ? event.source.groupId : event.source.userId;
      
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `✅ 登録完了！\n${parsed.description} - ¥${parsed.amount.toLocaleString()} (${parsed.date})`,
      });
      
      console.log(`Expense registration response sent to ${event.source.type}: ${targetId}`);
    } catch (replyError) {
      console.error("Failed to send immediate reply:", replyError);
    }

    // Process expense registration in background (don't await)
    processExpenseInBackground(event, parsed).catch(error => {
      console.error("Background expense processing failed:", error);
      
      // Send error notification to the source where message came from
      const targetId = event.source.type === 'group' ? event.source.groupId : event.source.userId;
      client.pushMessage(targetId, {
        type: "text",
        text: "⚠️ 支出の保存で問題が発生しました。データが正しく記録されていない可能性があります。",
      }).catch(pushError => console.error("Failed to send error notification:", pushError));
    });
  } catch (error) {
    console.error("Text message handling error:", error);
  }
}


async function processExpenseInBackground(event: any, parsed: any) {
  try {
    console.log("Starting background expense processing...");
    
    // Determine group context and user display name
    let activeGroup = null;
    let userDisplayName = "個人";
    let lineGroupId = null;
    
    // Check if this is from a LINE group
    if (event.source.type === 'group') {
      lineGroupId = event.source.groupId;
      
      // Get user profile from LINE to get display name with shorter timeout for background processing
      try {
        console.log("Getting user profile from LINE group...");
        const profilePromise = client.getGroupMemberProfile(lineGroupId, event.source.userId);
        const profileTimeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Profile fetch timeout')), 3000) // Reduced to 3 seconds
        );
        
        const profile = await Promise.race([profilePromise, profileTimeoutPromise]) as any;
        userDisplayName = profile.displayName;
        
        // Find or create group for this LINE group
        const groupId = await findOrCreateLineGroup(lineGroupId, event.source.userId, userDisplayName);
        const groups = await getUserGroups(event.source.userId);
        activeGroup = groups.find(g => g.id === groupId);
        console.log("Successfully set up LINE group context");
      } catch (profileError) {
        console.warn("Could not get user profile, using fallback:", profileError);
        userDisplayName = "メンバー";
        
        // Still try to create/find group with fallback name
        try {
          const groupId = await findOrCreateLineGroup(lineGroupId, event.source.userId, userDisplayName);
          const groups = await getUserGroups(event.source.userId);
          activeGroup = groups.find(g => g.id === groupId);
        } catch (groupError) {
          console.error("Failed to create group with fallback:", groupError);
        }
      }
    } else {
      // Individual chat - use existing group logic
      try {
        const userGroups = await getUserGroups(event.source.userId);
        activeGroup = userGroups.length > 0 ? userGroups[0] : null;
        
        if (activeGroup) {
          userDisplayName = activeGroup.memberInfo.displayName;
        }
      } catch (groupError) {
        console.warn("Failed to get user groups:", groupError);
      }
    }

    // Resolve appUid for this lineId
    console.log(`=== APPUID DEBUG TEXT: Resolving appUid for lineId: ${event.source.userId} ===`);
    const appUid = await resolveAppUidForExpense(event.source.userId);
    console.log(`=== APPUID DEBUG TEXT: Resolved appUid: ${appUid} ===`);
    if (!appUid) {
      console.error('Failed to resolve appUid for expense creation');
      throw new Error('Unable to resolve user ID');
    }
    
    // Get user's default category
    let defaultCategory = "その他";
    try {
      console.log(`=== CATEGORY DEBUG TEXT: Getting user settings for ${event.source.userId} ===`);
      const userSettings = await getUserSettings(event.source.userId);
      console.log(`=== CATEGORY DEBUG TEXT: Retrieved settings:`, userSettings);
      if (userSettings?.defaultCategory) {
        defaultCategory = userSettings.defaultCategory;
        console.log(`=== CATEGORY DEBUG TEXT: Using default category: ${defaultCategory} ===`);
      } else {
        console.log(`=== CATEGORY DEBUG TEXT: No default category found, using: ${defaultCategory} ===`);
      }
    } catch (error) {
      console.log("=== CATEGORY DEBUG TEXT: Failed to get user settings, using default category:", error);
    }
    
    // Create expense object
    const expense = {
      lineId: event.source.userId,
      appUid: appUid,
      groupId: activeGroup?.id,
      lineGroupId,
      userDisplayName,
      amount: parsed.amount,
      description: parsed.description,
      date: parsed.date,
      category: defaultCategory,
      confirmed: true,
      ocrText: "",
      items: [],
    };

    // Save expense to database
    console.log(`=== SAVING TEXT EXPENSE WITH APPUID: ${expense.appUid} ===`);
    const expenseId = await saveExpense(expense);
    console.log(`Text expense saved with ID: ${expenseId} for lineId: ${event.source.userId}, appUid: ${expense.appUid}`);
    
    // Send confirmation that background processing completed (optional)
    // We could send a quiet notification, but for now just log success
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
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Send welcome message with error handling
    try {
      await client.pushMessage(lineGroupId, {
        type: "text",
        text: "家計簿ボットがグループに参加しました！🎉\n\n📸 レシート画像を送信すると支出を自動記録\n💬 「500 ランチ」のようにテキストでも記録\n📊 「家計簿」で支出一覧を表示\n\nグループメンバーの支出が自動的に共有されます👥",
      });
      
      console.log(`Bot successfully joined and sent welcome to LINE group: ${lineGroupId}`);
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
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Use pushMessage instead of replyMessage for better compatibility
        await client.pushMessage(lineGroupId, {
          type: "text",
          text: "新しいメンバーがグループに参加しました！👋\n家計簿ボットで支出を記録・共有できます。\n\n「家計簿」と送信すると使い方を確認できます。",
        });
        
        console.log(`Successfully sent welcome message for new member in group: ${lineGroupId}`);
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
    if (!client || typeof client.getProfile !== 'function') {
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
        credentials: !!process.env.LINE_CHANNEL_TOKEN
      }
    });
  } catch (error) {
    console.error("Health check failed:", error);
    res.status(500).json({
      status: "unhealthy",
      error: (error as Error).message,
      timestamp: new Date().toISOString()
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
    memory: "512MiB",        // Increased from 256MiB to handle image processing
    timeoutSeconds: 540,     // Increased from 300s to 540s (9 minutes max)
    invoker: "public",
    secrets: ["LINE_CHANNEL_TOKEN", "LINE_CHANNEL_SECRET"],
  },
  app
);

// Export the syncUserLinks function
export { syncUserLinks } from "./syncUserLinks";

export default app;