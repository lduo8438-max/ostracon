# 專案現況

> 這份文件記錄「現在長什麼樣」，隨程式碼變動更新。定義與理由在 `architecture.md`，
> 規則在 `../CLAUDE.md`，資料模型的唯一真相是 `../db/schema.sql`。
>
> 最後更新：2026-08-17

---

## 1. 怎麼在你的機器上重建語料

**所有錨點都是 git 原生座標，任何機器都能重建。** 本機的絕對路徑在
`../CLAUDE.local.md`，不在版控裡。

| 語料 | 來源 | 釘死的終點 |
|---|---|---|
| Osiris（黃金測試集） | `https://github.com/simplifaisoul/osiris.git` | `994a5dcd69385e97cf7d1faa1263e5a51987da6b` |
| create-t3-app（demo 與效能基準） | `https://github.com/t3-oss/create-t3-app.git` | `4709861f7e67a15564c0460c13e7b4b6cfcae40d` |
| zustand（效能複驗） | `https://github.com/pmndrs/zustand.git` | `beca84e600e4e250f6b244d22878e72948f331c7` |

```bash
git clone https://github.com/simplifaisoul/osiris.git
git -C osiris checkout 994a5dcd69385e97cf7d1faa1263e5a51987da6b
pnpm golden:index -- --repo ./osiris --fixture fixtures/osiris.yaml --db fresh.db
pnpm golden       -- --fixture fixtures/osiris.yaml --db fresh.db --report out.json
```

語料的 URL 與 SHA **必須留在 fixture 裡**——本機副本只是省一次 clone，
兩者不可互相取代。這也是不變量 14 的實際形態：黃金測試集的錨點只能是
git 原生座標，不得引用索引器產生的 ID。

`reports/` 是量測產出與語料副本，在 `.gitignore` 裡，不是產品輸入。

---

## 2. 模組地圖

套件 `ostracon`（版本 `0.1.0`，可發布；`files` 白名單只有 `dist`、`db/schema.sql`、
README、LICENSE，`src/golden/` 不進封裝）。2026-08-03 實跑全部測試 **237/237 通過**、
`tsc --noEmit` **零錯誤**。

**Node 24 以上，且內建 SQLite 必須含 FTS5。** 實測 v24.14.1／CI 的 v24.18.0 可用、
v23.11.0 不可用（`no such module: fts5`，完整 schema 建不起來）。這是 runtime 差異，
不是測試回歸——`engines.node` 已由錯誤的 `>=22.13` 改為 `>=24`。

型別檢查於 2026-07-28 補上：devDependency `typescript` + `@types/node`，設定在
`tsconfig.json`，`pnpm test` 會先跑它。關鍵設定是 `erasableSyntaxOnly` 與
`verbatimModuleSyntax`——它們禁掉 `enum` / `namespace` / 建構子參數屬性等
無法只靠剝除型別執行的語法。少了這兩個，型別檢查通過也不代表
`node --experimental-strip-types` 跑得起來。`exactOptionalPropertyTypes` 試過後
關掉：它產生的 12 個錯誤全是雜訊，程式碼本身沒問題。

| 檔案 | 職責 | 備註 |
|---|---|---|
| `src/git/walk.ts` | git 呼叫、`--name-status` 解析 → `CommitRecord[]`、hunk 擷取（含 `--no-walk --stdin` 分批） | 用 `\x1e` / `\x1f` 當分隔符（commit message 可含任何字元） |
| `src/git/hunks.ts` | **純函式**：unified diff parser、路徑去引號、hunk 掛回 | 嚴格狀態機，見 `plan-diff-hunk.md` |
| `src/git/lineage.ts` | **純函式**：`CommitRecord[]` → 路徑血緣 | 不碰 git、不碰 DB |
| `src/git/types.ts` | 走訪、檔案變更與血緣的共用型別 | |
| `src/git/persist.ts` | 走訪層的 SQLite persistence | 含 FTS5 探測、增量水位線、血緣狀態載入、`file_hunk` 寫入、`openIndexDatabase` 與 schema 版本守門 |
| `src/git/index.ts` | 編排 + 增量 | force push 偵測（水位線非祖先即拒絕並要求重建） |
| `src/ast/types.ts` | `SynNode` 介面與 `LanguageProfile` | 欄位是 `startIndex`/`endIndex`（UTF-16），另有 `utf8ByteRange` 轉換 |
| `src/ast/hash.ts` | **純函式**：四層雜湊、S-expression、`changeLevel` 查表 | |
| `src/ast/bindings.ts` | **純函式**：區域繫結收集 | |
| `src/ast/profiles/typescript.ts` | TypeScript／TSX 的全部 grammar 相依知識 | 加語言＝加一份剖面 |
| `src/ast/profiles/python.ts` | Python 的剖面 | **存在的理由是驗證架構不寫死單一語言**，不是產品支援 |
| `src/ast/languages.ts` | 語言註冊表：副檔名 → wasm → 剖面 | 加語言只該改這裡加一份剖面；副檔名重複登記直接拋錯 |
| `src/ast/adapter.ts` | tree-sitter → `SynNode` + `verifyAdapter` | 已通過真實驗證 |
| `src/ast/parser.ts` | grammar 載入、解析與啟動驗證 | 每份登記的 grammar 都必須有探測，缺一個就啟動失敗 |
| `src/match/ladder.ts` | **純函式**：L1–L5 匹配階梯（含 L3b、L3c）與「本檔新生」排除 | 兩者都需呼叫端提供 `hunksByLineage`，省略時皆不啟用 |
| `src/match/position.ts` | **純函式**：hunk 位移回推、純新增 hunk 判定 | L3c 與「本檔新生」的證據來源 |
| `src/match/signature.ts` | n-gram、MinHash、精確 Jaccard | |
| `src/index/structural.ts` | 結構層共用寫入：觀察宣告、slot / entity / revision / match / change | **零 LLM**。materializer 與 `why` CLI 共用同一份，不各寫一份 |
| `src/index/lineage-pass.ts` | 單一路徑血緣的完整結構索引（解析→匹配→寫入） | `why` 的快路徑；**看不到跨檔案搬移** |
| `src/index/excursion.ts` | entity 層級迂迴偵測（A/C 級，零 LLM） | 搬移守門是必要條件；`scope` 必填且進版本字串 |
| `src/index/repo-pass.ts` | 全 repo 結構索引；候選池涵蓋一次改動的所有檔案 | L5 唯一能成立的條件；水位線 `pass_name = 'declarations'` |
| `src/cli/why.ts` | `why <path>:<symbol>` 時間軸查詢與呈現 | stated／linked 視覺分層；linked 依 provenance root 查詢時去重；`--full` 時觸發並呈現 excursion；已刪路徑走 `lineagesEverAt` fallback |
| `src/cli/ostracised.ts` | 被推翻的做法清單 | `pnpm ostracised`；一律全 repo pass，scope 不符即拒印 |
| `src/cli/hotspots.ts` | 攪動熱點：被重構最多次的宣告 | 只算 `shape`；entity 層級而非檔案層級（檔案級 `git log` 就有）；測試檔沿用 `isTestPath` |
| `src/evidence/span.ts` | **純函式**：span 斷言（零寬容、零 LLM、零 IO） | 信譽架構的基石；突變測試驗證過會咬 |
| `src/evidence/extract.ts` | **純函式**：規則式理由抽取、issue 參照抽取 | linked Markdown 模式排除 code fence／引用行，不放寬因果標記 |
| `src/evidence/store.ts` | stated／linked 文件抽取；候選驗證後才升格 `evidence` | 零網路；兩種 tier 共用 staging 與 span 驗證 |
| `src/cli/extract-evidence.ts` | 對既有索引跑證據層並回報理由覆蓋率 | `pnpm evidence:extract` |
| `src/http/types.ts` | `HttpFetcher` / `HttpResponse` 網路邊界 | linked orchestration 只依賴此介面 |
| `src/http/github.ts` | GitHub live adapter | **產品樹唯一直接呼叫 `fetch` 的檔案**；Node 全域 fetch，零新相依 |
| `src/http/fixtures.ts` | HTTP fixture 錄製／replay、敏感 header 濾除 | 測試與 golden 只用 replay |
| `src/evidence/linked.ts` | PR/issue body、comments、reviews → `source_doc`；修正 `to_kind`；linked 水位線 | 不知道 live/replay 的差別 |
| `src/cli/linked-evidence.ts` | 注入 live／record／replay fetcher | `pnpm evidence:linked`；無 token 時安全略過 |
| `src/claim/derive.ts` | verified evidence → 分型 claim（含 excursion 主體的 `abandoned_reason`） | 零 LLM；規則版本 `rule-claim-0.4.0+excursion-entity-binding` |
| `src/claim/aggregate.ts` | 聚合訊息偵測（squash merge 把 N 個 PR 壓成一顆） | 判準是結構不是數量；CRLF 一併處理 |
| `src/claim/scope.ts` | 一條理由的尺度：專講這個宣告，還是整批改動共用 | **CLI 與畫面共用**，不各算一次 |
| `src/ui/data.ts` | 組裝結構／時間軸／意圖／被推翻的做法 | 一律讀 `v_presentable_claim`；`ostracisedFor` 走 CLI 的同一支查詢 |
| `src/ui/page.ts` | 三欄 HTML／CSS／JS | 列高逐列量測、雙向同步捲動；**整份是一個樣板字串，註解裡的反引號會截斷它** |
| `src/ui/server.ts` | 唯讀本機 HTTP server | 只綁 `127.0.0.1`，零外部資源；端點是路徑式 `.json` |
| `src/ui/export.ts` | 把索引匯出成純靜態站台（線上 demo） | `--label` 必填，否則會公開匯出者的本機路徑 |
| `src/cli/main.ts` | 子指令分派 | 各支直接執行時走的是同一個 `main(args)` |
| `src/cli/ui.ts` ／ `src/cli/export-site.ts` | `ostracon ui` ／ `ostracon export` | — |
| `src/golden/corpus.ts` | 依 fixture 的 `clone_url` / `index_until` 取回語料 | `readdirSync` 掃整個 `fixtures/`，新 fixture 自動被認得 |
| `src/golden/materialize.ts` | 從 fixture + 真實 repo 建立 golden DB 座標、revision 與 match | fixture 專用；寫入層已改用 `src/index/structural.ts` |
| `src/golden/evaluate.ts` | 查詢 golden DB，將單一案例判為 pass/fail/missing | 會讀 SQLite，不是純函式 |
| `src/golden/report.ts` | **純函式**：分層彙總、Markdown、逐案例迴歸偵測 | 比率排除 ambiguous 案例，**迴歸閘門不排除** |
| `src/golden/cli.ts` | golden runner CLI | 舊文件誤寫的 `src/golden/run.ts` 不存在 |
| `src/golden/audit-matches.ts` | 對完整歷史的非 L1 配對與 ambiguity bucket 做審計 | |

**把核心邏輯寫成純函式（不吃 git、不吃 tree-sitter、不吃 DB）是刻意的架構決定**，
已多次兌現：npm 被封鎖時仍能完整測試雜湊層；一個跨批次血緣的嚴重 bug 只有純函式
的單元測試踩到，整合路徑剛好繞過了它。

### 加 Python：三個寫死的 TypeScript 假設 + 一個死旗標（2026-08-22）

W5 的第一項。**目的不是支援 Python，是驗證「加新語言＝新增一份剖面」這句話成立。**
它在 W1 就寫在 `types.ts` 的註解裡，但只在 TypeScript 與 TSX 上驗過——而那兩份
共用同一個 npm 套件、同一份 grammar 設計。實際加上第三種語言之後，那句話當時
並不成立，四個缺陷全部屬於本專案追了整個 W2–W4 的同一型：**宣稱支援兩種東西，
只驗了其中一種。**

| # | 缺陷 | 症狀 |
|---|---|---|
| 1 | `adapter.ts` 用字面值判斷「值是函式才算宣告」 | `variable_declarator` / `value` / `arrow_function` 四個 TS 專屬字串寫在語言中立層 |
| 2 | `preservedIdentifierTypes` 依**型別**保護屬性名 | Python 的 `self._d` 的 `_d` 是普通 `identifier`，於是 `self._data` 改成 `self._cache` **alpha 雜湊相等**——真實改動被歸類成「沒有改動」 |
| 3 | `parser.ts` 的 `grammar === "tsx" ? tsxProfile : typescriptProfile` | 第三種語言會被**靜默**判成 TypeScript：型別檢查過得去，雜湊用錯剖面照樣算得出數字 |
| 4 | `BindingRule.destructuring` 是死旗標 | 註解說它會遞迴進解構模式，但 `harvest` 兩個分支都會遞迴進全部子節點。對 `src/` 437 個宣告與 create-t3-app 213 個宣告實測，開不開差異 **0** |

修法：`profile.valueBearingDeclarations`、`profile.preservedFields`（依欄位保護）、
語言註冊表 `src/ast/languages.ts`、把死旗標換成真正需要的反向軸 `directOnly`
（Python 的 `parameters` 少了它會把型別註記收成繫結，`def f(x: int)` 與
`def f(x: str)` 的 alpha 雜湊會相等）。

**驗收是雙向的，兩邊都要成立。**

- **TypeScript 逐位元不變**：四套語料合計 **5,222 筆 revision** 的
  `hash_raw/token/alpha/alpha_self/shape` 與 `shape_profile` 指紋前後完全相同
  （osiris 1,582 `934d9efbbba1d567`、create-t3-app 3,606 `e591acbce0d88120`、
  vue-core 2 `e86b2c111792953a`、controlled 32 `3218f7d9312490d1`），
  四套黃金測試集全數 pass、測試 387 → 414。
- **新機制確實在做事**：把 `preservedFields` 與 `directOnly` 分別拿掉之後，
  對應的語意改動立刻變成看不見。**機制若拿掉也照樣通過，它就是下一個死旗標**——
  第 4 項就是這樣被抓到的，所以這一步不能省。

Python 實測（psf/requests，6,491 commits，`pnpm ostracised` 全 repo pass 3 分 04 秒）：

| 指標 | 值 |
|---|---|
| revision | 148,184（`python/0.25.0/sexp-1.0.0`） |
| entity | 3,406 |
| 匹配階梯 | L1 143,918／L2 753／L3 2／L3b 17／L3c 11／L4 71／L5 21 |
| change_level | none 136,056／shape 5,753／birth 3,114／death 2,254／alpha 1,618／raw 1,184／token 31 |
| ostracised | A 確證 988／C 疑似 512（另 200 條在測試檔） |

**匹配器、雜湊、圖遍歷、增量索引沒有任何一處因為換語言而改動。** `ostracon why`
在 Python 符號上也直接跑得通（`requests/models.py:PreparedRequest.prepare_body`，
311 次改動，且正好走到「路徑在 HEAD 已不存在，fallback 到血緣」那條路徑）。

#### 三個還沒修的，都已量過

1. **裝飾器不在實體邊界內**（第二刀已修，見下一節）。
2. **docstring 進 token 層、JSDoc 不進**：同一個「只改說明文字」的動作在兩個
   語言被分到不同的 `change_level`。`commentTypes` 是型別集合，表達不了「區塊
   開頭的字串字面值」這種位置相依概念。**仍未修**，有測試釘住目前行為。
3. **`ostracised` 的測試檔判準是 TS 慣例**（第二刀已修，見下一節）。

#### 相依論證

`tree-sitter-python@0.25.0` 是新的執行期相依，而「不增加執行期相依」是禁令，
所以要論證：

- **形狀與已接受的 `tree-sitter-typescript` 完全相同**：同樣的 `install:
  node-gyp-build`、同樣的 `node-addon-api` / `node-gyp-build`、同樣把
  `tree-sitter` 列為 optional peer。不引入任何新種類的安裝步驟。
- **pnpm 實測不跑建置腳本**（`Ignored build scripts`），沒有原生編譯。
- **裝起來 7.2 MB**，其中 wasm 458 KB；對照 `tree-sitter-typescript` 的 37 MB。
- 解析走 `import.meta.resolve` 拿 wasm，與 TS 同一條路徑，封裝後位置照樣解得到。

**這筆相依是為了驗證架構而付的，不是為了產品支援 Python。** 若哪天判定不值得，
移除它只要刪一份剖面與註冊表裡的一列。

### 發布收斂：封裝冒煙測試與 README 的實測缺口（2026-08-23）

W6 的第一刀。兩件事，都只有真的跑一次才知道。

**一、封裝。** 這一輪把讀 `db/schema.sql` 的程式碼從 `cli/` 搬到 `git/persist.ts`
（`openIndexDatabase`）。`../../db/schema.sql` 在 `dist/git/` 與 `dist/cli/` 下的
深度剛好一樣，所以沒壞——**但那是巧合不是保證**。實際打包驗過：`pnpm build` →
`npm pack`（267.7 KB）→ 在封裝外 `npm install` → 執行，`why` 與 `hotspots` 都跑得通
（後者對 ostracon 自己的 repo 索引 1.76 秒）。CI 的冒煙測試因此多一條
`hotspots`：`why` 走快路徑、`hotspots` 走全 repo pass，兩者的失敗方式不同。

**二、README 的四處過期宣稱。** 其中一處是我自己的量測推翻的：

| 位置 | 原本 | 現在 |
|---|---|---|
| 測試數 | 310 | 427 |
| 效能 | 「線性外推一萬 commit 約 1 分鐘」 | 改為每 revision 計價的三語料表 |
| 語言 | 「只支援 TypeScript」 | 與下方 Python 段落矛盾，改為「產品意義上」 |
| Python revision 數 | 148,184 | 148,199（今日實測） |
| docstring | 「算 token 級改動」 | **實際是 `alpha` 級**——黃金案例量到的 |

**「一萬 commit 約一分鐘」錯的不只是數字，是形式**（見 §成本控制重新定義）。
README 現在給的是三套語料的 commit／revision／時間／峰值 RSS／索引體積，
並明說「要估你自己的 repo，估 revision 數不要估 commit 數」。

docstring 那一條是文件與實作分岔：單元測試講的是「docstring 進 token 層」
（意思是 token 層不剝掉它），README 把它寫成「算 token 級改動」，
而使用者看到的 `change_level` 是 `alpha`。兩者差一級。

峰值 RSS 這一輪新量（先前 README 只有 create-t3-app 一筆）：

| 語料 | commit | revision | 秒 | 峰值 RSS | 索引體積 |
|---|---:|---:|---:|---:|---:|
| create-t3-app | 1,378 | 3,606 | 8.6 | 443 MiB | 4.5 MB |
| psf/requests | 6,491 | 148,199 | 100.1 | 873 MiB | 52.5 MB |
| vuejs/core | 7,156 | 233,665 | 165.8 | 1,175 MiB | 93.1 MB |

**記憶體是以 revision 計價的第三個維度**（大語料 5–6 KB／revision）。
一個七千 commit 的 repo 要 1.2 GB RSS，那是安裝前該知道的事。

### architecture.md 的一致性掃描（2026-08-23）

`README.md` 那處「docstring 算 token 級」的轉述失真**在 architecture.md 有一份
一模一樣的**。四個組合都實測過：

| 動作 | change_level |
|---|---|
| Python 只改 docstring | **`alpha`** |
| Python 只改 `#` 註解 | `raw` |
| TypeScript 只改 JSDoc 內文 | `raw` |
| TypeScript 只改 `//` 註解 | `raw` |

**差兩級，不是一級。** 來源是單元測試那句「docstring **進** token 層」
（意思是 token 層不剝掉它）被轉述成「**算** token 級改動」——一字之差降了一級，
然後被複製到兩份文件。說明限制的句子本身失真，比限制本身更糟。

其餘四處：`revision.hash_alpha_self` 與 `revision.minhash` 的表名（schema v2
起在 `declaration_content`）、CI 冒煙測試現在跑兩支、靜態匯出那一節的
「284 MB 的 SQLite」（現在同一份索引是 93 MB）。最後一處**結論沒有變**，
更新它是為了不讓過期的量測繼續替一個仍然正確的決定背書。

**補上內容定址那一節。** 這是這一段最大的資料模型決定，先前只寫在
`plan-content-addressed.md` 與這份 status，而 `architecture.md` 才是「規則背後的
定義與理由」該去的地方。

### 攪動熱點：先量過才決定要不要做（2026-08-22）

W5 的最後一項。動手前先回答一個問題：**這個功能有沒有可能只是重做 `git log`。**

實測 vuejs/core，兩種排法排**檔案**：

| 排法 | 前三名 |
|---|---|
| 依全部 `revision_change` 列（含 `none`） | renderer.ts 18,349／compileScript.ts 12,828／component.ts 10,399 |
| 只算 `shape` | renderer.ts 805／createRenderer.ts 503／compileScript.ts 498 |

**top-10 重疊 8/10、top-20 重疊 16/20**——在檔案層級上，「攪動」怎麼算幾乎不影響
答案，而檔案的 commit 次數 `git log` 直接給得出來。**所以檔案級的熱點視圖不做。**

entity 層級是另一回事。同一份語料，攪動最高的 15 個宣告分佈在 **12 個檔案**，
而且 `renderer.ts` 一個檔案裡有**三個獨立熱點**（`baseCreateRenderer` 212 次、
`createRenderer` 193 次、`baseCreateRenderer.mountComponent` 66 次）。檔案級視圖
把它們併成一列，於是「這個兩千行的檔案裡到底是哪一段一直在變」永遠答不出來。
這是 git 給不出來的東西，所以值得做。

#### 三個判準，都是量出來的

1. **只算 `shape`。** vue 有 88.5% 的 `revision_change` 是 `none`。`createRenderer`
   有 480 列改動、其中只有 193 次真的動到結構——**那個比值本身是資訊**，
   所以兩個數字都印。
2. **排序用絕對次數，不用速率。** 「結構改動／天」看起來更公平，實測是小分母
   陷阱：`createRenderer.processSuspense` 9 次 ÷ 52 天 = 每年 63 次，會排在
   `compileScript` 217 次之上。存活天數是屬性不是門檻，印出來讓人自己判斷
   （與 `ostracised` 對 `duration_days` 的處理一致）。
3. **排名不是「最老的程式碼」**——這件事會讓整支指令變成廢話，所以量過：
   依結構次數排的前 20 名與依存活天數排的前 20 名**只重疊 3 個**。

測試檔沿用 `ostracised` 那一份 `isTestPath`，不另寫。斷層密度與迂迴密度在 vue 上
都被 `.spec.ts` 主導（`Suspense.spec.ts:setup` 被置換 4 次，那只是每個 `it()` 各寫
一個同名 `setup`），攪動也有同樣的問題。vue 隱藏 269 條、requests 隱藏 438 條，
標頭都會報數量。

#### 一道自己造的假閘門，當場修掉

「排序是絕對次數不是速率」第一版寫成對 `renderHotspots` 斷言——**而排序發生在
SQL，純函式只是照著印**。把 `ORDER BY` 改成速率之後那條測試照樣通過。改成對
`listHotspots` 用手寫 fixture 斷言之後才會咬。四個判準現在各自驗過會紅。

同一輪還被前提檢查抓到一個測試自己的錯：把註解加在函式**外面**時，宣告的位元組
範圍完全沒變，`change_level` 是 `none` 而不是 `raw`——那樣測試只證明了「沒動的
不算」，證明不了「只改註解的也不算」。

### 內容定址：資料庫小三倍，索引快四成（2026-08-22，schema v2）

設計與取捨在 `plan-content-addressed.md`。這裡只記前後數字。

**體積**（同一台機器、同一份語料、各一次全 repo pass）：

| 語料 | 前 | 後 | |
|---|---:|---:|---:|
| psf/requests | 181.2 MiB | **52.5 MiB** | −71.0% |
| vuejs/core | 279.0 MiB | **93.1 MiB** | −66.6% |

`revision` 表加索引在 requests 上從 **157.1 MB（86.7%）降到 19.5 MB（37.1%）**，
新增的 `declaration_content` 是 8.9 MB（11,001 列）——兩者合計 28.4 MB，
比原本那一張表少 **82%**。現在最大的兩塊換成 `revision_change`（11.4 MB）與
`revision_match`（7.8 MB），都不在這次的題目裡。

**時間**（這是意料之外的收穫，不是目標）：

| 語料 | 前 | 後 | |
|---|---:|---:|---:|
| psf/requests | 180.8 s | **100.7 s** | −44% |
| vuejs/core | 293.6 s | **170.0 s** | −42% |

每列少寫約 634 bytes、三條大索引少維護，寫入 I/O 直接反映在時間上。
每 revision 的成本因此從 1.22–1.26 ms 降到 **0.68–0.73 ms**、
從 1.24–1.25 KB 降到 **0.36–0.41 KB**。預算已在 `roadmap.md` §3 更新
（一萬 commit 由 6.9 分鐘變 4.0 分鐘）。

**驗收的重點不是變小，是沒變。**

- **四套 TypeScript 語料 5,222 筆 revision 的雜湊指紋，解碼後與改動前逐位元相同**
  （osiris 1,582 `5a32a4e9402dec0f`、controlled 32 `98428935e3a251d2`、
  create-t3-app 3,606 `fe4cae454f2da698`、vue-core 2 `0ebd96df5d8fa257`）。
  雜湊**值**沒有改變，改變的只是它存在哪裡、用幾個位元組存。
- **迂迴偵測的語意不變**：requests 1,701 條（A 1,079／C 622）、vue 1,285 條
  （A 710／C 575），前後完全相同，`stable_key` 集合也相同。這條要特別驗，
  因為搬移守門的查詢方向被換掉了（改成從內容表出發再 join 回 revision）。
- 五套黃金測試集全過，測試 421 全過。

**踩到一個會靜默壞掉的地方**：迂迴的 A 級判準是 `firstRaw === lastRaw`，
而 BLOB 從 SQLite 讀出來是 `Uint8Array`——`===` 在上面是**參照**比較，兩個內容
相同的緩衝區也會不相等，整個 A 級會靜默歸零。修法是查詢端用 `hex()` 讓它仍是
字串。**型別檢查抓不到這個**（兩邊都是 `string` 或都是 `Uint8Array` 都過得了），
是寫的時候想到才擋下來的。

**代價**：schema 換版，所有既有資料庫都要重建。`schema_migration` 那張表從 v0.5
起就存在卻從來沒有任何程式讀寫過，這次啟用它——否則舊資料庫的失敗方式會是
`no such column: content_id`，而那個訊息不會告訴任何人原因。建庫邏輯原本在
`why.ts` / `ostracised.ts` / `materialize.ts` 各抄一份，一併收斂成
`openIndexDatabase`。

### 成本控制重新定義：計價單位是 revision（2026-08-22 量測）

W5 排程上的「成本控制」原本指的是 LLM token。**零 LLM 之下那一項早就由四層雜湊
階梯兌現了**（`hash.ts` 的註解就這麼寫），所以先量清楚真實成本落在哪裡，再決定
要不要做、做什麼。四套語料在同一台機器同一輪跑完：

| 語料 | commit | entity | revision | 秒 | ms/commit | ms/entity | ms/rev | KB/rev |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| osiris | 99 | 307 | 1,579 | 4.2 | 42.6 | 13.7 | 2.67 | 1.95 |
| create-t3-app | 1,378 | 405 | 3,606 | 8.8 | 6.4 | 21.8 | 2.45 | 2.30 |
| psf/requests | 6,491 | 3,409 | 148,199 | 180.8 | 27.8 | 53.0 | **1.22** | **1.25** |
| vuejs/core | 7,156 | 6,561 | 233,665 | 293.6 | 41.0 | 44.7 | **1.26** | **1.24** |

**時間與空間是同一個軸。** 三套真實語料的離散度：ms/commit 6.4 倍、ms/entity
2.4 倍、ms/revision 2.0 倍；兩套大語料的 ms/rev 只差 3%、KB/rev 只差 1%。
小語料那兩筆 2.4–2.7 ms 是固定成本攤不掉，不是單位成本較高。

這同時回答了 §效能外推的變數可能挑錯了（2026-08-17）留下的問題：**方向對了
（commit 是壞軸），但答案不是 entity 而是 revision。** 每 commit 的 revision 數
在四套語料之間差 12.6 倍（2.6／15.9／22.8／32.7），那就是 commit 軸失準的全部原因。
預算已在 `roadmap.md` §3 重新表述。

#### 索引體積的組成：90% 的 revision 列在存重複內容

`dbstat` 逐表量測（psf/requests 181.2 MB／vuejs/core 283.7 MB）：

| 佔比 | requests | vue |
|---|---:|---:|
| `revision` 表 + 它的索引 | **86.7%** | **85.9%** |
| `revision_change` + 索引 | 6.3% | 5.8% |
| `revision_match` + 索引 | 4.3% | 4.4% |

`revision` 每列欄位內容約 692 bytes，其中：

| 欄位 | 每列 bytes | 佔內容 |
|---|---:|---:|
| `exact_ngram_hashes` | 205 | 28.3% |
| 五個雜湊（各 64 字元 hex） | 320 | 44.0% |
| `blob_sha`（40 字元 hex） | 40 | 5.5% |
| `signature` ／ `minhash` ／ `shape_profile` | 35／30／24 | 12.3% |
| 位置與外鍵（byte/line/id） | 約 30 | 4% |

**而相異的 `hash_raw` 只有 7.4%（requests）與 9.7%（vue）。** 也就是說九成以上的
列，那 634 bytes 的內容衍生欄位與另一列逐位元相同——差別只在 commit、路徑與位置
（位置確實會變，同一段程式碼會因為檔案別處的改動而位移，所以不能直接刪列）。

三個可能的方向，估算值都由上面的量測直接推出：

1. **內容定址**：把內容衍生欄位抽到以 `hash_raw` 為鍵的表，`revision` 只留 id、
   位置與外鍵。requests 的內容 102.6 MB → 約 18.6 MB，整個資料庫估**約 3 倍**縮減，
   三條大索引（alpha／alpha_self／shape 合計 34 MB）也一併降到 7.4% 的列數。
   代價是資料模型變更與全量重建，**要獨立設計與獨立 PR**。
2. **雜湊改存 BLOB**（32 bytes 而非 64 字元 hex）＋ `blob_sha` 同理：省 180
   bytes／列，requests 約 −13% 內容加索引鍵縮短，估整體 **−20%**。若做第 1 項，
   這一項應該併進去做，不單獨做。
3. **`exact_ngram_hashes` 的 200 門檻**：調低會讓更多列改用 minhash（30 bytes
   而非 205），但那會改變召回語意——**不是免費的空間，是拿精確度換的**，不列為
   成本控制的選項。

**第 1、2 項已經做了**（2026-08-22，作者裁定這是發布前最後一個資料模型變更窗口），
前後數字見下一節。第 3 項維持不採用。

### 裝飾器把宣告自身的名稱吸進 hash_alpha（2026-08-22，已修：剖面 1.1.1）

**第十四發，而且是第二刀自己留下的。** 移動實體邊界會連帶改變「誰是根節點」，
而那一點在 1.1.0 漏掉了。

`bindings.ts` 的 `walk(decl, true)` 只在**根節點**跳過 bindingRules，理由寫在
那段註解裡：套在根上會把實體自己的名字也正規化，`hash_alpha` 就等同
`hash_alpha_self`，兩者的區別整個消失。剖面 1.1.0 把實體節點換成包裝節點
`decorated_definition` 之後，`function_definition` 降成**子節點**——`isRoot`
對它是 false，於是 `{ nodeType: "function_definition", field: "name" }` 命中它。
**註解描述的正是實際發生的狀態。**

同一個包裝還讓 `declarationName` 失效：`decorated_definition` 的直屬子節點只有
`decorator` 與 `definition`，沒有 `name` 欄位，所以它一律回 `undefined`，
`hash_alpha_self` 退化成 `hash_alpha`。**兩個半邊都要修，缺一不可**——實測分別
還原任一半，帶裝飾器的測試都會紅。

psf/requests 全 6,491 commit 的前後對照（各一次全 repo pass）：

| 指標 | 前 | 後 | 差 |
|---|---:|---:|---:|
| `hash_alpha = hash_alpha_self` 的 revision | **12,464** | **0** | **−12,464** |
| change_level `token` | 32 | 31 | −1 |
| change_level `alpha` | 1,643 | 1,644 | +1 |
| L3 ／ L3b | 3 ／ 16 | 2 ／ 17 | −1 ／ +1 |
| revision ／ entity | 148,199 ／ 3,409 | 148,199 ／ 3,409 | 0 ／ 0 |
| excursion ／ 其餘 change_level ／ 其餘 tier | 不變 | | |

12,464 筆是 8.4% 的 revision（HEAD 快照上是 807 個宣告裡的 137 個，17.0%）。
**輸出層面只動了兩筆**：一次帶裝飾器的純改名從 `token`（「只改局部變數名」）
回到 `alpha`，一條配對從 L3 回到 L3b——L3 當時之所以成立，正是因為名字被吸收掉了。
`stable_key` 逐一比對 **3,409 個全部相同**，沒有任何身份漂移。

方向本來就是安全的（L3b 不觸發就往下掉，L4/L5 有精確驗證），錯的是分級：
帶裝飾器的宣告單純改名會被報成「只改局部變數名」。

**TypeScript 逐位元不變**：四套語料 5,222 筆 revision 的
`hash_raw/token/alpha/alpha_self/shape` 與 `shape_profile` 指紋前後完全相同
（osiris 1,582 `5a32a4e9402dec0f`、controlled 32 `98428935e3a251d2`、
create-t3-app 3,606 `fe4cae454f2da698`、vue-core 2 `0ebd96df5d8fa257`）。
`declarationWrappers` 只有 Python 非空，所以這一刀在 TypeScript 上照定義是 no-op，
但仍然量過才敢說。

剖面版本 1.1.0 → **1.1.1**。雜湊值變了就得升版（不變量 7），即使這份語料的
`stable_key` 恰好一個都沒動——混在同一個資料庫裡的話，跨水位線的 `change_level`
比較會拿兩套規則的 alpha 值互比。**版本字串把三份剖面串在一起，所以 Python 一動，
TypeScript 的既有資料庫也一併不得續跑**，那是刻意的保守。

抓到它的是「幫 Python 找黃金測試集案例」的過程，不是測試——
`python-profile.test.ts` 的「宣告自身改名由 hash_alpha_self 吸收」用的是**沒有
裝飾器**的 `def f`。現在那條測試改成帶／不帶裝飾器各跑一次。

### Python 進黃金測試集（2026-08-22）

**在這之前，整道閘門只有 TypeScript 語料。** W5 加 Python 的論點是「加新語言＝
新增一份剖面，匹配器／雜湊／圖遍歷／增量索引一處都不動」，而那個論點原本只有
一次手跑 psf/requests 6,491 commit 的量測撐著——不可重跑、不進 CI。剖面被改壞的
話，四套 TypeScript 語料逐位元不變，閘門一聲不響。

語料選 psf/requests，`index_until` 釘在 `4d6871d917`（1,744 個 commit）。這份
fixture 沒有 excursion 案例，所以 `golden:index` 不跑全 repo pass——**實測
clone 16 MB／6.9 秒、materialize 2.8 秒**，是整道閘門裡最便宜的一步。

四條案例，每一條都先驗過會咬：

| 案例 | 釘什麼 | 拿掉什麼機制會紅 |
|---|---|---|
| `py-docstring-edit-is-alpha` | 只改 docstring 是 `alpha`（字串字面值不是註解） | `string` 加進 `commentTypes` → `raw` |
| `py-comment-edit-is-raw` | 只改 `#` 註解是 `raw` | `comment` 移出 `commentTypes` → `shape` |
| `py-declaration-rename-only` | 純改名走 L3b（`hash_alpha_self`） | 拿掉自身名稱正規化 → L4 |
| `py-method-move-across-files` | 帶類別名前綴的方法跨檔案搬移走 L5 | 拿掉 `class_definition` → 兩條 missing |

**前兩條是一對，缺一不可。** 單獨的 docstring 案例只證明「這顆 commit 是 alpha」，
證明不了「docstring 與註解不同」；註解那條是對照組，兩條一起才鎖得住那條分界線。
實測也確認它們互不重疊：破壞 `commentTypes` 的兩個方向各自只讓其中一條紅。

**刻意沒收進來的兩件事，理由寫在 fixture 裡而不是假裝有覆蓋**：裝飾器編輯
（整個 requests 歷史只有三顆「只改裝飾器」的 commit，最早在 2016 年、要多索引
4,000 多個 commit）與屬性名的 alpha 保護（早期歷史沒有單純改 `self.<attr>` 的
commit，硬找一顆夾雜其他改動的來當錨點，失敗時分不出是哪裡壞了）。兩者都由
`test/python-profile.test.ts` 直接釘住。

fixture 沒有負例，驗證器會警告——與 vue-core 相同。現有的案例類型表達不了
「這個符號不得被當成宣告」（模組層級賦值那類），而唯一想得到的迂迴負例
（搬移的方法不得判為迂迴）在 lineage 案例通過時必然通過，**不會失敗的案例
什麼都沒守到**，所以不收。

### 版本守門只裝在兩條路徑裡的一條（2026-08-22，已修）

**第十三發。** 而且是上一刀自己留下的：剖面版本進水位線那一節寫的「水位線那條
路徑早就有版本不符就拒絕的處理」只對全 repo pass 成立。`resolveResumePoint` 有
守門，`indexLineage` 一道都沒有——**而 `ostracon why` 預設走的是快路徑**。

實測（Osiris 前 50 個 commit 建一份索引，再把 declarations 版本字串裡的剖面段落
拿掉，模擬「加 Python 之前建的資料庫」，然後續跑到 HEAD）：

| 執行方式 | 修正前 | 修正後 |
|---|---|---|
| `why --full` | 拋錯，訊息說要刪檔重建 | 不變 |
| `why`（預設） | **靜默續跑，revision 208 → 371** | 拋同一則錯誤，208 列原封不動 |

修正前那 371 列裡，208 列用舊剖面算、163 列用新剖面算，混在同一個資料庫。
**更糟的是第二層**：收尾的 `recordDeclarationScope` 把水位線覆寫成新版本字串，
混合的證據當場消失——下一趟 `--full` 看到版本相符，判定為增量，永遠不會重建。
所以測試除了斷言拋錯，也斷言**水位線不得被改寫**；只驗前者的話，這一層會漏掉。

修法：`assertDeclarationsResumable`（`repo-pass.ts`）裝在 `indexLineage` 進場處，
兩個 pass 共用同一段比對與同一則錯誤訊息。比對的是版本字串**去掉 `+scope:` 之後**
的部分，所以既有的兩種行為都保留：`lineage` → `repo` 照樣自動作廢重建，repo scope
的資料庫照樣可以跑快路徑而不觸發無謂重建。

**代價**：這道守門在讀的路徑上也會咬。舊版本的資料庫即使索引完整、`why` 一列都
不會寫，一樣拋錯——它印出來的 `stable_key` 與改動層級就是用另一套規則算的，
與「降級過的索引不得被靜默讀出去」同一條線。`reports/` 底下的五個資料庫全部在
這個狀態，要用就得重建。

驗收：測試 418 → 419，四套黃金測試集全過（osiris 33/33、controlled 8/8、
create-t3-app 3/3、vue-core 3/3，四支 baseline 閘門 exit 0）。**把
`assertDeclarationsResumable` 的呼叫註解掉，新測試立刻紅**——機制拿掉還過的
就是下一個死旗標，這一步照舊不省。

### 裝飾器進實體邊界、剖面版本進水位線（2026-08-22）

W5 的第二刀。兩個都是 Python 專屬、都不動 TypeScript 的雜湊，所以合成一刀。

#### 1. 實體邊界含裝飾器

`decorated_definition` 是包裝節點，實體原本落在裡面的 `function_definition` 上，
於是 `@property` 換成 `@cached_property` 四層雜湊全部看不見。剖面因此多一個欄位
`declarationWrappers`（包裝節點型別 → 被包裝宣告的欄位名），TypeScript 留空
（那份 grammar 的 `decorator` 是子節點不是包裝，本來就在邊界內）。

前後對照（psf/requests，6,491 commits，各一次全 repo pass）：

| 指標 | 前 | 後 | 差 |
|---|---:|---:|---:|
| revision | 148,184 | 148,184 | 0 |
| entity | 3,406 | 3,409 | +3 |
| `change_level = none` | 136,056 | **135,940** | **−116** |
| shape | 5,753 | 5,811 | +58 |
| alpha | 1,618 | 1,643 | +25 |
| raw | 1,184 | 1,213 | +29 |
| token | 31 | 32 | +1 |
| L1／L2／L3／L3b／L3c／L4／L5 | 143,918／753／2／17／11／71／21 | 143,918／753／3／16／11／69／20 | |

**116 次改動從「沒有改動」移到真實的變更層級**，那些正是原本看不見的裝飾器編輯。
`revision` 筆數不變是預期的——同一批宣告，只是位元組範圍變寬。

單一實例眼檢：`2ccecf6dbd`（只加了一行 `@pytest.mark.skip`）在舊邊界下
`change_level = none`、新邊界下 `shape`；`ostracon why
'tests/test_testserver.py:TestTestServer.test_request_recovery'` 的那一列也從
「無變更」變成「結構重構」。

#### 2. 剖面版本進 declarations pass 的水位線

**這是加 Python 那一刀當下就漏掉的。** 剖面決定「哪個節點是宣告」與「哪個名字是
繫結」，兩者都是雜湊的輸入，不變量 7 適用，但它原本不在任何版本字串裡。兩個
靜默錯誤：

- 加一種語言之後，含該語言檔案的舊資料庫會**續跑**，只有水位線之後的 commit
  拿得到新語言的宣告——一份一半有、一半沒有的索引，不報錯。
- 移動實體邊界之後續跑，新舊 `stable_key` 混在同一個資料庫裡。

**`shape_profile` 擋不住這兩件事**——同一趟 pass 的兩側都是用當下的剖面現場觀察
出來的，本來就一致，它偵測不到版本改變。能擋的是水位線。版本字串由註冊表推導，
新增語言會自動改變它。實測拿舊資料庫重跑會直接拒絕：

```
資料庫的 declarations indexer_version 是 …+scope:lineage，
目前版本是 …+profiles:tsx@profile-1.0.0,typescript@profile-1.0.0,python@profile-1.1.0+scope:repo。
演算法改變後既有的索引不可續跑（不變量 7）。請刪除 --db 指向的檔案後重跑。
```

**代價要說清楚**：這個字串一變，所有既有資料庫都不得續跑。錯誤訊息會明確說出
怎麼辦，而且刪掉重建是安全的——但這是一次真實的中斷，不是零成本的守門。

#### 3. 測試檔判準拆成目錄慣例與檔名慣例

目錄慣例（`tests/`、`__tests__/`、`e2e/`）跨語言通用，**檔名慣例不是**。原本整條
規則只認得 `*.test.ts`，於是 requests 根目錄的 `test_requests.py` 完全逃過過濾。
檔名那一半移進語言註冊表（`GrammarSpec.testFilePattern`）——**加一種語言要一起
帶進來的東西，就該放在加語言的那一個地方**。`conftest.py` 刻意不收：它是設定不是
測試，裡面的 fixture 被推翻是值得看見的決定。

requests 的 `ostracised` 因此從「A 988／C 512、隱藏 200」變成
「**A 973／C 503、隱藏 225**」。

TypeScript 一如既往逐位元不變（四套語料 5,222 筆指紋相同、四套 golden 全過），
測試 414 → 418。

### 意圖層與 Chrome 算繪驗證（2026-08-17）

`abandoned_reason` 已接上 entity 層級 excursion：只收 remove commit 上 verified 的
stated／linked evidence，並要求同一 entity 在該 commit 有 `death` change；claim
主體是 `excursion_id`，不是 `revision_change_id`。UI 查詢再把它對回 remove commit
那列。`evidence:extract` 與 `ostracised` 都會在自己的輸入完成後重跑這個零 LLM 的
claim 投影，所以兩種執行順序最後會得到同一份意圖資料。

Chrome 1280×535 實測 60 列時間軸：第一版演化／意圖的列數同為 60，但只有從演化欄
捲動才同步；從意圖欄捲動後兩者實測相差 420 px。另因 `offsetHeight` 捨入，最長時間軸
有 0.5625 px 的累積頂端偏差。修正後雙向捲動同為 7420 px，含多行 claim 的列高與
頂端偏差都為 0。

既有 `reports/demo-create-t3.db` 是 repo 身分與跨 repo 汙染修正前的歷史產物：同一語料
有相對／絕對路徑兩個 repo row，且 excursion 的 `repo_id` 與 entity 所屬 repo 不一致。
UI 本身只讀，不會偷偷修資料，因此這次目視使用它的暫存副本驗一般 claim，再用符合
現行 schema 關係的暫存 excursion 驗 `abandoned_reason`。W3 的 fresh DB 端到端重跑
刻意排在最前面，舊 demo DB 不得拿來當新版本的正確性證據。

### 聚合訊息誤歸因的修正（2026-08-17）

W3 的第一項——fresh DB 全流程重跑——在 create-t3-app 上立刻抓到意圖層的誤報。

| 指標 | 修正前 | 修正後 |
|---|---|---|
| claim 總數 | 271 | **18** |
| `abandoned_reason` | 55 | **0** |
| verified evidence | 30 | 30（不變） |
| 主旨行 claim | 14 | 14（不受影響） |
| Osiris claim | 74 | **74**（不受影響） |

271 條 claim 只來自 11 顆 commit，而其中 5 顆是 release squash，**貢獻 253 條
（93.4%）**；55 條 `abandoned_reason` 全部出自它們，一條例外都沒有。`2dd37e138d`
把約 200 個 PR 壓成一顆，抽取器從 body 三條互不相關的 PR 標題各挖一句，全被當成
該 commit 移除的 13 個 entity 的放棄理由。

`change_level = 'death'` 那道守門擋不住：commit 確實移除了那些 entity，壞掉的是
訊息本身是 N 份文件的串接。判準與設計理由見 `architecture.md`
§6「聚合訊息不得歸因」。

**兩套語料在這個指標上完全相反**：Osiris 74/74 全部來自單一訊息 commit、全部在
主旨行、聚合為零。意圖層從頭到尾只在 Osiris 上驗過。**這是「同一個功能，兩種輸入，
只驗了一種」的第七、第八發**——第七發是 subject-line commit 驗過而 squash 沒驗，
第八發是偵測器本身 LF 驗過而 CRLF 沒驗（`.` 不匹配 `\r`，靜默回報零命中）。

### 降級過的索引不得被靜默讀出去（2026-08-21）

線上 demo 的數字比乾淨重建**多了 8 列改動與 147 列「沒動」**，而且多出 3 個
entity。追下去不是索引器的 bug，是**我自己從一個被降級的資料庫匯出的**。

`ostracon why` 預設走單一血緣的快路徑。對一個已經跑過全 repo pass 的資料庫再跑
一次 `why`，它會用小候選池重走那條血緣：搬移守門在那個範圍下是瞎的，配不到的
宣告被算成誕生。索引端本來就處理了這件事——宣告層水位線降級成 `scope:lineage`，
下次 `--full` 會作廢重建——但**畫面與匯出讀得一聲不響**。

| | changes | untouched | entity |
|---|---|---|---|
| 全 repo pass（乾淨） | 24,779 | 191,076 | 6,561 |
| 被 `why` 降級之後 | 24,787 | 191,223 | 6,564 |

三次連續 `ostracised` 是冪等的（24,779 不動），所以問題不在重跑，在**混用兩種
候選池**。

處置不對稱，因為代價不對稱：

- **`ostracon export` 直接拒絕。** 它的產出會被發佈出去，收不回來。
- **`ostracon ui` 只警告。** 本機檢視擋掉太煩，但不能不說。

判定走 `declarationScopeOf`，讀的是既有的宣告層水位線，沒有新增狀態。

### `ostracised` 的排序與測試檔（2026-08-21）

**排序由長到短改成由短到長。** 原本第一眼看到的是活了 **2,676 天**才被重構掉的
函式——`architecture.md` 自己寫著「三週是試錯，三年是技術演進」，而舊排序保證
使用者先看到技術演進那一端，也就是這支指令**最沒有資訊量**的部分。

改成由短到長之後，三套語料的開頭都是真的實驗：

| 語料 | 名單開頭 |
|---|---|
| vuejs/core | `Dep.ts:hasBit` / `setBit` / `clearBit`——當天引入、當天以「refactor: reduce bundle size」移除的位元旗標追蹤 |
| Osiris | `fetch511SFCameras` / `fetchNYCCameras`——城市專用的 camera fetcher，後來換成全球資料源 |
| create-t3-app | `prettierInstaller` / `Installers` |

排序方向不是門檻：長命的仍在名單裡，只是不再佔據第一個畫面。

**測試檔的宣告預設排除。** vuejs/core 的 A 級 710 條裡有 **173 條（24%）**在
`__tests__/*.spec.ts`（`App.render`、`testRender.makeApp` 這類）；Osiris 與
create-t3-app 都是 0 條，所以這件事只有在有大型測試套件的語料上才看得見。
判準是路徑，抽樣驗過 40 條全部命中真正的測試檔，而 `latest.ts`／`contest.ts`
這類產品程式碼不會被誤殺。

**排除不靜默**：標頭印出「另有 173 條在測試檔裡」，`--include-tests` 看得回來。
連「全部都是測試檔」的情況也要說明，而不是回報「沒有找到被推翻的做法」。
vuejs/core 的 A 級名單因此從 710 條變成顯示 537 條。

### vuejs/core 進入黃金測試集（2026-08-21）

Osiris 與 create-t3-app 在好幾個指標上**剛好落在同一側**，於是一整類缺陷可以活很久：

| 指標 | Osiris | create-t3-app | vuejs/core |
|---|---|---|---|
| 引文被硬換行切斷 | 0% | 0% | **24.2%** |
| 死亡點早於最後 revision | 1 | 0 | **176（10.8%）** |
| 跨 package 搬移 | 無 | 無 | 有 |

三條案例，全部只釘那一側：`vue-quote-spans-hard-wrap`（跨硬換行的引文）、
`vue-contrastive-keeps-rejected-side`（對比標記含被拒方案）、
`vue-compat-package-move`（`class Vue` 從 `packages/vue` 搬到 `packages/vue-compat`，
`expect_tier_at_most: L3c`）。

**`index_until` 釘在 topo 900 而不是 HEAD。** 要釘的現象都在早期（搬移在 topo 159、
最早的硬換行引文在 856），而且這份 fixture 沒有 excursion 案例，所以 `golden:index`
不跑全 repo pass——**實測 0.7 秒**。閘門的價值來自它擋不擋得下退步，不是來自
索引了多少歷史。

**閘門實測會咬**：把 `continuesOnNextLine` 改成永遠回 false（等於退回抽取器
0.4.0），`golden` 立刻 `exit=1`，而且正好只有 `vue-quote-spans-hard-wrap` 變 fail。

### `death_commit_id` 停在第一次死亡（2026-08-20，已修）

`entity.death_commit_id` 是**衍生欄位**，真相在 `revision_change` 的 `death` 列。
但兩個 pass 都在寫死亡時就地更新，而且帶著 `AND death_commit_id IS NULL`——那條件
本意是防覆寫，實際效果是**宣告死而復生時死亡點永遠停在第一次**。

vuejs/core 的 `Vue` 死在 topo 108，卻一路活到 topo 356，中間還從
`packages/vue/src/index.ts` 搬到 `packages/vue-compat/src/index.ts`。更極端的：
`getNow` 死亡記在 topo 225，最後一個 revision 在 **7100**。

| 語料 | 有死亡紀錄 | 死亡點早於最後 revision | 受影響的 A 級迂迴 |
|---|---|---|---|
| vuejs/core | 1,632 | **176（10.8%）** | 44 |
| remix | 12,387 | 243（2.0%） | 69 |
| create-t3-app | 189 | **0** | 0 |
| Osiris | 129 | 1 | 0 |

**兩套黃金語料又是 0。**「同一個功能，兩種輸入，只驗了一種」第十發。

修法是把兩處就地更新**整個刪掉**，改成 pass 結尾的 `reconcileEntityDeaths`
依 `revision_change` 重算：最後一次 `death` 必須晚於最後一個 revision，這個
entity 才算死了。一份實作、走訪順序與續跑都不影響結果，而且**順手修好舊資料庫**，
不必為了這個修正逼所有人重建索引。另外在 `detectExcursions` 加一道守門：誕生與
消亡同一顆 commit 的不是迂迴——那在語意上永遠不成立。

修正後（fresh DB 重建）：

| 指標 | 修正前 | 修正後 |
|---|---|---|
| vuejs/core 異常死亡點 | 176 | **0** |
| vuejs/core `introduce == remove` | 39 | **0** |
| vuejs/core A 級迂迴 | 757 | **710** |
| vuejs/core `duration_days = 0` | 51 | 12 |
| Osiris／create-t3-app A 級 | 94 ／ 102 | 94 ／ 102（不變） |

controlled fixture 補上「移除 → 一字不差加回 → 再移除」的形狀（`index_until`
移到 `f359ecde`），golden 新增 `ctrl-revived-second-removal`。**它釘住的是第二段
生命週期自己成立**，不是繼承第一次的死亡點。

### 稀疏度的分母原本混進了「沒動」（2026-08-19）

拆成兩個數字之後才看出來：**分子與分母在數不同的東西**。claim 的相關性判準是
`change_level <> 'none'`，但分母把 `none` 也算進去了——那些列的意思是「這個檔案
動了，但這個宣告沒動」，根本不是改動。

| 語料 | `none` 列 | 全部列 | 佔比 |
|---|---|---|---|
| vuejs/core | 191,076 | 215,855 | **88.5%** |
| remix | 148,299 | 206,151 | 71.9% |
| create-t3-app | 2,201 | 3,795 | 58.0% |
| Osiris | 909 | 1,705 | 53.3% |

修正後的標頭（分母只算真正的改動，`none` 單獨列出）：

| 語料 | 有專屬理由 | 全部改動 | 比例 | 只有整批理由 | 「沒動」 |
|---|---|---|---|---|---|
| vuejs/core | 37 | 24,779 | 0.15% | 656 | 191,076 |
| remix | 32 | 57,852 | 0.06% | 1,413 | 148,299 |
| create-t3-app | 4 | 1,594 | 0.25% | 14 | 2,201 |
| Osiris | **0** | 796 | 0.00% | 74 | 909 |

`EntityRow.revisions` 同樣不再把 `none` 算成改動——`ExtractPropTypes` 原本顯示
「168 次改動」，其中 156 次是沒動。

### 放棄理由的 entity 綁定守門（2026-08-19）

選材那一輪的結論下錯了。「每個 entity 剛好拿到一條理由」**只排除了多理由的笛卡兒積，
沒有證明理由與 entity 相關**——vuejs/core 的 104 條 `abandoned_reason` 其實只來自
**18 條引文**，7 條被掛到多個 entity，最嚴重的一條掛到 36 個。

| 語料 | 修正前 | 修正後 | 被收回 |
|---|---|---|---|
| vuejs/core | 104 | **10** | 8 條引文 ／ 94 候選 ／ 8 顆 commit |
| remix | 400 | **9** | 37 條引文 ／ 378 候選 ／ 22 顆 commit |
| Osiris | 0 | 0 | — |
| create-t3-app | 0 | 0 | — |

判準與被否決的替代方案見 `architecture.md`。存活的 10 條抽查後有 7 條的引文與被移除的
宣告直接對得上（`isBuiltInTag -> use makeMap instead of Set`、`trigger deps directly
instead of storing in an array`、`set dom stub type to never instead of {}`），
其餘 3 條引文較簡短但 commit 只移除了那一樣東西，綁定仍可辯護。

**W4 的正面 demo 因此建立在 10 條而不是 104 條上。**

### 一般 claim 的扇出還沒處理（2026-08-19 量測）

同一個問題在一般 claim（`why`／`constraint`／`tradeoff`）上更大，**尚未修**：

| 語料 | 一般 claim | 背後的引文 | 來自扇出 >1 的引文 | 最大扇出 |
|---|---|---|---|---|
| vuejs/core | 722 | 123 | 684（95%） | 72 |
| Osiris | 74 | **3** | 74（100%） | 70 |

**Osiris 長期被當成健康基準的「74 條 claim」，其實只是 3 條引文**，其中一條掛在
70 個 entity 上。

**已處理（2026-08-19）：標示尺度而不是收回。** 收回的代價量過——「扇出 == 1」會讓
Osiris 的意圖層整個歸零、vuejs/core 只剩 38 條（5%）；`change_level` 收緊存活
82–91%，根本不是過濾器；檔案範圍的中間值在語料間從 3% 跳到 100%。判準與被否決的
方案見 `architecture.md`。

稀疏度標頭實測（拆成兩個數字之後）：

| 語料 | 有專屬理由的改動 | 只有整批理由的改動 | 全部改動 |
|---|---|---|---|
| vuejs/core | 37 | 656 | 215,855 |
| Osiris | **0** | 74 | 1,705 |
| remix | 32 | 1,413 | 206,151 |
| create-t3-app | 4 | 14 | 3,795 |

**Osiris 的「0 次專屬理由」是這一輪最誠實的一個數字。**

### W4 選材量測：`abandoned_reason` 第一次在真實資料上開火（2026-08-17）

意圖層與迂迴偵測接起來之後，**兩套黃金語料都產不出一條 `abandoned_reason`**——
專案的命名由來在真實資料上是空的。原因各不相同，都不是門檻太嚴：

| 語料 | commit | 聚合 | 有理由 | entity | excursion | 移除 commit 有證據 | `abandoned_reason` |
|---|---|---|---|---|---|---|---|
| Osiris | 99 | 2.0% | 4.0% | 307 | 115 | **0** | 0 |
| create-t3-app | 1,378 | 0.6% | 1.9% | 405 | 170 | 23 | **0**（全被聚合擋下） |
| **vuejs/core** | 7,156 | **0.0%** | 2.0% | 6,561 | 1,389 | 104 | **104** |
| remix-run/remix | 8,743 | 0.1% | 2.3% | 24,084 | 10,588 | 210 | 400 |

Osiris 是沒人在移除 commit 裡寫理由；create-t3-app 是理由全在 squash body 裡。
**換一個非 release-squash 的語料，功能立刻開火**——所以先前的 0 是語料的性質，
不是設計錯誤。

**entity 相關性的量測結果決定了選材。** 同一個 entity 拿到幾條相異的放棄理由：

| 語料 | 拿到 1 條 | 拿到 2 條以上 | 最多 |
|---|---|---|---|
| vuejs/core | **104** | **0** | 1 |
| remix | 94 | **116（55%）** | 7 |

remix 的移除 commit 常常一則訊息裡有好幾個因果標記，全部掛到該 commit 移除的
每一個 entity 上——`e44bfbf08` 是 4 條引文 × 22 個 entity。**至少有三條是錯的。**
這是聚合問題在單顆 commit 內的縮小版：守門擋得住 200 個 PR 的串接，擋不住一則
訊息裡的多個理由。vuejs/core 完全沒有這個現象，104 個 entity 各拿到剛好一條。

**結論：意圖層的正面 demo 用 vuejs/core。** remix 在修掉「一則訊息多個理由」
之前不適合展示放棄理由。

### 引文被硬換行切斷（2026-08-17，已修：抽取器 0.5.0）

引文的右邊界取到行尾，而 commit body 通常硬換行在 72 字元。實測：

| 語料 | 相異引文 | 疑似被換行切斷 |
|---|---|---|
| Osiris | 3 | 0（0.0%） |
| create-t3-app | 6 | 0（0.0%） |
| vuejs/core | 124 | **30（24.2%）** |
| remix | 174 | **37（21.3%）** |

`because the Symbol does not fit well` ／下一行 `into V8's hidden class model.`
——切在換行處，讀起來不成句。**兩套黃金語料都是 0%，因為它們的理由全在單行
主旨上**；這是「同一個功能，兩種輸入，只驗了一種」的第九發。

**已修**（抽取器 0.5.0，右邊界取到句末）。以抽取器自己的停止判準重測，四套語料
**真正被切斷的都歸零**；vuejs/core 與 remix 的候選各少 1 條與 3 條，那是續行把
同一句裡的第二個標記收了進去，claim 隨之 829 → 826、3,077 → 3,013。Osiris 與
create-t3-app **完全沒有任何 span 改變**——再一次說明它們驗不出這一類缺陷。

### 效能外推的變數可能挑錯了（2026-08-17 觀察，2026-08-22 已定案）

> **已定案：軸是 revision，不是 entity 也不是 commit。** 四套語料的量測見
> §成本控制重新定義，預算已在 `roadmap.md` §3 重新表述。下面保留當時的推論記錄。


vuejs/core 7,156 commit 的全 repo pass 實測 **5 分 05 秒**，外推一萬 commit 約
**7.1 分鐘**，而 §效能那節記的是 **1.07／1.21 分鐘**。預算是 10 分鐘，還沒破，
但差了約六倍。

兩套舊語料是 405 與 1,000 出頭個 entity，vuejs/core 是 6,561 個——**成本的驅動
變數可能是 entity 數而不是 commit 數**，那樣的話「一萬 commit 約一分鐘」這句話
的形式本身就是錯的。需要一次以 entity 數為橫軸的量測才能定案。

### 抑制數字只留一份實作（2026-08-17）

聚合守門上線後，CLI 報「5 顆聚合 commit」而 UI 標頭報「6 顆」。兩邊各寫了一份
SQL：畫面那份少了 `change_level <> 'none'` 這道前置過濾，於是把 `410899aeed`
也算進來——那顆有 5 次改動、**其中相關 0 次**，它的空白本來就是相關性抑制造成的，
跟 squash 無關。

修法不是把過濾補上，是**把畫面那份 SQL 整個刪掉**。候選蒐集抽成
`collectCandidates`，`deriveClaims` 與新的 `unattributableEvidence` 共用同一份，
兩個數字因此不可能再分岔。同時把摘要拆成三個單位不同、不可互換的數字：
`candidates`（證據 × 主體，對應「少寫了幾條 claim」）、`quotes`（相異引文，
畫面的單位）、`commits`。

實測 create-t3-app：CLI 與 UI 現在都是 **253 候選 ／ 9 條引文 ／ 5 顆 commit**
（修正前畫面是 10 條 ／ 6 顆）。

### 對比標記的引文補回被拒方案（抽取器 0.4.0，2026-08-17）

`instead of`／`rather than` 的**被拒方案在標記左邊**，而 span 從標記處開始，
於是四條實測引文全部只剩右半：

| 掉掉的左側 | 舊引文 |
|---|---|
| `fix: use auth` | `instead of question while merging the router (#330)` |
| `fix: load all CCTV regions globally` | `instead of UK-only hardcode` |
| `Fix active fires layer to use global NASA FIRMS Open Data CSVs` | `instead of US-biased EONET` |
| `refactor: using path` | `instead of passing prop` |

`tradeoff` 的定義就是那組對比，只留右半邊等於把型別的內容拿掉。與中文那條
`理由改變。` 同型：**逐字為真、span 斷言通過、意思殘缺**。修法沿用 `so that`
迂迴義既有的 `sentenceStart`，`to avoid`／`to prevent` 不跟著擴張（它們的內容在
標記右邊）。

**claim 數量與歸屬完全不變**（create-t3-app 18 條、Osiris 74 條，分型分布逐列
相同），改的只有引文範圍；`rejected: 0` 表示每一條新 span 仍通過驗證。

修這一條時撞到一個既有的靜默缺陷：左邊界拉長過的 span 規則字串寫成
`causal:instead of/result`，而 `markerOf` 的樣式錨在 `$`，對它**整個失配**——
標記變成 `undefined`、claim 被算成 `unmapped`。原本只有 `so that` 的迂迴義會踩到，
量太小沒被發現；對比標記一改就會變成整類意圖靜默消失。已修並加上回歸測試。

### 全 repo 結構 pass 的效能（2026-07-31 實測，Osiris 99 commit）

| 指標 | 值 |
|---|---|
| repo pass 耗時 | **5.33 s**（簽章快取前 7.49 s，本輪前 5.68 s） |
| 走訪（`indexGit`） | 0.11 s |
| **pass 1–2 總計** | **5.43 s** |
| 峰值 RSS | 645 MB |
| 增量重跑 | 0 commit、0 ms、不重複寫入 |

**外推一萬 commit 約 9.15 分鐘**，在 `roadmap.md` 的 10 分鐘預算內。
餘裕仍不大，語料換一個就可能又超出，不該當成永久解決。

三次 fresh DB 取中位數；固定產出（1579 revision / 1272 match / 1 跨檔案 /
307 birth / 130 death、tier L1 1162 · L2 46 · L3c 51 · L4 12 · L5 1）
在每一次優化前後都完全相同——這幾個數字是純效能改動的唯一驗收條件。

已完成的優化：

1. **blob sha 本地算**（`blobShaOf`）。先前每寫一筆 revision 就 spawn 一次
   `git rev-parse`，Osiris 一趟就是 1579 次程序啟動。雜湊的是原始位元組，
   所以沒有編碼往返風險，且有測試對照 git 自己算的值。
2. **觀察快取加上限**（64 項 LRU）。`ObservedDeclaration` 帶著整份原始碼與節點
   子樹，無上限時 Osiris 就吃掉 750 MB。
3. **n-gram 只算一次**。`buildSignature` 內部本來就會算 n-gram，而呼叫端又另外
   算一次給精確驗證用。新增 `signatureFromSet` 讓兩者共用。
4. **blob 按 commit 批次讀取**。observer 先以 `git cat-file --batch` prefetch
   本次 commit 的前後版本，取代每個檔案一次 `git show`。協定以 Buffer 解析，
   missing 不消耗內容換行，且 header oid 會與本地 `blobShaOf` 互相驗證。
   同機隔離量測：574 次 `git show` 1.85 s → 90 次 `cat-file` 0.308 s，
   全 pass 由 8.93 s 降至 7.17 s。
5. **簽章與 n-gram 集合以 `hashToken` 為鍵重用**（`createSignatureCache`，
   2048 項 LRU）。7.49 s → 5.68 s，**降 24.2%**。
6. **每個 commit 一個 transaction，加上 prepared statement 快取**。
   5.68 s → 5.33 s。消融量測顯示兩者的貢獻是 **transaction 284 ms、
   statement 快取 69 ms**——與事前預期相反（原本以為約一萬次 `db.prepare()`
   是大宗），所以這個拆分值得記下來。

### 為什麼 `hashToken` 是安全的鍵

`hashToken` 雜湊的是 `` `${type}\u001f${text}` `` 的 token 序列，而 `ngramSet`
消費的是**同一個序列化**。鍵相同就必定是同一組 token，因此 n-gram 集合與 MinHash
必定相同——這是恆等而非近似，沒有「大概一樣」的空間。

實測 Osiris 全歷史 **2920 次宣告觀察只有 561 個相異 `hashToken`，命中率 80.8%**；
需要走 MinHash 的 889 次觀察中命中率 65.8%。命中同時省下 `ngramSet` 與 MinHash
兩段計算。

**回傳的 `ngrams` 與 `signature.exact` 是共用物件，呼叫端不得修改。** 共用正是
RSS 反而下降的原因（重複的 Set 不再各存一份），但一旦有人就地修改，所有共用同一個
`hashToken` 的宣告會一起壞掉且不報錯。測試釘住「相同鍵回傳同一個物件」與
「快取與純函式的 MinHash 逐位元相同」。

### 為什麼 transaction 的邊界取在單一 commit

整趟包成一個的話，一萬個 commit 的 WAL 會膨脹到不可接受，而且中途失敗會把所有
已完成的工作一起丟掉。取在單一 commit：WAL 有界、失敗只損失一個 commit 的工作，
而水位線本來就只在整趟結束時前進，所以重跑會把那個 commit 重做一次——
所有寫入都是 ON CONFLICT 冪等的。

**包 transaction 引入了一個新的失敗模式**：半批寫入必須不留痕跡，且 ROLLBACK
之後連線要能繼續用（沒發出 ROLLBACK 的話，下一個 BEGIN 會以「transaction 已開啟」
失敗，在真實索引中會變成連鎖崩潰）。三條測試分別守住成功提交、失敗回滾、
回滾後可續用。

### CPU profile 的成本分佈（2026-07-31，簽章快取之後）

| 項目 | self time | 佔比 |
|---|---|---|
| `minhash` | 1700 ms | **28.4%** |
| `spawnSync`（git） | 891 ms | 14.9% |
| tree-sitter（wasm） | ~364 ms | 6.1% |
| crypto（四層雜湊） | ~364 ms | 6.1% |
| SQLite 三個寫入函式 | 320 ms | 5.3% |

**剩下的錢在 `minhash`。** SQLite 那一步做完之前就先量過天花板是 320 ms，
實際拿到 353 ms（transaction 的節省有一部分不在那三個函式的 self time 裡）。
下一步若還要壓，優先看 MinHash——但它是簽章的定義，動它要提升
`SIGNATURE_VERSION` 並重算全部簽章。

### MinHash 的量化缺陷（2026-08-02 已修）

`minhash()` 原本寫 `(a * x + b) % MERSENNE_31`。`a` 與 `x` 都可接近 2^31，乘積達
2^62 而 `Number.MAX_SAFE_INTEGER` 只有 2^53，高位被靜默捨去。**以實際係數實測
96.7% 的呼叫得到錯誤的值**（128 個係數的 `a` 最小值就有 3.0e7，沒有一個小到安全）。

先前記為「不影響正確性」是對的——結果仍決定性，且 L4/L5 接受前一律精確 Jaccard
驗證——但那族雜湊的碰撞性質是任意的，召回階段可能漏掉真正相似的候選，而漏掉的
東西不會有任何錯誤訊息。

修法是把 `x` 拆成高低 16 位，並用 Mersenne 質數的 `2^31 ≡ 1 (mod p)` 做規約。
**除以 2^31 在 IEEE-754 下完全精確**（只調整指數，不捨入），所以整段沒有精度風險，
也不需要 BigInt。

| 語料 | pass 耗時（三次中位數） | 結構指標 |
|---|---|---|
| Osiris | 5,467 → **3,816 ms（-30.2%）** | 13 項全部相同 |
| create-t3-app | 8,247 → **7,778 ms（-5.7%）** | 13 項全部相同 |

**修正後比原本錯誤的版本還快。** 原因是 double 的 `%` 走 fmod，比「除以 2 的冪 +
乘 + 減」慢一個數量級；微基準上規約寫法是 `%` 寫法的 13 倍快。Osiris 的降幅較大是
因為它 483/1579 的 revision 走 MinHash 路徑，create-t3-app 只有 385/3606。

**結構產出完全沒變**：兩個語料的 commits / revisions / entities / matches /
crossFile / births / deaths / discontinuities / tier 分佈 / excursion 全部逐項相同，
Osiris golden 維持 33/33 且逐案例零差異。這正是「MinHash 只做召回」該有的結果——
若有任何 tier 變動，反而代表精確驗證沒擋住。

`MINHASH_SEED_VERSION` 由 `mh-1.0.0` 升為 `mh-2.0.0`。**同時把 `SIGNATURE_VERSION`
接進 `declarationIndexerVersion`**：先前它只被寫進每一列 `revision` 的
`minhash_version` 欄位，沒有進水位線，所以改了簽章演算法之後續跑不會報錯，
資料庫會靜默混進兩族互不可比的簽章。註解裡寫「換了就要重算」而系統不強制，
那不是規則是願望。現在版本不符會直接拒絕續跑並要求重建。

（附帶一提：第一次量化這個缺陷時得到 95.4%，那支腳本的 RNG 自己就用了
`seed * 1103515245` —— 同樣超過 2^53。換成純位元運算的 xorshift32 後才是 96.7%。
測試的亂數源踩了它要測的同一個坑，這件事寫在 `test/minhash-arithmetic.test.ts` 裡。）

### 迂迴偵測：搬移守門

entity 層級的迂迴用現有的 `entity` / `revision` 就夠——**不需要 `construct_span`**，
schema 的 `excursion` 是 `entity_id` XOR `construct_id`。

A 級兩條路（都是純結構、零 LLM）：死亡 commit 本身是 `Revert`（`git_revert`），
或內容從引入到移除逐字未變、移除的 diff 就是引入的反向（`inverse_diff`）。
B 級**刻意不做**：現有 evidence 掛在 commit 上而非 entity 上，硬接會產生
看似有據實則無關的宣稱。

**已接進產品路徑（2026-08-02）。** `why --full` 會在全 repo pass 之後跑
`detectExcursions`，時間軸標頭直接呈現裁決。下表的數字現在由產品路徑本身產生，
不再是一次性腳本：`pnpm why:cli ... --until 4709861f --full` 的 fresh DB 跑出
189 候選、71 A / 40 C、排除 78，與先前腳本量到的完全一致。

create-t3-app（1,378 commit）實測：

| 指標 | 值 |
|---|---|
| 誕生與死亡都在觀測範圍內的候選 | 189 |
| **被搬移守門排除** | **19（10%）** |
| A 級（全部是 `inverse_diff`） | 102 |
| C 級（`trajectory`） | 68 |

**判準是「有沒有一份相同的內容活得比它久」。** 有 → 這次死亡是搬移或去重，
內容還在，抑制；沒有 → 內容在這一刻離開了 repo，那正是迂迴要報的時機。
這也讓「搬移後再刪除」只報一次，而且報在內容真正離開的那次 commit。

**比對的是 entity 的生死，不是「有沒有 revision 落在死亡之後」。**
`revision` 只在檔案被觸及時才寫入，所以搬過去的副本若之後再也沒被改動，
用 revision 的時間去查會完全漏掉。

#### `>=` 曾經造成 84% 的錯誤排除（2026-08-05 已修）

判準原本寫成「死得**不比我早**」（`dc.topo_order >= ?`），而同一個 commit 的
`topo_order` 相等——於是 **N 份相同內容一起被刪時全部互相抑制**，但它們全都消失了。
刪掉一整個重複的樣板目錄正是這個模式。

實測 77 個排除裡有 **65 個（84%）只被已死的 entity 抑制**。最清楚的一對是兩個
380-node 的 `Home`（`template-prisma` 與 `template-prisma-auth`），互相抑制、
同死於 `e6fe4e6b`、終點兩個檔案都不存在——用 git 獨立驗證過。

改成嚴格的 `>` 之後：排除 77 → **19**，迂迴 111 → **170**（A 102 / C 68）。
`EXCURSION_VERSION` 由 `1.0.0` 升為 `1.1.0`。

**放寬守門是單調的**（條件變嚴 → 抑制變少 → 迂迴只增不減），所以任何
`expect: present` 的黃金案例都不可能因此退步——兩套 golden 實測確認未動。

**刻意不加 `node_count` 閘門。** 修正後仍被排除的 19 個裡有 11 個低於 25 個節點，
小宣告的 `hash_raw` 相同確實是弱證據；但加閘門會讓守門更少觸發、更多東西被判成
迂迴，那是往誤報方向移動，而誤報成本遠高於漏報。

**也刻意不做呈現層的摺疊。** 修正後 `da760c7d4b` 一次刪掉 6 個樣板變體裡的
`TechnologyCard`，看起來像 12 條獨立迂迴。但實測 23 個「同 commit 同名」的組裡，
**9 組的 `node_count` 不一致、3 組混了 A 與 C** ——例如
`getServerAuthSession @ 41de302b5a` 有 6 份，node 36 與 8、強度 A 與 C、
存活 783/637/411/377 天。那不是一個東西的多份拷貝，是剛好同名的不同宣告。
以（commit, 名稱）為鍵摺疊會宣稱它們是同一件事，那是製造一個新的假宣稱，
而摺疊只把 170 減到 117。

`duration_days` **用 `authored_at` 而不是 `committed_at`**：committer 時間會被
rebase 重寫，Osiris 的 99 個 commit 只有 88 個相異 committer 時間，而 fixture
案例的引入與移除 commit 的 committer 時間完全相同，算出來會是 0 天。

### 接線的三個決定（2026-08-02）

1. **`scope` 進版本字串。** `detectExcursions` 必填 `{ scope: "repo" | "lineage" }`，
   版本字串是 `excursion-1.0.0+inverse-raw+move-guard+scope:<scope>`。搬移守門在
   lineage scope 下**看不到別的檔案**，同一個 entity 在兩種 scope 下可以得到相反的
   答案，所以那不是同一份產出（不變量 7）。scope 升級時水位線版本不符，自動重算。
   golden materializer 走 `indexLineage`，因此它是 `scope: "lineage"`——現有 fixture
   靠死亡 commit 的 subject 判 A 級，不依賴守門，但**新增 excursion fixture 前要先想過**。
   必填參數而非預設值，是為了讓型別檢查逼呼叫端表態；實際加上去時它抓到全部 7 個呼叫點。
2. **只在 `why --full` 呼叫。** 單一血緣的候選池會把搬移通通判成迂迴。
   非 full 模式下若 entity 已消亡，時間軸明說「還無法判斷，加 --full」，
   **不沉默**：沉默會被讀成「不是迂迴」，等於憑空替使用者排除一段歷史。
3. **翻盤的舊列必須刪，但不能整表刪。** `claim.excursion_id` 是 ON DELETE CASCADE，
   整表刪會連帶清掉掛在上面的 claim。改成 temp table 標記保留集合後刪除補集。

### 呈現：同名存活者的警語與它的雜訊

眼檢指出的「限定名稱仍存活 11/71（15%）」已實作：A/C 級裁決下方列出仍存活的同名
entity 路徑。全 111 條迂迴實測**觸發率 14%（15/111）**，與先前眼檢的 15% 吻合。

**但這是純名稱比對，不是語意判定。** 命中品質兩極：`createInnerTRPCContext`（12 處）、
`createContextInner`、`AvailablePackages`、`createQueryClient` 確實是同一個概念存活下來；
`Home`（**39 處**）、`Session`（10）、`RootLayout`（4）、`Options` 則是模板泛用名，
撈到的多半不相干。因此措辭一律用「不必然是這個想法」，而且**只列前三個加總數**——
39 條路徑不是資訊而是雜訊。要真正分辨需要語意層，屬於獨立切片。

### 已消失的構造：定址與清單（2026-08-02，已完成）

接線完成當下量到 111 條迂迴裡有 91 條（82%）**在終點無法用 `why` 定址**：
`lineageIdAt` 解析的是「在 `--until` 這個 commit 上，這個路徑屬於哪條血緣」，而
迂迴的定義就是檔案已經不在了。使用者得先知道它什麼時候死的才問得出為什麼死。
這一片把兩端都補上，**定址率現在是 111/111**。

`src/index/structural.ts` 新增 `lineagesEverAt()`：某路徑在 `--until` 之前曾經
屬於的所有血緣，最近的排前面。**`lineageIdAt` 的語意完全沒動**——它被結構層與
golden materializer 共用，改語意等於拿黃金測試集當賭注；新函式只在前者回
undefined 時當 fallback。

**路徑被刪除後又重建（D→A）時回傳全部，不挑一條。** Osiris 的
`scanner/server.js` 就是這種：實測回傳 2 條血緣，`why` 把兩段歷史都印出來並說明。
靜默挑「最近的一條」會讓更早那段整個消失，與誤報斷層同級。這與 `entitiesFor`
面對同名多實體時「不得替使用者挑一個而不說明」是同一條既有裁決。

新 CLI `pnpm ostracised`（`src/cli/ostracised.ts`）列出被推翻的做法：

| 項目 | 值 |
|---|---|
| create-t3-app 名單 | 111 條（A 71 / C 40），與偵測器一致 |
| 查詢耗時（五次中位數） | **2.6 ms**，預算 300 ms |
| 需要的新索引／schema 變更 | **無**——`idx_excursion_strength` 直接吃得到 |

三個設計決定：

1. **不給 `--full` 開關，一律跑全 repo pass。** 搬移守門在單一血緣下是瞎的，
   給開關等於給使用者一個會產生假名單的選項。另有 `assertExcursionScope()`
   在版本或水位線不符時**拒絕輸出**——使用者無從分辨名單是完整還是殘缺的，
   而錯的那一半看起來與對的一模一樣。
2. **A 與 C 分段呈現。** 混在同一份清單裡就是把疑似當確證。
3. **`--strength` 過濾時標頭不得暗示沒查的那一段是零。** 第一版印
   「A 確證 0｜C 疑似 40」，會被讀成這個 repo 沒有 A 級的——實際上有 71 條。
   改成「40 個 C 級的紀錄（已用 --strength 過濾）」。沒查與沒有是兩件事，
   與 golden runner 分開 `pass` / `missing` 是同一個道理。

清單不自己定義什麼是迂迴，只讀偵測器寫進 `excursion` 的列；第二套定義會是最典型的債。

### 十條 A 級迂迴的眼檢（2026-08-01，create-t3-app）

71 條 A 級，存活天數中位 34.6 天、最長 666 天。取涵蓋分佈的十條實讀。

**偵測器找對了東西。** 最強的三條是 `upgrade/` 整個子專案：
`feat: add t3-upgrade project (#1429)` 引入，666 天後被
`chore: nuke upgrade, use next/font (#2074)` 整個移除。這是教科書等級的迂迴，
而且沒有別的工具會告訴你這件事。其他清楚的還有 `env` 驗證被
`fix: delete old env stuff (#1187)` 換掉（212 天）、prettier 選項被
`remove prettier option` 拿掉。

**但沒有一條說得出「為什麼」。** 四個移除 commit 的訊息全文分別是
「chore: nuke upgrade, use next/font」「delete old env stuff」「remove prettier
option」「feat: skip http for trpc rsc calls」——全部只說做了什麼。理由在 PR 裡
（#2074、#1187、#1670），也就是 **linked 層**，而 create-t3-app 的 linked 尚未收取。
這與 stated 只有 2.0% 是同一件事的兩面：squash-merge 文化把理由推進 PR。

**限定名稱仍存活的比例：11/71（15%）。** 例如 `createInnerTRPCContext` 與
`AvailablePackages` 在終點仍然存在，只是內容被改寫過，所以內容守門抓不到。
這類不是假的「這段程式碼消失了」，但**使用者會讀成「這個想法被放棄了」**，
而那是錯的。呈現時必須能區分「實作被換掉」與「概念被放棄」——
最省事的做法是在時間軸上一併顯示同名的存活 entity，讓讀者自己看到它還在。

### 證據層在真實語料上的覆蓋率（2026-07-28 實測，Osiris）

| 指標 | 值 |
|---|---|
| commit message | 99 |
| **含可抽取理由的訊息** | **4（4.0%）** |
| 產出候選 / 通過驗證 | 4 / 4 |
| 被拒絕 | 0 |
| `reference_link` | 23（18 條 `closes #N`、5 條裸參照） |
| 耗時 | 4 ms |

**4% 是語料的性質，不是抽取器壞掉**，而且這是題目層級的訊號：Osiris 的
commit message 絕大多數只寫做了什麼。`stated` 層在這類 repo 上本來就沒有多少
東西可說，換成 LLM 也變不出原文裡不存在的理由。真正的槓桿在 PR 與 issue
討論串（`linked` 層），那需要網路。

抽到的四條都是真的在解釋為什麼，例如
「to prevent Vercel Data Cache quota burn, rely exclusively on Edge CDN Cache-Control headers」、
「instead of US-biased EONET」。

**「抽取器不得產出自己的驗證器會拒絕的 span」有專門的性質測試**，並在真實語料上
也成立（0 rejected）。第一版曾把整行當引文，導致引文與時間軸上方的 subject
一字不差地重複——改成從因果標記處開始才真的只留下「為什麼」。

### linked 層切片 0–3（2026-07-31）

Osiris 已確認為公開 repo。23 條 reference 全部存在，實際是 **5 PR / 18 issue**；
22 個 body 非空，非空 body 字數中位數 401。既有 `extractRationale` 在 13 份 body
抽到 22 條候選，語料價值足以繼續。

切片 1 完成注入式 HTTP、錄放、source_doc 收取、PR/issue 種類修正與 linked
水位線。離線 replay 測試涵蓋同一 PR 的兩則 comment 使用不同 external_id、
`provenance_root='pr:N'`、token 不落 fixture，以及 429 不越過水位線。
錄製 fixture 取自公開的 Osiris PR #162（body、comments、reviews），可由另一台機器
以 `--record` 重建；測試不依賴私人 repo 或合成的 HTTP 錄製檔。

切片 2 以 `tier='linked'` 重用 staging／`submitCandidates`／span 驗證；Markdown
模式排除 fenced code 與引用行。測試證明同串四份文件仍各自留下 evidence、重跑不
增生、PR body 編輯後 `revalidateEvidence` 只回報對應列 stale。

切片 3 在 `timelineOf`／`why` 查詢時依 provenance root 收斂，顯示代表逐字引用、
PR/issue 編號、reference method／confidence 與同串額外文件數。寫入列完全不刪，且
body hash 已變的 stale evidence 不呈現。

切片 3 當下（2026-07-31，excursion 尚未實作）兩套 golden 為 Osiris
**32 pass / 0 fail / 1 missing**、controlled **2 pass / 0 fail / 0 missing**——
這是當時的紀錄，目前基準線見第 5 節。

### linked 層的 live 實跑基準（2026-08-02，Osiris）

**第一次用真實 GitHub API 跑通。** 本機 `gh` 的 token 有效（scopes 含 `repo`），
額度 5,000/hr——先前記載的「本機 token 已失效」**已不成立**。

| 指標 | 值 |
|---|---|
| commits 掃描 | 99 |
| reference | 23（修正後 **5 PR / 18 issue**） |
| source_doc | 33（issue_body 18 · pr_body 5 · pr_comment 7 · issue_comment 3） |
| 取回失敗 | **0** |
| linked evidence 升格 / 拒絕 | **23 / 0** |
| 有 evidence 的獨立 `provenance_root` | 14 |
| **實際 HTTP 請求** | **51** |
| 耗時 | 41.7 s（**0.82 s／請求**，完全序列、無並行） |

#### 請求成本模型（從我們這端精確計數）

每一條 **reference row**：`/issues/{n}` 一次 + `/issues/{n}/comments` 分頁；
是 PR 再加 `/pulls/{n}/reviews` 分頁。所以 issue 2 次、PR 3 次。
Osiris：18×2 + 5×3 = **51**，與實測逐項相同。

**GitHub 自己的計數器只走了 28。** 兩趟共發 102 次而 `rate_limit` 回報 `used: 56`，
約只收一半的費。原因未確認（條件請求或部分端點不計費都有可能），**不可依賴**——
規劃一律用我們這端的數字，那才是保守的方向。

#### 逐目標去重（2026-08-02 已修）

`ingestLinkedDocuments` 原本依 commit 迴圈、對每一條 reference row 各取一次，
同一個 PR 被多個 commit 提到就會**重取**。Osiris 是 23 rows / 23 distinct 看不出差別；
create-t3-app 是 **1,310 rows / 1,085 distinct**，約 17% 的請求是重複的。

現在單趟內以 `to_key` 為鍵快取。**鍵不含 `to_kind`**——GitHub 的 issue 與 PR 共用
同一組編號，號碼本身就唯一標定討論串，而且 `to_kind` 在取回之前一律是 `issue`，
放進鍵就永遠命不中。命中時只快取 `kind`、不快取文件內容（該目標的 `source_doc`
早就寫進去了），所以記憶體與相異目標數無關。

**命中仍必須修正該列的 `to_kind`。** 省請求不得省掉這一步，否則第二個 commit 的
那一列會永遠留著錯的 `issue`，而查詢層靠它分辨 PR。有專門的測試守住這件事。

快取只活在單趟之內：續跑時是冷的，但水位線已跳過做完的 commit，
且所有寫入都是 ON CONFLICT 冪等的，所以不影響可恢復性。
Osiris 複驗零回歸（`deduplicated: 0`、仍是 51 請求、33 文件、5 條修正）。

#### 兩個尚未修的問題（實跑時踩到）

**1. `reference_link` 的 UNIQUE 把衍生欄位算進身分 → 已修（2026-08-02）。**

`to_kind` 是衍生的：抽取器只看得到 `#162`，一律先寫 `'issue'`；要等 linked 層
真的取回才知道那是 PR 還是 issue。把它放進 UNIQUE 的後果：

1. `evidence:extract` 插入 `to_kind='issue'`
2. `evidence:linked` 把其中的 PR 改成 `'pr'`
3. 再跑一次 extract（`why --full` 內含）→ ON CONFLICT 鍵不再吻合，**又插一份
   `'issue'`**（Osiris 實測 23 → 28 列）
4. 下一次 `evidence:linked` 要修正那份重複列 → **UNIQUE 衝突、整趟 crash**

UNIQUE 改成 `(repo_id, from_kind, from_key, to_key, method)`。身分是「哪個 commit、
提到哪個編號、用哪種方法」；GitHub 的 issue 與 PR 共用同一組編號，所以 `to_key`
本身就唯一標定目標，`to_kind` 由它決定。真實 CLI 驗證：同一序列現在停在 23 列、
5 PR / 18 issue 正確保留、水位線重置後重跑不再 crash。

`why` 的 linked 查詢也從 `PARTITION BY to_kind, to_key` 改成只依 `to_key`。
在乾淨資料上兩者等價，但資料一旦髒掉，一列未修正的 `'issue'` 與一列已修正的
`'pr'` 會落在兩個分群，**同一個討論串顯示兩次且其中一次標錯種類**。

**先前對嚴重度的判斷過高，這裡更正。** 原本記為「使用者會撞到 crash」，實測後：
重複列**立刻且永久**產生（計數膨脹 22%），但 crash 只在舊 commit 被重新處理時
發生（換 `LINKED_PASS_VERSION`、重建、重置水位線）——正常增量續跑不會觸發。
而且多出來的 `issue:N` 指向的 `provenance_root` 有 0 份文件（真正的文件在 `pr:N`），
所以**對時間軸顯示是惰性的**。`reports/demo-create-t3.db` 檢查後為 0 重複組，
沒有既有產物需要修復。

**沒有 schema 遷移機制**，所以在這個 commit 之前建立的資料庫仍帶舊索引。
影響僅止於上述範圍，重建即可。

**2. `createGitHubFetcher` 沒有任何重試 → 已修（2026-08-02）。**
demo 那趟 51 分鐘內出現 **4 次 `fetch failed`**，每一次都足以讓整趟中止。

修法是 `src/http/retry.ts` 的 `createRetryingFetcher`——**可組合的包裝，自己不碰
網路**，所以「網路只准出現在 `github.ts`」不受影響，`createGitHubFetcher` 也維持
單一職責。包裝順序是 `record(retry(live))`：錄下來的必須是成功的回應而不是中途的
失敗；replay 不包，離線重播不會有暫時性失敗。

**4xx 一律不重試，429 尤其不能。** rate limit 由呼叫端的 `stopped` 路徑優雅處理
（讀 `x-ratelimit-reset`、保住水位線、稍後續跑）；在這裡用幾秒退避去重試，等於把
「暫停，稍後再來」變成盲目敲門，而 reset 可能在一小時之後。只有 5xx 與丟出來的
網路錯誤會重試，指數退避、預設 5 次（總等待上限 15 秒）。

用完次數時**把原始錯誤照原樣拋出**（包一層會蓋掉 `ECONNRESET` 這種排查資訊），
5xx 則照原樣回傳讓呼叫端的 `stopped` 接手。重試不靜默——`onRetry` 會把每一次印
到 stderr，看不見的降級等於沒有降級。

#### 誠信問題在 linked 上比 stated 更明顯

眼檢早已指出「理由引文 span-correct 但未必 entity-relevant」。linked 讓它更嚴重：
`7fc02862b8` 一次提到 6 個 issue，時間軸就在一列 **`無變更 [L1]`** 底下掛了
6 條關聯引文。引文全部通過 span 斷言、issue 編號也對，但那個 entity 在該 commit
根本沒有實質改動。**UI 不得把 commit-wide 的理由暗示成 entity-specific 因果**，
這在接意圖層之前必須處理。

### Demo 語料基準（2026-08-01；linked 待憑證）

Demo 語料固定為公開的
[`t3-oss/create-t3-app`](https://github.com/t3-oss/create-t3-app)，索引終點釘在
`4709861f7e67a15564c0460c13e7b4b6cfcae40d`。本機可重建副本放在
`reports/corpora/create-t3-app`，基準資料庫是 `reports/demo-create-t3.db`；兩者都在
`reports/` 下，不是產品輸入，也不取代 Osiris golden。

#### 為什麼選它

| 候選 | commit | 提到 PR/issue 的 commit | 嚴格 revert | 刪除過的 TS/TSX | 裁決 |
|---|---:|---:|---:|---:|---|
| `t3-oss/create-t3-app` | 1,378 | **951（69.0%）** | 4 | **83** | 選用 |
| `modelcontextprotocol/typescript-sdk` | 1,597 | 723（45.3%） | 12 | — | PR 文化未達 50% 目標 |
| `vuejs/pinia` | 2,273 | 668（29.4%） | 4 | — | PR 文化太低 |
| `modelcontextprotocol/inspector` | 2,604 | 825（31.7%） | 35 | 251 | excursion 足、PR 文化不足 |
| `pmndrs/zustand` | 1,372 | 903（65.8%） | 12 | **6** | PR 文化好，但被推翻痕跡太薄 |

`create-t3-app` 目前 544 個 tracked files 中有 107 個 `.ts`、48 個 `.tsx`。若把
Markdown／MDX／Astro 文件算進分母，TS/TSX 是 28.5%；但實際程式碼以 TS/TSX 為主
（155 個，對 26 個 JS/MJS），符合目前 parser 的語料範圍。更重要的是它有一條可見、
可驗證的 excursion：`e35cedfa39` 在 2023-05-25 加入整個 `t3-upgrade` 專案，
`519fac5a32` 在 2025-03-21 以 `chore: nuke upgrade` 移除；後者一次刪掉該目錄
18 個 TS/TSX 檔與 1,901 行；該 commit 全體則是 4,449 deletions。這不是只看
commit subject 猜測，而是完整目錄
從加入、維護到消亡的 Git 軌跡。

#### 完整結構層基準

固定 SHA 的 fresh DB full-mode 實跑結果：

| 類別 | 指標 |
|---|---|
| 規模 | 1,378 commits；975 lineages；3,606 revisions；405 entities |
| pass 1 | 0.977 s；5,752 file changes；31,677 hunks；0 orphan |
| pass 2 | 7.297 s；490 個 commit 有宣告；3,201 matches；32 cross-file matches |
| **總耗時** | **8.277 s** |
| **峰值 RSS** | **456,672 KiB（446 MiB）**，由 `process.resourceUsage().maxRSS` 量得 |
| **線性外推 10k commits** | **約 60.1 s（1.00 分鐘）** |
| accepted tier | L1 3,148 · L2 18 · L3 1 · L3b 2 · L3c 0 · L4 10 · L5 22 |
| 斷層 | **0**（路徑重現 0、佔用者置換 0） |

三次 fresh full run 的總時間為 8.311、8.310、8.277 秒，產出一致。這是第一次用
1,000+ commits 實測，不再沿用 Osiris 99 commits 的 9.15 分鐘外推；新結果大幅變好，
照實記錄，不反向調整 matcher 門檻。

（MinHash 修正後重測為 walk 1.10 s + pass 7.78 s = **8.88 s**，結構產出逐項相同。）

### 第二個 1,000+ commit 語料的獨立複驗（2026-08-02）

單一語料的外推不足以宣稱效能預算成立，所以補了第二個。
`pmndrs/zustand`，SHA `beca84e600e4e250f6b244d22878e72948f331c7`，1,372 commits。
**這是複驗用的量測，不是新的 demo 語料**，也沒有放進 `reports/corpora`。
重現方式：`git clone https://github.com/pmndrs/zustand.git` 後 checkout 該 SHA。

| 指標 | create-t3-app | zustand |
|---|---|---|
| commits | 1,378 | 1,372 |
| revisions | 3,606 | **11,940** |
| 每 commit 的 revision 密度 | 2.62 | **8.70** |
| entities | 405 | 620 |
| matches | 3,201 | 11,320 |
| tier 分佈 | L1 3148·L2 18·L4 10·L5 22 | L1 7106·**L2 2060**·**L3c 1888**·**L4 235**·L5 8 |
| 總耗時（三次中位數） | 8.88 s | 9.93 s |
| 峰值 RSS | 464 MiB | 535 MiB |
| **外推一萬 commit** | **1.07 分鐘** | **1.21 分鐘** |

**zustand 是遠比 create-t3-app 難的語料**：每個 commit 的 revision 密度是 3.3 倍，
而且真正把匹配階梯用起來了——L2 2,060 條、L3c 1,888 條、L4 235 條，
對照 create-t3-app 的 18 / 0 / 10。它同時也是 `slot_discontinuity` 第一次在
demo 以外的語料上有實際數量（27 條）。

兩個語料都落在 1.1–1.3 分鐘，預算是 10 分鐘。三次 run 的 tier 分佈完全相同。
**「一萬 commit 約一分鐘」現在有兩個獨立語料支撐，不再只是單點外推**，
但仍不宣稱成普遍保證：不同 repo 的單次 commit 大小差異可以很大。

#### 證據層與 linked 水位

stated 收入 1,378 份 commit message，27 份有理由（**2.0%**），31/31 candidates
通過 span 驗證，建立 1,310 條 `reference_link`。其中有 1,085 個不同目標；依計畫的
`distinct to_key × 3` 粗估至少 **3,255 requests**，尚未計分頁。現行 linked 實作會
逐 reference row 取回，同一目標若被多個 commit 提及也會重取，因此 1,310 rows 的
上界是 **3,930 requests 加分頁**，已接近單一認證時段 5,000 requests 的額度。

#### linked 基準（2026-08-02 完成，live）

**阻塞解除，基準已建立。** 1,310 條 reference 全部取回，`missing: 0`。

| 指標 | 值 |
|---|---|
| reference（修正後） | **1,278 PR / 32 issue**（97.6% 是 PR） |
| 相異目標 | 1,085 |
| source_doc（linked） | **7,425**（pr_comment 4,249 · pr_review 2,015 · pr_body 1,059 · issue_comment 76 · issue_body 26） |
| 有理由的文件 | 350 |
| linked 候選 / 升格 / **拒絕** | 381 / 381 / **0** |
| 有 evidence 的獨立 `provenance_root` | **280**（linked 253 · stated 27） |

**commit 層覆蓋率（分母 1,378）：**

| 層 | commit 數 | 比例 |
|---|---:|---:|
| stated（commit message） | 27 | 2.0% |
| **linked（PR／issue 討論串）** | **224** | **16.3%** |
| 兩者皆有 | 19 | 1.4% |
| **聯集** | **232** | **16.8%** |

**linked 是 stated 的 8 倍，而且幾乎不重疊**（交集只有 1.4%），所以它是淨增
14.3 個百分點，不是把同一批 commit 再數一次。這正面證實了選這個語料的理由：
squash-merge 文化把理由推進 PR，只讀 commit message 會漏掉八成以上的解釋。
對照 Osiris 的天花板（99 個 commit 只有 10 個提到 issue/PR，聯集 10–11%）。

**span 斷言 0 拒絕**：381 條候選全部通過，抽取器仍未產出自己的驗證器會拒絕的 span。

#### 但「通過驗證」不等於「有資訊量」

span 斷言保證引文**逐字存在於原文**，它不保證那段文字**說了什麼**。實測 381 條：

| 類別 | 條數 | 比例 |
|---|---:|---:|
| 長度 < 30 字元 | 44 | 11.5% |
| 以 `?` 結尾（是提問不是解釋） | 29 | — |
| 以 `:` 結尾（指向後文，本身無內容） | 13 | — |
| **上述任一（可疑無資訊量）** | **79** | **20.7%** |

長度中位數 68 字元、四分位 41／115。最短的幾條是
`「the reason」`、`「otherwise.」`、`「since version 7?」`、`「because of this:」`——
規則式抽取器命中了因果標記，但標記後面沒有實際內容。

**這是抽取器的問題，不是驗證器的問題，也不是語料的問題。** 現行規則從因果標記處
起算到句尾，遇到「the reason」這種標記自身就是整個句子的情況就會抽到空殼。
可能的方向：要求標記後至少有 N 個實詞、排除以 `?` 結尾的句子、排除標記後只剩
指示代名詞的情況。**動之前要先量「收緊之後真正的理由掉了幾條」**——寧可留雜訊，
不可濾掉真的解釋。

> 這三個方向後來**全部被裁決結果否決**，見下方〈裁決結果與抽取器修正〉。
> 量出來的代價是：長度門檻殺 55 條真理由才換到 8 條空殼。

#### 裁決樣本已產出（2026-08-08，`pnpm quotes:audit`）

`src/golden/audit-quotes.ts` 把可疑引文分組列出供人工裁決。**列完整聯集不抽樣**：
只有百來條，全部裁決得到的是精確值，而這個數字要拿來決定是否收緊抽取器，
外推的信賴區間比省下的時間貴。

demo 語料 443 條 evidence（381 linked + 62 stated），**103 條（23.3%）**被至少一條
候選規則抓到：

| 規則 | 命中 | 獨立代價 |
|---|---:|---|
| R1 長度 < 30 字元 | 68 | 68 |
| R2 以 `?` 結尾 | 29 | 23 |
| R3 以 `:` 結尾 | 13 | 12 |
| R4 標記後不足 4 字元 | 5 | **0** |
| R5 標記後只剩指示代名詞 | 1 | **0** |

**R4 與 R5 沒有獨立代價**——它們命中的每一條都同時被 R1 抓到，所以不是可以
單獨採用的方案。這件事在只看「命中數」時完全看不出來。

**兩個在裁決之前就成立的觀察**（不是裁決結果，裁決是作者的工作）：

1. **R1 的 68 條裡有 42 條（62%）是 `instead of` / `rather than`**——被拒絕的
   替代方案，正好是這個專案的核心題目（「哪些做法試過又被推翻」）。
   `instead of main`、`instead of fetch`、`to avoid early return` 都短於 30 字元
   而且都有內容。**長度門檻會優先刪掉價值最高的那一批。**
2. **R4 比長度精確，但仍誤傷 `instead of 4.`**——residue 只有一個字元，
   可是那個 `4` 就是內容。

裁決欄是**三選一不是二選一**：`真理由` / `空殼` / `該拉長`。第三個存在是因為
附上前後文之後看得出來，有些引文的理由其實在隔壁行——那導向的是「把 span 邊界
拉長」，與「丟掉這條」是完全不同的抽取器改動。只給留刪二選一的話，
span 切太短會被誤記成這條沒有價值。

**Osiris 不能用來做這件事**：99 則 commit message 只有 4 則寫了為什麼，
evidence 共 4 條、可疑 2 條。裁決只能在 demo 語料上做。

報告在 `reports/quote-audit.md`（`reports/` 不進版控，用指令重生）。

**重新定價要靠 `(external_id, quoted_text)`，不能靠 evidence id。** `--json` 兩者
都保留，但作廢重建會讓 rowid 換一輪——這與不變量 1 是同一件事，只是換到證據層。

#### 裁決結果與抽取器修正（2026-08-09）

103 條全部裁決完畢：**真理由 87／空殼 9／該拉長 7**。逐規則拆開之後，
原本的五條候選規則**全部被否決**：

| 規則 | 命中 | 空殼 | 真理由 | 該拉長 | 精確率 |
|---|---:|---:|---:|---:|---:|
| R1 長度 < 30 | 68 | 8 | **55** | 5 | 11.8% |
| R2 以 `?` 結尾 | 29 | 2 | 26 | 1 | 6.9% |
| R3 以 `:` 結尾 | 13 | 0 | 11 | 2 | **0%** |
| R4 標記後不足 4 字元 | 5 | 3 | 1 | 1 | 60% |
| R5 只剩指示代名詞 | 1 | 0 | 0 | 1 | 0% |

**長度門檻要殺 55 條真理由才換到 8 條空殼**，R3 更是殺 11 條換 0 條。
「可疑引文」這個框架本身是錯的：可疑不等於沒有資訊量。

裁決逼出的是另一個結論：**9 條空殼有三個各自獨立的成因，全部是標記配到了
另一個詞義，不是品質門檻問題。**

1. **`since` 的時間義**（4 條）：`since August.`、`since version 7?`。
   英文的 `since` 同時是「因為」與「自從」，而 `indexOf` 分不出來。
2. **標記後空無一物**（3 條）：`the reason`、`otherwise.`。判準是標記後有沒有
   字母或數字，**不是剩幾個字元**——`instead of 4.` 一樣短，那個 `4` 就是內容。
3. **`so that` 接繫詞**（`so that's` / `so that is`）：那是「所以，那個是」，
   不是表目的的 `so that`。這一類的理由在標記**之前**，所以左邊界往前拉到句首
   （句末標點為界，只在行內找），不是丟掉。裁決把這一類全判為「該拉長」。

`EXTRACTOR_VERSION` 升到 `0.2.0`（不變量 7）。demo 語料 repo 1 前後對照：

| | 前 | 後 |
|---|---:|---:|
| evidence | 412 | 403 |
| 可疑引文 | 91（22.1%） | 82（20.3%） |
| 空殼 | 8 | **2** |
| 該拉長 | 7 | 3 |
| **真理由** | 76 | **76（一條沒掉）** |
| stated 覆蓋率 | 2.0% | 1.9% |

R4 的命中從 5 掉到 1，剩下那條正是 `instead of 4.`——它是真理由，本來就不該被抓。

**刻意沒修的兩條空殼**，理由都是「規則會比它要修的問題更貴」：

- `Otherwise looks OK to me`（`otherwise` 的「在其他方面」義）：只有 1 條已裁決
  案例，而最明顯的模式（`otherwise` + 無主詞動詞）在同一份語料上還會打到另外
  2 條未裁決的引文。為 1 條案例訂規則是過擬合。
- `the reason for having prettier slowing down the eslint server?`（問句）：
  R2 的精確率 6.9%，26 條真理由是提問形式的設計質疑。

**3 條「該拉長」也刻意沒修**：理由在下一段、圖片或 blockquote 裡，要跨行往後
擴張。跨行會把別人的句子收進來——`provenance_root` 是以文件為單位去重的，
行與行之間可能根本不是同一個人在說話。

#### 升版本而不作廢，等於修正在用過的資料庫上無效（2026-08-09 同批修）

`submitCandidates` 是純新增的，所以光升 `EXTRACTOR_VERSION` 不會讓任何既有資料庫
改變：舊演算法留下的空殼引文原地不動，而使用者完全看不出來。**這是「同一個問題、
兩種執行方式給不給同一個答案」那條線上的第 5 個實例**——全新資料庫拿到修正後的
結果，用過的資料庫拿到修正前的結果。

`discardStaleRuleEvidence` 依 `evidence_candidate.generator_version` 作廢舊產出，
兩個版本前綴（stated 與 linked）都算「當前」，否則後跑的那一支會刪掉先跑的那一支
剛寫好的列。**`source_doc` 不動**：linked 文件是花網路取回來的，重抽取完全離線。
兩道 DELETE 不依賴級聯，`PRAGMA foreign_keys` 開關都得到同一個結果；回報的數字
先數再刪，否則 `candidates` 會隨 pragma 變動。`why` 與 `evidence extract` 都會
印出作廢通知，共用同一份字串。

實測：demo 語料 repo 1 作廢 412 條、重抽 403 條（30 stated + 373 linked）。

#### 中文標記沒有詞界（2026-08-10，抽取器 0.3.0）

**是自我索引發現的，不是測試發現的。** 拿 `pnpm why:cli` 指向這個 repo 自己，
時間軸上的引文一眼就看得出從詞中間開始。33 條 evidence 裡 **15 條（45%）** 如此，
13 條來自裸的 `理由`。

最嚴重的一條：

```
原文：…所以版本字串沒有⟦理由改變。⟧
引文：理由改變。
```

原文說「版本字串**沒有**理由改變」，抽出來的是「理由改變。」。**span 斷言完全
通過**——引文逐字出自原文。不變量 8 的字面滿足了，誠信沒有：否定詞留在 span
外面，一段逐字為真的子字串主張了相反的事。

> **抽取式加驗證是誠信的必要條件，不是充分條件。** 這一條要寫進設計裡：
> `verifySpan` 保證引文出自原文，不保證切點沒有把句子的意思切反。

成因與英文那三個同型：標記配到了別的東西。中文沒有詞界而 `indexOf` 照配，
`理由` 命中 `真理由`／`判斷理由`／`當成理由`／`沒有理由`。

修法取現成的對稱性：英文的名詞標記本來就帶冒號（`reason:`、`why:`），中文的
`理由`／`原因` 是名詞卻沒帶。改成 `理由：`／`原因：`（半形亦收）。

**兩條候選規則，實測定價後選了後者**：

| 規則 | 殺掉的壞引文 | 誤殺的好引文 |
|---|---:|---:|
| 前一字不得是漢字（泛用） | 0 | **1**（`必須進水位線否則規則只是願望。`） |
| 名詞標記要求冒號 | **13** | 0 |

泛規則之所以無效，是因為連接詞接在漢字後面是合法的（`這是因為…`）；
27 次 `理由`／`原因` 裡只有 1 次帶冒號，其餘 26 次沒有一條是真的理由。

前後對照：

| | 前 | 後 |
|---|---:|---:|
| 自我索引 evidence | 33 | 14 |
| 引文切在詞中間 | 15 | **2** |
| 新增的引文 | — | 0 |
| demo 語料（英文） | 433 | **433（一條沒動）** |

剩下的 2 條是量測用啟發式的誤報，不是缺陷：`原因：界線先前不存在。` 與
`否則規則只是願望。` 讀起來都是對的。

**evidence 從 33 掉到 14 是把灌水擠掉，不是覆蓋率退步。** 消失的 19 條裡
13 條切在詞中間，另外 6 條是「理由」這個名詞的一般用法（`理由都記進
architecture.md：`），沒有一條是對某次改動的解釋。

**為什麼兩套黃金測試集抓不到：Osiris 與 create-t3-app 都是英文語料。**
抽取器宣稱中英並列，中文那一半從來沒有語料驗過。這是掃描線的兄弟版本——
**同一個功能、兩種語言，只驗了一種**。

#### repo 身分不正規化會產生假斷層（2026-08-10）

**這條先前被我判為「只是浪費」，實測推翻了那個判斷。**

`upsertRepo` 拿 `--repo` 的原字串當身分，所以同一個 repo 的不同拼法各建一列。
後果不是重複索引而已——`why` 會說：

```
serializeAccount 在這個檔案的歷史上有 2 個不同的實體（slot 延續但內容血緣斷開）
```

三個 entity 的 `stable_key` **完全相同**，是同一段程式碼。這是**假斷層**，
不變量 2 指名的最嚴重失效模式：「假斷層會叫使用者忽略真實歷史」。

**用預設參數就撞得到**：`ostracon why X` 之後再 `ostracon why X --repo .`，
同一個目錄、沒有 `--db`、沒有任何特殊旗標。

**根因不在 `upsertRepo`。** `lineage_id` 其實是全域唯一的（repo 1 拿 1–8、
repo 2 拿 9–16）。洩漏在 `lineageIdAt` 的快路徑：

```sql
WHERE gc.sha = ? AND fc.path = ?     -- 沒有 repo 過濾，也沒有 LIMIT
```

同一個 sha 出現在多列 repo 時 `.get()` 隨便挑一列，`why` 於是拿著別列的血緣去
索引卻寫上自己的 `repo_id`。**同一支函式的 fallback 查詢有做 repo 過濾，
快路徑漏了**——疏忽，不是設計。它也不依賴重複列才能觸發：上游與 fork
索引進同一個資料庫時 sha 本來就共用。

**修法分兩層，兩層都要：**

1. **身分正規化**用 `git rev-parse --show-toplevel`，不是 `path.resolve`。
   實測三種拼法的收斂能力：

   | 拼法 | `path.resolve` | `--show-toplevel` |
   |---|---|---|
   | 相對 → 絕對 | ✅ | ✅ |
   | 子目錄 → repo 根 | ❌ | ✅ |
   | symlink → 實體路徑 | ❌ | ✅ |

   macOS 的 `/tmp` 就是 symlink，而 `--repo` 預設是 `process.cwd()`，
   從子目錄跑就是子目錄字串。不增加相依，`tryGit` 已經在那裡。

2. **查詢層綁 repo**（`lineageIdAt`、`lineagesEverAt`、`entitiesFor`）。
   第 1 層擋的是「別再產生重複」，第 2 層擋的是「已經有重複的舊資料庫也要給
   對的答案」。**存下來的相對 `root_path` 無從還原**（不知道當初的 cwd），
   所以收斂不保證清得乾淨——只做第 1 層的話，既有使用者的資料庫永遠是錯的。

**遷移**：`consolidateRepoPaths` 在索引開始時把能證明是同一個 repo 的舊列收斂
成一列（留 commit 最多的），並把這件事印出來。少了它，改用正規路徑當身分
反而會再插一列——**親手製造出這個修正要消滅的重複狀態**，那就是
「升版本但不作廢舊產出」的同型錯誤。目錄已不存在的舊列一律不動：那可能是
別台機器搬過來的資料庫，無從判斷是不是同一個 repo，刪掉就是刪使用者的東西。

實測（同一個 repo 四種拼法：預設、`--repo .`、絕對路徑、從子目錄 `--repo ..`）：
修正前第二次起就報假斷層，修正後**四種輸出逐字相同、repo 表只有一列**。

#### 以 sha 為鍵的查詢全面綁 repo（2026-08-12）

上一條的殘留。**sha 在單一 repo 內唯一，在資料庫內不唯一**：上游與 fork、
`git clone`、`git worktree` 都共用歷史。`--db` 預設是相對 cwd 的
`.ostracon/index.db`，所以**在同一個目錄下對兩個 repo 各跑一次就落進同一個
檔案**——拿 fork 跟上游比對正是這個工具的自然用法。

`commitId(db, sha)` 在**寫入路徑**上（`ensureRevision`、`ensureEntity`、
`revision_change` 都經過它），不綁 repo 就回傳任意一列。實測（12 個 commit 的
fork／upstream，預設參數）：

| | 修正前 | 修正後 |
|---|---:|---:|
| `why` 之後的跨 repo 關聯 | 5 | **0** |
| `ostracised`（全 repo pass）之後 | **66** | **0** |
| `DELETE FROM repo` | FK 違反，**失敗** | 成功，另一個 repo 未受影響 |
| `why` / `ostracised` 的輸出 | 四組比對全部相同 | 同左 |

**這是潛伏汙染，不是錯答案。** 輸出當時仍然正確，因為查詢鏈都繞過
`commit_id`；`stable_key` 也不受影響（它雜湊的是 sha 字串而不是列，所以
不變量 1 安全）。但汙染隨每次索引累積、隨 repo 大小成長，而且已經讓資料庫
變得刪不掉。**下一個加上 `commit_id` join 的人會直接踩到。**

修正是機械式的參數穿透：`commitId`、`hunksFor`、`isParentOf` 全部加 `repoId`，
`writeChange` 與 `writeDiscontinuity` 的 args 補上 `repoId`。

**真正耐久的是 `assertNoCrossRepoRows`**：結構層寫入之後檢查這個 repo 沒有任何
一列指向別的 repo 的 commit，`why` 與 `ostracised` 各呼叫一次。潛伏汙染看不見，
所以不能靠眼睛擋——這與 `assertExcursionScope` 是同一個模式。
成本實測：demo 語料 7,212 列 revision，三道檢查合計 **29.8 ms**（每次指令一次，
不是每次查詢），相對於索引本身的秒級耗時可以忽略。

`topo_order` 的排序風險量過：共用前綴的 12 個 sha **topo_order 全部一致**，
所以排序目前不會出錯。那是線性歷史的性質，不是保證——但綁 repo 之後這條路
已經封死，不必再依賴它。

#### 中文 controlled fixture 與 `kind: evidence`（2026-08-10）

上一條的耐久修法。**沒有拿自我索引當 golden**：repo 每次 commit 都在動，
而黃金測試集的錨點必須釘死（不變量 14）。改成在既有的 controlled repo 尾端
追加四則中文 commit message——`build-controlled-repo.mjs` 是決定性的，
實測兩次產生逐位元相同，既有案例的 SHA 一個都沒變。

`kind: evidence` **先前只寫在 `golden-fixtures-spec.md` 裡、沒有實作**
（evaluate.ts 與 materialize.ts 零命中），所以證據層的任何退步都沒有黃金測試集
在擋。中文標記的 bug 就是這樣溜過去的。這次一併實作：

| 案例 | 難度 | 守什麼 |
|---|---|---|
| `evd-zh-negation-outside-span` | adversarial | `沒有理由改變` 不得抽成 `理由改變。` |
| `evd-zh-marker-mid-word` | adversarial | `真理由`／`判斷理由` 不得命中 |
| `evd-zh-colon-marker` | hard | `理由：…` 照常抽出（負例的價格標籤） |
| `evd-zh-conjunction-after-han` | hard | `這是因為…` 不得被詞界規則誤殺 |

**這組案例確認過它會失敗。** 把抽取器改回裸的 `理由` 之後重跑，恰好
兩條 adversarial 失敗、其餘五條照常通過，`binary` 回報
`{"expected":{"spans":0},"actual":{"spans":1}}`，`observed` 直接列出
`理由改變。`。沒看過失敗的黃金案例只是裝飾。

controlled 基準線 4 → 8 條，全部 pass；既有四條的判定一字未改。
Osiris 33/33、create-t3-app 3/3 不變。

#### entity 相關性已處理（2026-08-02）

`suppressUnrelatedRationale`（`src/cli/why.ts`）在查詢層抽掉 `change_level = 'none'`
列上的引文，只保留參照指標。標頭交代被抑制了幾次改動、幾則討論串——
**靜默丟掉與靜默誤植同樣不誠實**：前者讓使用者以為沒有理由可查，而其實有。

| 語料 | 保留的引文 | 被抑制的參照 | 仍有引文的 entity |
|---|---:|---:|---:|
| create-t3-app | 2,110 | 1,167 | 307 / 405 |
| Osiris | 279 | 310 | 123 / 307 |

（以上是**去重後**的代表引用數，比原始 evidence 列少。）

**接線本身要有整合測試守。** 純函式對不代表它真的被呼叫到：實測把
`suppressUnrelatedRationale` 從 `timelineOf` 拆掉、把同名存活查詢改成回空陣列，
**250 條測試全部通過**——兩者各有會咬的單元測試，但沒有任何東西斷言它們被接上了。
現在 `why.test.ts` 有兩條走完整 `why` 的整合測試；重跑那兩個拆線實驗，
各自被對應的測試擋下。

這也是為什麼**不替呈現層新增 golden case kind**：缺口不是「golden 表達不了」，
是整合測試沒寫。新增 kind 會讓 golden 同時代表兩種東西（索引器對歷史的判斷
vs 輸出字串），稀釋「覆蓋率 33/33」這個頭條數字，而且不變量 14
「錨點只能是 git 原生座標」對呈現層案例沒有意義。一條整合測試就守得住的事，
不該用 fixture 規格變更去守。

**沒有蓋 hunk 交集那套機制。** 原本的計畫是拿 `file_hunk` 的行範圍與 `revision`
的行區間相交，實作出來量過之後發現它幾乎完全等價於 `change_level != 'none'`：
`shape`／`alpha`／`death`／`raw`／`token` **100% 有交集**、`none` **98.7% 無交集**。
而在兩者不一致的地方 `change_level` 更精確——那 32 條「`none` 但有交集」是 hunk
觸及了行區間、但改的是上下文行，實體本身逐字未變，hunk 規則會誤收。
既然現成的欄位更準，就不要另外蓋一套還要處理 merge 無 hunk 與邊界語意的比對邏輯。

**方向偏保守：寧可濾掉，不可留錯。** 誤濾的話使用者少看到一條解釋，但參照還在，
他可以自己去讀那個 PR；漏濾的話他會讀到一個關於別段程式碼的理由，而且
**沒有任何辦法察覺那是錯的**（引文逐字為真、編號正確、span 驗證通過）。
與「誤報斷層比漏報嚴重」同一個道理。代價實測：44 個 entity（12.5%）
完全失去引文，entity 覆蓋率 86.7% → 75.8%。

在查詢層而不是寫入層：`evidence` 列是事實，歸屬是判斷。判斷寫進資料庫等於把門檻
烤進儲存資料，而且規則一改就要重建索引。

#### 原始量化（2026-08-02）

先前只知道「引文 span-correct 但未必 entity-relevant」是個現象。實際量出來之後，
**它比 20.7% 那件事嚴重得多**。以 demo 語料的每一次「引文顯示」（entity × commit ×
evidence 三元組，共 6,367 次）計：

| 類別 | 次數 | 比例 |
|---|---:|---:|
| 掛在 `change_level = 'none'` 的列上（該 entity 在該 commit 根本沒變） | 2,653 | **41.7%** |
| 幾乎無資訊量 | 1,532 | 24.1% |
| 兩者皆是 | 674 | 10.6% |
| **兩項都乾淨（真的有改動 + 引文有內容）** | **2,856** | **44.9%** |

換一個切法：會顯示引文的 1,272 條（entity, commit）列裡，**648 條（50.9%）是
`無變更`**。時間軸上「這是為什麼」出現的位置，有一半以上是那個 entity 什麼都沒發生
的地方。

**這是意圖層的前置條件，不是呈現層的打磨。** 不變量 9 只擋 `inferred`；
`stated` / `linked` 是直接呈現、帶完整可信度的。相關性錯誤會原封不動變成
自信的錯誤宣稱，而意圖層的工作正是把 evidence 變成 claim——在 44.9% 可信的
基礎上蓋推論，是把錯誤放大而不是產生洞見。

歸屬本身不是無解的：`file_hunk` 已經有每個 commit 的行級改動範圍，而 `revision`
有每個 entity 的行區間。兩者相交就能判斷「這個 commit 的哪些 hunk 落在這個 entity
裡」，進而分辨「這條理由是不是在講這段程式碼」。這是結構性的、零 LLM 的，
與斷層／迂迴同一類手法。**但門檻怎麼訂要人裁決**，且要先確認收緊後真正的理由
掉多少。

#### 實際成本與去重的效果

| 指標 | 值 |
|---|---|
| 實際請求 | **3,229**（issues 1,085 + comments 1,085 + reviews 1,059） |
| 未去重會是 | 3,898（1,310 + 1,310 + 1,278） |
| **去重省下** | **669 次（17.2%）、約 10.5 分鐘** |
| `deduplicated` 回報 | 225（= 1,310 − 1,085，與相異目標數完全吻合） |
| 耗時 | **3,057 s（51 分鐘）**，1.06 req/s |
| 分頁 | **完全沒有觸發**——每個目標的 comments 與 reviews 都只要一次請求 |
| 暫時性網路錯誤 | **4 次**，全部由 runner 的退避重試恢復 |

**4 次 `fetch failed` 是這一趟最重要的實測**：產品的 `createGitHubFetcher` 沒有重試，
換成正式 CLI 這趟會在第 8 分鐘、第 18 分鐘、第 21 分鐘各炸一次。水位線讓它可以續跑，
但要人守著重跑四次才做得完——這是上面「兩個尚未修的問題」第 2 條的實證。

**注意**：這個資料庫的 `declarations` 水位線仍帶 MinHash 修正前的版本字串，
所以現在對它跑 repo pass 會（正確地）要求重建。結構產出已證實逐項相同，
linked 基準不受影響，但要繼續做結構層的話得重建一次。

#### 十條時間軸眼檢

實際逐條讀了：改動最多的 `AvailableDependencies`、`runCli`；改名的
`envVariablesInstaller`；跨檔案的 `createInnerTRPCContext`、`getBaseUrl`、
`AppRouter`；隨機抽到的 `AuthShowcase`、`createTRPCContext`、
`KnownLanguageCode`；以及 excursion 見證 `upgrade.getDiffFromGithub`。

- **像決策史的約 4/10，乾巴巴或誤導的約 6/10。** 尚未到 8/10 的題目級否決線，
  但不是可以忽略的 UI 雜訊。長時間軸常被 `[L1] 無變更` 淹沒；例如
  `AvailableDependencies` 68 次、`KnownLanguageCode` 32 次，大部分只是同檔其他位置被改。
- **判定依據有兩個真的有用。** `envVariblesInstaller → envVariablesInstaller` 的
  `[L3b]` 與跨路徑延續的 `[L5]`，不用懂 matcher 也能理解；反之每列都印 `[L1]`
  幾乎沒有使用者價值。`AppRouter` 的 `[L5，2 個等價候選]` 誠實揭露歧義，應保留。
- **理由引文是 span-correct，但未必 entity-relevant。** `t3-upgrade` 的出生列掛到
  「because they contain 0's」；`AvailableDependencies` 也吃到同 commit 其他改動的理由。
  引文確實存在於 commit message，卻不一定解釋眼前實體。linked 尚未跑完前不能判定
  PR 脈絡能改善多少，但 UI 不應把 commit-wide 理由暗示成 entity-specific 因果。
- `upgrade.getDiffFromGithub` 的 2023-05-25 誕生與 2025-03-21 消亡非常清楚，證明
  語料本身確實有 excursion 可偵測。

本次工作未修改 `src/`、`test/`、`fixtures/` 或 `db/schema.sql`。眼檢當下（excursion
偵測器尚未實作）Osiris golden 為 **32 pass / 0 fail / 1 missing（32/33）**。

### `--full` 在用過的資料庫上靜默無效（2026-08-08 已修）

從「同一個問題，兩種執行方式給不給同一個答案」這條線掃出來的第四個缺陷，
也是目前最嚴重的一個：**踩到它不需要任何旗標**。

`--db` 預設是 `.ostracon/index.db`（`why.ts:626`），所以最自然的序列就是壞的那種：

```
$ ostracon why src/lib/ssrf-guard.ts:isRateLimited          # 只有 1 次改動，可疑
$ ostracon why src/lib/ssrf-guard.ts:isRateLimited --full   # 加旗標重問
  → 完全相同的錯誤答案，沒有任何提示
$ ostracon why ... --full   # 換一個乾淨的 db
  → 6 次改動，誕生於 src/app/api/scanner/route.ts
```

使用者加 `--full` 正是因為文件說「跨檔案搬移才看得見」。系統跑完整趟全 repo
pass（entity 9→308）、L5 也確實配對到了，然後把答案丟掉。

根因不是 `ensureRevision`（它對既有的 `(commit_id, slot_id)` 直接回傳既有 id，
從不檢查 `entity_id`），而是**快路徑跑完不留任何痕跡**——`lineage-pass.ts`
完全沒碰 `pass_state`，沒有任何欄位記得結構層是用哪一種候選池建的。
`excursion` pass 早就把 scope 編進版本字串了；規則寫在衍生層上，卻沒套用到
它所依賴的那一層。設計與方向的不對稱見 `architecture.md`。

**影響範圍**（血緣跨越一條以上 lineage 的 entity ＝ 快路徑必定看不全的那些）：

| 語料 | entity | 跨檔案 | 受影響的檔案 |
|---|---:|---:|---:|
| Osiris | 307 | 1（0.3%） | 2 / 71（2.8%） |
| create-t3-app | 405 | 29（7.2%） | 76 / 297（**25.6%**） |

create-t3-app 每四個檔案就有一個，裡面至少有一個構造的血緣是快路徑看不全的。

`src/golden/materialize.ts` 自己就在跑那個順序（discontinuity 案例走
`indexLineage`、excursion 案例走 `indexRepoStructure`，同一個資料庫）。修正後
Osiris golden 實測會觸發一次 `mode = "rebuilt"`，**33/33 不變**；
create-t3-app 3/3、controlled 3/3 也不變。測試 254 → 258。

順帶量到的一件事：`node:sqlite` 的 `PRAGMA foreign_keys` **預設是 1**
（SQLite 的 C 預設是 0）。不變量 13 的「每連線都要設一次」仍然該遵守，
但要知道它目前是深度防禦而不是承重牆。

**`--until` 已一併驗過，沒有同型缺陷**（同一個資料庫、兩種調用參數）：
先索引到第 40 個 commit 再推進到終點，與一次索引到底，307 個 entity
逐個 `stable_key` 完全相同；反方向（水位線比 `--until` 新）在
`isAncestor` 就明確報錯，不會靜默混歷史。

**`ostracised` 的重建提示已補上（2026-08-08）**：它同樣預設 `.ostracon/index.db`、
同樣會觸發作廢重建，但先前把 `RepoPassReport` 丟在地上，重建完全沒說。
對這支指令而言沉默的代價比 `why` 更高——搬移守門在單一血緣下是瞎的，
沒重建的話名單**本身是錯的**而不只是比較短。提示文字改為共用常數
`REBUILD_NOTICE`。兩條接線測試走完整 CLI 路徑斷言輸出，拿掉任一邊都會紅。

### SQLite 使用範圍

正式走訪層的 persistence 呼叫集中在 `src/git/persist.ts`；但 golden 的
materializer、runner 與 evaluator 目前會為建料／查詢直接使用 `node:sqlite`。
「所有 SQLite 呼叫都只在一個檔案」**不是目前事實**，別依這個假設重構。

---

## 3. Schema 重點

**目前是 v2**（`schema_migration` 記錄它，`openIndexDatabase` 比對它）。
v1 → v2 的唯一差別是內容定址：內容衍生欄位移到 `declaration_content`，
`revision` 只留身分與位置，雜湊與 `blob_sha` 改存 BLOB。見上方對照與
`plan-content-addressed.md`。以下是 v0.5 當時記的其餘重點，仍然成立。

表：`repo` / `git_commit` / `git_commit_parent` / `path_lineage` /
`path_lineage_segment` / `file_change` / `file_hunk` / `slot` / `entity` / `entity_link` /
`slot_discontinuity` / `declaration_content` / `revision` / `revision_match` / `revision_change` /
`construct` / `construct_span` / `source_doc` / `reference_link` /
`evidence_candidate` / `evidence` / `claim` / `claim_evidence` / `excursion` /
`llm_cache` / `pass_state`，加上 FTS5 虛擬表與同步 trigger。

v0.5 讓 `slot_discontinuity.similarity` nullable：`NULL` 是無法比較，`0` 是精確
比較後完全不同。斷層分為 D→A 路徑重現（Git 結構事實）與低 Jaccard 的同 slot
佔用者置換；兩者都維持零 LLM。

已修過的重要問題（勿回退）：

- `file_change` 的 `UNIQUE (commit_id, path)`——否則重跑會把整批再插一次
- `path_lineage_segment` 的部分索引 `WHERE to_commit_id IS NULL`——增量續跑靠它重建存活路徑集合
- FTS5 external content 表**必須有同步 trigger**，否則全文檢索永遠是空的且不報錯
- `source_doc.external_id` 必須 NOT NULL（SQLite 視每個 NULL 為相異值，UNIQUE 會失效）
- `revision_change` 必須 CHECK 兩端不可皆 NULL
- `idx_change_entity(entity_id, commit_id)`——「給我實體 X 的時間軸」是最熱查詢
- `reference_link` 的 UNIQUE 不含 `to_kind`——那是取回後才知道的衍生欄位
- `claim` / `excursion` 用 typed nullable FK + CHECK 恰好一個非 NULL，不用多型外鍵

---

## 4. 走訪層的既有決定

### 增量索引已修的三個 bug（勿回退）

1. **lineage id 必須全域配號**（`MAX(id)` 不帶 `WHERE repo_id`）。否則第二個 repo
   從 1 重新配號，segment 全部掛到第一個 repo 的血緣上，沒有任何錯誤訊息。
   注意：全新 repo 的路徑也要帶全域起點，不只續跑路徑。
2. **`topo_order` 必須接續**，不可每批從 0 重數，否則「祖先必定小於後代」這個不變量破了。
3. **跨批次接縫的 parent edge**：本批第一個 commit 的父是水位線 commit，在 DB 裡
   但不在本批 map 中，必須回 DB 補查。

### 合併 commit 語意

只取 combined diff（與**所有**父版本都不同的部分，即衝突解決與 evil merge）。
三種結果：全父皆 `A` → `A`；全父皆 `D` → `D`；其他 → `M`。
**combined diff 不支援 `-M`，所以合併永遠不產生 `R`/`C`。**
只存在於單一父版本、在合併中被刪除的檔案完全不出現在 combined diff 裡
（相對另一父版本它前後都不存在）。

### 走訪設定

改名 `-M30%`、複製 `-C40%`，`findCopiesHarder` 預設關閉；diff 演算法明確指定
`histogram`。任何改變產出的設定變更都必須提升 `INDEXER_VERSION`
（目前 `walk-0.2.0+M30C40+histogram`）。

**已修（2026-07-28）**：版本字串先前寫死成 `walk-0.2.0+M30C40+histogram`，但
`WalkOptions` 的三個門檻都可覆寫，改了門檻卻沿用同一個版本會讓新舊產出混進同一個
資料庫而不報錯——違反不變量 7。現在由 `indexerVersion(opts)` 從實際選項算出，
`INDEXER_VERSION` 只是預設值下的常數。`git-index.test.ts` 有兩條測試守住：
改任一門檻必須換版本，且續跑時必須拒絕混接。

---

## 5. 黃金測試集現況

工具：`mine-candidates.mjs`（找素材，只回答「該去哪裡找」，**刻意不提供任何標註
建議**，避免蓋章效應與繼承 git 啟發式的盲點）、`validate-fixtures.mjs`（防止無聲
腐爛，錨點解析失敗是硬錯誤）、`TEMPLATE.yaml`。

### Runner 的三個設計決定（勿回退）

- **`pass` / `fail` / `missing` 必須分開。** 混為一談的話，索引沒跑完時整份報告是
  0% 看起來像全面失敗；真的有結果之後，一個真實退步又與「還沒被索引到」無法區分。
  覆蓋率是頭條數字，missing 超過兩成時報告明說「所有比率不可解讀」。
- **迴歸閘門逐案例比對，不比對彙總。** 覆蓋率上升時本來 missing 的案例開始被評估，
  一部分必然 fail，通過率會下降——那是新資訊不是退步。只有「基準線 pass 的案例
  變成 fail 或 missing」才算退步，且只看 hard / adversarial 層。
- **指標一律分層報告，不出單一總分。** 斷層看精確率／召回率分開（誤報比漏報嚴重）；
  change_level 看混淆矩陣（shape 誤判成 raw 是漏掉真實變更，raw 誤判成 shape 是白燒
  token，代價完全不同）；血緣看鏈級完整率並單獨計數「用了比預期更弱的 tier」。
- **materializer 必須餵完整候選池。** 先前逐案例只餵一對候選，**任何 bucket 都會
  虛假地呈現 1:1**，導致 runner 對所有唯一性相關行為完全是盲的。現在會以錨點檔案
  的完整宣告池執行匹配。

### 目前的基準線

**Osiris**：**33 pass / 0 fail / 0 missing，覆蓋 33/33（100%）**（2026-08-02 以 fresh DB
重新實跑確認）。分層全數 100%：adversarial 7/7、easy 17/17、hard 9/9；
change_level 20、lineage 11、discontinuity 1、excursion 1。

`dis-scanner-server-recreated` 由 L3c 位置錨定補上，`exc-balloons-get-git-revert`
由 entity 層級迂迴偵測補上——**後者不需要 construct pass**，見 `plan-excursion.md` §1。
兩條都補完之後 missing 歸零。其餘原有 31 條逐案例 JSON 完全未變。

斷層門檻先以 1.0 對完整 99 commit 歷史量測再收緊：共 8 個候選，其中 6 個是
同一次 `scanner/server.js` D→A、`fetchQuote` 置換 Jaccard=0.092、另一個
`Dashboard.fetchEndpoint` Jaccard=1.0 是假置換。最終門檻 0.25 重跑後為 7 條：
6 條路徑重現加 1 條佔用者置換，人工檢查全數符合證據。
先前的 29/31 基準線（`reports/osiris-prehunk.json`）逐案例仍全部一致，新增的
兩條是 L3c 的正例與負例。

**create-t3-app**：**3/3 覆蓋、3 pass / 0 fail**（2026-08-05）。專門守搬移守門——
那道判準只有在真實語料上才有意義，受控 repo 造不出跨越多個子專案的搬移。

| 案例 | 守什麼 |
|---|---|
| `exc-t3-home-prisma-same-commit`（C 級） | 同 commit 刪掉的雙胞胎不得互相抑制 |
| `exc-t3-home-prisma-auth-same-commit`（A 級） | 同上，且強度不得被高估 |
| `exc-t3-neg-getfont-moved`（`expect: absent`） | 守門的存在本身：真搬移不得被判為迂迴 |

**三條各守各的，已分別驗證會咬**：判準改回 `>=` → 兩條正例 fail；
完全拿掉守門 → 負例 fail。兩條正例的強度不同（A 與 C）本身就是證據——
它們不是同一個東西的兩份拷貝。

`golden:index` 對含 excursion 案例的 fixture 改跑**全 repo pass**（`scope: "repo"`）。
先前只索引錨點血緣、以 `scope: "lineage"` 呼叫，守門在那裡是瞎的，
`expect: absent` 的負例必然失敗。Osiris 逐案例零差異，materialize 由約 2 秒變 5 秒。

**受控 fixture**：主要指標 **3/3 覆蓋、3 pass / 0 fail**（2026-08-05）。
新增 `ctrl-non-ascii-path-move`：`src/legacy.ts` 原封不動改名成 `src/票券解析.ts`。

**這條案例是先驗證過會咬才收進來的**：把走訪層的去引號拿掉後它變成 `missing`，
baseline 更新後閘門 exit code 由 0 變 1。不會失敗的 fixture 什麼都沒守到。

它一個案例同時守住非 ASCII 檔案有沒有被解析、`R` 記錄的新舊路徑是否都去引號、
以及血緣有沒有跨過改名。新 commit 一律追加在尾端，所以既有三條案例的錨點 SHA
完全未變，只有 `index_until` 改成新的 tip。

- `ctrl-position-scoped`：外層 scope 可區分、要求 `#0→#1`。**已由 L3c 位置錨定修好**
  （先前如預期 fail，是當時列的「未來改進的真實目標」）
- `ctrl-position-ambiguous`：四種雙射都可接受、標 `label_confidence: ambiguous`、
  不計主要指標。**2026-07-28 起可實際判定**：改讀 `revision_match.ambiguity_size`，
  pass 的條件是「選中的配對落在可接受集合內」**且**「ambiguity_size > 1」。
  實測系統回報 3（三個等價前像），pass。把 ambiguity_size 改回 1 會 fail。

語料組成：20 條 change_level（raw 8 / alpha 1 / shape 6 / birth 3 / death 2）、
5 條 lineage、4 條負例（fetchEndpoint cross-occurrence 假陽性，現在全部 pass、
actual 為 unmatched）、2 條真實相似度邊界（同檔泛化 Jaccard 0.555 → L4；跨檔抽取
0.769 → L5）、1 條可重現的純宣告改名（命中 L3b）、1 條位置錨定（命中 L3c）。

`lin-fetch-endpoint-position-anchored-j91` 是唯一守住 L3c 的黃金案例，
要求 `expect_tier_at_most: L3c`。**已實測它會咬**：把 materializer 的 hunk 供給
關掉後，該案例以 `expected ["L3c"], actual ["L4"]` fail。配對的裁決依據是
enclosing scope 的 banner（四個 closure 各自唯一），不是 occurrence 序號，
也不是 matcher 的輸出。

負例 4 / 正例 12 仍低於驗證器要求的一半，這個警告在加入這兩條之前就存在，
是既有的語料缺口。

Osiris 沒有 R50–R70 的 git rename（只有一筆 R90），所以沒有硬湊分數，改用直接
作用於 matcher 門檻的精確 Jaccard 案例。**git 的 rename score 與 Jaccard 是兩個
不同的度量**，後者才是實際驅動 L4/L5 的東西。

### 已量到的主要缺陷

完整 Osiris 歷史：109 條非 L1 配對、132 個 ambiguity bucket，其中 **51 條是 L4 且
精確 Jaccard = 1.0、源自 n×m 內容歧義**——佔非 L1 配對的 47%。這 51 條集中在
25 個 commit 的 `Dashboard.fetchEndpoint` 族群，是**一種反覆出現的模式**而非
51 個分散錯誤；而它打在 `src/app/page.tsx`（攪動最高、最可能拿來 demo 的檔案）。

**2026-07-28 已解決（切片 3a）**：51 條全部轉為 L3c 位置錨定，`l4ExactOneAfterAmbiguity`
從 51 降到 0，其中 1 條配對本身被修正。前後對照見 `plan-diff-hunk.md` §5。以下是
當時的判斷記錄。

**2026-07-28 修正：這 51 條不是錯的配對。** 用 diff hunk 回推行號實測（見
`plan-diff-hunk.md` §5），50 條可判定案例中有 50 條與 matcher 現在的選擇完全一致。
它們的問題不是判錯，而是**沒有理由**：系統記的是 L4 相似度，說不出「為什麼是
這兩個」，而正確性依賴 `order` 以 `startIndex` 排序的巧合——任何擾動排序的改動
都可能讓 `stable_key` 靜默漂移。缺陷的性質從「準確率」變成「可解釋性與穩定性」。

對策見 `plan-diff-hunk.md`。切片 1（hunk parser）與切片 2（`file_hunk` 進資料庫）
已完成，Osiris 全歷史有 1607 個 hunk、其中 471 個純新增可供約束使用；
真正消費這份資料的約束層是切片 3，指標尚未改變。
