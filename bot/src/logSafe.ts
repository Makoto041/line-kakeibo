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

/**
 * 原因のエラーコード（`error.cause.code`）。fetch の通信の失敗（`TypeError: fetch failed`）の診断に使う
 * （undici の ECONNRESET / ENOTFOUND / UND_ERR_CONNECT_TIMEOUT など）。
 * 英大文字・数字・`_` だけの 64 文字以内の文字列のときだけ返す（それ以外の形は、入力の断片でありうるので返さない）。
 * cause の文言や cause そのものは返さない
 */
export function errorCauseCode(error: unknown): string | undefined {
  const code = (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
}
