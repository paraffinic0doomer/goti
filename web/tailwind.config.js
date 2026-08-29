/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink: { DEFAULT: '#121816', soft: '#4A5551', faint: '#79837F' },
        surface: { DEFAULT: '#FFFFFF', alt: '#EDF1EF', page: '#F6F8F7' },
        rule: { DEFAULT: '#D9DFDC', strong: '#B7C0BC' },
        taka: { DEFAULT: '#0B6B51', soft: '#E3EFEA' },
        debit: { DEFAULT: '#A5412B', soft: '#F7E8E4' },
        warn: { DEFAULT: '#8A6410', soft: '#F5EDDC' },
      },
    },
  },
  plugins: [],
};
