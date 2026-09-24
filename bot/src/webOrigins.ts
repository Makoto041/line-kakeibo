/**
 * Web（Next.js）のオリジン許可リスト
 *
 * `index.ts` の `/auth/line` と同じ判定。既定は本番 Vercel と localhost で、環境変数
 * `WEB_ORIGINS`（カンマ区切り）で上書きできる。このプロジェクトの Vercel プレビュー
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
