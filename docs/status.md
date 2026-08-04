# 專案現況

> 這份文件記錄「現在長什麼樣」，隨程式碼變動更新。定義與理由在 `architecture.md`，
> 規則在 `../CLAUDE.md`，資料模型的唯一真相是 `../db/schema.sql`。
>
> 最後更新：2026-08-02

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

套件 `@ostracon-dev/indexer`（`private: true`、版本 `0.0.0`）。
2026-08-01 以含 FTS5 的 Node v24.14.0 實跑全部測試 **193/193 通過**、
`tsc --noEmit` **零錯誤**。系統 Node v23.11.0 的內建 SQLite 沒有 FTS5，不能用來
跑完整 schema；這是 runtime 差異，不是測試回歸。

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
| `src/git/persist.ts` | 走訪層的 SQLite persistence | 含 FTS5 探測、增量水位線、血緣狀態載入、`file_hunk` 寫入 |
| `src/git/index.ts` | 編排 + 增量 | force push 偵測（水位線非祖先即拒絕並要求重建） |
| `src/ast/types.ts` | `SynNode` 介面與 `LanguageProfile` | 欄位是 `startIndex`/`endIndex`（UTF-16），另有 `utf8ByteRange` 轉換 |
| `src/ast/hash.ts` | **純函式**：四層雜湊、S-expression、`changeLevel` 查表 | |
| `src/ast/bindings.ts` | **純函式**：區域繫結收集 | |
| `src/ast/profiles/typescript.ts` | 全部 grammar 相依知識 | 加語言＝加一份剖面 |
| `src/ast/adapter.ts` | tree-sitter → `SynNode` + `verifyAdapter` | 已通過真實驗證 |
| `src/ast/parser.ts` | grammar 載入、TS/TSX 路由、解析與啟動驗證 | |
| `src/match/ladder.ts` | **純函式**：L1–L5 匹配階梯（含 L3b、L3c）與「本檔新生」排除 | 兩者都需呼叫端提供 `hunksByLineage`，省略時皆不啟用 |
| `src/match/position.ts` | **純函式**：hunk 位移回推、純新增 hunk 判定 | L3c 與「本檔新生」的證據來源 |
| `src/match/signature.ts` | n-gram、MinHash、精確 Jaccard | |
| `src/index/structural.ts` | 結構層共用寫入：觀察宣告、slot / entity / revision / match / change | **零 LLM**。materializer 與 `why` CLI 共用同一份，不各寫一份 |
| `src/index/lineage-pass.ts` | 單一路徑血緣的完整結構索引（解析→匹配→寫入） | `why` 的快路徑；**看不到跨檔案搬移** |
| `src/index/excursion.ts` | entity 層級迂迴偵測（A/C 級，零 LLM） | 搬移守門是必要條件；`scope` 必填且進版本字串 |
| `src/index/repo-pass.ts` | 全 repo 結構索引；候選池涵蓋一次改動的所有檔案 | L5 唯一能成立的條件；水位線 `pass_name = 'declarations'` |
| `src/cli/why.ts` | `why <path>:<symbol>` 時間軸查詢與呈現 | stated／linked 視覺分層；linked 依 provenance root 查詢時去重；`--full` 時觸發並呈現 excursion；已刪路徑走 `lineagesEverAt` fallback |
| `src/cli/ostracised.ts` | 被推翻的做法清單 | `pnpm ostracised`；一律全 repo pass，scope 不符即拒印 |
| `src/evidence/span.ts` | **純函式**：span 斷言（零寬容、零 LLM、零 IO） | 信譽架構的基石；突變測試驗證過會咬 |
| `src/evidence/extract.ts` | **純函式**：規則式理由抽取、issue 參照抽取 | linked Markdown 模式排除 code fence／引用行，不放寬因果標記 |
| `src/evidence/store.ts` | stated／linked 文件抽取；候選驗證後才升格 `evidence` | 零網路；兩種 tier 共用 staging 與 span 驗證 |
| `src/cli/extract-evidence.ts` | 對既有索引跑證據層並回報理由覆蓋率 | `pnpm evidence:extract` |
| `src/http/types.ts` | `HttpFetcher` / `HttpResponse` 網路邊界 | linked orchestration 只依賴此介面 |
| `src/http/github.ts` | GitHub live adapter | **產品樹唯一直接呼叫 `fetch` 的檔案**；Node 全域 fetch，零新相依 |
| `src/http/fixtures.ts` | HTTP fixture 錄製／replay、敏感 header 濾除 | 測試與 golden 只用 replay |
| `src/evidence/linked.ts` | PR/issue body、comments、reviews → `source_doc`；修正 `to_kind`；linked 水位線 | 不知道 live/replay 的差別 |
| `src/cli/linked-evidence.ts` | 注入 live／record／replay fetcher | `pnpm evidence:linked`；無 token 時安全略過 |
| `src/golden/materialize.ts` | 從 fixture + 真實 repo 建立 golden DB 座標、revision 與 match | fixture 專用；寫入層已改用 `src/index/structural.ts` |
| `src/golden/evaluate.ts` | 查詢 golden DB，將單一案例判為 pass/fail/missing | 會讀 SQLite，不是純函式 |
| `src/golden/report.ts` | **純函式**：分層彙總、Markdown、逐案例迴歸偵測 | 比率排除 ambiguous 案例，**迴歸閘門不排除** |
| `src/golden/cli.ts` | golden runner CLI | 舊文件誤寫的 `src/golden/run.ts` 不存在 |
| `src/golden/audit-matches.ts` | 對完整歷史的非 L1 配對與 ambiguity bucket 做審計 | |

**把核心邏輯寫成純函式（不吃 git、不吃 tree-sitter、不吃 DB）是刻意的架構決定**，
已多次兌現：npm 被封鎖時仍能完整測試雜湊層；一個跨批次血緣的嚴重 bug 只有純函式
的單元測試踩到，整合路徑剛好繞過了它。

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

### 迂迴偵測：搬移守門排除了 41% 的候選

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
| **被搬移守門排除** | **78（41%）** |
| A 級（全部是 `inverse_diff`） | 71 |
| C 級（`trajectory`） | 40 |

**沒有搬移守門，41% 的迂迴會是假的。** 它們是 matcher 漏接的搬移——
內容還在 repo 裡，只是換了檔案。而「這個做法被推翻了」講錯的代價與誤報斷層同級。

**守門的判準是「另一個 entity 在我們死亡時仍活著」，不是「有 revision 落在死亡
之後」。** `revision` 只在檔案被觸及時才寫入，所以搬過去的副本若之後再也沒被改動，
用 revision 的時間去查會完全漏掉——第一版就是這樣寫的，測試抓到之後才發現
先前量到的「13%」是嚴重低估，真值是 41%。

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
2. **只在 `why --full` 呼叫。** 單一血緣的候選池會把搬移通通判成迂迴——就是那 41%。
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
不可濾掉真的解釋。這一項未做。

#### entity 相關性已處理（2026-08-02）

`suppressUnrelatedRationale`（`src/cli/why.ts`）在查詢層抽掉 `change_level = 'none'`
列上的引文，只保留參照指標。標頭交代被抑制了幾次改動、幾則討論串——
**靜默丟掉與靜默誤植同樣不誠實**：前者讓使用者以為沒有理由可查，而其實有。

| 語料 | 保留的引文 | 被抑制的參照 | 仍有引文的 entity |
|---|---:|---:|---:|
| create-t3-app | 2,110 | 1,167 | 307 / 405 |
| Osiris | 279 | 310 | 123 / 307 |

（以上是**去重後**的代表引用數，比原始 evidence 列少。）

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

### SQLite 使用範圍

正式走訪層的 persistence 呼叫集中在 `src/git/persist.ts`；但 golden 的
materializer、runner 與 evaluator 目前會為建料／查詢直接使用 `node:sqlite`。
「所有 SQLite 呼叫都只在一個檔案」**不是目前事實**，別依這個假設重構。

---

## 3. Schema v0.5 重點

表：`repo` / `git_commit` / `git_commit_parent` / `path_lineage` /
`path_lineage_segment` / `file_change` / `file_hunk` / `slot` / `entity` / `entity_link` /
`slot_discontinuity` / `revision` / `revision_match` / `revision_change` /
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

**受控 fixture**：主要指標 2/2 覆蓋、**2 pass / 0 fail**（2026-07-28，切片 3a 之後）。

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
