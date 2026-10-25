/**
 * ログ出力用のマスクヘルパー
 *
 * Cloud Logging には LINE の userId / groupId、Firebase の uid などを
 * そのまま残さない。運用上の突き合わせに必要な末尾 4 文字だけを出す。
 */

/** ID を末尾 4 文字だけ残してマスクする（例: `U1234...abcd` → `…abcd`） */
export function maskId(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) return '(none)';
  if (id.length <= 4) return '****';
  return `…${id.slice(-4)}`;
}

/** Error から message だけを取り出す（リクエスト設定やヘッダーを含む巨大なオブジェクトを出さない） */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Error から名前（SyntaxError など）だけを取り出す。文言に入力の断片が入りうるエラーに使う
 * （JSON.parse の SyntaxError の文言には、解釈しようとした文字列の一部が入る）。Error でなければ型の名前
 */
export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
