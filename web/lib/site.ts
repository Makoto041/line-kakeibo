// 検索結果に出すサイトの名前と URL（トップページの metadata と JSON-LD。app/(app)/page.tsx）。
// トップ（/）だけは検索に出す（robots.txt・next.config.ts の X-Robots-Tag・ルートの metadata と合わせる）。
// Google はサイト名をトップの WebSite の構造化データ・og:site_name・<title> から決める。
// 無いと vercel.app のドメインから推測され「Vercel」と出る。

/** 本番の Web のトップ（末尾 / 付き。next.config.ts の trailingSlash と同じ形） */
export const SITE_URL = 'https://line-kakeibo.vercel.app/';

/** サイト名（manifest の name・metadata の applicationName と同じ） */
export const SITE_NAME = 'ぶちこむ家計簿';

/** 別名（<title> と同じ） */
export const SITE_ALTERNATE_NAMES = ['ぶちこむ家計簿アプリ'];

/** トップに出す schema.org の WebSite（固定の値だけ。利用者の入力は入れない） */
export const WEBSITE_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE_NAME,
  alternateName: SITE_ALTERNATE_NAMES,
  url: SITE_URL,
};

/**
 * <script type="application/ld+json"> の中身。`<` を < にして、値に `</script>` が入っても
 * スクリプトの外に出ないようにする（JSON としては同じ値）
 */
export function jsonLdScriptContent(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
