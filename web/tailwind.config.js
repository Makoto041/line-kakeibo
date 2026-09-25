/** @type {import('tailwindcss').Config} */
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
        },
        ring: 'rgb(var(--ring) / <alpha-value>)',
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
        '3xl': '1.5rem',
      },
      boxShadow: {
        // v4 renamed the default scale (v3 `shadow-sm` -> v4 `shadow-xs`), which would
        // silently enlarge every existing `shadow-sm`. Pin it to the v3 value so the
        // rendered result stays identical.
        sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        glass: '0 1px 1px rgb(0 0 0 / 0.04), 0 8px 24px -12px rgb(15 23 42 / 0.18)',
        'glass-lg': '0 1px 1px rgb(0 0 0 / 0.05), 0 18px 48px -20px rgb(15 23 42 / 0.30)',
      },
      blur: {
        // 同じく v4 で blur スケールが 1 段ずれた（v3 `sm`=4px -> v4 `sm`=8px）。
        // v4 は blur と backdrop-blur で `--blur-*` を共有するため、ここを固定すると
        // `backdrop-blur-sm`（モーダル背景 2 箇所）が v3 と同じ 4px に戻る。
        sm: '4px',
      },
      keyframes: {
        blob: {
          '0%,100%': { transform: 'translate(0,0) scale(1)' },
          '33%': { transform: 'translate(24px,-32px) scale(1.08)' },
          '66%': { transform: 'translate(-18px,18px) scale(0.94)' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        blob: 'blob 18s ease-in-out infinite',
        'fade-up': 'fade-up 0.35s ease-out both',
      },
    },
  },
  plugins: [],
}
