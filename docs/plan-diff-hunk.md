# 下一步：diff-hunk 約束

狀態：實作中。分四個切片交付，每片獨立可測。

---

## 1. 為什麼

完整 Osiris 歷史的 51 條「L4、精確 Jaccard = 1、源自 n×m 內容歧義」配對
（見 `status.md` §5），代表匹配器在內容完全相同的候選之間只能任選。
內容資訊已經用盡，必須引入**新的訊號**。

git 已經告訴我們新增的是哪幾行，而這是目前完全沒用上的資訊，且比 AST 位置穩定
得多。真實的三個 `fetchEndpoint` 的 enclosing scope 雖然也可由用途、body 與依賴
陣列區分，但階層式 scope matching 的架構成本高一個量級——**先做 diff-hunk，
不足時再付那個成本**。暫不實作 `disambiguator`。

---

## 2. 必須先講清楚的限制

diff-hunk 解得了 `ctrl-position-scoped` 與真實的 fetchEndpoint，但**解不了
`ctrl-position-ambiguous`**：git 的 diff 演算法面對「四個完全相同的區塊、插入
一個」時遇到同一個歧義，Myers 通常把新增歸到相同區段的**尾端**而非開頭。
所以 hunk 只是把歧義從我們的匹配器轉移到 git 的 diff 演算法。

這可以接受（該案例本來就標 `ambiguous` 不計指標），但**必須寫進 README 已知限制**，
否則之後有人會拿合成案例質疑 hunk 約束「壞掉了」。

---

## 3. 設計

### 3.1 hunk 存新表，不塞 JSON

之後要用行號做區間查詢，JSON 會逼你全表掃描。

**原始提案**是 `file_hunk(file_change_id, side, start_line, line_count)`，
`side` 為 `old` / `new`。**這個形狀有缺陷，已改。**

理由：約束的判準是「候選完全落在**新增** hunk 內 → 判為 birth」。在 `-U0` 之下，
純新增的 hunk 是 `@@ -10,0 +11,3 @@`（old_count = 0），而修改的 hunk 是
`@@ -10,3 +11,5 @@`（old_count > 0）。兩者的 new-side 範圍在 `side` 拆列後
長得一模一樣，配對關係被拆掉就再也分不出來——於是一個被修改的宣告會落在
「新增範圍」內而被誤判成 birth，正好是最不能犯的錯（誤報 birth ＝ 假斷層）。

改為**一列一個 hunk**，保留配對：

```sql
CREATE TABLE file_hunk (
  file_change_id INTEGER NOT NULL REFERENCES file_change(id) ON DELETE CASCADE,
  hunk_index     INTEGER NOT NULL,   -- 該檔案內的順序，穩定可重現
  old_start      INTEGER NOT NULL,
  old_count      INTEGER NOT NULL,
  new_start      INTEGER NOT NULL,
  new_count      INTEGER NOT NULL,
  PRIMARY KEY (file_change_id, hunk_index)
) WITHOUT ROWID;
```

`old_count = 0` ⇔ 純新增；`new_count = 0` ⇔ 純刪除。列數也少一半。

### 3.2 diff 演算法必須進 `indexer_version`

Myers / histogram / patience 產生的 hunk 邊界不同，而 hunk 現在會影響匹配結果。
明確指定 `--diff-algorithm=histogram`，並把它寫進 `INDEXER_VERSION`。

### 3.3 約束強度：硬排除，且只在非合併 commit 上

next 候選完全落在**純新增** hunk 內 → 不得與任何 prev 配對，直接判為 birth。

- 軟優先解決不了問題：Jaccard 全是 1.0 時排序仍然任意。
- 合併的 combined diff 沒有可靠的單一父 hunk，所以合併 commit 不套用。

**必要的保險**：只有當「該檔案內落在純新增 hunk 的候選數」恰好等於「next 比 prev
多出來的候選數」時才套用約束。不相等代表 hunk 與宣告邊界對不上（例如一個 hunk
橫跨兩個宣告），這時硬排除會排掉不該排的，寧可退回原本行為並記一筆 ambiguity。

### 3.4 順帶：`revision_match.ambiguity_size`

目前 `ctrl-position-ambiguous` 報 missing 的理由是「資料庫沒有 confidence」。
若之後想讓 UI 誠實地說「這裡有四個等價候選，我選了一個」，那個數字現在就得記下來
——事後補要重算全部匹配。

---

## 4. 切片

| # | 範圍 | 狀態 |
|---|---|---|
| 1 | `src/git/hunks.ts` 純函式 parser + `walk.ts` 擷取 + 單元測試 | ✅ 完成 |
| 2 | schema 加 `file_hunk` 與 `revision_match.ambiguity_size`；`persist.ts` 寫入 | ✅ 完成 |
| 3a | `ladder.ts` 加 L3c 位置錨定層；`Candidate` 加行號；`ambiguity_size` 寫入 | ✅ 完成 |
| 3b | 「純新增 hunk → 本檔新生」與逐檔案數量保險 | ✅ 完成 |
| 4 | L3c fixture、`ambiguity_size` 評估、README 已知限制 | ✅ 完成 |

`INDEXER_VERSION` 已在切片 2 提升（hunk 一進資料庫，diff 演算法就成為索引產出的
一部分），切片 3 只在改變匹配結果時才需要再提升。

**動匹配器前的基準線**（2026-07-28，`reports/osiris-prehunk.json`）：
Osiris 29 pass / 0 fail / 2 missing，覆蓋 29/31。切片 3 完成後必須逐案例比對這份。

### 切片 2 的實作筆記

- **`insertFileChanges` 必須交出 id。** 它用 `ON CONFLICT DO NOTHING`，衝突時
  `lastInsertRowid` 不可信，所以插入後一律回頭 SELECT（與 `insertCommits` 同樣做法），
  回傳 `${sha}\0${path}` → `file_change.id` 供子表使用。
- **`hunks === undefined` 的保守側就是「不寫入」。** 資料庫分不出「沒去取」與
  「取了但零個 hunk」，兩者都是零列；能維持保守的唯一辦法是 undefined 時一列都不寫。
  實務上 `attachHunks` 也永遠不會產生 `[]`（`parsePatchLog` 的 `flushFile` 會丟掉
  零 hunk 的檔案），所以 `[]` 這個狀態目前不可達——見下方「切片 3 要注意的」。
- **分批取用 `--no-walk --stdin`**，理由與量測見 `architecture.md` §1。
  批次大小 500（約 13 MB／批）。測試以批次大小 1 對真實 repo 驗證分批與
  一次取完的結果逐 commit 相等。

### 切片 2 的實測結果

Osiris 完整歷史（99 commit，2 個合併），端到端 `indexGit` 進真實 schema：

| 指標 | 值 | 與切片 1 的單獨量測比對 |
|---|---|---|
| `filesWithHunks` | 427 | 一致 |
| `file_hunk` 列數 | 1607 | 一致 |
| 純新增 hunk（`old_count = 0`） | 471 | 一致 |
| `hunkOrphans` | 0 | 一致 |
| 合併 commit 的 hunk 列數 | 0 | 符合設計 |
| 非合併但零列的 `file_change` | 16 | 全部是 git 判定為 binary 的檔案 |
| 端到端耗時 | 114 ms | 走訪 43 ms + hunk 47 ms + persist |
| 峰值 RSS | 100 MB | — |

黃金測試集：Osiris **29 pass / 0 fail / 2 missing、逐案例與 `osiris-prehunk.json`
完全一致**（31 案例零差異）；受控 fixture 2/2 覆蓋、1 pass / 1 fail，皆與基準線相同。
切片 2 不動匹配器，本來就該零差異——這次比對是為了確認 `INDEXER_VERSION` 提升與
重建索引沒有意外改變任何東西。報告存為 `reports/osiris-posthunk-slice2.json`。

---

## 5. 切片 3 動手前的測量：計畫的前提是錯的

2026-07-28，在改任何匹配器程式碼之前，對 Osiris 完整歷史重放匹配並統計。
兩個測量都精確重現了那 51 條（`l4ExactOneAfterAmbiguity: 51`），所以統計的是
同一個母體。

### 測量 1：計畫指定的機制（純新增 hunk → birth）

| 指標 | 值 |
|---|---|
| L4 / Jaccard=1 / 源自歧義 bucket | 51 |
| next 候選完全落在純新增 hunk 內 | **1** |
| 數量保險通過後實際會被排除 | **1** |
| 逐檔案數量保險通過率 | 309 / 332 |

**這個機制打不到問題。** 原因很清楚：那 51 條根本不是「新誕生的宣告」。
三個 `fetchEndpoint` 在前後像都存在，歧義是「哪個對到哪個」，不是「哪個是新的」。
它們坐落在未變更或被修改的行上，不在純新增 hunk 裡。

「純新增 → birth」仍然是正確的 birth 偵測機制，但那是另一個問題。

### 測量 2：改用行號回推

改問另一個問題：把沒有被任何 hunk 碰到的候選視為未變更，用 hunk 位移把它的
新側行號**精確回推**成舊側行號，再去對前像候選。

| 指標 | 值 |
|---|---|
| next 候選完全未被 hunk 碰到 | 50 / 51 |
| 回推行號恰好命中一個 prev 候選 | **50 / 50**（0 落空、0 多重命中） |
| 命中結果與 matcher 現在選的**相同** | **50 / 50** |
| 與 matcher 不同（＝會被修正的錯誤） | **0** |

### 結論：那 51 條不是錯的

matcher 目前的貪婪選擇，在全部 50 條可判定的案例上與 hunk 給出的位置真相
**完全一致**。原因是結構性的：`order` 以 `startIndex` 排序，內容相同的候選
因此按檔案順序配對；而當這些宣告都未被變更時，檔案順序恰好就是位置保序的雙射。

所以 `status.md` §5 把它們描述成「任意配對」在**結果上是錯的**——它們是對的。
真正成立的說法是它們**沒有理由**：系統記的是 L4 相似度，說不出「為什麼是這兩個」，
而正確性依賴排序的巧合，任何擾動排序的改動都可能讓 `stable_key` 漂移而不被察覺。

### 這對切片 3 的意涵

hunk 約束的價值不是「修好 51 條錯誤配對」，而是：

1. **把猜測升級成證據。** 「這個候選位於未變更的行，回推後恰好落在那個前像宣告
   的位置」是確定性、可解釋、可寫進 UI 的判定依據，正是產品信譽的來源。
2. **防止漂移。** 目前的正確性靠排序巧合，不靠任何被記錄下來的不變量。

指標上這不會讓黃金測試集的 pass 數變動（那 51 條本來就對），所以切片 4 的
「前後指標對照」要改成對照**配對的判定依據分佈**，而不是 pass/fail。

### 切片 3a 的實測結果

完整 Osiris 歷史，同一份程式碼、同一條歷史，只切換 `--no-hunk-constraint`：

| 指標 | 之前 | 之後 |
|---|---|---|
| 非 L1 配對 | 109 | 109 |
| 歧義 bucket | 132 | 132 |
| L2 | 46 | 46 |
| **L4** | **62** | **11** |
| **L3c** | — | **51** |
| L5 | 1 | 1 |
| L4/Jaccard=1 源自歧義 bucket | **51** | **0** |

配對本身的變化：50 條只是 tier 從 L4 變成 L3c（同一組前後像），**1 條配對被改掉**
——commit `0b15973d` 插入 78 行並新增一個同名宣告（`@@ -263,0 +231,78 @@`），
occurrence 序號整體推移，貪婪匹配因此接錯，位置證據把它改回來。

這條修正是**間接**的：那個 commit 的目標宣告本身落在純新增 hunk 內、沒有位置證據，
但其他候選被 L3c 認領之後，殘餘候選池只剩唯一正解。

黃金測試集：29 pass / 0 fail / 2 missing，**逐案例與 `osiris-prehunk.json` 完全一致**。

**覆蓋缺口已補**（2026-07-28）。原本黃金測試集一條 L3c 都沒產生：lineage 鏈的
兩個錨點多半不是父子 commit，而 hunk 只描述「相對第一父」的差異，materializer
因此不餵 hunk。現已補上父子相鄰的案例，見下方「L3c 的黃金案例」。

報告：`reports/osiris-match-audit-prel3c.json` / `osiris-match-audit-l3c.json`。

### 切片 3b 的實測結果

**設計偏離**：計畫 §3.3 寫「不得與**任何** prev 配對」。實作時改成「不得與**同一個
檔案**的 prev 配對」。理由是硬排除會消滅 L5 的搬移／抽取偵測——函式從 A 檔搬到
B 檔時，它在 B 檔必然整段落在純新增 hunk 內。git 說的是「這幾行對這個檔案是新的」，
不是「這段程式碼對這個 repo 是新的」，證據只能用到它實際涵蓋的範圍。跨檔案的
雜湊相等（L2/L3）與相似度（L5）仍然成立。

數量保險照計畫實作：逐血緣比對「落在純新增 hunk 的候選數」與「next 減 prev 的
候選數」，不相等就整個放棄並記一筆 ambiguity。

完整 Osiris 歷史，相對切片 3a：

| 指標 | 3a | 3b |
|---|---|---|
| 非 L1 配對 | 109 | 110 |
| L2 / L3c / L4 / L5 | 46 / 51 / 11 / 1 | 46 / 51 / 12 / 1 |

**新增的那一條是修正，而且是這個專案的核心案例。** commit `c1a1187` 把
`src/app/api/markets/route.ts` 的 `fetchQuote` 改名為 `fetchYahoo`，同時新增
`fetchYahooV6`、`fetchCoinGecko`，以及一個**同樣叫 `fetchQuote`** 的新 dispatcher
（純新增 hunk `@@ -39,0 +44,56 @@` 涵蓋這三個）。

- 3b 之前：舊 `fetchQuote` 因為同檔同名被 **L1** 接到新的 dispatcher，兩個不同的
  實體被當成同一個，真實的斷層被抹掉。
- 3b 之後：dispatcher 判為本檔新生，舊 `fetchQuote` 正確接到 `fetchYahoo`（L4）。

這正是 slot 與 entity 分歧的教科書案例——slot `fetchQuote` 延續，entity 走到
`fetchYahoo`。修好它同時說明了為什麼「誤報 birth」與「漏報 birth」的代價都很高。

### 受控 fixture：`ctrl-position-scoped` 由 fail 轉 pass

由**切片 3a** 修好，這裡一併記錄（3a 當時只跑了 Osiris，沒有重跑受控 fixture）。

| | 之前 | 之後 |
|---|---|---|
| 主要指標 | 1 pass / 1 fail | **2 pass / 0 fail** |

`ctrl-position-scoped` 要求 `expect_tier_at_most: L4` 且指定 `#0→#1` 的配對。
現在該配對確實存在、且由 **L3c** 接住（比 L4 強）。這條案例先前被記為「如預期
fail，是未來改進的真實目標」，目標達成。

`ctrl-position-ambiguous` 仍是 missing，理由不變（runner 讀不到 confidence）。
`ambiguity_size` 已經寫進 `revision_match`，所以這條案例現在**可以**被評估了，
只差 `evaluate.ts` 去讀它——留給切片 4。

報告：`reports/osiris-match-audit-l3c-birth.json`、`reports/controlled-l3c-birth.json`。

### L3c 的黃金案例（切片 4 的第一項）

commit pair `0b15973d` → `e810f4b8`（父子相鄰）。該步 `src/app/page.tsx` 有四個
`Dashboard.fetchEndpoint` closure，宣告文字逐字相同，所以 `hash_raw` 相等、
精確 Jaccard = 1，L1 與 L2 的 bucket 都是 4×4，兩層都必須因雙端唯一性失敗而往下掉。
位置是唯一剩下的判別資訊。

**裁決依據不是 occurrence 序號，也不是系統輸出**，而是 enclosing scope：四個
closure 各自位於唯一可辨識的區塊，前後版本 banner 完全一致——
#0 `PROGRESSIVE DATA LOADING`、#1 `LAYER-AWARE DATA LOADING`、
#2 `LAYER-AWARE POLLING`、#3 `REACTIVE`。

兩條案例：

- `lin-fetch-endpoint-position-anchored-j91`（正例，adversarial）：#2 → #2，
  要求 `expect_tier_at_most: L3c`。
- `lin-neg-fetch-endpoint-position-crosswire-j91`（負例，adversarial）：同一個
  commit pair，要求 #2 **不得**接到 #1。負例挑相鄰的 #1 而不是隨便一個 occurrence，
  因為唯一性放寬時最可能的失敗形態就是接到相鄰那一個。

**已實測這條 fixture 會咬**：把 materializer 的 hunk 供給暫時關掉後，正例以
`expected ["L3c"], actual ["L4"]` fail。沒有這個驗證，「要求 L3c」只是寫在
YAML 裡的一句話。

順帶：`validate-fixtures.mjs` 的 `TIERS` 原本不含 `L3c`，會直接拒絕這條 fixture，
兩份驗證器（根目錄與 `fixtures/`）都補了。

基準線更新為 **31 pass / 0 fail / 2 missing、覆蓋 31/33**；原本 29/31 的 31 條案例
逐案例仍完全一致。報告：`reports/osiris-l3c-fixture.json`。

### `ctrl-position-ambiguous` 現在真的被判定了

原本無條件回傳 `missing`，理由是「資料模型尚未保存 confidence」。`ambiguity_size`
進資料庫後這個理由不再成立，改成讀它。pass 條件有兩個，缺一不可：

1. 系統選中的配對恰好落在可接受集合內的一種；
2. `ambiguity_size > 1`——沒有把那個任選宣稱成唯一。

第 2 點是這條案例存在的唯一理由。少了它，一個「永遠宣稱唯一」的匹配器只要碰巧
選到可接受的那一個就會過關。

**連帶修正兩處**：

- **L3c 的 `ambiguity_size` 原本填 1，是錯的。** 其他層填 1 因為 bucket 本來就唯一；
  走到 L3c 恰恰是因為內容 bucket **不**唯一，唯一的是位置。改成回報內容等價類的
  大小，也就是「有 n 個內容一樣的候選，位置挑了一個」——那正是 UI 要說的話。
  實測 `ctrl-position-ambiguous` 回報 3，Osiris 的 fetchEndpoint 族群回報 4。
- **迴歸閘門原本也排除 ambiguous 案例**（`findRegressions(primaryCases, …)`）。
  排除在「比率」之外是對的（配對沒有唯一正解，算進通過率只會稀釋分母），但一併
  排除在迴歸之外，等於寫了一條永遠不會擋下任何東西的測試。改成 `findRegressions(cases, …)`。

**已實測會咬**：把 L3c 的 `ambiguity_size` 暫時改回 1，該案例以
`宣稱的等價候選數為 1` fail。單元測試同時覆蓋兩個方向與迴歸閘門。

### README

專案先前沒有 README。新增一份精簡的，重點是「已知限制」四節：diff hunk 只是把
歧義轉移給 git 的 diff 演算法、diff 演算法屬於索引產出、合併沒有 hunk、
跨檔案搬移不受本檔新生判定影響。刻意不放任何還做不到的承諾——`why` CLI
還不存在，README 明說這件事。

### 切片 3 要注意的

- **`Candidate` 沒有行號。** `ladder.ts` 的 `Candidate` 只有 `startIndex`
  （UTF-16 位移），而 hunk 是行號。約束層需要 `startLine` / `endLine`，
  轉換寫法可抄 `materialize.ts` 中 `line_start` / `line_end` 的算法。
- **`ambiguity_size` 欄位已就位但沒人填**，要由切片 3 從 `LadderResult` 的
  bucket 大小寫入。
- **`FileChangeRecord.hunks === []` 目前不可達**（parser 會丟掉零 hunk 的檔案）。
  若之後要讓「取了但沒有 hunk」在資料庫裡可辨識，得先改 `parsePatchLog`
  保留零 hunk 的檔案，並在 `file_change` 上加一個覆蓋旗標——現在不需要，因為
  約束只做排除，零列與零純新增 hunk 的效果相同。

### 切片 1 的實作筆記

- **不能與 `--name-status` 同一趟取得。** 實測 `git log --name-status --patch` 中
  `--name-status` 恆勝，patch 不會輸出（兩個順序都試過）。所以 hunk 需要第二趟
  `git log --patch --unified=0`。
- **合併 commit 不需要**，而 `git log --patch` 預設就不對合併輸出 diff，正好一致。
  注意 map 裡仍會有合併的 sha、值為空陣列——「有沒有取到 hunk」的唯一可靠訊號是
  `FileChangeRecord.hunks` 是否為 `undefined`，不是 map 的 key 是否存在。
- **檔案路徑從 `+++ b/<path>` 取**（刪除檔則取 `--- a/<path>`），並處理 git 的
  C-style 引號。用 `diff --git a/x b/y` 那行反而難解：路徑含空白時無法切分。
- **parser 必須是嚴格狀態機。** `-U0` 的內容行只加一個 `+`/`-` 前綴，所以一行內容
  `++ b/foo` 會輸出成 `+++ b/foo`，與檔案標頭完全同形。讀到 hunk 標頭後照它宣告的
  行數把內容原封不動吃掉（`\ No newline` 不計），中途不做任何語法判斷。
- **`hunks === undefined` 與 `hunks === []` 不可混同**：前者是「沒去取」（合併、
  二進位、mode 變更、純改名），不得套用約束；後者是「取了但內容沒動」。

### 切片 1 的實測結果

完整 Osiris 歷史（99 commit，2 個合併）：

| 指標 | 值 |
|---|---|
| 非合併 file_change | 443 |
| 有 hunk 覆蓋 | 427 |
| 未覆蓋 | 16——**全部是 git 自己判定為 binary 的檔案**（圖片、zip，以及兩個含 NUL 位元組的 `.gitignore`） |
| hunk 總數 | 1607，其中純新增（`oldCount === 0`）471 |
| orphan（patch 有、name-status 沒有的路徑） | **0** |
| 額外成本 | walk 43 ms → 加 hunk pass 48 ms，約多一倍 |

- **體積**：Osiris 的 `-U0` patch 是 2.5 MB（約 26 KB/commit）。外推一萬個 commit
  約 260 MB，`execFileSync` 會整個進記憶體。這在預算邊緣，切片 2 併入索引流程時
  要重新量；必要時分批走訪或用 pathspec 只取可解析的副檔名。
