/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  // **契約測試要真的把元件掛起來。** 上線後的兩個全黑崩潰都在 render 本體
  // （`rows[0].id`、`selected.sha`），任何只驗資料的測試都攔不住，而先前這裡
  // 一條渲染測試都沒有。jsdom 是為了 `window.location.hash`——深連結的冷開
  // 路徑會讀它。
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
  },
  // **資產路徑必須是相對的。** 預設的 base '/' 會產生 `/assets/…`，那在
  // `ostracon ui`（從根服務）看起來完全正常，但線上 demo 把每套語料放在
  // 子目錄（`/vuejs-core/`），瀏覽器會去根目錄找 `/assets/…` 而拿到 404。
  //
  // **同一份產物，兩種部署方式，本機只驗得到其中一種。** 發布前把匯出放進
  // demo 的目錄結構起站台才撞到——這條之所以以前不存在，是因為舊頁面把
  // CSS 與 JS 全部內嵌，根本沒有外部資產。
  base: './',
  server: {
    host: '127.0.0.1',
    port: 4324,
    // 開發時把 /api 轉給本機的 `ostracon ui`。**正式環境不需要這段**：
    // 匯出的靜態站台與伺服器用的是同一組 /api/*.json 路徑，頁面因此沒有
    // 「靜態版／伺服器版」的分支——那是後端刻意的設計，前端不要破壞它。
    proxy: {
      '/api': { target: 'http://127.0.0.1:4319', changeOrigin: true },
    },
  },
  build: {
    // **產物落在套件的 dist 裡**，因為 `files` 白名單只有 dist——額外的資產
    // 目錄要另接一套複製步驟，那就是安裝摩擦的開始。
    outDir: '../dist/ui/app',
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) return
        warn(warning)
      },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) return 'motion'
          if (id.includes('@tanstack')) return 'query'
        },
      },
    },
  },
})
