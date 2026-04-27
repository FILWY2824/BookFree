/** @type {import('tailwindcss').Config} */
// The palette and tokens are deliberately the same as the reference
// project so the visual language carries over. Three families:
//
//   paper.*   warm off-white surfaces (page, card, panel)
//   ink.*     deep blue-greys for type and borders
//   accent.*  the single brand colour, used for primary action and
//             active-state. Conservative — never a fill on something
//             the user didn't explicitly request.
//
// Reader theming lives in CSS variables (`--reader-bg`, `--reader-fg`,
// `--reader-border`) overridden via `[data-reader-theme="..."]`. We
// expose the variables as Tailwind colour tokens so reader components
// can use `bg-reader text-reader border-reader` without juggling
// inline styles.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: {
          50: '#FAF7F2',
          100: '#F5F1EA',
          200: '#EBE5D9',
          300: '#D9D1BF',
        },
        ink: {
          300: '#A8AEB8',
          400: '#7A828F',
          500: '#5A626F',
          600: '#3F4855',
          700: '#2C3441',
          800: '#1B2230',
          900: '#0F1420',
        },
        accent: {
          DEFAULT: '#7C5A3A',
          dark: '#5E4128',
          light: '#A57E55',
        },
        // Reader themes — these resolve from CSS vars at runtime.
        reader: {
          DEFAULT: 'var(--reader-bg)',
          fg:      'var(--reader-fg)',
          border:  'var(--reader-border)',
          muted:   'var(--reader-muted)',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        serif: ['"LXGW WenKai"', 'ui-serif', 'Georgia', 'Cambria', '"Times New Roman"', 'serif'],
      },
      maxWidth: {
        reader: '42rem',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 20, 32, 0.04), 0 4px 12px -2px rgba(15, 20, 32, 0.06)',
        elev: '0 4px 24px -4px rgba(15, 20, 32, 0.18)',
      },
    },
  },
  plugins: [],
};
