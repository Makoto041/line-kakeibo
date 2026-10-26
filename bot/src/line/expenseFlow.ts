/**
 * LINE のテキスト入力（「500 ランチ」など）を支出として登録する
 *
 * 発言者のプロフィール・所属グループ・appUid を並列に解決し、カテゴリを決めて保存したうえで、
 * 登録カード（Flex Message）を replyToken で返信する（失敗時だけ push）。
 */

import { toCanonicalCategoryName } from "../categoryNormalization";
import { subCategoriesOf } from "../categoryTaxonomy";
import { findLineGroupId, getUserGroups, getUserSettings, saveExpense } from "../firestore";
import { classifyExpense } from "../geminiCategoryClassifier";
import type { ClassificationResult } from "../geminiCategoryClassifier";
import { getCategoryEmoji } from "../gmail/types";
import { isHouseholdMember, resolveExpenseGroupScope } from "../expenseGroupScope";
import { resolveAppUidForExpense } from "../linkUserResolver";
import { errorFields, maskId } from "../logSafe";
import { resolveSubCategory } from "../subCategoryRules";
import { getPaymentMethodLabel, PaymentMethod } from "../textParser";
import { getLineClient, replyText, replyWithPushFallback } from "./client";
import { buildExpenseEditUrl, sendTextExpenseNotification, TextExpenseInfo } from "./flexMessage";
import type { CategoryOrigin } from "./flexMessage";

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
      console.warn("Profile fetch attempt failed", { label, attempt, ...errorFields(error) });
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
      console.warn("Fallback getProfile also failed", errorFields(individualError));
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

/** 分類の結果を採用する確信度の下限（辞書・Jev・Gemini のどれで決まっても同じ） */
const CLASSIFY_MIN_CONFIDENCE = 0.4;

/**
 * LINE の入力のカテゴリと、その判定元（最初のカードの括弧に出す）を決める。
 *
 * - 入力でカテゴリを指定していればそれを使う（specified）
 * - 無ければ分類の結果を確信度 0.4 以上のときだけ採用する（判定元は分類の provider）
 * - それでも「その他」なら、利用者の既定カテゴリがあればそれにする（default）。無ければ「その他」（unclassified）
 *
 * classified は分類が失敗（rejected）したら null、defaultCategory は設定を読めなかったら渡さない。
 * 指定と既定カテゴリは LINE の旧名（医療費・娯楽費など）のことがあるので、正準名に揃えて返す
 * （toCanonicalCategoryName。#243）。分類の結果は正準名なのでそのまま。
 */
export function decideTextExpenseCategory(input: {
  specified?: string;
  classified?: ClassificationResult | null;
  defaultCategory?: string | null;
}): { category: string; origin?: CategoryOrigin } {
  if (input.specified) return { category: toCanonicalCategoryName(input.specified), origin: "specified" };

  let category = "その他";
  let origin: CategoryOrigin | undefined = "unclassified";

  const classified = input.classified;
  if (classified && classified.category && classified.confidence >= CLASSIFY_MIN_CONFIDENCE) {
    category = classified.category;
    origin = classified.provider;
  }

  // 分類できない（Jev・Gemini とも失敗し辞書にも無い）または low confidence の場合、ユーザーデフォルトを使用
  if (category === "その他" && input.defaultCategory) {
    category = toCanonicalCategoryName(input.defaultCategory);
    origin = "default";
  }

  return { category, origin };
}

/**
 * LINE の入力の中項目（#235）。説明文を辞書で照合する（resolveSubCategory。入力した時刻は食べた時刻とは限らないので、時刻は渡さない）。
 * 決まらなければ undefined（保存で項目ごと付かない）。判定に失敗しても投げず undefined にして、保存は続ける。
 * 大項目に中項目の一覧があるとき（食費・娯楽）だけ、結果をログに出す（説明・ID は出さない）。
 */
export function textSubCategoryOf(category: string, description: string): string | undefined {
  try {
    const sub = resolveSubCategory({ major: category, text: description, source: "text" });
    if (subCategoriesOf(category).length > 0) {
      console.log("Subcategory resolved", { source: "text", subCategory: sub ?? null });
    }
    return sub ?? undefined;
  } catch (error) {
    console.warn("Subcategory resolution failed", { source: "text", ...errorFields(error) });
    return undefined;
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
        ).catch((replyError) => console.warn("Failed to reply to a message without userId", errorFields(replyError)));
      }
      return;
    }

    // 並列実行のためのプロミス配列
    const promises: Promise<any>[] = [];
    
    let activeGroup = null;
    let userDisplayName = null; // Will be set based on context
    let lineGroupId = null;
    let appUid = null;
    // 世帯の確認（getUserGroups・findLineGroupId）が失敗したか。activeGroup が null でも、
    // 「メンバーでない」のか「確認できなかった」のかを分ける（カテゴリ分類でモデルを呼ぶかに使う。#245）
    let membershipLookupFailed = false;
    // プロフィール（個人チャットは所属グループも）を実際に取得したか（キャッシュに当たらなかったか）。
    // キャッシュは取得した回だけ書く。当たった回も書き直すと期限が延び、入力を続ける間は
    // 所属の変更（管理スクリプトでの無効化など）が反映されなくなる
    let fetchedProfile = false;

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
        fetchedProfile = true;
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
        fetchedProfile = true;
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
              if (value.error) {
                membershipLookupFailed = true;
              } else if (value.data.length > 0) {
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

      // キャッシュ更新。取得した回だけ書き、期限は取得した時点から CACHE_TTL（キャッシュに当たった回は延ばさない）。
      // 所属グループの読み取り（個人チャットの getUserGroups）に失敗したときは残さない。
      // 失敗を「所属なし」として 15 分残すと、その間はメンバーの入力でもモデルを呼ばず、個人支出にもなるため。
      // プロフィールの取得に失敗した（表示名が取れなかった）ときも残さない（#261）。個人チャットはキャッシュに
      // 当たるかの判定で表示名を見ないため、残すとその間は入力のたびに「ユーザー情報の取得に失敗しました」で止まる
      if (fetchedProfile && !membershipLookupFailed && userDisplayName) {
        const cacheKey = event.source.type === "group"
          ? `${event.source.userId}_${lineGroupId}`
          : event.source.userId;

        userProfileCache.set(cacheKey, {
          profile: { displayName: userDisplayName },
          groups: activeGroup ? [activeGroup] : [],
          timestamp: Date.now()
        });
      }
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
        membershipLookupFailed = true;
        console.error("Failed to setup group after profile fetch", errorFields(groupError));
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
        ...errorFields(profileFetchError),
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
    // 推定を挟まずに使う（「医療費」のような旧名は正準名に揃える）。以前は parseTextExpense が返す category を捨てて
    // 説明文（この場合は残りが無いためフォールバックの「支出」）を Gemini に投げており、
    // 低信頼→デフォルトカテゴリへ倒れて毎回カード上で付け直す必要があった。
    // 判定元（categoryOrigin）は最初のカードの括弧に出すだけで、保存しない。
    let decided: { category: string; origin?: CategoryOrigin };

    if (parsed.category) {
      decided = decideTextExpenseCategory({ specified: parsed.category });
    } else {
      // モデル（Jev・Gemini）を呼ぶのは世帯メンバーの入力だけ（費用・無料枠の保護。#245）。
      // メンバーでなければ辞書だけで判定し、決まらなければ既定カテゴリか「その他」（モデルが使えないときと同じ）。
      // 世帯の確認自体に失敗したときはモデルを呼ぶ（メンバーでない人は Firestore の失敗を起こせない。
      // 一時的な失敗でメンバーの入力を辞書だけにしないほうを優先する）
      const allowModels = membershipLookupFailed || isHouseholdMember(activeGroup, lineGroupId);
      if (!allowModels) {
        console.log("Skipping category models: poster is not a household member", {
          user: maskId(event.source.userId),
        });
      } else if (membershipLookupFailed) {
        console.warn("Household membership lookup failed; classifying with models", {
          user: maskId(event.source.userId),
        });
      }

      // カテゴリ分類を並列実行（辞書・モデル〔Jev → 失敗時 Gemini〕 + ユーザーデフォルト）
      const [classification, userSettingsResult] = await Promise.allSettled([
        classifyExpense(event.source.userId, parsed.description, { allowModels }),
        getUserSettings(event.source.userId)
      ]);

      // 分類結果を優先使用（閾値0.4で精度向上）。決まらなければユーザーデフォルト（decideTextExpenseCategory）
      decided = decideTextExpenseCategory({
        classified: classification.status === 'fulfilled' ? classification.value : null,
        defaultCategory: userSettingsResult.status === 'fulfilled'
          ? userSettingsResult.value?.defaultCategory
          : undefined,
      });
    }

    const finalCategory = decided.category;
    const categoryOrigin = decided.origin;
    // 中項目は大項目が決まったあとに説明文から決める（指定・分類・既定のどの経路でも同じ。判定元には影響しない）
    const subCategory = textSubCategoryOf(finalCategory, parsed.description);

    // グループ所属の決定。発言元の LINE グループに紐づくグループの有効なメンバーで
    // なければ lineGroupId も付けず個人支出にする（LINE 集計・精算への混入防止）。
    const groupScope = resolveExpenseGroupScope(activeGroup, lineGroupId);
    if (lineGroupId && !groupScope.lineGroupId) {
      console.warn('Poster is not an active member of the group linked to the LINE group; saving as personal expense', {
        user: maskId(event.source.userId),
        lineGroup: maskId(lineGroupId),
      });
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
      subCategory, // 決まらなければ undefined（saveExpense が項目を付けない）
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
    console.log('Text expense saved', {
      expense: maskId(expenseId),
      user: maskId(event.source.userId),
      appUid: maskId(expense.appUid),
    });

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
        subCategory, // 保存した中項目（カテゴリの行に「食費 › 昼ご飯」と出す）
        // 最初のカードだけに出す（保存しない。postback で作り直したカードには出ない）
        categoryOrigin,
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
    console.error("Background expense processing error", errorFields(error));
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
