/**
 * LINE のテキスト入力（「500 ランチ」など）を支出として登録する
 *
 * 発言者のプロフィール・所属グループ・appUid を並列に解決し、カテゴリを決めて保存したうえで、
 * 登録カード（Flex Message）を replyToken で返信する（失敗時だけ push）。
 */

import { findLineGroupId, getUserGroups, getUserSettings, saveExpense } from "../firestore";
import { classifyExpenseWithGemini } from "../geminiCategoryClassifier";
import { getCategoryEmoji } from "../gmail/types";
import { resolveExpenseGroupScope } from "../expenseGroupScope";
import { resolveAppUidForExpense } from "../linkUserResolver";
import { errorMessage, maskId } from "../logSafe";
import { getPaymentMethodLabel, PaymentMethod } from "../textParser";
import { getLineClient, replyText, replyWithPushFallback } from "./client";
import { buildExpenseEditUrl, sendTextExpenseNotification, TextExpenseInfo } from "./flexMessage";

// 支出を紐づけるグループを選ぶ。
//   - LINE グループでの発言: 発言元の LINE グループに紐づくグループだけを返す（無ければ null）。
//     一致しないグループを返すとキャッシュに残り、その後に世帯へ追加されても TTL の間
//     findLineGroupId が呼ばれず個人支出として保存されてしまうため。
//   - 個人チャット: LINE グループに紐づくグループ（世帯）を優先し、無ければ先頭。
//     自分で「グループ作成」した LINE 非連携のグループに世帯の支出が入らないようにする。
function pickActiveGroup(groups: any[] | undefined, lineGroupId: string | null) {
  if (!groups || groups.length === 0) return null;
  if (lineGroupId) {
    return groups.find((g) => g?.lineGroupId === lineGroupId) || null;
  }
  return groups.find((g) => g?.lineGroupId) || groups[0] || null;
}

// ユーザー情報キャッシュ（メモリ内、15分TTL）
const userProfileCache = new Map<string, { profile: any; groups: any[]; timestamp: number }>();
const CACHE_TTL = 15 * 60 * 1000; // 15分

/** LINE API 呼び出しに打ち切り時間を付ける */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * attemptTimeoutsMs の数だけ試す（各回の打ち切り時間を指定。失敗の間に 500ms 待つ）。
 * すべて失敗したら最後のエラーを投げる。
 */
async function retryWithTimeouts<T>(
  label: string,
  attemptTimeoutsMs: number[],
  call: () => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attemptTimeoutsMs.length; i++) {
    const attempt = i + 1;
    try {
      return await withTimeout(call(), attemptTimeoutsMs[i], `${label} timeout (attempt ${attempt})`);
    } catch (error) {
      lastError = error;
      console.warn(`${label} failed`, { attempt, error: errorMessage(error) });
      if (attempt < attemptTimeoutsMs.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  throw lastError;
}

type ProfileResult = { type: "profile"; data: { displayName?: string } | null; error?: unknown };

/**
 * LINE グループでの発言者のプロフィール。グループのメンバープロフィールを 2 回まで試し
 * （テキスト処理は高速性を優先）、だめなら個人プロフィールを 1 回試す。
 * グループの場合はフォールバック名を使わずエラーにする。
 */
async function fetchGroupPosterProfile(lineGroupId: string, userId: string): Promise<ProfileResult> {
  const client = getLineClient();
  try {
    const profile = await retryWithTimeouts("Group profile", [5000, 8000], () =>
      client.getGroupMemberProfile(lineGroupId, userId)
    );
    return { type: "profile", data: profile };
  } catch {
    try {
      const profile = await withTimeout(client.getProfile(userId), 6000, "Individual profile timeout");
      return { type: "profile", data: profile };
    } catch (individualError) {
      console.warn("Fallback getProfile also failed", { error: errorMessage(individualError) });
      return { type: "profile", error: individualError, data: null };
    }
  }
}

/** 個人チャットの発言者のプロフィール（3 回まで試す） */
async function fetchIndividualProfile(userId: string): Promise<ProfileResult> {
  const client = getLineClient();
  try {
    const profile = await retryWithTimeouts("Profile", [6000, 10000, 10000], () => client.getProfile(userId));
    return { type: "profile", data: profile };
  } catch {
    console.warn("All profile fetch attempts failed for individual chat");
    return { type: "profile", error: new Error("All retries failed"), data: null };
  }
}

export async function processExpenseInBackground(
  event: any,
  parsed: any,
  replyToken?: string
) {
  try {
    // LINE は利用規約に同意していないユーザーのグループ内イベントで userId を省く。
    // lineId を持たない支出は所有者が定まらないため保存しない。
    if (!event?.source?.userId) {
      console.warn("Skipping expense: event.source.userId is missing (user has not consented to the LINE OA terms)");
      if (replyToken) {
        await replyText(
          replyToken,
          "支出を記録できませんでした。この Bot を友だち追加すると、支出を記録できるようになります。"
        ).catch((replyError) => console.warn("Failed to reply to a message without userId:", replyError));
      }
      return;
    }

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
        userDisplayName = cached.profile.displayName;
        activeGroup = pickActiveGroup(cached.groups, lineGroupId);
      }

      if (!hasCachedProfile) {
        // キャッシュミスまたは名前がない場合 - 並列取得

        // プロファイル取得を並列実行（リトライ機能付き）
        promises.push(fetchGroupPosterProfile(lineGroupId, event.source.userId));

        // グループ取得は後で（プロファイル取得後に実行）
        // promises.pushはせずに、プロファイル取得が完了した後に実行
      }
    } else {
      // Individual chat - キャッシュまたは並列取得
      const cacheKey = event.source.userId;
      const cached = userProfileCache.get(cacheKey);
      const now = Date.now();
      
      if (cached && (now - cached.timestamp < CACHE_TTL)) {
        activeGroup = pickActiveGroup(cached.groups, lineGroupId);
        userDisplayName = cached.profile?.displayName;
      } else {
        // 個人チャットの場合もプロファイルを取得（リトライ機能付き）
        promises.push(fetchIndividualProfile(event.source.userId));

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
                activeGroup = pickActiveGroup(value.data, lineGroupId);
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
        // メンバーの自動追加は行わない（世帯は2名固定。追加は管理スクリプトのみ）。
        // 有効なメンバーでなければ activeGroup は null のままになり、支出は groupId を持たない。
        const groupId = await findLineGroupId(lineGroupId, event.source.userId, userDisplayName);
        if (groupId) {
          const groups = await getUserGroups(event.source.userId);
          activeGroup = groups.find((g) => g.id === groupId) || null;
        }
      } catch (groupError) {
        console.error("Failed to setup group after profile fetch:", groupError);
      }
    }

    // フォールバック処理
    if (!appUid) {
      appUid = event.source.userId;
    }
    
    // ユーザー表示名とプロファイル取得エラーのチェック
    if (!userDisplayName || profileFetchError) {
      // プロファイル取得に失敗した場合は、グループでも個人でもエラーとして処理
      const context = event.source.type === "group" ? "グループ" : "個人チャット";
      console.error("PROFILE ERROR: Failed to get user profile", {
        context,
        user: maskId(event.source.userId),
        error: errorMessage(profileFetchError),
      });

      const targetId = event.source.type === "group" ? event.source.groupId : event.source.userId;
      const profileErrorMessage = {
        type: "text" as const,
        text: "ユーザー情報の取得に失敗しました。\n\nしばらく待ってから再度お試しください。\n\n問題が継続する場合は、LINEアプリを再起動してください。"
      };

      // replyToken（無料）を優先使用し、失敗時のみpushMessageにフォールバック
      await replyWithPushFallback(replyToken, targetId, [profileErrorMessage]);
      return; // 処理を中断（データは書き込まない）
    }
    

    // カテゴリの決定
    //
    // 本人が「光熱費 28727」のようにカテゴリ名を書いていれば、それが最も確かな指定なので
    // 推定を挟まずそのまま使う。以前は parseTextExpense が返す category を捨てて
    // 説明文（この場合は残りが無いためフォールバックの「支出」）を Gemini に投げており、
    // 低信頼→デフォルトカテゴリへ倒れて毎回カード上で付け直す必要があった。
    let finalCategory = "その他";

    if (parsed.category) {
      finalCategory = parsed.category;
    } else {
      // カテゴリ分類を並列実行（Gemini + ユーザーデフォルト）
      const [geminiResult, userSettingsResult] = await Promise.allSettled([
        classifyExpenseWithGemini(event.source.userId, parsed.description),
        getUserSettings(event.source.userId)
      ]);

      // Gemini結果を優先使用（閾値0.4で精度向上）
      if (geminiResult.status === 'fulfilled') {
        const result = geminiResult.value;
        if (result && result.category && result.confidence >= 0.4) {
          finalCategory = result.category;
        }
      }

      // Geminiが失敗またはlow confidenceの場合、ユーザーデフォルトを使用
      if (finalCategory === "その他" && userSettingsResult.status === 'fulfilled') {
        const userSettings = userSettingsResult.value;
        if (userSettings?.defaultCategory) {
          finalCategory = userSettings.defaultCategory;
        }
      }
    }

    // グループ所属の決定。発言元の LINE グループに紐づくグループの有効なメンバーで
    // なければ lineGroupId も付けず個人支出にする（LINE 集計・精算への混入防止）。
    const groupScope = resolveExpenseGroupScope(activeGroup, lineGroupId);
    if (lineGroupId && !groupScope.lineGroupId) {
      console.warn(
        `Poster ${maskId(event.source.userId)} is not an active member of the group linked to LINE group ${maskId(lineGroupId)}; saving as personal expense`
      );
    }

    // Create expense object with payment method
    const expense = {
      lineId: event.source.userId,
      appUid: appUid,
      groupId: groupScope.groupId,
      lineGroupId: groupScope.lineGroupId,
      userDisplayName,
      amount: parsed.amount,
      description: parsed.description,
      date: parsed.date,
      category: finalCategory,
      confirmed: false, // 未確認状態で保存（ボタンで確認）
      includeInTotal: false, // LINE手入力は初期状態では会計に含めない
      payerId: event.source.userId, // デフォルトは入力者
      payerDisplayName: userDisplayName,
      ocrText: "",
      items: [],
      // 新規追加: 入力元と支払い方法
      inputSource: 'line_text' as const,
      paymentMethod: parsed.paymentMethod,
    };

    // Save expense to database
    const expenseId = await saveExpense(expense);
    console.log(
      `Text expense saved with ID: ${expenseId} for lineId: ${maskId(event.source.userId)}, appUid: ${maskId(expense.appUid)}`
    );

    // Flex Messageで確認通知を送信
    const targetId = event.source.type === "group"
      ? event.source.groupId
      : event.source.userId;

    if (targetId) {
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
        // 保存時の値と揃える（LINE手入力は OK を押すまで集計に入らない）
        includeInTotal: expense.includeInTotal,
        // 「修正」はWeb編集画面への直リンク。グループの場合カードはグループ全員に
        // 届くため、リンクは入力した本人のIDで固定される。
        editUrl: event.source.userId
          ? buildExpenseEditUrl(expenseId, event.source.userId)
          : undefined,
      };

      // replyToken（無料・月200通制限の対象外）を優先使用し、
      // 期限切れ等で失敗した場合のみpushMessageにフォールバック
      await sendTextExpenseNotification(targetId, textExpenseInfo, replyToken);
    }

  } catch (error) {
    console.error("Background expense processing error:", error);
    throw error; // Re-throw to trigger error notification
  }
}

/** 退出したメンバーのキャッシュを捨てる（memberLeft 用） */
export function forgetCachedProfiles(lineGroupId: string, userIds: string[]): void {
  for (const userId of userIds) {
    userProfileCache.delete(`${userId}_${lineGroupId}`);
    userProfileCache.delete(userId);
  }
}
