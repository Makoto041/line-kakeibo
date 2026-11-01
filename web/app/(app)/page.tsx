import type { Metadata } from 'next';
import HomeClientPage from './HomeClientPage';
import { SITE_NAME, WEBSITE_JSON_LD, jsonLdScriptContent } from '@/lib/site';

// トップ（/）だけは検索に出し、サイト名とアイコンを正しく表示させる（ほかのページはルートの metadata の noindex のまま）。
// リンクはたどらせない（follow: false）。robots.txt と next.config.ts の X-Robots-Tag もトップだけ許可している。
// 画面はクライアントコンポーネント（HomeClientPage）なので、metadata と JSON-LD はこのサーバー側のページで出す。
export const metadata: Metadata = {
  robots: {
    index: true,
    follow: false,
  },
  openGraph: {
    siteName: SITE_NAME,
  },
};

export default function Page() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScriptContent(WEBSITE_JSON_LD) }}
      />
      <HomeClientPage />
    </>
  );
}
