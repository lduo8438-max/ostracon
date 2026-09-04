# 扇出、排序與可達性：資料與互動規格

**狀態**：提案。尚未實作。
**來源**：兩套陌生 repo 的實測（pypa/pip 16,241 commit、microsoft/playwright
17,815 commit），量測腳本 `reports/probe/profile.mjs`，兩套共用同一支。
**這份文件先定資料與互動規格，不畫版面。**

---

## 0. 先撤回一項

先前把「引文含硬換行 38–47%」列為缺陷候選。**那是量錯了層。**

`unwrapQuote`（`src/evidence/span.ts`）早就存在，`ostracon why` 與 `src/ui/data.ts`
都在用。儲存層逐字保留硬換行是**設計要求**（否則 `verifySpan` 不成立），而呈現層
已經把它收成空白。實測 playwright 的 API 回應：

```
DB   "due to UnhandledPromiseRejection, the\r\nrelated error should be…"
API  "due to UnhandledPromiseRejection, the related error should be…"
```

掃過所有引文表面之後，唯一殘留的是取主旨用 `char(10)` / `split("\n")`，在 CRLF
訊息上會留一個尾端 `\r`——pip 6 筆、playwright 0 筆，在終端機與 HTML 裡都不可見。
**不值得一個版本，記錄在此以免重新發現。**

跨句與孤兒括號仍在人工裁決軌上，這份提案不碰。

---

## 1. 實測基線

同一支腳本量的，兩套語料：

| | pypa/pip | microsoft/playwright |
|---|---:|---:|
| entity | 21,409 | 42,512 |
| 有可呈現 claim 的 entity | 4,243 | 4,155 |
| **有「專屬」理由的 entity** | **125** | **45** |
| 逐列 claim（現在畫面數的） | 6,866 | 6,982 |
| **相異引文（該數的單位）** | **762** | **490** |
| 縮小倍率 | 9.0× | 14.2× |
| 專屬引文 ／ 整批引文 | 152 ／ 610 | 54 ／ 436 |
| 最大扇出 | 790 | 341 |
| 中位扇出 | 3 | 6 |
| 前 53 條引文佔全部（引文,entity）組合 | 58.3% | 52.5% |

**兩個結構性事實：**

1. **理由的絕對量不隨語料成長。** entity 從 21,409 到 42,512 翻倍，而「有 claim
   的 entity」兩套都是約 4,200。策展上限的問題只會愈來愈嚴重。
2. **「說得清楚為什麼」的宣告是一個小集合。** 125 與 45。這不是排序問題——
   **它小到可以整份列出來。**

---

## 2. 不變量一：扇出是 scope，不是品質

> 一條引文指向 72 個 entity，產品要表達的是「這是一條整批理由，涵蓋 72 個
> entity」，不是「72 條獨立理由」。

**不做的事**：不用扇出門檻刪除、降權或收回任何理由。資料層保留完整的
（引文 × entity）關聯。

### 2.1 資料層

新增以引文為主鍵的視圖，與現有逐列的 `intent` 並存：

```ts
interface RationaleGroup {
  quoteId: string          // 引文文字的雜湊，穩定且可當網址片段
  text: string             // 已過 unwrapQuote
  kind: 'why' | 'constraint' | 'tradeoff' | 'abandoned_reason'
  commitSha: string        // 說這句話的那顆 commit
  scope: 'entity' | 'shared'
  entities: string[]       // stable_key；**完整清單，不截斷**
  reach: number            // = entities.length，與 entities 同一個陣列導出
}
```

`reach` **必須從 `entities` 導出**，不得另算——標頭數字與清單分岔在這個專案
已經出過事（CLI 說 5 顆聚合 commit、UI 說 6 顆）。

端點：`api/rationales.json`。**體積要先量**：pip 762 條 × 平均 9 個 entity，
playwright 490 × 14；估計 100–200 KB（gzip 前）。若超過就分片，分片規則要與
`evolution/<key>.json` 一致。

### 2.2 呈現與統計

- 引文只顯示一次。
- 整批引文明示 `Shared across N entities`。
- 受影響的 entity **預設折疊**，可展開、可在其中搜尋。
- **專屬與整批永遠分欄、分數、分母**，不合併成一個總數。

現有標頭「N entity rationales · M batch-only」數的是**列**。改成數**引文群組**：

| | 現在（列） | 改後（引文） |
|---|---:|---:|
| pip | 6,866 | 762 |
| playwright | 6,982 | 490 |

### 2.3 核心驗收

> **同一條引文的扇出增加，畫面上的理由數不得增加。**

可測：fixture 裡一條引文從 3 個 entity 變成 30 個，
`rationaleGroups(db).length` 與畫面標頭的兩個數字都必須不變，
而 `reach` 從 3 變成 30。**還原分組邏輯要讓這條紅。**

---

## 3. 不變量二：排序不合成分數

> churn 最高不等於解釋最好。單一加權分數會把兩個概念重新混在一起，
> 而且很難解釋成因。

### 3.1 兩個入口，兩個問題

| 入口 | 回答的問題 | 排序 |
|---|---|---|
| **Best explained**（預設） | 「哪些宣告有人說得出為什麼」 | 見下方字典序 |
| Most changed | 「哪些宣告被改最多」 | 維持現有 churn／結構改動 |

**預設是 Best explained**，因為產品承諾是讓人讀懂「為什麼」。Most changed 是另一條
分析軸，不得冒充理由品質。

Most changed 的每一列要逐列標示 `專屬` / `整批` / `無理由`——這是把兩條軸並排讓
使用者自己看出差異，而不是替他們合成。

### 3.2 可解釋的字典序（不發明 score）

1. 有專屬理由
2. 專屬理由數（多者前）
3. 有整批理由
4. 整批理由的**最小扇出**（小者前）
5. churn（tie-breaker）

每一層都可以用一句話解釋成因，而加權分數不行。

### 3.3 驗收

**不是檢查排序函式，是檢查第一屏真的出現高資訊量案例。**

在 pip 與 playwright 上各印前 10 名，人工確認：

- pip 的第一屏必須含 1:1 引文的持有者（例如 `to prevent UnicodeDecodeError (#13670)`）
- **pip 的 `InstallRequirement` 不得出現在 Best explained 的第一屏**
  （543 次改動、73 條理由、只有 1 條專屬且在第 3,523 行）——它是 Most changed 的
  第一名，兩個入口在第一屏就該分得開
- playwright 的第一屏不得被 `Frame`／`Page` 佔滿（兩者專屬理由皆為 0）

集合大小已知：Best explained 的「第一級」（有專屬理由）在 pip 是 **125 個**、
playwright 是 **45 個**。**小到可以整份列出**，所以第一級不需要分頁。

---

## 4. 不變量三：可達性拆成三個契約

> 不要再用一句「所有 entity 可達」同時描述 server、靜態匯出與 demo。

| 契約 | 定義 |
|---|---|
| **Indexed** | 資料庫裡存在的全部 entity |
| **Discoverable** | 可由搜尋／目錄找到，**且知道它有沒有理由** |
| **Inspectable** | 可打開完整 timeline |

### 4.1 三種部署的目標

- **本機 server**：所有 indexed 都應 discoverable 且 inspectable。
  現況 `listEntities` 預設 400 是個 cap，要換成搜尋。
- **靜態匯出**：允許只匯出子集，但**必須公開涵蓋率、選取規則與缺席原因**。
- **UI**：任何顯示為可點擊的 entity 必須有 timeline；任何未匯出的 entity
  **不得偽裝成不存在**。

### 4.2 cap 進資料契約，不只進文案

`summary.json` 新增：

```ts
coverage: {
  indexed: 21409,
  discoverable: 400,
  inspectable: 752,
  rule: 'entities with a rationale, topped up by change count',
  absentReason: 'not included in this export'
}
```

畫面上的「400 exported / 21,409 indexed」必須**由這組欄位算出來**，不得手寫。

### 4.3 是否全量匯出，由體積決定

playwright 有 42,512 條 timeline。是否全部靜態化是**體積與載入成本的問題**，
不是誠實性的問題——**誠實可達性不等於強迫全量匯出**。要先量：
單條 timeline 的中位大小 × 42,512，以及 GitHub Pages 的檔案數限制。

### 4.4 驗收

- `coverage.discoverable <= coverage.indexed`，且 `inspectable` 的每一個 key
  都真的有 `evolution/<key>.json`（**這條已經有測試**，擴到新欄位）。
- 本機 server 上 `discoverable === indexed`。
- 畫面上任何可點擊的 entity 都打得開（現有的「清單上的每一條都匯出得到時間軸」
  測試涵蓋一半，另一半是搜尋結果）。

---

## 5. 明確不做

- 不用扇出門檻刪除或降權任何理由。
- 不發明加權分數。
- 不為了對齊而強迫全量匯出。
- 不碰跨句與孤兒括號的引文邊界（人工裁決軌）。
- 不做 mobile timeline 重排（另一條線）。

---

## 6. 實作順序建議

1. **資料層先行**：`RationaleGroup` 與 `coverage`，兩者都可以在沒有畫面的
   情況下用 pip／playwright 驗證數字。
2. 標頭與統計改成數引文群組（**這一步就能驗核心驗收**）。
3. Best explained 入口（字典序），Most changed 加逐列標示。
4. 搜尋：本機 server 先做，靜態匯出的方案另議（可能是預先產生的索引檔）。

每一步都要能在 pip 與 playwright 上各跑一次並記下數字。
