import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
// **字體隨套件攜帶，不連外。** 先前這裡從 Google Fonts @import——那會讓
// `ostracon ui` 在離線或內網環境下退回系統字體，而這個專案的整個發行論述是
// 「零執行期相依、不上傳任何東西」。實測代價 83 KB：Plus Jakarta Sans 用變數
// 字體把五個字重收成一檔（26 KB），IBM Plex Mono 四個字重各約 14 KB。
//
// **只收 latin。** 變數字體的聚合入口（wght.css）會把 latin-ext 與 vietnamese
// 一起拉進來——實測多 30 KB，而這個介面是英文的，一個字都用不到。所以那一族
// 的 @font-face 寫在 index.css 裡，只指向 latin 那一檔；等寬字的 latin-400.css
// 等本來就是分開的，直接用。
import App from './App'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: Infinity,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
)
