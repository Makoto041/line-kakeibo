/**
 * LINE のテキストコマンド
 *
 * 上から順に試し、最初に一致したコマンドだけを処理する（順序は従来どおり）。
 * どれにも一致しなければ false を返し、呼び出し元が支出の登録として扱う。
 */

import { handleAdvanceCommand } from "./advance";
import { handleCategoryCommand } from "./category";
import { handleFeedbackCommand } from "./feedback";
import { handleGroupCommand } from "./group";
import { handleKakeiboCommand } from "./kakeibo";

type CommandHandler = (event: any, text: string) => Promise<boolean>;

const COMMANDS: CommandHandler[] = [
  handleKakeiboCommand, // 家計簿
  handleFeedbackCommand, // 要望 / 改善 / 不具合 / フィードバック
  handleCategoryCommand, // カテゴリー
  handleGroupCommand, // グループ作成 / 参加 / グループ一覧
  handleAdvanceCommand, // 立替一覧 / 立替 / 精算
];

/** コマンドとして処理したら true */
export async function handleCommand(event: any, text: string): Promise<boolean> {
  for (const command of COMMANDS) {
    if (await command(event, text)) return true;
  }
  return false;
}
