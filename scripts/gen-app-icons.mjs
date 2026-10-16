// アプリ（PWA）のアイコンを生成する一度きりのスクリプト。デザインは「濃い緑に丸文字の『ぶ』」（E 案）。
//   npm run gen:app-icons
// 出力: web/public/pwa/（manifest のアイコン）、web/app/apple-icon.png（iPhone のホーム画面）、web/app/favicon.ico
//
// 「ぶ」は M PLUS Rounded 1c ExtraBold（SIL Open Font License 1.1）の字形をアウトライン化したもの。
// フォントを読み込まずに描けるよう、100×100 の中央に置いたパスとして持つ。
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PWA_DIR = join(ROOT, 'web', 'public', 'pwa');
const APP_DIR = join(ROOT, 'web', 'app');
mkdirSync(PWA_DIR, { recursive: true });

const BG = '#047857'; // emerald-700
const FG = '#ffffff';
const BU_PATH =
  'M46.05 68.26Q48.44 68.26 49.88 67.04Q51.32 65.81 51.32 63.77Q51.32 61.91 50.33 60.12Q49.34 58.32 46.53 55.33Q43.59 52.15 42.39 49.76Q41.20 47.36 41.20 44.73Q41.20 40.18 46.35 35.68Q46.41 35.62 46.41 35.56Q46.41 35.50 46.35 35.50L35.87 35.50Q34.49 35.50 33.50 34.52Q32.51 33.53 32.51 32.15L32.51 30.71Q32.51 29.34 33.50 28.35Q34.49 27.36 35.87 27.36L55.69 27.36Q57.07 27.36 58.09 28.35Q59.10 29.34 59.10 30.71L59.10 33.41Q59.10 36.40 55.93 38.08Q51.32 40.48 51.32 43.71Q51.32 45.27 52.25 46.97Q53.17 48.68 55.75 51.61Q59.16 55.51 60.45 58.20Q61.74 60.90 61.74 63.77Q61.74 69.88 57.61 73.41Q53.47 76.95 46.53 76.95Q42.69 76.95 38.56 75.45Q37.24 74.97 36.68 73.62Q36.11 72.28 36.65 70.90L37.30 69.28Q37.78 67.96 39.07 67.39Q40.36 66.83 41.68 67.30Q44.37 68.26 46.05 68.26Z' +
  'M61.38 25.86L61.50 25.86Q62.76 25.20 64.13 25.62Q65.51 26.04 66.17 27.30Q66.53 27.96 67.19 29.28Q67.85 30.59 68.09 31.01Q68.69 32.27 68.24 33.59Q67.79 34.91 66.53 35.50Q65.21 36.10 63.86 35.62Q62.52 35.15 61.86 33.89Q61.02 32.15 60.00 30.35Q59.34 29.16 59.73 27.81Q60.12 26.46 61.38 25.86Z' +
  'M75.57 24.84Q77.55 28.62 77.61 28.74Q78.27 30.00 77.82 31.31Q77.37 32.63 76.11 33.23L75.99 33.35Q74.73 33.95 73.36 33.50Q71.98 33.05 71.32 31.79Q70.96 31.19 70.30 29.94Q69.64 28.68 69.34 28.08Q68.69 26.88 69.07 25.50Q69.46 24.13 70.72 23.53L70.96 23.47Q72.22 22.81 73.57 23.20Q74.91 23.59 75.57 24.84Z' +
  'M75.51 68.38L73.60 68.98Q72.22 69.40 70.93 68.71Q69.64 68.02 69.22 66.71Q66.35 58.50 63.06 52.15Q62.46 50.96 62.91 49.67Q63.36 48.38 64.61 47.84L66.53 46.94Q67.85 46.34 69.19 46.85Q70.54 47.36 71.20 48.62Q74.73 55.87 77.67 64.19Q78.15 65.51 77.49 66.74Q76.83 67.96 75.51 68.38Z' +
  'M25.87 69.16L24.01 68.38Q22.69 67.84 22.21 66.56Q21.73 65.27 22.33 64.01Q25.15 57.78 27.72 49.88Q28.20 48.50 29.43 47.81Q30.66 47.12 32.03 47.42L34.13 47.90Q35.51 48.20 36.20 49.40Q36.89 50.60 36.47 51.91Q34.07 59.82 30.48 67.42Q29.88 68.74 28.53 69.22Q27.18 69.70 25.87 69.16Z';

/**
 * @param {object} o
 * @param {number} [o.scale]  字の大きさ（1 = 幅 56 / 100）。maskable は切り抜かれても収まるよう小さく、ファビコンは読めるよう大きく
 * @param {number} [o.radius] 角丸（0 = 正方形のまま。iPhone と maskable は OS が切り抜くので正方形にする）
 */
function svg({ scale = 1, radius = 0 } = {}) {
  const t = `translate(${50 - 50 * scale} ${50 - 50 * scale}) scale(${scale})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="${radius}" fill="${BG}"/><path d="${BU_PATH}" fill="${FG}" transform="${t}"/></svg>`;
}

function png(source, size) {
  return new Resvg(source, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();
}

/** PNG をそのまま入れた ICO（Vista 以降のすべてのブラウザが読める） */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const rounded = svg({ radius: 22 });
writeFileSync(join(PWA_DIR, 'icon-192.png'), png(rounded, 192));
writeFileSync(join(PWA_DIR, 'icon-512.png'), png(rounded, 512));
// maskable: Android が丸などに切り抜いても字が収まるよう、中央 80% の円の中に置く
writeFileSync(join(PWA_DIR, 'icon-maskable-512.png'), png(svg({ scale: 0.8 }), 512));
writeFileSync(join(APP_DIR, 'apple-icon.png'), png(svg(), 180));
const favicon = svg({ scale: 1.15, radius: 20 });
writeFileSync(join(APP_DIR, 'favicon.ico'), ico([16, 32, 48].map((size) => ({ size, data: png(favicon, size) }))));

console.log('generated app icons -> web/public/pwa/, web/app/apple-icon.png, web/app/favicon.ico');
