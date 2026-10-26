/**
 * ログ出力用のマスクヘルパー
 *
 * Cloud Logging には LINE の userId / groupId、Firebase の uid などを
 * そのまま残さない。運用上の突き合わせに必要な末尾 4 文字だけを出す。
 *
 * ログは `console.error('固定文', { user: maskId(id), ...errorFields(error) })` のように、固定文とオブジェクトで出す
 * （docs/SECURITY_OPERATIONS.md §9）。書式文字列（テンプレートリテラル）に値を埋め込まない。例外は生のまま・文言（message）を出さない
 * （Firestore のエラーの文言には文書のパス〔LINE の ID を含みうる〕が、JSON.parse の SyntaxError の文言には入力の断片が入る。
 * 生の例外には、通信先のヘッダー〔アクセストークン〕や応答の本文が入ることがある）。
 */

/** ID を末尾 4 文字だけ残してマスクする（例: `U1234...abcd` → `…abcd`） */
export function maskId(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) return '(none)';
  if (id.length <= 4) return '****';
  return `…${id.slice(-4)}`;
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

/** errorFields が返す値 */
export interface ErrorFields {
  errorName: string;
  errorCode?: string | number;
  errorCause?: string;
  errorStatus?: number;
}

/**
 * ログに出す例外の種類。例外はこれで出す（`console.error('固定文', errorFields(error))`）
 *
 * - errorName: 名前（errorName）
 * - errorCode: `error.code`。有限の数（Firestore の gRPC のコード〔5 = NOT_FOUND など〕・Gmail API の HTTP のコード）か、
 *   英大文字・数字・`_` だけの 64 文字以内の文字列（ECONNRESET・ERR_BAD_REQUEST など。errorCauseCode と同じ形）か、
 *   Firebase の形（`auth/id-token-expired` のような、英小文字の区分と英小文字・数字・`-` だけの名前）の文字列のときだけ
 * - errorCause: 原因のコード（fetch の通信の失敗の ECONNRESET など。errorCauseCode）
 * - errorStatus: `error.status` が 100〜599 の整数のとき（LINE の HTTPFetchError・Gmail API・axios の HTTP の状態）
 *
 * 文言（message）・原因の文言・例外そのものは出さない。
 */
export function errorFields(error: unknown): ErrorFields {
  const fields: ErrorFields = { errorName: errorName(error) };
  const e = error as { code?: unknown; status?: unknown } | null | undefined;
  const code = e?.code;
  if (
    (typeof code === 'number' && Number.isFinite(code)) ||
    (typeof code === 'string' && (/^[A-Z0-9_]{1,64}$/.test(code) || /^[a-z]{1,16}\/[a-z0-9-]{1,64}$/.test(code)))
  ) {
    fields.errorCode = code;
  }
  const cause = errorCauseCode(error);
  if (cause) fields.errorCause = cause;
  const status = e?.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    fields.errorStatus = status;
  }
  return fields;
}
