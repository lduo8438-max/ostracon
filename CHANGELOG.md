# 變更記錄

版本號遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

**這裡只記對使用者可見的變更。** 內部量測、重構與設計理由在 `docs/status.md`，
那份是逐刀的完整紀錄，不是給使用者讀的。

判斷「可見」的標準有三條，符合任一條就要記：
指令與旗標的行為、**產出的內容**（同一份 repo 會不會印出不同的答案）、
以及資料庫的相容性（既有索引還能不能用）。

---

## [0.1.0] — 2026-08-30

第一次公開發布。

### 指令

- `ostracon why <path>:<symbol>` — 印出一段程式碼的演化史。預設只索引該檔案
  所屬的血緣（快）；`--full` 索引整個 repo，跨檔案搬移才看得見（慢）。
  路徑在 `--until` 已被刪除也查得到。
- `ostracon ostracised` — 列出試過又被推翻的做法。由短命到長命排序；
  測試檔的宣告預設排除，`--include-tests` 看得回來。
- `ostracon hotspots` — 列出被重構最多次的宣告。**只算真的動到結構的改動**，
  而且是 entity 層級不是檔案層級。
- `ostracon evidence extract` — 從 commit message 抽取理由並驗證 span。
  零網路、零 LLM。
- `ostracon evidence linked` — 取回被參照的 GitHub PR / issue 討論串。
  唯一會連外的指令。
- `ostracon ui` — 三欄畫面（結構 → 演化 → 意圖），只綁 `127.0.0.1`。
- `ostracon export` — 把索引匯出成純靜態站台。`--label` 必填，否則
  `summary.rootPath` 會把本機路徑公開出去。

三支查詢指令都收 `--until`，用來限制單次工作量。**產出與一次跑完相同**，
但它是可恢復、可排程的操作方式，**不是效能解法**——檢查點落在 commit 邊界。

### 語言

TypeScript、TSX、Python。加一種語言等於新增一份剖面，匹配器／雜湊／圖遍歷
／增量索引都不動。

### 環境需求

Node 24 以上，**而且它的內建 SQLite 必須含 FTS5**。沒有 FTS5 時會在建立 schema
之前明確失敗並說明怎麼辦，而不是留下 `no such module: fts5`。

### 已知限制

六條全部列在 README，不只留在註解裡。最該先知道的兩條是平行分支上的血緣歸屬，
以及 `node:sqlite` 仍是實驗性 API。

### 資料庫相容性

`schema_migration` 記錄版本。發布版是 **v3**：

- **v2 → v3 就地遷移**，不要求重建。那一版只加了一條索引，產出逐位元不變。
- **v1 → v2 拒絕續用**。那一版改了資料的存法，舊索引不可能給出正確答案。

判準是「產出會不會變」，不是「版本號有沒有變」。

[0.1.0]: https://github.com/lduo8438-max/ostracon/releases/tag/v0.1.0
