# 架構文件 v0.1

`CLAUDE.md` 是規則，這份是規則背後的定義與理由。資料模型的唯一真相是 `db/schema.sql`。

---

## 1. 系統概觀

```
git repo
   │
   ├─ [pass 1] structural ──────────── 零 LLM，可離線
   │    走訪 commit → tree-sitter 解析 → 四層雜湊
   │    → 匹配階梯 L1–L5 → slot / entity / revision / revision_change
   │
   ├─ [pass 2] lifecycle ───────────── 零 LLM
   │    構造抽取 → construct_span → excursion (A/C 級)
   │
   ├─ [pass 3] evidence ────────────── 需網路，不需 LLM
   │    commit message / PR / issue → source_doc
   │    → reference_link → excursion 升級為 B 級
   │
   └─ [pass 4] claim ───────────────── 唯一花錢的一層
        抽取式 span 擷取 → 程式斷言 → evidence → claim
```

四個 pass 各有獨立水位線（`pass_state`）。pass 1–2 可以跑完整個 repo 而完全不碰網路、不花一毛錢；這是「先給你看結構，你覺得有用再開 API key」的產品策略的技術基礎，也是冷啟動摩擦最小化的關鍵。

### 套件劃分

```
packages/
  core/       資料模型、SQLite 存取、型別定義
  indexer/    pass 1–2。git 走訪、解析、雜湊、匹配、構造抽取
  enrich/     pass 3–4。GitHub adapter、span 擷取與驗證
  server/     HTTP API
  web/        React 前端
  cli/        why 指令
fixtures/     黃金測試集
```

`indexer` 不得相依 `enrich`。反向相依是允許的。

### Git 走訪與路徑血緣

非合併 commit 由一次反向拓撲序 `git log --name-status` 走訪，預設使用
`-M30% -C40%`；合併 commit 另外只取 combined diff。這避免把被合入分支上
已走訪過的 commit 重算一次，保留的正是衝突解決與 evil merge。combined diff
不支援改名／複製偵測，因此不產生 `R` / `C`：所有父版本都沒有／都有的路徑仍
可記為 `A` / `D`，其他組合記為 `M`。

只存在於部分父版本、又在合併結果消失的路徑不會出現在 combined diff；它相對至少
一個父版本沒有變化。這筆刪除仍存在於分支自己的 commit，查詢不可把「merge-time
deletion」等同於「一定能在 merge commit 找到 D」。

`buildLineages` 是不碰 Git 與資料庫的純函式。它以存活路徑集合為輸入／輸出；
資料庫中 `to_commit_id IS NULL` 的 segment 就是這個集合的唯一持久化表示，不另建
平行狀態表。回傳給下一批的開放 segment 必須標成已持久化，跨批次關閉時才能產生
`UPDATE`，而不是在當批空的 segment 陣列中尋找。

增量寫入必須同時維持以下不變量：

- `path_lineage.id` 從全資料庫最大值之後配置，不可每個 repo 從 1 重來；
- `topo_order` 延續該 repo 前一批最大值，跨批次 parent edge 要回查既有 commit；
- structural 水位線與該批資料在同一個 transaction 提交；
- 水位線不是新終點祖先、或 `indexer_version` 不同時，直接要求重建；
- `file_change` 由 `UNIQUE (commit_id, path)` 保證重跑冪等；
- 開放 segment 用部分索引加速續跑狀態重建。

SQLite driver 使用 Node 內建 `node:sqlite`，所有呼叫集中在單一 persistence 模組。
完整 schema 依賴 FTS5；啟動時必須先做 capability probe，缺少時明確失敗，不能等到
建表中途或查詢時才暴露。

### diff hunk

走訪還取第二趟 `git log --patch --unified=0`，把每個檔案改動的行號範圍存進
`file_hunk`。動機是匹配：內容完全相同的候選之間，雜湊與相似度都已用盡資訊，
而 git 早就算好「改動的是哪幾行」——這是唯一還沒用上、且比 AST 位置穩定的訊號。

必須是第二趟，不能與 `--name-status` 併成一次：實測 `git log --name-status --patch`
中 `--name-status` 恆勝，patch 根本不輸出（兩種順序都試過）。

四個約束：

- **一列一個 hunk，不拆成 old/new 兩列。** `-U0` 之下純新增是 `@@ -10,0 +11,3 @@`、
  修改是 `@@ -10,3 +11,5 @@`，兩者的 new-side 範圍拆開後同形。丟掉配對關係，
  被修改的宣告就會落在「新增範圍」內被誤判成 birth——誤報 birth ＝ 假斷層，
  是最不能犯的錯。`old_count = 0` ⇔ 純新增；`new_count = 0` ⇔ 純刪除。
- **diff 演算法是索引產出的一部分。** Myers / histogram / patience 的 hunk 邊界
  不同，所以明確指定 `--diff-algorithm=histogram` 並寫進 `indexer_version`，
  不吃 git 預設值（使用者的 `diff.algorithm` 設定否則會改變索引結果）。
- **零列不等於「沒有改動」，而是「沒有 hunk 證據」。** 合併（combined diff 沒有
  可靠的單一父 hunk，刻意不收）、二進位檔、純 mode 變更都是零列。消費端必須把
  零列當成「不得套用 hunk 約束」。合併另可由 `git_commit.is_merge` 直接排除。
- **依 sha 清單分批取，用 `--no-walk --stdin`。** 成本幾乎全在單次 git 呼叫的原始
  字串（Osiris 實測約 26 KB/commit，解析後的結構只留 263 KB/99 commit），分批把
  峰值壓成常數。不切成 `A..B` 區間是因為拓撲序的一段切片不等於任何範圍運算式；
  `--no-walk` 的語意正好是「就這幾個 commit，各自對第一父 diff」，且改名偵測
  逐 commit 進行，分批不會改變任何一個 commit 的結果。

---

## 2. 四層雜湊階梯（精確定義）

這是整個系統的地基。定義一旦變更就必須提升 `indexer_version` 並重算。

| 層 | 欄位 | 定義 |
|---|---|---|
| 1 | `hash_raw` | 宣告區間原始位元組的 SHA-256 |
| 2 | `hash_token` | tree-sitter tokenize 後**捨棄空白與註解 token**，對 `(token_type, token_text)` 序列取雜湊 |
| 3 | `hash_alpha` | 同上，但**局部繫結識別子**依首次繫結順序替換為 `$0, $1, …` |
| 4 | `hash_shape` | 保留 AST 節點型別、child field name、巢狀與順序；識別子與字面量只抹除內容 |

### L3b：`hash_alpha_self`

`revision.hash_alpha_self` 在索引時一併計算：先做 `hash_alpha` 的局部繫結正規化，
再把**該宣告自己的名稱**及解析為該宣告的 self-reference 替換為 `$SELF`。它能讓
body 不變的同檔宣告改名不因模組層級宣告名而直接掉到相似度匹配。

`lin-company-intel-wrapper` 暴露了需要這個特徵的方向，但它本身不是 L3b 正例：
該 commit 同時把兩個 JSX 子元件改成 render function、加入 key 並修改 error
handler，`hash_alpha_self` 應該不同，因此仍預期由 L4 接住。這條案例同時防止 L3b
過度認領。真正的正例是可重現受控 repo 裡的
`lin-controlled-pure-self-rename`：只修改宣告自身名稱，真實索引結果為 L3b。

這個欄位**不屬於四層 change-level 向量**；它只在身份匹配階梯中形成 L3b，
介於 `hash_alpha` 精確相等與相似度匹配之間。接受 L3b 必須同時滿足：

1. 前後候選位於同一路徑血緣（同一檔案）；
2. `shape_profile` 與宣告 kind 相同；
3. 兩端 `node_count >= 25`；
4. `hash_alpha_self` 相等；
5. 在該 commit 尚未匹配的同檔候選中，這個 hash bucket 的前後基數皆為 1。

第五項是必要條件，不可只靠 node-count 門檻：大型檔案也可能有兩個 body 相同的
工具函式。bucket 有歧義時不得任選，直接退回 L4。門檻與唯一性規則必須進
`indexer_version`。門檻必須由真正的純改名正例校準，並由
`lin-company-intel-wrapper` 這類「改名加編輯」案例守住誤配邊界。

### 第 3 層：什麼算「局部繫結」

**替換**：參數、局部變數、局部函式名、`catch` 繫結、解構出的局部名、型別參數（`<T>`）。

**保留**：import 進來的名稱、全域名稱、屬性名（`obj.foo` 的 `foo`）、被呼叫的函式名、型別名稱、字串與數字字面量。

理由：`obj.method()` 改成 `obj.other()` 是語意變更，必須被偵測到；`const a` 改名為 `const b` 不是。alpha 層要精確捕捉這條界線。

### 第 4 層：必須用結構化編碼

不可以只把節點型別做前序展開後串接——不同的樹會產生相同的序列。必須用帶括號
的 S-expression 形式保留結構，並保留每個 child 的 tree-sitter field name：

```
(function_declaration
  parameters:(formal_parameters (identifier))
  body:(statement_block
    (if_statement condition:(…) consequence:(…))))
```

**決定：保留 field name。** `node_count >= 25` 只擋掉小實體的高碰撞區，不代表
大型樹可以主動丟棄結構角色。field name 能以很低的計算成本區分 condition、
consequence、body 等語意位置；資料庫只保存固定長度雜湊，所以序列化輸入變長不會
增加每筆 revision 的儲存體積。

`hash_shape` **不承諾跨語言可比較**。tree-sitter 的 node type 本身已經由 grammar
定義，只刪 field name 並不會讓 TypeScript 與 Python 變成共同語彙。雜湊輸入必須
以 `shape_profile = 語言家族 + grammar/version + serializer_version` 做 domain
separation，匹配器只比較相同 profile。若未來真的需要跨語言血緣，另建 canonical
IR 與獨立 hash，不能削弱這個原生 shape hash 來假裝語言中立。

**碰撞閘門**：`hash_shape` 只在 `node_count >= 25` 時可用於匹配。三行的 getter 與其他上千個 getter 的 shape 相同——低於門檻時 shape 只能當人類可讀的分類，不得參與身份判定。

### 副產品：變更分類免費

兩個 revision **第一次相異的層級**即變更性質，`revision_change.change_level` 直接查表得出，不需要規則引擎：

| 首次相異 | 語意 | 是否送 LLM |
|---|---|---|
| raw（token 相同） | 格式／註解 | 否 |
| token（alpha 相同） | 局部變數改名 | 否 |
| alpha（shape 相同） | 字面量／呼叫目標變更，控制流不變 | 視情況 |
| shape | 結構重構 | 是 |

實測預期：一般 repo 中 raw + token 佔六成以上。這條路徑省下的 token 成本是專案能被個人負擔的主因。

---

## 3. 匹配階梯

對每個 commit，取父 commit 與本 commit 中所有被觸及檔案的宣告，做一次貪婪二分匹配，**依 tier 由強到弱套用**，每接受一個匹配就把兩端從候選池移除。

L1 與雜湊層一樣必須做**雙端 bucket 唯一性**：相同
`(lineage_id, qualified_name, disambiguator)` 在前後候選池都恰好出現一次才可
接受。schema 的 UNIQUE 約束只保護已持久化資料，不能證明尚未寫入的批次候選
已唯一。碰撞時記錄 ambiguity 並往 L2–L5 掉，不得用 Map 的最後一筆靜默覆蓋。

目前不填 `disambiguator`。受控案例把資訊邊界拆成兩種：

- `ctrl-position-ambiguous`：三個完全相同的同名 closure 前插第四個，連
  enclosing `useEffect` 的 body 與依賴陣列也完全相同。任何雙射都保持全部
  可見資訊，因此沒有唯一正解；fixture 以 `accept_any_of` 接受四個目的
  occurrence，並要求系統不得宣稱唯一、高信心。
- `ctrl-position-scoped`：內部 closure 相同，但 enclosing scope 的依賴與
  其餘 body 可區分。這才是先匹配 scope、再約束內部宣告的階層式匹配目標。

完整 Osiris 歷史審計得到 51 條「L4、精確 Jaccard=1、且先前落入 n×m 內容
bucket」的配對；它們集中在 25 個 commit 的 `Dashboard.fetchEndpoint`
宣告族群，已不是單次的個位數邊緣案例。由於 Git hunk 能直接指出新增行，
後續先評估以 diff 位置約束候選池；只有 hunk 不足時才支付遞迴 scope matching
的架構成本。兩條路徑都不得用 occurrence 序號偷渡位置身份。

| Tier | 條件 | 意義 |
|---|---|---|
| L1 | 同 slot（同路徑血緣 + 同限定名稱 + 同 disambiguator） | 原地編輯 |
| L2 | `hash_raw` 或 `hash_token` 相等 | 純改名或純搬移 |
| L3 | `hash_alpha` 相等 | 改名 + 局部變數也改了 |
| L3b | 同檔、唯一 1:1 候選且 `hash_alpha_self` 相等（兩端 `node_count >= 25`） | 宣告自身改名 |
| L3c | 同檔、`hash_raw` 相等、宣告完全未被任何 diff hunk 碰到，且行號回推唯一命中 | 內容相同的多個候選之間，由位置決定身份 |
| L4 | 同檔案內，相似度 ≥ 門檻 | 改名 + 編輯 |
| L5 | 跨檔案，相似度 ≥ 較高門檻 | 搬移 + 編輯、函式抽取 |

#### L3c：位置錨定

這一層解的問題與其他層不同。其他層解「找不到配對」，L3c 解「找得到但說不出理由」。

一個檔案裡有三個內容完全相同的宣告時，內容資訊已經用盡——雜湊相等、Jaccard = 1，
任何雙射都同樣說得通。但 git 告訴我們哪幾行沒被碰過，而**沒被碰過的宣告，它在前像
的行號可以由 hunk 位移精確回推**。內容用盡的地方，位置仍然是確定的。

判準全部是硬性且精確的，沒有任何門檻或近似：同血緣、`hash_raw` 相等、宣告區間
完全不與任何 hunk 相交、回推範圍精確命中恰好一個前像候選、雙端唯一。任一項不滿足
就退到 L4。**近似命中不是證據**——一旦允許模糊比對，這一層就從證據退化成另一個猜測。

「完全不相交」不能簡化成「只比對端點」：一個「兩行換兩行」的 hunk 落在宣告正中間時
位移為零，端點回推得到完全正確的舊行號，但宣告內容其實改了，會產生假的位置證明。

沒有 hunk 資料時（合併、二進位、純 mode 變更）完全不套用這一層。**零列代表「沒有
證據」，不是「沒有改動」**，兩者混同就會把保守側弄反。

實測（Osiris 完整歷史，見 `plan-diff-hunk.md` §5）：51 條原本靠相似度接住的
內容歧義配對，50 條轉為 L3c，其中 1 條配對本身被修正——貪婪匹配在一次插入
78 行、新增一個同名宣告的 commit 上接錯了，位置證據把它改回來。

#### 純新增 hunk：本檔新生

候選完全落在 `old_count = 0` 的 hunk 內，代表這幾行在前像根本不存在，因此它不得
再與**同一個檔案**的前像配對。

**界線是同檔案，不是全 repo。** git 說的是「這幾行對這個檔案是新的」，不是
「這段程式碼對這個 repo 是新的」。函式從 A 檔搬到 B 檔時，它在 B 檔必然整段落在
純新增 hunk 內；若排除所有配對，L5 的搬移與抽取偵測會被直接消滅。跨檔案的雜湊
相等（L2/L3）與相似度（L5）仍然成立。

**數量保險**：逐血緣比對「落在純新增 hunk 的候選數」與「next 減 prev 的候選數」，
不相等就整個檔案都不套用，並記一筆 ambiguity。不相等代表 hunk 與宣告邊界對不上
（例如宣告被刪除後在別處重新加入），硬排除會排掉不該排的。誤報 birth ＝ 假斷層，
是最不能犯的錯，所以退回原本行為，但絕不靜默。

實測（Osiris 完整歷史）：修正了一條 L1 誤配。`fetchQuote` 被改名為 `fetchYahoo`
的同時，一個**同名**的新 dispatcher 被加進同一個檔案；同檔同名讓 L1 把兩個不同
的實體接成一個，抹掉了真實的斷層。這正是 slot 與 entity 分歧的案例。

**貪婪而非最佳指派**是刻意的簡化。最佳二分指派（匈牙利演算法）在單一 commit 的候選規模下收益極小，但會讓結果難以解釋——而「為什麼系統認為這兩個是同一個」必須能對使用者說清楚。

### 相似度只由 MinHash 召回，不由它判定

`revision.minhash`（128 permutations，token n-gram）僅用於產生 L4/L5 候選。**接受前必須計算精確 Jaccard 並寫入 `exact_jaccard`、`exact_verified = 1`**，schema 層級以 CHECK 強制。

切分依據是**排序去重後的 token n-gram 集合基數 `ngram_count`**，不是 AST 的
`node_count`。若只能在原始計數中二選一，`token_count` 比 `node_count` 更接近
正確尺度；但產生 MinHash 本來就必須先得到 n-gram 集合，因此沒有理由不用直接的
集合基數。v1 以 `ngram_count <= 200` 為 exact mode，保存完整
`exact_ngram_hashes` 並直接精確比對；超過 200 才存 128-permutation MinHash。
`200` 是版本化的索引器參數並納入 `indexer_version`，暫不寫成 schema CHECK，
讓黃金測試校準門檻時不必做資料庫 migration。

### 函式抽取的偵測

同一 commit 內，某實體 body 大幅縮減，且出現新宣告與被移除的片段高度相似 → 建立 `entity_link(relation = 'extracted_from')`。對等拆分（兩半都保留部分職責）在黃金測試集中標為 `ambiguous`，不強求唯一答案。

### 斷層偵測

兩種獨立證據寫入 `slot_discontinuity`：

1. **路徑重現**：同一路徑先有明確 `D`、之後再 `A`。新檔維持新的
   `path_lineage`，斷層記在新 lineage 的 slot；`prev_entity` 指向舊路徑最後一位
   同名佔用者。segment 因 rename 關閉不算，必須有 `file_change.change_type='D'`。
2. **佔用者置換**：同 lineage、同 slot 的 next 宣告沒有被 matcher 接到前像，且
   slot 先前已有不同 entity。matcher 漏接本身不夠，精確 3-gram Jaccard 必須
   `<= 0.25`；0.25–0.5 的灰區寧可漏報。

路徑重現的 D→A 是 Git 的版控事實，不代表檔案真的從工作目錄消失；被 gitignore
後停止追蹤再重新追蹤也會形成斷層。`similarity` 在可比較時保存精確 Jaccard；
`NULL` 表示舊內容無法比較，數值 `0` 才表示實際比較後完全沒有交集。

門檻與判定規則由 `DISCONTINUITY_VERSION` 進入 declarations pass 的
`indexer_version`，不可讓不同規則的產出混在同一水位線之後。

這是產品最有價值的輸出之一：它告訴使用者「斷層以前的討論與現在的實作無關」，直接省下讀錯歷史的時間。

**誤報成本遠高於漏報**：假斷層會叫使用者忽略真實歷史。門檻應偏保守。

---

## 4. 構造生命週期

追蹤單位從實體下放到實體內部**可跨 revision 穩定對位的語意構造**。

### 為什麼需要這一層

完整回退很少見且容易偵測（`git revert` 就抓到了）。真正常見且有價值的是**部分放棄**——某個做法被拿掉，但周邊改動保留。實體層級的相似度會把這種情況完全抹平，因為實體整體看起來一直在往前走。

構造層級問的不是「這個函式回到舊樣子了嗎」，而是「**這裡曾經存在、現在消失了的東西有哪些**」。

### 抽取器介面

```ts
interface ConstructExtractor {
  readonly version: string;      // 寫入 construct.extractor_version
  readonly language: string;
  extract(entityNode: SyntaxNode, ctx: ExtractContext): ExtractedConstruct[];
}

interface ExtractedConstruct {
  kind: string;          // call_target | type_usage | control_strategy
                         // | resource_strategy | annotation
  semanticKey: string;   // 同一 entity 內可跨 revision 對位的穩定鍵
  properties: Record<string, unknown>;
  nodeCount: number;
  label?: string;        // 給人看的描述
}
```

**白名單不寫進 schema。** 什麼算一個構造由抽取器定義並版本化，因為這件事無法紙上決定——太窄會漏掉真正有趣的迂迴，太寬會滿螢幕雜訊。必須拿真實 repo 調，而版本化讓調整不會弄髒歷史資料。

存在區間以 run-length 編碼存於 `construct_span`（逐 revision 存會讓表大到不能用）。一個構造可以死而復生，故一對多。

---

## 5. 迂迴偵測

| 強度 | 判準 | 需要 |
|---|---|---|
| **A 確證** | `git revert`，或返回 commit 的 diff 與引入 commit 的 diff 呈近似反向匹配 | 純結構，零 LLM |
| **B 高可信** | 生命週期符合 + 有文字證據明確提及 | pass 3 |
| **C 疑似** | 僅結構符合，無任何文字佐證 | — |

C 級在 UI 上必須標示「疑似」，不得作為結論陳述。

`duration_days` 記錄但**不作為門檻**：三週後撤掉是試錯，三年後撤掉是技術演進，兩者都有價值但意義不同，讓使用者自己過濾。

---

## 6. 證據管線

### 兩個 pass、兩份不同的輸出契約

**stated / linked 層是抽取式的。** 給模型 commit message 或 issue 全文，任務不是「解釋為什麼」，而是：

> 找出文本中解釋此變更動機的片段，逐字回傳，並附上字元起訖位置。

回傳後由程式斷言該 span 確實存在於 `source_doc.body`，且 `body_sha256` 未變。對不上即整條丟棄。

**這讓 stated 層的 why 在物理上不可能是幻覺**——它是一段可點擊跳回原文的引用，不是模型的敘述。

**inferred 層才允許自由生成**，且永遠不進 `v_presentable_claim`。

### staging 機制

待驗證的候選只進 `evidence_candidate`，驗證通過才升格為 `evidence`。失敗候選保留 `rejection_reason`，供調整 extractor 與 prompt——這是 prompt 品質唯一的客觀回饋來源。

### span 斷言的實作契約（已實作，零 LLM）

`src/evidence/span.ts` 是純函式，**刻意不知道 LLM 的存在**：候選從規則、模型或
匯入來都走同一道驗證。先把驗證做對再談誰產生候選，順序不可顛倒。

- **位移單位是 UTF-16 碼元**，也就是 JavaScript 字串的原生索引。單位選擇本身沒有
  安全性含意，因為真正的錨點是 `quoted_text`：單位對不上就 slice 不出同樣的文字，
  結果是拒絕而不是寫入錯的東西。明確寫下來是為了讓產生候選的那一端有唯一契約。
- **零寬容**：不修剪、不正規化、不模糊比對。差一個字元、多一個空白都拒絕。
  一旦允許「差不多就好」，證據就從引用變成改寫，而之後沒有任何地方能重新判斷
  哪些證據是真的。
- **`body_sha256` 先於內容比對**。上游文字被編輯過時，內容就算碰巧仍對得上也不
  採信——候選是針對另一份文字算出來的。
- **代理對完整性**必須獨立檢查。切在 emoji 中間 slice 出的半個字元，可能與同樣被
  切壞的引文相等，只靠內容比對抓不到。commit message 帶 emoji 非常常見。
- **拒絕理由是結構化的 enum**，不是人類文字。`offset_mismatch`（引文存在但位置錯）
  與 `text_not_found`（幻覺）必須分開——兩者要修的東西完全不同，混為一談就看不出
  產生端到底哪裡壞掉。

`revalidateEvidence` 只**回報**失效的 evidence，不自動刪除：什麼時候該作廢是
呼叫端的決定，不是驗證器的。

### 規則式抽取器（已實作，零 LLM）

`src/evidence/extract.ts`。它的用途不是取代模型，而是三件事：讓驗證那一半有真實
輸入、定義候選的產出契約（模型日後填同一個形狀、走同一道驗證）、以及當成模型
必須打敗的基準線。沒有基準線，「模型有幫助嗎」無法回答。

**刻意高精確率、低召回率。** 只在出現明確因果標記時才產出候選，且 span 從標記處
開始而不是行首——第一版取整行，結果引文與時間軸上方的 subject 一字不差地重複，
那不是引用理由，是把標題抄一遍。右邊界取到行尾；切在標點會更緊，但逗號在中英文
的用法差異太大。**收緊右邊界正是模型可能勝過規則的地方**，那是日後比較兩者時該
看的具體差異。

「fix」「update」這類動詞刻意不收：它們說的是做了什麼，不是為什麼。為了讓覆蓋率
好看而把兩者混為一談，會讓 stated 層從引用退化成摘要，正好毀掉這一層唯一的價值。

**抽取器不得產出自己的驗證器會拒絕的 span**——這是它的責任，有專門的性質測試，
並在真實語料上也成立（Osiris 0 rejected）。

issue / PR 參照抽成 `reference_link` 而**不是** evidence：它們指向另一份還沒被取回
的文件。把參照當成證據，等於宣稱「他提到了 #72」就是「他解釋了為什麼」。

### linked 文件的網路邊界（切片 1 已實作）

網路只存在於 `src/http/github.ts`。`src/evidence/linked.ts` 只吃 `HttpFetcher`，因此
live GitHub、錄製與離線 replay 對收取邏輯是同一條路徑；store、測試與 golden 都
不直接呼叫網路。錄製檔以 URL 的 SHA-256 命名，request 不保存 headers，response
headers 只保留 `content-type`、`link`、`retry-after`、`x-ratelimit-reset` 安全清單，
不保存 Authorization、cookie、token-like 值或不穩定的 request id／時間戳。

GitHub 的 issue 與 PR 共用編號，`GET /issues/{n}` 回應有 `pull_request` 欄位才判為
PR，並回寫 `reference_link.to_kind`。body、issue comments 與 PR reviews 各自存成
獨立 `source_doc`；同串共用 `provenance_root='pr:N'`，但 `external_id` 帶上 body／
comment id／review id，不能在寫入時合併。

`pass_state.pass_name='linked'` 只在一個 commit 的全部遠端文件成功寫入後才前進。
404 當成不存在並可越過；其他非 200（包含 403/429）停止而不跨過失敗 commit，並把
`retry-after` / `x-ratelimit-reset` 回報給呼叫端。PR/issue body 被編輯時以 upsert
更新 `source_doc.body_sha256`，既有 evidence 的快照不變，之後
`revalidateEvidence` 才能正確標成 stale。

### linked 抽取與呈現（切片 2–3 已實作）

`extractFromLinkedDocuments` 對五種 PR／issue `doc_type` 跑既有因果標記，但使用獨立的
Markdown 模式與 extractor version。它只多做兩個保守排除：fenced code block 與
`>` 引用行；因果標記本身沒有放寬。候選仍逐列進 `evidence_candidate`，並以
`tier='linked'` 走同一個 `submitCandidates`／`verifySpan`，所以 linked 不存在第二套
較寬鬆的證據規則。

同一討論串的 body、comments、reviews 在寫入時全部保留。`timelineOf` 才按
`provenance_root` 收斂：同一 root 在整條 entity 時間軸只選一個代表引用，`why`
遇到同名多 entity 時也共用已顯示 root 集合。若多個 commit 參照同一 root，選
`confidence` 最高的 reference（同分再依拓撲序）並呈現 `method` 與強度；同串另有
多少份文件產生 evidence 也一併回報。查詢額外要求
`evidence.doc_body_sha = source_doc.body_sha256`，上游編輯後的 stale evidence 不會繼續
出現在可信時間軸上。

### 為什麼是這個順序

先找證據、再生成可引用的原子結論；不是先生成故事再補引用。後者不管 prompt 寫得多嚴格，模型都會先有敘事再找支撐，於是「找不到支撐時就編一個」變成預設行為。

一個 claim 只講一件事。禁止產生跨多個結論的散文——那會讓證據無法逐條對應。

---

## 7. 成本模型

| 措施 | 效果 |
|---|---|
| raw / token 層變更不呼叫模型 | 省六成以上 |
| `llm_cache` 內容定址（input_hash + prompt_version + model） | prompt 未變時重跑零成本 |
| pass 4 獨立水位線 | 可只對使用者查詢過的實體按需生成 |
| 抽取式 prompt 輸出短 | 輸出 token 遠低於生成式 |

預設 provider 為 Anthropic API，同時支援 Ollama——**沒有 API key 的人必須也能跑完 pass 1–3**，否則冷啟動摩擦會殺死一半的潛在使用者。

---

## 8. 效能預算

目標值。沒有目標就沒有「變慢了」這件事。

| 操作 | 預算 |
|---|---|
| pass 1–2 索引一萬個 commit（中型 TS repo，筆電） | < 10 分鐘 |
| 增量索引一百個新 commit | < 10 秒 |
| 單一實體的時間軸查詢 | < 100 ms |
| 「已消失的構造」清單查詢 | < 300 ms |

超出預算即為 bug。時間軸查詢依賴 `idx_change_entity(entity_id, commit_id)`；動到那條索引前先確認查詢計畫。

全 repo 結構 pass 取 blob 時，observer 會先收集單一 commit 所需的前後版本，
再用 `git cat-file --batch` 讀入；不把整段歷史一次留在記憶體。協定解析以 Buffer
和 header 宣告的 byte size 為準，missing 只有 header；快取基準上限是 64，
大 commit 則暫時提高到本批唯一項目的兩倍，確保同輪 prefetch 不會自行逐出。
header 的 blob oid 另與本地計算的 `blobShaOf` 對照，兩條獨立路徑不一致時立即失敗。

---

## 9. 非目標

不做程式碼問答、不做程式碼生成、不做 PR 審查、不做多語言全覆蓋、不做即時監看、不做雲端服務。

**判準**：任何讓「抽掉 LLM 之後還剩什麼」這個答案變弱的功能，都不做。
