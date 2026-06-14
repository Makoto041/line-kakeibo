// lucide の SVG を色付きPNGに変換し web/public/icons/ に出力する一度きりの生成スクリプト。
// LINE Flex の image は PNG/JPEG のみ対応のため、静的PNGとして配信する。
//   node scripts/gen-line-icons.mjs
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'node_modules', 'lucide-static', 'icons');
const OUT = join(ROOT, 'web', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

const SIZE = 96; // 出力PNGの一辺(px)
const ACCENT = '#10b981';

// key(出力名) -> [lucideアイコン名, 色]
const ICONS = {
  // カテゴリ（categoryVisuals の色に合わせる）
  'cat-food': ['utensils', '#f97316'],
  'cat-transport': ['bus', '#0ea5e9'],
  'cat-daily': ['shopping-bag', '#f59e0b'],
  'cat-fun': ['gamepad-2', '#d946ef'],
  'cat-clothes': ['shirt', '#ec4899'],
  'cat-health': ['heart-pulse', '#f43f5e'],
  'cat-education': ['graduation-cap', '#6366f1'],
  'cat-utility': ['lightbulb', '#eab308'],
  'cat-housing': ['house', '#14b8a6'],
  'cat-insurance': ['shield-check', '#06b6d4'],
  'cat-tax': ['landmark', '#78716c'],
  'cat-beauty': ['sparkles', '#a855f7'],
  'cat-comm': ['smartphone', '#3b82f6'],
  'cat-subscription': ['refresh-cw', '#8b5cf6'],
  'cat-gift': ['gift', '#ef4444'],
  'cat-travel': ['plane', '#10b981'],
  'cat-pet': ['paw-print', '#84cc16'],
  'cat-savings': ['piggy-bank', '#22c55e'],
  'cat-other': ['ellipsis', '#94a3b8'],
  // ユーティリティ（emerald）
  'wallet': ['wallet', ACCENT],
  'receipt': ['receipt', ACCENT],
  'calendar': ['calendar-range', ACCENT],
  'paperclip': ['paperclip', ACCENT],
  'list': ['list', ACCENT],
  'credit-card': ['credit-card', ACCENT],
  'users': ['users', ACCENT],
  'external-link': ['external-link', ACCENT],
  'message': ['message-circle', ACCENT],
};

// lucide名の揺れに対するフォールバック
const FALLBACK = { house: 'home', ellipsis: 'more-horizontal' };

function loadSvg(name) {
  let p = join(SRC, `${name}.svg`);
  if (!existsSync(p) && FALLBACK[name]) p = join(SRC, `${FALLBACK[name]}.svg`);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

let ok = 0;
const missing = [];
for (const [key, [name, color]] of Object.entries(ICONS)) {
  const svg = loadSvg(name);
  if (!svg) { missing.push(`${key}(${name})`); continue; }
  const colored = svg.replace(/stroke="currentColor"/g, `stroke="${color}"`);
  const resvg = new Resvg(colored, { fitTo: { mode: 'width', value: SIZE }, background: 'rgba(0,0,0,0)' });
  const png = resvg.render().asPng();
  writeFileSync(join(OUT, `${key}.png`), png);
  ok++;
}
console.log(`generated ${ok} icons -> web/public/icons/`);
if (missing.length) console.log('MISSING:', missing.join(', '));
