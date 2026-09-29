/**
 * 「カテゴリー」コマンド: デフォルトカテゴリーの表示・設定
 */

import { getUserSettings, saveUserSettings } from "../../firestore";
import { replyText } from "../client";

/**
 * LINE の「カテゴリー」コマンドで選べるカテゴリー
 *
 * Web / Gemini の正準カテゴリー（categoryNormalization.CANONICAL_CATEGORIES）とは
 * 別の、LINE コマンドの案内に出してきた一覧。返信文が変わるため揃えていない。
 */
const LINE_DEFAULT_CATEGORIES = [
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

const CATEGORY_BULLETS = LINE_DEFAULT_CATEGORIES.map((c) => "• " + c).join("\n");

export async function handleCategoryCommand(event: any, text: string): Promise<boolean> {
  const isCategoryCommand =
    text === "カテゴリー" ||
    text.startsWith("カテゴリー ") ||
    text.startsWith("カテゴリー　");
  if (!isCategoryCommand) return false;

  // カテゴリー一覧表示
  if (text === "カテゴリー") {
    // 現在のデフォルトカテゴリーを取得
    let currentCategory = "未設定";
    try {
      const userSettings = await getUserSettings(event.source.userId);
      if (userSettings?.defaultCategory) {
        currentCategory = userSettings.defaultCategory;
      }
    } catch (error) {
      console.warn("Failed to get current category setting:", error);
    }

    await replyText(event.replyToken, `利用可能なカテゴリー:\n\n${CATEGORY_BULLETS}\n\n現在のデフォルト: ${currentCategory}\n\n設定方法:\n「カテゴリー 食費」のように送信してください`);
    return true;
  }

  // カテゴリー設定
  let category = "";
  if (text.startsWith("カテゴリー ")) {
    category = text.replace("カテゴリー ", "").trim();
  } else if (text.startsWith("カテゴリー　")) {
    category = text.replace("カテゴリー　", "").trim();
  }
  if (!category) {
    await replyText(event.replyToken, `カテゴリー名を指定してください。\n例: 「カテゴリー 食費」\n\n利用可能なカテゴリー:\n${CATEGORY_BULLETS}`);
    return true;
  }

  if (!LINE_DEFAULT_CATEGORIES.includes(category)) {
    await replyText(event.replyToken, `「${category}」は有効なカテゴリーではありません。\n\n利用可能なカテゴリー:\n${CATEGORY_BULLETS}`);
    return true;
  }

  try {
    await saveUserSettings(event.source.userId, category);

    await replyText(event.replyToken, `デフォルトカテゴリーを「${category}」に設定しました！\n\n今後の支出入力は自動的に「${category}」カテゴリーになります。\n\n変更するには「カテゴリー [新しいカテゴリー]」と送信してください。`);
  } catch (error) {
    console.error("Error saving user settings:", error);
    await replyText(event.replyToken, "カテゴリーの設定に失敗しました。もう一度お試しください。");
  }
  return true;
}
