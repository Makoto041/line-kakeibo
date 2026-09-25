/** @type {import('tailwindcss').Config} */

// 新しい画面の文字サイズ（design.md §1.3 の採用値）。[サイズ, { 行の高さ, 太さ, 字間 }]
const kbText = (size, lineHeight, fontWeight, letterSpacing) => [
  size,
  { lineHeight, fontWeight, ...(letterSpacing ? { letterSpacing } : {}) },
];

module.exports = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Token-driven palette (RGB triplets defined in globals.css)
        bg: 'rgb(var(--bg) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        card: 'rgb(var(--card) / <alpha-value>)',
        line: 'rgb(var(--border) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          fg: 'rgb(var(--accent-fg) / <alpha-value>)',
          strong: 'var(--kb-accent-strong)',
          light: 'var(--kb-accent-light)',
        },
        ring: 'rgb(var(--ring) / <alpha-value>)',
        // 新しい画面の配色（--kb-*）
        ink: {
          DEFAULT: 'var(--kb-ink)',
          soft: 'var(--kb-ink-soft)',
          2: 'var(--kb-ink-2)',
          3: 'var(--kb-ink-3)',
          4: 'var(--kb-ink-4)',
          5: 'var(--kb-ink-5)',
          edit: 'var(--kb-edit-ink)',
        },
        dots: 'var(--kb-dots)',
        warn: {
          bg: 'var(--kb-warn-bg)',
          ink: 'var(--kb-warn-ink)',
          icon: 'var(--kb-warn-icon)',
          halo: 'var(--kb-warn-halo)',
        },
        ok: {
          bg: 'var(--kb-ok-bg)',
          ink: 'var(--kb-ok-ink)',
          fill: 'var(--kb-ok-fill)',
        },
        off: {
          bg: 'var(--kb-off-bg)',
          ink: 'var(--kb-off-ink)',
          fill: 'var(--kb-off-fill)',
        },
        danger: 'var(--kb-danger)',
        'danger-ink': 'var(--kb-danger-ink)',
        chip: {
          bg: 'var(--kb-chip-bg)',
          rim: 'var(--kb-chip-rim)',
          ink: 'var(--kb-chip-ink)',
        },
        'nav-ink': 'var(--kb-nav-ink)',
        divider: 'var(--kb-divider)',
        skeleton: 'var(--kb-skeleton)',
      },
      fontSize: {
        'kb-title': kbText('26px', '1.2', '700'),
        'kb-month': kbText('24px', '1.2', '700'),
        'kb-pill': kbText('14px', '1.2', '500'),
        'kb-pill-month': kbText('18px', '1.2', '500'),
        'kb-label': kbText('17px', '1.4', '500'),
        'kb-hero': kbText('62px', '1.1', '700', '-0.01em'),
        'kb-settle': kbText('68px', '1.1', '700', '-0.01em'),
        'kb-card-amt': kbText('44px', '1.15', '700', '-0.01em'),
        'kb-amt-lg': kbText('24px', '1.2', '700', '-0.01em'),
        'kb-amt': kbText('22px', '1.2', '600', '-0.01em'),
        'kb-pct': kbText('16px', '1.25', '500'),
        'kb-sub': kbText('17px', '1.4', '400'),
        'kb-banner': kbText('18px', '1.3', '600'),
        'kb-section': kbText('19px', '1.35', '500'),
        'kb-group': kbText('17px', '1.3', '500'),
        'kb-date': kbText('14px', '1.3', '400'),
        'kb-row': kbText('18px', '1.3', '500'),
        'kb-row-lg': kbText('19px', '1.3', '500'),
        'kb-seg': kbText('14px', '1.2', '500'),
        'kb-nav': kbText('14px', '1.2', '500'),
        'kb-chip': kbText('14px', '1.2', '500'),
        'kb-strip': kbText('15px', '1.3', '500'),
        'kb-btn': kbText('20px', '1.2', '700'),
        'kb-card-label': kbText('18px', '1.3', '500'),
        'kb-sum-label': kbText('18px', '1.3', '500'),
        'kb-note': kbText('18px', '1.3', '400'),
        'kb-avatar': kbText('32px', '1', '600'),
        // シートの中
        'kb-sheet-title': kbText('20px', '1.3', '700'),
        'kb-body': kbText('16px', '1.5', '400'),
        'kb-caption': kbText('14px', '1.4', '400'),
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
        '3xl': '1.5rem',
        // 新しい画面（design.md §1.4）
        'kb-xl': '28px',
        'kb-card': '24px',
        'kb-row': '20px',
        'kb-banner': '16px',
        'kb-strip': '12px',
      },
      boxShadow: {
        // v4 renamed the default scale (v3 `shadow-sm` -> v4 `shadow-xs`), which would
        // silently enlarge every existing `shadow-sm`. Pin it to the v3 value so the
        // rendered result stays identical.
        sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      },
      blur: {
        // 同じく v4 で blur スケールが 1 段ずれた（v3 `sm`=4px -> v4 `sm`=8px）。
        // v4 は blur と backdrop-blur で `--blur-*` を共有するため、ここを固定すると
        // `backdrop-blur-sm`（モーダル背景 2 箇所）が v3 と同じ 4px に戻る。
        sm: '4px',
      },
    },
  },
  plugins: [],
}
