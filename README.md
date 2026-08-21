# Ostracon

從 git history 重建程式碼的**決策演化史**：一段程式碼何時誕生、被哪幾次改動重塑、
每次的理由是什麼、以及哪些做法試過又被推翻。

不是「問答你的 repo」。差別在於：問答工具描述程式碼的**現況**，這個工具描述它的
**演化**。

判準：抽掉 LLM 之後仍剩下 AST 解析、四層雜湊、匹配演算法、圖遍歷、增量索引引擎。
任何讓這個答案變弱的功能都不做。

## 線上 demo

**<https://lduo8438-max.github.io/ostracon-demo/>** —— 不用安裝，三個真實 repo：

| 語料 | 有專屬理由的改動 | 展示什麼 |
|---|---|---|
| [vuejs/core](https://lduo8438-max.github.io/ostracon-demo/vuejs-core/) | 37 / 24,779 | 意圖層。非 squash 歷史，理由指得到單一宣告 |
| [create-t3-app](https://lduo8438-max.github.io/ostracon-demo/create-t3-app/) | 4 / 1,594 | **誠實留白**。squash 銷毀了歸屬，253 個候選不升格 |
| [osiris](https://lduo8438-max.github.io/ostracon-demo/osiris/) | **0** / 796 | 小型專案：一次都沒有替單一宣告寫過理由 |

左欄有兩份名單：**全部宣告**（含已消亡的，逐列標示）與**被推翻的做法**
（A 級確證，vuejs/core 有 537 條）。點任何一條都會在右邊展開它的時間軸與意圖。

**畫面上的每個字都是零 LLM 產生的。** 意圖欄的空白是真實的觀測值——理由是稀有的，
三個語料說得出專屬理由的改動都不到 0.3%。整批共用的理由會標成「整批」並降一階
呈現：**唯一的暖色只留給專屬引文**，否則色彩本身就在誇大。

自己匯出一份：

```bash
ostracon export --db <index.db> --out <dir> --label <語料名稱>
```

---

## 環境需求

**Node 24 以上，而且它的內建 SQLite 必須含 FTS5。** 先跑這一行確認：

```bash
node -e "new (require('node:sqlite').DatabaseSync)(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')" \
  && echo "FTS5 可用" || echo "這個 Node 的 SQLite 沒有 FTS5，請換一個 build"
```

沒有 FTS5 的話，建立 schema 會失敗在 `no such module: fts5`——那個訊息不會告訴你
原因，所以寫在這裡。實測 **v24.14.1 可用、v23.11.0 不可用**（後者 `node:sqlite`
存在，但沒有把 FTS5 編進去）。全文檢索是 schema 的一部分，不是選配。

零執行期相依是刻意的取捨（只有 tree-sitter 兩個套件），代價就是綁在 Node 內建的
SQLite 上。`node:sqlite` 目前仍是實驗性 API，每次執行都會印 `ExperimentalWarning`。

## 安裝

```bash
npx ostracon why 'src/auth.ts:validateToken' --repo /path/to/repo
```

或裝起來：`npm i -g ostracon`。零執行期相依（只有 tree-sitter 兩個套件），
索引存在本機 SQLite，不上傳任何東西。

```
ostracon why <path>:<symbol>     印出一段程式碼的演化史
ostracon ostracised              列出試過又被推翻的做法
ostracon evidence extract        從 commit message 抽取理由並驗證 span
ostracon evidence linked         取回被參照的 GitHub PR / issue 討論串
ostracon ui                      三欄畫面：結構 → 演化 → 意圖（只綁 127.0.0.1）
```

## 自己驗證它的宣稱

這份 README 說黃金測試集是 33/33。**不要相信它，自己跑一次。**

```bash
pnpm install
pnpm corpus:fetch        # 依 fixture 裡釘死的 SHA 取回語料並驗證 HEAD
pnpm golden:index -- --repo corpora/osiris --fixture fixtures/osiris.yaml --db osiris.db
pnpm golden       -- --fixture fixtures/osiris.yaml --db osiris.db \
                     --baseline fixtures/baselines/osiris.json
```

語料的 clone URL 與釘死 commit 都寫在 `fixtures/*.yaml` 裡，**那是唯一真相**——
CI、文件與這支指令全都從它讀，沒有第二份 SHA 可以分岔。取回後會驗證 HEAD 確實
等於 fixture 指定的 commit，不符就硬失敗（抓錯 commit 會讓 golden 以「案例 missing」
的形式壞掉，那和「索引器壞了」在報告上長得一模一樣）。

同一組指令就是 `.github/workflows/ci.yml` 在跑的東西。

## 現在能跑什麼

```bash
pnpm typecheck   # tsc --noEmit，零錯誤是硬門檻
pnpm test        # 先跑 typecheck，再跑單元測試（310 個）

# 印出一段程式碼的演化史
pnpm why:cli -- 'src/app/page.tsx:Dashboard.fetchEndpoint' --repo /path/to/repo

# 加 --full 索引整個 repo，跨檔案的搬移與抽取才看得見（慢很多）
pnpm why:cli -- 'src/lib/ssrf-guard.ts:isRateLimited' --repo /path/to/repo --full

# 列出試過又被推翻的做法（由短命到長命；測試檔的宣告預設排除）
pnpm ostracised -- --repo /path/to/repo [--strength A] [--include-tests]

# 取回已參照的 GitHub PR / issue 文件（無 token 時安全略過）
GITHUB_TOKEN=... pnpm evidence:linked -- --db /path/to/index.db

# 三欄畫面。只讀不建索引，零相依、零建置流程、不連外
pnpm ui -- --db /path/to/index.db
```

輸出長這樣：

```
src/app/page.tsx:Dashboard.fetchFlights
entity 5fbf11f62529　共 46 次改動
現在叫 Dashboard.fetchEndpoint

b83294c055  2026-05-12  誕生
            Osiris v1.0.0 - Open Source Global Intelligence Platform
            src/app/page.tsx:146-158

7099ba0756  2026-05-12  結構重構　[L4]
            v1.1.0 — GPU rendering, CCTV cameras, NASA fires, ...
            改名：Dashboard.fetchFlights → Dashboard.fetchEndpoint
            src/app/page.tsx:98-109
```

方括號裡的 `[L4]` 是**判定依據**——系統為什麼認為這兩個版本是同一段程式碼。
有多個等價候選時會一併寫出來（`[L3c，4 個等價候選]`），不會假裝唯一。

commit message 裡有解釋動機的句子時，會以**逐字引用**印在時間軸上：

```
027798718e  2026-05-21  格式／註解　[L1]
            fix: disable Next.js ISR to prevent Vercel Data Cache quota burn, ...
            理由「to prevent Vercel Data Cache quota burn, rely exclusively on ...」
```

每一段引文都通過了 span 斷言——程式確認過那段文字**逐字存在於原文**，
不是摘要也不是改寫。沒有解釋動機的 commit 就不會有這一行，系統不會替它編一個。

先執行 `evidence:linked` 收取過 PR／issue 時，時間軸會把 linked 證據分開顯示：

```
            關聯「because each isolate believes its own cache is warm.」（issue #110；message_ref 0.9；另有 1 則同串留言）
```

同一討論串的原始 evidence 全部保留，但整條時間軸只把它算成一份獨立證據。

實測 Osiris 的 99 則 commit message，只有 **4 則（4%）**寫了為什麼。
這是語料的性質，不是工具的問題：原文裡沒有的理由，換成任何模型都變不出來。

`--full` 之下跨檔案搬移會出現在時間軸上：

```
b3f2597b62  2026-05-21  結構重構　[L5]
            fix(security): implement SSRF guards, rate limiting, ...
            src/lib/ssrf-guard.ts:221-233
```

上面幾筆都在 `src/app/api/scanner/route.ts`——這個函式被抽到共用模組，
而 entity 跟著程式碼走，不是在舊檔案死掉、在新檔案重生。

### 被推翻的做法

專案的名字就是從這裡來的：ostraca 是被丟棄的陶片碎片，而 `ostracised` 列出
repo 裡**試過又被拿掉**的東西。

```
170 個曾經存在、後來被整段移除的宣告（A 確證 102｜C 疑似 68）

── A 確證（102）：結構上可獨立驗證
    666 天  upgrade/src/app/api/og/route.tsx:GET
          2023-05-25 → 2025-03-21　519fac5a32　移除的與加入的逐字相同
          chore: nuke upgrade, use next/font (#2074)
```

`why` 對這些已經消失的路徑一樣查得到，並直接說出裁決：

```
注意：upgrade/src/app/api/og/route.tsx 在 4709861f… 已經不存在，以下是它消失前的歷史。

upgrade/src/app/api/og/route.tsx:GET
entity 66dc39b028df　共 5 次改動
這個做法被推翻了：存活 666.0 天後整段移除
　　依據：移除掉的內容與當初加入的逐字相同（A 級）
```

**A 與 C 分開呈現，而且分得很硬。** A 是結構上可獨立驗證的（死亡 commit 本身是
revert，或移除掉的內容與當初加入的逐字相同）；C 只有生命週期符合、沒有反向證據，
一律標「疑似」，不會寫成結論。

宣告迂迴之前會先查**這段內容是不是還存在於別的地方**——是的話那是搬移不是迂迴，
直接排除。判準是**有沒有一份相同的內容活得比它久**——有的話它只是搬走或去重，
不是被放棄。`create-t3-app` 實測 189 個候選裡有 19 個（10%）被這道守門排除。

這個判準也讓「搬移後再刪除」只報一次：內容從 A 搬到 B、之後 B 才被刪，
迂迴報在 B 消失的那一刻，也就是內容真正離開 repo 的時候。

預設的快路徑只索引目標檔案的血緣，看不到跨檔案搬移；`--full` 看得到，代價是慢。
全 repo 索引的效能已達標：`create-t3-app` 1,378 commits 實測 8.3 秒、峰值 RSS
446 MiB，線性外推一萬 commit 約 1 分鐘（預算 10 分鐘）。

### 三欄畫面

`ostracon ui` 開一個本機頁面：**結構 → 演化 → 意圖**。`node:http` 加手寫
HTML/CSS/JS，零新相依、零建置流程、不連任何外部資源。只綁 `127.0.0.1`——
資料庫裡是整個 repo 的歷史。

意圖欄替**每一次改動保留一格，沒有證據的就留白**。這是刻意的：實測 Osiris
只有 4.0% 的 commit 說得出為什麼，把空格填滿或摺疊掉都是對資料說謊。標頭直接
印出「N / M 次改動說得出為什麼」。

被偵測為迂迴的宣告若在移除 commit 有已驗證的因果引文，死亡那列會另外標成
**「放棄理由」**。這條 claim 的主體是整段 `excursion`，不是單次 revision；
沒有 verified 支持證據就不顯示，仍然零 LLM。

版面上唯一的暖色只給逐字引文——看到那個顏色就是看到有人真的寫下了那句話。
介面其餘部分一律等寬字（路徑、符號、sha 都是機器座標），只有引文用比例字體
並放大：排版的分野就是認識論的分野。

`stated` commit-message 證據完全離線。`linked` 文件收取需要網路與 GitHub token；
沒有 token 時其餘索引仍正常完成，只是 linked 層為空。測試與 golden 只讀
`fixtures/http/` replay，永遠不需要網路或 token。目前只支援 github.com；GitLab
與自架 Git 服務尚未實作。linked 的收取、逐字抽取與時間軸呈現已完成；`why` 不會
自行發網路請求，需先用 `evidence:linked` 更新遠端文件。

索引器涵蓋 git 走訪、路徑血緣、tree-sitter 解析、四層雜湊與 L1–L5 匹配階梯，
全部零 LLM 呼叫。詳細現況見 [`docs/status.md`](docs/status.md)，
設計與理由見 [`docs/architecture.md`](docs/architecture.md)。

只支援 TypeScript。

---

## 已知限制

### 淺層 clone 會被直接拒絕

`git clone --depth N` 之後歷史在截斷點被切斷，而**截斷點看起來與真正的初始 commit
一模一樣**。工具會把它當成「誕生」印出來，輸出裡沒有任何跡象顯示那是假的——
而「這段程式碼何時誕生」正是這個工具的第一個賣點。

所以偵測到淺層 clone 時直接拒絕執行，不是印警告：警告會捲過去，時間軸照樣說謊。

```
… 是淺層 clone（shallow），歷史在截斷點被切斷。
請先取回完整歷史：git fetch --unshallow
```

**`actions/checkout` 預設 `fetch-depth: 1`**，所以在 CI 裡跑之前記得設
`fetch-depth: 0`。partial clone（`--filter=blob:none`）不受影響——它的 commit
歷史是完整的，只有 blob 延遲取得。

### 平行分支上的血緣歸屬可能出錯

走訪層維護的是一張**全域的 path → lineage 對照表**，而不是逐 commit 的完整樹狀態。
同一個路徑在兩條平行分支上各自演化、之後才合併時，血緣歸屬可能接錯。

完全正確需要對每個 commit 保存樹快照，成本高一到兩個數量級。實務上這種情況集中在
長命分支上，多數 repo 罕見。

**目前沒有繞過它的辦法。** `--first-parent` 走訪在原理上可以完全避開（代價是看不到
分支上的個別 commit），但**那個選項還沒有實作**——先前這份文件寫得像是已經可用，
那是錯的。真的遇到這個問題的話請開 issue，那會是實作它的理由。

**這是刻意的取捨，不是待修的 bug。**

### 合併 commit 不做改名偵測

合併只取 combined diff（與**所有**父版本都不同的部分，也就是衝突解決與 evil merge），
而 git 的 combined diff **不支援 `-M` / `-C`**。所以合併永遠不會產生 `R`（改名）或
`C`（複製）——在合併裡完成的改名會被看成一次刪除加一次新增。

只存在於單一父版本、並在合併中被刪除的檔案，則完全不會出現在 combined diff 裡
（相對另一個父版本，它前後都不存在）。

### alpha 層是名稱比對，不是作用域解析

四層雜湊的 alpha 層把區域繫結的名稱正規化成 `$0`、`$1`…，用的是一張**扁平的
名稱對照表**，沒有做真正的作用域解析。內層作用域遮蔽（shadowing）外層同名變數時，
兩者會被正規化成同一個槽位。

**方向是保守的**：這會**過度**正規化，也就是把「其實有差異」判成「只是改名」，
結果是 `change_level` 偏小——**會少送 LLM，不會多送**。反過來的錯誤（把相同判成
不同）才會造成白燒 token，而這個實作不會產生那一種。

屬性名與 shorthand 屬性名永不正規化：`obj.foo` 的 `foo` 改掉就是改語意，
`{ userId }` 的 `userId` 同時是物件的鍵。

### diff hunk 只是把歧義轉移，不是消滅它

匹配階梯的 L3c 用 git 的 diff hunk 回推行號，解決「一個檔案裡有多個內容完全相同
的宣告時，哪個對應哪個」。它在真實語料上有效：Osiris 完整歷史中 51 條原本只能靠
相似度任選的配對，全部轉為有位置證據的判定。

**但面對「N 個完全相同的區塊、插入一個」這種合成案例，它解不了。** git 的 diff
演算法遇到的是同一個歧義：插入的到底算哪一個？histogram 與 Myers 通常把新增歸到
相同區段的**尾端**而非開頭。所以 hunk 沒有消滅歧義，只是把它從我們的匹配器轉移到
git 的 diff 演算法。

我們的處理方式是**誠實回報而不是假裝解決**：這種情況下 `revision_match.ambiguity_size`
會記下「有幾個等價候選」，而不是宣稱唯一。黃金測試集的 `ctrl-position-ambiguous`
就是專門守住這件事的案例——它接受四種結果中的任何一種，但要求系統不得把任選的
那一個宣稱成唯一。

實務上這不常見（真實程式碼的同名宣告多半位於可區分的 enclosing scope），
但它是真實的限制，寫在這裡是為了避免有人拿合成案例質疑「hunk 約束壞掉了」。

### diff 演算法是索引產出的一部分

hunk 邊界隨 diff 演算法而不同，而 hunk 會影響匹配結果。所以索引器明確指定
`--diff-algorithm=histogram`，不吃 git 的預設值——否則使用者的 `diff.algorithm`
設定會改變索引結果。這個值寫進 `indexer_version`，換演算法就必須重建索引。

### 合併 commit 沒有 hunk

合併的 combined diff 沒有可靠的單一父 hunk，所以 `file_hunk` 刻意不收合併。
消費端必須把「零列」當成「沒有 hunk 證據」，不是「沒有改動」——二進位檔與純
mode 變更同樣是零列。把兩者混同會讓保守側反過來，而誤報斷層比漏報嚴重。

### 跨檔案搬移不受「本檔新生」判定影響

候選完全落在純新增 hunk 內時，判定為「在這個檔案裡是新生的」，不再與同檔前像配對。
但這**不**排除跨檔案配對：函式從 A 檔搬到 B 檔時，它在 B 檔必然整段落在純新增
hunk 內。git 說的是「這幾行對這個檔案是新的」，不是「這段程式碼對這個 repo 是
新的」，證據只能用到它實際涵蓋的範圍。

### 迂迴偵測只到 entity 層級，而且沒有 B 級

`ostracised` 目前判的是**單一宣告**的迂迴，不是「整個模組或方案被推翻」——後者
（construct 層級）尚未實作。

強度只有 A（結構上可獨立驗證）與 C（僅生命週期符合）。**B 級刻意不做**：它需要
文字**明確提到**該 entity／做法。現在 `abandoned_reason` 只把 remove commit 上、
同一 entity 確實發生 death change 的 verified evidence 掛到 excursion；這足以誠實
呈現原文，還不足以把結構上的 C 級疑似升成文字確證的 B 級。

「同名者仍存在於他處」的提示是**純名稱比對**，不是語意判定。`createInnerTRPCContext`
這種名字命中的確實是同一個概念，`Home`、`Options` 這類模板泛用名則多半不相干
（create-t3-app 實測 `Home` 有 39 個同名存活者）。所以措辭一律是「不必然」，
且最多只列三個。

### `node:sqlite` 仍是實驗性 API

資料存取用 Node 內建的 `node:sqlite`，**零執行期相依**是刻意的取捨——安裝摩擦是
開源專案的頭號死因。但這個取捨有代價，而且代價比預期大：

- 這個 API 仍是實驗性的，未來的 Node 版本可能變動，每次執行都會印
  `ExperimentalWarning`（v24.14.1 實測仍會出現）。
- **它把可用性綁在 Node 的 build 設定上**。FTS5 有沒有被編進去不是我們能控制的，
  而沒有它整個 schema 就建不起來（見「環境需求」）。那是 runtime 差異不是 bug，
  但對使用者來說沒有差別——一樣是跑不起來。

換句話說，「零相依」把安裝摩擦從 `npm install` 移到了「你的 Node 是哪個 build」。
目前的判斷仍是這樣比較好，但這不是免費的。

---

## 文件

| 我要找 | 去哪 |
|---|---|
| 規則背後的定義與理由 | [`docs/architecture.md`](docs/architecture.md) |
| 資料模型的唯一真相 | [`db/schema.sql`](db/schema.sql) |
| 現在的模組地圖與基準線 | [`docs/status.md`](docs/status.md) |
| 排程、效能預算 | [`docs/roadmap.md`](docs/roadmap.md) |
| 黃金測試集規格 | [`docs/golden-fixtures-spec.md`](docs/golden-fixtures-spec.md) |
| 進行中工作的細部設計 | [`docs/plan-diff-hunk.md`](docs/plan-diff-hunk.md)、[`docs/plan-excursion.md`](docs/plan-excursion.md) |
