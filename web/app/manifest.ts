import type { MetadataRoute } from 'next';

// PWA の manifest（/manifest.webmanifest）。ホーム画面に追加すると全画面のアプリとして開く。
// アイコンは scripts/gen-app-icons.mjs で生成する。名前は iPhone のホーム画面で切れない「ぶちこむ」
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'ぶちこむ家計簿',
    short_name: 'ぶちこむ',
    description: 'LINEで入力した支出を家計簿に保存するアプリ',
    lang: 'ja',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#f8fafc',
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
