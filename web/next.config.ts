import type { NextConfig } from "next";

// ------------------------------------------------------------
// セキュリティヘッダー
// ------------------------------------------------------------

const isDev = process.env.NODE_ENV !== "production";
const isVercelPreview = process.env.VERCEL_ENV === "preview";

/** URL 文字列から origin を取り出す（不正・未設定なら fallback の origin） */
function originOf(url: string | undefined, fallback: string): string {
  try {
    return new URL((url || "").trim() || fallback).origin;
  } catch {
    return new URL(fallback).origin;
  }
}

// LIFF の ID トークンを Firebase カスタムトークンに交換する bot の `api` 関数（web/lib/lineAuth.ts）
const authEndpointOrigin = originOf(
  process.env.NEXT_PUBLIC_AUTH_ENDPOINT,
  "https://us-central1-line-kakeibo-0410.cloudfunctions.net/api/auth/line"
);
// bot の /household/*（確認・精算。web/lib/householdApi.ts）。未設定なら認証エンドポイントと同じ origin
const householdApiOrigin = process.env.NEXT_PUBLIC_API_BASE?.trim()
  ? originOf(process.env.NEXT_PUBLIC_API_BASE, authEndpointOrigin)
  : authEndpointOrigin;
// Firebase Auth がモバイルブラウザで先読みする認証用 iframe（web/lib/firebase.ts の authDomain）
const firebaseAuthOrigin = originOf(
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
    ? `https://${process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN.trim()}`
    : undefined,
  "https://line-kakeibo-0410.firebaseapp.com"
);

/**
 * Content-Security-Policy（全体を強制する。実機で Report-Only の違反が出ないことを確認済み）
 *
 * 許可リストはアプリが実際に読み込む・通信する先から作っている:
 * - Firebase Auth: identitytoolkit / securetoken、モバイルでは authDomain の iframe と apis.google.com
 * - Firestore: firestore.googleapis.com（WebChannel / long polling）
 * - Storage: firebasestorage.googleapis.com（レシート画像の表示・アップロード）
 * - LIFF SDK（npm 同梱）: api.line.me / access.line.me、liffsdk.line-scdn.net（翻訳データ）、
 *   static.line-scdn.net（拡張スクリプト・UI）、uts-front.line-apps.com（SDK の計測）、
 *   liff-subwindow.line.me（サブウィンドウ用 iframe）
 * - bot の `api` 関数（LIFF ログイン → カスタムトークン発行、確認・精算の /household/*）
 * - フォントは next/font がビルド時に自己ホストするため Google Fonts への通信は無い
 * - Next.js はインラインスクリプトを使うため script-src に 'unsafe-inline' が必要（nonce 化は別途）
 *
 * report-uri / report-to は未設定のため、違反はブラウザの DevTools コンソールでしか見えない。
 * 新しい通信先（外部のスクリプト・API・画像）を足すときは、ここの許可リストにも足すこと。
 * 足さないと本番でブロックされる（Vercel のプレビューでは vercel.live などを別途許可している）。
 */
const cspDirectives: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": [
    "'self'",
    "'unsafe-inline'",
    "https://static.line-scdn.net",
    "https://apis.google.com",
    ...(isDev ? ["'unsafe-eval'"] : []),
    ...(isVercelPreview ? ["https://vercel.live"] : []),
  ],
  "style-src": ["'self'", "'unsafe-inline'", ...(isVercelPreview ? ["https://vercel.live"] : [])],
  "img-src": [
    "'self'",
    "data:",
    "blob:",
    "https://firebasestorage.googleapis.com",
    "https://static.line-scdn.net",
    ...(isVercelPreview ? ["https://vercel.live", "https://vercel.com"] : []),
  ],
  "font-src": ["'self'", "data:", ...(isVercelPreview ? ["https://vercel.live", "https://assets.vercel.com"] : [])],
  "connect-src": [
    "'self'",
    "https://firestore.googleapis.com",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
    "https://firebasestorage.googleapis.com",
    authEndpointOrigin,
    householdApiOrigin,
    "https://api.line.me",
    "https://access.line.me",
    "https://liffsdk.line-scdn.net",
    "https://uts-front.line-apps.com",
    // 開発時: HMR の WebSocket と Firestore エミュレータ（web/lib/firebase.ts、localhost:8080）
    ...(isDev ? ["ws:", "wss:", "http://localhost:8080"] : []),
    ...(isVercelPreview ? ["https://vercel.live", "wss://ws-us3.pusher.com"] : []),
  ],
  "frame-src": [
    firebaseAuthOrigin,
    "https://liff-subwindow.line.me",
    ...(isVercelPreview ? ["https://vercel.live"] : []),
  ],
  // PWA: Service Worker（public/sw.js）と manifest（app/manifest.ts）はどちらも同じ origin
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
};

const contentSecurityPolicy = Object.entries(cspDirectives)
  .map(([directive, sources]) => `${directive} ${Array.from(new Set(sources)).join(" ")}`)
  .join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // /attach のカメラ撮影は <input type="file" capture> で、camera ポリシーの対象（getUserMedia）ではない。
  // 実機でカメラが起動しなくなった場合は camera=() を外す。
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
];

const nextConfig: NextConfig = {
  // `output: 'export'` removed: the static export produced RSC flight files
  // (e.g. `index.txt`) that browsers sometimes downloaded during client
  // navigation. Vercel builds/serves Next.js natively (via Git integration),
  // which handles RSC and serverless API routes correctly.
  trailingSlash: true,
  // X-Powered-By ヘッダーでフレームワークを名乗らない
  poweredByHeader: false,
  images: {
    unoptimized: true,
  },
  // Skip type checking during build (pre-existing React 19 / recharts typings)
  typescript: {
    ignoreBuildErrors: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      // 個人の家計簿なので、トップ（/）以外は検索エンジンにインデックスさせない（robots.txt と併用）。
      // トップだけは検索結果にサイト名とロゴ（ぶ）を出すため許可し、ロゴの画像も取得できるよう外す
      {
        source: "/((?!pwa/|favicon\\.ico|apple-icon\\.png|_next/).+)",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      // Service Worker は毎回取り直し、更新をすぐ反映する（キャッシュされると古い sw.js が残り続ける）
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          // Service Worker 自体は同じ origin にしか通信しない（ページの CSP とは別に、こちらは強制する）
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
