import { defineConfig } from 'vite'

export default defineConfig({
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
