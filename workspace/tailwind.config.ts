import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: '#f7f8f7',
        canvas: '#07090d',
        panel: '#0d1117',
        line: '#222832',
        mint: '#79f2ce',
      },
      boxShadow: {
        signal: '0 0 48px rgba(121, 242, 206, .16)',
      },
    },
  },
  plugins: [],
} satisfies Config
