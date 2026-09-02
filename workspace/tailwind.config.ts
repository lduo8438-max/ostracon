import type { Config } from 'tailwindcss'

export default {
  // **測試檔不得影響出貨產物。** Tailwind 是掃字串的：契約測試裡一個叫
  // `container` 的區域變數就讓 `.container` 那整組 utility 進了正式 CSS
  // （+288 bytes 的死碼）。掃描範圍要排除測試。
  content: [
    './index.html',
    './src/**/!(*.test).{ts,tsx}',
  ],
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
