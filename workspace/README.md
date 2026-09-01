# Ostracon — Evolution Workspace

從 git history 重建出來的**決策演化史**的前端。它讀 `ostracon` 的索引，
把匹配階梯、身份斷層、時間軸、攪動熱點與被推翻的做法攤成五個畫面。

**這不是儀表板。** 這個工具的價值在於它敢留白：理由是稀有的（實測 Osiris 只有
4.0% 的 commit 說得出為什麼），所以沒有證據的地方就是空的，不補、不摺疊、
不用推測填滿。畫面上唯一的暖色只給**逐字引文**——看到它就是看到有人真的寫下
了那句話。

## 資料從哪來

`src/api.ts` 是對後端的唯一出入口，路徑一律是相對的 `/api/*.json`：

| 端點 | 內容 |
|---|---|
| `summary.json` | 語料規模、schema 版本、改動層級分佈、稀疏度 |
| `entities.json` | 宣告清單 |
| `ladder.json` | 匹配階梯 L1–L5 的分佈，與跨檔案搬移的逐條清單 |
| `discontinuities.json` | 身份斷層 |
| `hotspots.json` | 攪動熱點（只算真的動到結構的改動） |
| `ostracised.json` | 被推翻的做法 |
| `evolution/<stable_key>.json` | 一個宣告的完整時間軸 |

**`ostracon ui`（本機伺服器）與 `ostracon export`（靜態站台）用的是同一組
URL**，所以這裡沒有、也不該有「哪一種後端」的分支。

## 本機開發

```bash
# 另一個終端機：起後端
pnpm ui -- --db <index.db> --port 4319

# 這裡：vite 會把 /api 轉過去
npm install
npm run dev
```

## 尚未接的兩項

畫面現在**誠實留白**，不編造：

- **斷層的前後程式碼片段**。索引不存原始碼（只存 blob hash 與 byte 位移），
  要顯示得回讀 git blob。實跑驗過可行，但牽涉匯出流程與一條授權注意事項。
- **`hunkTouched`**。資料在 `file_hunk` 裡，但判準必須與 matcher 的
  `insidePureAddHunk` 共用——另寫一份就會出現「畫面說沒碰到、matcher 當時
  認為碰到了」。

## Stack

React 18 · TypeScript · Vite · Tailwind · TanStack Query · Framer Motion · Lucide
