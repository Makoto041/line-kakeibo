/**
 * Web（Next.js）のオリジン許可リスト
 *
 * `/auth/line`（auth/lineAuth.ts）と `/household`（householdApi.ts）が共用する唯一の定義。既定は本番 Vercel と
 * localhost で、環境変数 `WEB_ORIGINS`（カンマ区切り）で上書きできる。このプロジェクトの Vercel プレビュー
 * （line-kakeibo*.vercel.app）も許可する。
 *
 * CORS は防御線ではない（正規表現は他人の Vercel プロジェクト名にも一致しうる）。API の
 * 保護は Firebase ID トークンの検証とメンバー確認で行い、Cookie は使わない。
 */

const DEFAULT_WEB_ORIGINS = 'https://line-kakeibo.vercel.app,http://localhost:3000';

function webOriginAllowlist(): string[] {
  return (process.env.WEB_ORIGINS || DEFAULT_WEB_ORIGINS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedWebOrigin(origin?: string): boolean {
  if (!origin) return false;
  if (webOriginAllowlist().includes(origin)) return true;
  return /^https:\/\/line-kakeibo[a-z0-9-]*\.vercel\.app$/.test(origin);
}

/**
 * 許可したオリジンからのリクエストにだけ CORS の許可ヘッダーを付ける。
 *
 * @returns 許可ヘッダーを付けたか（オリジンが許可リストにあったか）
 */
export function applyWebCorsHeaders(
  req: { headers: { origin?: string } },
  res: { setHeader(name: string, value: string): unknown },
  options: { methods: string; allowHeaders: string }
): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !isAllowedWebOrigin(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', options.methods);
  res.setHeader('Access-Control-Allow-Headers', options.allowHeaders);
  res.setHeader('Access-Control-Max-Age', '3600');
  return true;
}
