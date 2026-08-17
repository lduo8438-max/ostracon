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

### 目錄劃分

原先規劃的是 `packages/*` monorepo。實際做出來是單一套件的 `src/*`——沒有出現需要獨立版本或獨立發布的邊界，拆成多套件只會多一層 workspace 設定。**這裡記實際的樣子**：

```
src/git/       pass 1。走訪、路徑血緣、hunk 擷取、SQLite persistence
src/ast/       tree-sitter 解析、四層雜湊、語言剖面
src/match/     匹配階梯 L1–L5、n-gram 簽章
src/index/     結構層寫入、單一血緣／全 repo pass、迂迴偵測
src/evidence/  span 斷言、規則式抽取、stated／linked 收取
src/http/      網路邊界：GitHub adapter、錄放 fixture、重試包裝
src/cli/       ostracon 的子指令與分派
src/golden/    黃金測試集的 materializer、runner、語料取回
db/schema.sql  資料模型的唯一真相
fixtures/      黃金測試集與其 baseline
```

依賴方向仍然單向：`git` / `ast` / `match` 不得相依 `evidence` 或 `http`。

### 淺層 clone 直接拒絕

`git clone --depth N` 的截斷點與真正的初始 commit 在資料上無法區分，於是被當成
「誕生」印出來——而輸出裡沒有任何跡象顯示那是假的。實測 `--depth 5` 的本 repo，
`minhash` 被報成誕生於截斷邊界，實際誕生點在更早的初始 commit。

影響不只誕生：`ostracised` 會把「歷史被截斷」讀成「這段程式碼被移除」，迂迴的
搬移守門也看不到截斷線以外的內容。

**拒絕執行而不是印警告。** 警告會捲過去，而時間軸照樣說謊，使用者分不出哪一條
「誕生」是真的。這與「scope 不符就拒印迂迴清單」是同一個模式：使用者無從分辨
輸出是完整的還是殘缺的時，不輸出比輸出好。檢查放在開啟資料庫之前——與其產生一個
會說謊的索引再叫人重建，不如一開始就不要寫。

partial clone（`--filter=blob:none`）不在此列：commit 歷史完整，只有 blob 延遲
取得，所以歷史正確、只是比較慢。

### 路徑一律去引號

git 預設 `core.quotePath=true`，非 ASCII 檔名在 `--name-status` 會輸出成
`"my \346\252\224\346\241\210.ts"`。走訪層若直接採用那個字串，路徑會帶著引號與
八進位逸出存進 `file_change` 與 `path_lineage_segment`，而 `grammarForPath` 用
`/\.ts$/` 判副檔名——結尾是 `.ts"` 就永遠不匹配，**那些檔案完全不被解析**
（實測 revision 數為 0，不是「查不到」而是根本不存在）。

它還會製造假死亡：函式從 ASCII 檔名搬到非 ASCII 檔名時，搬移端看不見，於是被記成
死亡，再餵給迂迴偵測就變成假的「被推翻」。而且 diff parser 本來就會去引號，
所以兩邊的路徑對不起來，非 ASCII 檔案連 hunk 約束都失效。

八進位逸出是**位元組不是字元**，必須先組回 byte 陣列再用 UTF-8 解碼；逐字元
`String.fromCharCode` 會把非 ASCII 路徑解成亂碼。走訪層與 diff parser 共用同一個
`unquotePath`，不各寫一份。

路徑值改變等於走訪層產出改變，所以 `WALK_ALGORITHM_VERSION` 由 `0.2.0` 提升到
`0.3.0`——ASCII-only 的 repo 產出完全相同，但舊資料庫裡那些路徑是壞的，
續跑會讓兩種形態混在同一個水位線之後。

### 產品與評估工具的界線

`files` 白名單只有 `dist`、`db/schema.sql`、README、LICENSE。**`src/golden/` 不進封裝**：它是評估工具不是產品——只服務這個專案自己的開發流程，而且它 import `yaml`（devDependency）。要跑黃金測試集的人是 clone 整個 repo，不是裝 npm 套件。

這條界線先前不存在，所以「`yaml` 是 devDependency 卻被 `src/` import」看起來像相依宣告錯了。界線畫出來之後那件事就是正確的。

**開發與測試不經過建置**（`node --experimental-strip-types`），`pnpm build` 只在發布時用而且由 `prepublishOnly` 觸發，所以「原始碼與產物不同步」的風險只存在於發布那一刻。建置用 tsc 本身、零新相依，關鍵是 `rewriteRelativeImportExtensions`：匯入寫的是 `./walk.ts`（strip-types 要求副檔名照實寫），emit 時改寫成 `.js`，同一份原始碼兩種執行方式都成立。

CI 會真的打包、在封裝外安裝、實跑一次 `why`。那是唯一驗得到 `db/schema.sql` 與 tree-sitter wasm 在**安裝後的位置**解析得到的方法；在原始碼樹裡跑永遠會過。

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

### 續跑時記憶體對照表必然落空，必須回資料庫查

全 repo pass 用兩張記憶體 Map（`entityAt` / `revisionAt`）把「宣告座標 → entity /
revision」帶到下一個 commit，但那兩張表**每次呼叫都重建**。續跑時 matcher 仍然
接得到前像（它重新從 git 觀察父 commit，不受水位線影響），Map 卻是空的——
於是「匹配到了但這一趟還沒見過它」被誤判成誕生。

實測 create-t3-app 先索引到中繼點再續 100 個 commit：多出 **169 個 entity**
（574 對 405）。`matches` 與 tier 分佈完全正常，所以除了 entity 數以外沒有任何
指標看得出來。使用者看到的是水位線處一次假的「誕生」，外加一句
「這個檔案的歷史上有 2 個不同的實體」——憑空報告一個不存在的斷層。
而 `why` 本身就是增量的，所以這是預設路徑而不是邊緣情境。

三件事缺一不可：

1. **entity 與 revision 必須一起從資料庫解析。** 只補 entity 的話，`revisionAt`
   的落空會走 `ensureRevision(前像)`，在父 commit 新建一筆全量跑從來沒寫過的
   revision（實測多出 169 筆），而且 match 會掛到那筆假的前像上。
2. **查的是「早於當前 commit 的最後一筆」，不是「剛好落在父 commit」。**
   `revision` 只在檔案被觸及時才寫入，所以前像宣告最後一次被記錄的 commit
   通常更早——用 `c.sha = 父 commit` 查的話，169 個一個都減不掉。
3. **死亡分支也要同樣處理。** 它同樣讀那兩張 Map；落空時直接 `createEntity`
   會把死亡記到一個當場生出來的 entity 上，而真正該死的那個仍標為存活
   （實測 18 個，每個只有一筆為了記死亡而憑空補的 revision）。

驗收條件是**逐個 `stable_key` 相同**，不是計數相同：`stable_key` 是對外身份
（不變量 1），計數對而身份錯一樣是壞的。三個語料、五個切點實測完全一致。

### 兩個結構層 pass 的候選池不同，產出不可混在同一個資料庫

`indexLineage` 的候選池是一條路徑血緣，`indexRepoStructure` 的是整個 commit。
**同一個 entity 因此會拿到不同的 `stable_key`**：Osiris 的 `isRateLimited` 在
repo scope 下誕生於 `src/app/api/scanner/route.ts`（6 次改動），在 lineage scope
下誕生於它被抽取進 `src/lib/ssrf-guard.ts` 的那一刻（1 次改動）。兩個答案各自
對它看得到的範圍都是誠實的，但它們不是同一份產出（不變量 7）。

混在同一個資料庫的後果是 `--full` **靜默無效**。`ensureRevision` 對
`(commit_id, slot_id)` 已存在的列直接回傳既有 id，從不檢查 `entity_id` 是否與
本次計算一致；於是全 repo pass 重算了整趟、L5 也確實配對到了跨檔案前像，
**算出來的答案卻被整個丟掉**。`--db` 預設是 `.ostracon/index.db`，所以
「先 `why` 再 `why --full`」這個最自然的序列不需要任何旗標就會踩到，
而使用者看到的是加了旗標卻毫無變化。

方向是不對稱的，兩邊都實測過：

| 順序 | 結果 |
|---|---|
| repo → lineage | 正確。既有列全部命中，快路徑一列都插不進去 |
| lineage → repo | 全 repo 的跨檔案血緣全數丟失 |

`excursion` pass 早就把 scope 編進版本字串了；宣告層沒有。**規則寫在衍生層上，
卻沒套用到它所依賴的那一層**——這是這個 bug 的根因，不是 `ensureRevision`。

修法：`pass_state.indexer_version` 帶上 `+scope:repo|lineage`。

- lineage pass **只在真的插入了 revision 時**才標記 scope。已跑過全 repo pass
  的資料庫上它一列都插不進去，標記維持 `repo`，不會逼出無謂的重建。
- repo pass 看到 lineage 標記就作廢重建（`mode: "rebuilt"`），並由 CLI 說出來。
  使用者打 `--full` 表達的就是這個意圖，而全 repo pass 實測 1,378 commit 只要
  8.88 秒。反方向不作廢。
  提示文字是**共用常數 `REBUILD_NOTICE`**，`why` 與 `ostracised` 都用它：
  兩份平行的文字一定會分岔，而這個專案已經被「抑制與交代抑制分散在兩個地方」
  咬過一次。對 `ostracised` 而言沉默的代價更高——搬移守門在單一血緣下是瞎的，
  沒重建的話名單**本身是錯的**（實測 41% 的候選只是被搬走），不只是比較短。
- 版本字串在 scope 以外還不同，代表演算法變了，照舊拋錯——那種情況系統無權
  替使用者決定要不要丟掉舊索引。
- lineage scope 的 `last_commit_id` 記 `NULL`。它做完的是「這幾條血緣」而不是
  「到某個 commit 為止的全部」，寫一個 topo 進去會是謊話，而下一趟續跑會信它。

作廢走 `ON DELETE CASCADE`，所以**外鍵必須是開的**（不變量 13）。`node:sqlite`
目前預設就開著，這道斷言是深度防禦而非承重牆；留著它是因為驅動改預設的失敗
方式是靜默的半刪除，而半修好的資料庫比兩個極端都糟。證據層刻意不刪——它
衍生自 commit message，與結構層的候選池無關。

`src/golden/materialize.ts` 自己就在跑這個壞掉的順序（discontinuity 案例走
`indexLineage`、excursion 案例走 `indexRepoStructure`，同一個資料庫）。修正後
Osiris 的 golden 實際會觸發一次重建，33/33 不變。

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

### repo 的身分是正規路徑，查詢一律綁 repo

repo 的身分是 `git rev-parse --show-toplevel`，**不是 `--repo` 的原字串，
也不是 `path.resolve`**。要收斂的有三種拼法，而 `path.resolve` 只解得開第一種：
相對路徑、**repo 內的子目錄**（`--repo` 預設是 `process.cwd()`）、以及
**symlink**（macOS 的 `/tmp` 就是）。

沒有正規化時，同一個 repo 的不同拼法會在同一個資料庫裡各建一列。後果不是
重複索引而已：以 sha 或 lineage 為鍵而**不綁 repo** 的查詢會撈到別列的資料，
同一段程式碼於是被算成多個實體，`why` 印出「slot 延續但內容血緣斷開」——
**假斷層**。實測 `ostracon why X` 之後再 `ostracon why X --repo .` 就會發生。

所以防線有兩層，缺一不可：

- **身分正規化**讓重複列不再產生；
- **查詢綁 repo**（`lineageIdAt`、`lineagesEverAt`、`entitiesFor`）讓既有的
  重複列也不能汙染答案。存下來的相對 `root_path` 無從還原成正規路徑
  （不知道當初的 cwd），所以收斂**不保證**清得乾淨。

改用正規路徑當身分時必須**同時**遷移舊列（`consolidateRepoPaths`），否則舊列
找不到就會再插一列——修正親手製造出它要消滅的狀態。目錄已不存在的舊列不動：
無從證明它是同一個 repo，而刪除是不可逆的。

**sha 也不是資料庫層級的身分。** sha 在單一 repo 內唯一，但上游與 fork、
`git clone`、`git worktree` 共用歷史，而 `--db` 預設相對 cwd——在同一個目錄下
對兩個 repo 各跑一次就落進同一個檔案。所以 `commitId`、`hunksFor`、`isParentOf`
一律帶 `repoId`。`commitId` 尤其關鍵：它在**寫入路徑**上，挑錯列會把 revision
掛到別的 repo 的 commit 上。

那類汙染是**潛伏**的——輸出仍然正確，因為查詢鏈繞過 `commit_id`；`stable_key`
也不受影響（雜湊的是 sha 字串而非列）。但它隨每次索引累積，並讓
`DELETE FROM repo` 直接違反外鍵。看不見的東西不能靠眼睛擋，所以結構層寫入之後
以 `assertNoCrossRepoRows` 斷言，與 `assertExcursionScope` 同一個模式。

### 相似度只由 MinHash 召回，不由它判定

`revision.minhash`（128 permutations，token n-gram）僅用於產生 L4/L5 候選。**接受前必須計算精確 Jaccard 並寫入 `exact_jaccard`、`exact_verified = 1`**，schema 層級以 CHECK 強制。

切分依據是**排序去重後的 token n-gram 集合基數 `ngram_count`**，不是 AST 的
`node_count`。若只能在原始計數中二選一，`token_count` 比 `node_count` 更接近
正確尺度；但產生 MinHash 本來就必須先得到 n-gram 集合，因此沒有理由不用直接的
集合基數。v1 以 `ngram_count <= 200` 為 exact mode，保存完整
`exact_ngram_hashes` 並直接精確比對；超過 200 才存 128-permutation MinHash。
`200` 是版本化的索引器參數並納入 `indexer_version`，暫不寫成 schema CHECK，
讓黃金測試校準門檻時不必做資料庫 migration。

#### 模乘不能直接寫成 `(a * x + b) % p`

MinHash 的置換是 `(a·x + b) mod (2^31 − 1)`，而 `a` 與 `x` 都可接近 2^31。直接相乘的乘積達 2^62，遠超過 `Number.MAX_SAFE_INTEGER`（2^53），高位被靜默捨去——**以實際係數實測 96.7% 的呼叫得到錯誤的值**（128 個係數的 `a` 最小值就有 3.0e7，沒有一個小到安全）。

這**不影響配對的正確性**：結果仍是決定性的，而 MinHash 只做召回、L4/L5 接受前一律要精確 Jaccard 驗證。但那族雜湊的碰撞性質是任意的而非理論值，召回階段可能漏掉真正相似的候選，**而漏掉的東西不會有任何錯誤訊息**。

修法是把 `x` 拆成高低 16 位，並用 Mersenne 質數的 `2^31 ≡ 1 (mod p)` 做部分規約：每一步的中間值都遠低於 2^53，最後一次條件減法把結果收進 `[0, p)`。除以 2^31 只是調整指數，在 IEEE-754 下**完全精確、不產生捨入**，所以整段沒有精度風險，也不需要 BigInt。

**修正後比原本錯誤的版本還快**（Osiris 的 pass 由 5,467 ms 降到 3,816 ms，−30.2%）：double 的 `%` 走 fmod，比「除以 2 的冪 + 乘 + 減」慢一個數量級。兩個語料的結構產出逐項相同——若有任何 tier 變動，反而代表精確驗證沒擋住。

`MINHASH_SEED_VERSION` 因此由 `mh-1.0.0` 升為 `mh-2.0.0`：種子沒變，但**種子與算術兩者都決定產出的值**，所以它識別的是整族雜湊。

#### `SIGNATURE_VERSION` 必須進 declarations 水位線

簽章決定 L4/L5 的召回，換了它就可能換掉配對，進而換掉 `stable_key`。先前它只被寫進每一列 `revision` 的 `minhash_version` 欄位，**沒有進水位線**——結果是改了簽章演算法之後續跑不會報錯，資料庫會靜默混進兩族互不可比的簽章。註解裡寫「換了就要重算」而系統不強制，那不是規則，是願望。

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
| **B 高可信** | 生命週期符合 + 有文字證據明確提及 | **刻意不做**，見下 |
| **C 疑似** | 僅結構符合，無任何文字佐證 | — |

C 級在 UI 上必須標示「疑似」，不得作為結論陳述。

**B 級刻意不做。** 它需要把文字證據關聯到 entity，而現有的 evidence 掛在 commit 上而不是 entity 上——commit 級的理由與「這個宣告為什麼被拿掉」不是同一件事（見 §6「理由屬於 commit，時間軸屬於 entity」，實測 41.7% 的引文落在該實體毫無變動的列上）。硬接會產生看似有據、實則無關的宣稱，那比沒有 B 級更糟。

**目前只做 entity 層級，不做 construct 層級。** schema 的 `excursion` 是 `entity_id` XOR `construct_id`，entity 那一半用現有的 `entity` / `revision` 就夠，不需要 `construct_span`。「整個模組或方案被推翻」留給構造層。

`duration_days` 記錄但**不作為門檻**：三週後撤掉是試錯，三年後撤掉是技術演進，兩者都有價值但意義不同，讓使用者自己過濾。它用 `authored_at` 而不是 `committed_at`——committer 時間會被 rebase、cherry-pick 與 amend 重寫，Osiris 的 99 個 commit 只有 88 個相異 committer 時間，而黃金案例的引入與移除 commit 的 committer 時間完全相同，算出來會是 0 天。

### 搬移守門：這一層最重要的判準

**宣告一段程式碼「被推翻」之前，必須先確認它不是被搬走。** 判準是：這段內容在死亡當下或之後，是否仍以相同 `hash_raw`（或 `hash_alpha`）出現在**另一個仍活著的 entity** 上。是的話那是 matcher 漏接的搬移，直接排除，連 C 級都不給——它根本沒有消失。

判準是**有沒有一份相同的內容活得比它久**：有 → 這次死亡是搬移或去重，內容還在，抑制；沒有 → 內容在這一刻離開了 repo，那正是迂迴要報的時機。create-t3-app 實測 189 個候選裡有 19 個（10%）被排除。「這個做法被推翻了」講錯的代價與誤報斷層同級：它讓使用者相信一段從未發生的歷史。

**比對的是 entity 的生死，不是「有沒有 revision 落在死亡之後」。** `revision` 只在檔案被觸及時才寫入，所以搬過去的副本若之後再也沒被改動，用 revision 的時間去查會完全漏掉。

**而且必須是嚴格活得比我久（`>`），不是「死得不比我早」（`>=`）。** 同一個 commit 的 `topo_order` 相等，用 `>=` 的話 N 份相同內容一起被刪時會全部互相抑制——而它們全都消失了。刪掉一整個重複的樣板目錄正是這個模式。實測這個差別佔了原本 77 個排除中的 65 個（84%）：修正後排除降到 19、迂迴由 111 升到 170。

**放寬守門是單調的**：條件變嚴 → 抑制變少 → 迂迴只增不減，所以任何 `expect: present` 的黃金案例都不可能因此退步。

**刻意不加 `node_count` 閘門。** 修正後仍被排除的 19 個裡有 11 個低於 25 個節點，小宣告的 `hash_raw` 相同確實是弱證據；但加閘門會讓守門更少觸發、更多東西被判成迂迴，那是往誤報方向移動，而誤報成本遠高於漏報。這是刻意接受的保守代價。

這道查詢是單次索引查找，成本可忽略。

### 搬移守門的可見範圍必須進版本字串

守門在**只索引了部分血緣**時是瞎的：搬到未索引檔案的內容查不到，於是被誤判成迂迴。所以偵測器要求呼叫端明確宣告 `scope`（`repo` 或 `lineage`），並把它寫進 `pass_state` 的版本字串（`excursion-1.0.0+inverse-raw+move-guard+scope:<scope>`）。

同一個 entity 在兩種 scope 下可以得到相反的答案，因此**那不是同一份產出**，不得混在同一個水位線之後（不變量 7）。scope 由 `lineage` 升級到 `repo` 時版本不符，水位線檢查會自動要求重算。

`scope` 是必填而非有預設值，是為了讓型別檢查逼呼叫端表態；實際加上去時它一次抓到全部 7 個呼叫點。

「被推翻的做法」清單一律跑全 repo pass，**不提供 `--full` 開關**——給開關等於給使用者一個會產生假名單的選項。清單查詢前另有 `assertExcursionScope`，版本或水位線不符即拒絕輸出：使用者無從分辨名單是完整的還是殘缺的，而錯的那一半看起來與對的一模一樣。

### 名稱還在，不代表想法還在

守門比對的是內容雜湊，所以「名稱還在、實作被改寫」它抓不到。create-t3-app 的 71 條 A 級裡有 11 條（15%）限定名稱仍然存在。這不是假的「這段程式碼消失了」，但**使用者會讀成「這個想法被放棄了」**，而那是錯的。

呈現時必須一併列出仍存活的同名 entity。但那是**純名稱比對，不是語意判定**：`createInnerTRPCContext`、`createQueryClient` 命中的確實是同一個概念，`Home`（39 處）、`Session`、`Options` 這類模板泛用名撈到的多半不相干。所以措辭一律用「不必然是這個想法」，而且只列前三個加總數——39 條路徑不是資訊，是雜訊。全 111 條實測觸發率 14%。

### 已消失的東西要定址得到

迂迴的定義就是檔案已經不在了，而 `lineageIdAt` 解析的是「在這個 commit 上，這個路徑屬於哪條血緣」——對已刪除的路徑必然回傳 undefined。以釘死的 SHA 實測，111 條迂迴只有 20 條（18%）在終點可定址。

這是 catch-22：使用者得先知道它什麼時候死的，才問得出它為什麼死。

`lineagesEverAt` 補上這一半：某路徑在該 commit 之前**曾經**屬於的所有血緣，最近的排前面，只在 `lineageIdAt` 失敗時當 fallback。**`lineageIdAt` 的語意不動**——它被結構層與 golden materializer 共用。

路徑被刪除後又重建（D→A，斷層機制已涵蓋）時**回傳全部，不挑一條**。靜默挑「最近的一條」會讓更早那段歷史整個消失，這與 `entitiesFor` 面對同名多 entity 時「不得替使用者挑一個而不說明」是同一條裁決。

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

**標記命中之後還要過詞義檢查。** 這一層不是品質門檻，是修 bug：`indexOf` 分不出
`since`（因為）與 `since`（自從），也分不出表目的的 `so that` 與「所以，那個是」。
配錯詞義產生的引文從來就不是一條寫得太短的理由，它根本不是理由。三道檢查：

- `since` 後面接時間或版本 → 不是因果義；
- 標記後沒有任何字母或數字 → 標記自身就是整句，沒有理由可言。判準是**有沒有
  內容而不是剩幾個字元**：`instead of 4.` 一樣短，那個 `4` 就是內容；
- `so that` 後面接繫詞 → 理由在標記**之前**，左邊界往前拉到句首（以句末標點為
  界，且只在行內找。跨行往前拉會把別人的句子收進來——`provenance_root` 是以
  文件為單位去重的）。

被否決的標記**不連累整行**：`since August. Pinned it to avoid the CI flake` 的
理由在第二個標記上，逐一檢查才抓得到。

**中文的名詞標記一律要求冒號**（`理由：`／`原因：`／半形亦收），與英文的
`reason:`／`why:` 是同一個形狀。中文沒有詞界而標記是用 `indexOf` 配的，裸的
`理由` 會命中 `真理由`、`判斷理由`、`當成理由`。連接詞類（`因為`／`由於`／
`否則`）不受此限——`這是因為…` 接在漢字後面是合法的，實測泛用的「前一字不得是
漢字」規則代價 1 條、收益 0 條，已否決。

> **這是 span 斷言擋不住的一類錯誤。** 原文「版本字串沒有理由改變」會抽出
> 「理由改變。」——逐字為真、`verifySpan` 通過、意思相反，因為否定詞留在 span
> 外面。不變量 8 保證的是「引文出自原文」，**不保證切點沒有把句子的意思切反**。
> 抽取式加驗證是誠信的必要條件，不是充分條件。

門檻不是用直覺訂的。demo 語料 103 條可疑引文全部人工裁決後量出：長度 < 30 這條
規則要殺 55 條真理由才換到 8 條空殼，所以它連同其餘四條候選規則一起被否決。
逐項數字見 `docs/status.md`。

**升 `EXTRACTOR_VERSION` 必須連帶作廢舊產出**（`discardStaleRuleEvidence`）。
`submitCandidates` 是純新增的，光升版本不會讓任何既有資料庫改變——舊演算法留下的
引文原地不動，而使用者看不出來。作廢只碰 `evidence` 與 `evidence_candidate`，
**`source_doc` 不動**：linked 文件是花網路取回來的，重抽取完全離線。

**抽取器不得產出自己的驗證器會拒絕的 span**——這是它的責任，有專門的性質測試，
並在真實語料上也成立（Osiris 0 rejected）。

### 意圖層的第一刀不需要模型

`src/claim/derive.ts`。**零 LLM。**

這一層看起來像模型的地盤，其實不是。`v_presentable_claim` 在 schema 層就規定：
只收 `stated`／`linked`，而且必須有 `verified = 1` 的支持證據（不變量 9）。
模型能加的是 `inferred`，而那一層**依定義永遠不進那個 view**。所以能上畫面的
意圖層完全可以確定式地建出來——**抽掉 LLM 之後，意圖層剩下的不是空的，是全部。**

claim 與 evidence 的差別在**主體**：evidence 掛在文件上（「這個 commit 的訊息裡
有這句話」），claim 掛在改動上（「這次改動的理由是這個」）。型別由抽取器命中的
標記確定式導出：`instead of`／`rather than` → `tradeoff`（被拒絕的替代方案，
這個專案的題目，所以自成一類）；`to avoid`／`否則` → `constraint`（不這樣做會
怎樣）；其餘因果標記 → `why`。**對照表沒收的標記不產出 claim，不預設歸 `why`**
——猜一個型別比沉默糟，使用者看到 `why` 就會當成作者說的理由。

「這句話是不是在講這個 entity」用的是**既有的** `change_level <> 'none'`，
與 `suppressUnrelatedRationale` 同一條規則。各寫一份的話兩者遲早分岔，
而分岔的後果是畫面上出現一條時間軸不承認的理由。

`linked` 的 `confidence` 直接繼承 `reference_link.confidence`（`closes #N` 是
0.9，裸的 `#N` 是 0.4），不另外發明一組數字：claim 的可信度不可能高於
「這個 commit 真的跟那個討論串有關」。

**這一層是全量重算而不是增量。** 它的輸入是整個證據集合，而證據會因為抽取器
升版而整批換掉——在這種輸入上做水位線，只會做出一個「看起來是增量、其實漏掉
一半」的介面。

一個 commit 改動 N 個 entity 時，它的理由會掛在 N 條改動上。那不是重複而是
正確的：那確實是這 N 個 entity 各自改動的理由。呈現端要**依改動分組**，
不是把一個 entity 的所有理由攤平成一張清單。

### `abandoned_reason` 的主體是 excursion

一般 `why`／`constraint`／`tradeoff` 綁 `revision_change_id`；「這個做法為何被
放棄」講的卻是從 introduce 到 remove 的整段迂迴，所以 `abandoned_reason` 必須綁
`excursion_id`。把它也掛在死亡 revision 上，會把「一次改動的理由」與「整個方案的
放棄理由」混成同一個主體，資料庫雖然存得下，語意卻是錯的。

確定式升格只收 excursion 的 **remove commit** 上已驗證的 stated／linked evidence，
而且該 commit 必須有這個 entity 的 `change_level = 'death'`。同一個 commit 有因果
引文還不夠；它必須真的移除該 entity。這仍是 commit 粒度的保守相關性，不因此把
excursion 升成 B 級——B 級要求文字明確提到該做法，現有 span 尚未提供那個語意判定。

畫面把 excursion claim 對回 `remove_commit` 的死亡列；結構欄與整體稀疏度也把它算成
那次改動「有意圖」。`v_presentable_claim` 的門仍然不變：只有 verified 支持證據的
stated／linked 能進正式畫面，inferred 仍永遠不進。

### 三欄畫面：結構 → 演化 → 意圖

`src/ui/`。`node:http` 加手寫 HTML/CSS/JS，**零新相依、零建置流程、不連外**。
「不增加執行期相依」是禁令，而 roadmap 把這一版叫「最醜的 UI」——它的工作是把
端到端跑通，一個框架加一套建置流程換到的東西這裡沒有一項用得上。

頁面寫成 TypeScript 模組（`page.ts` 匯出一個字串）而不是獨立的 `.html`，
是為了讓 `tsc` 直接把它帶進 `dist`：`package.json` 的 `files` 白名單只有 `dist`，
額外的資產檔要另接一套複製步驟，而那就是安裝摩擦的開始。

**只綁 `127.0.0.1`。** 資料庫裡是使用者整個 repo 的歷史，包括私有程式碼的路徑
與 commit 訊息；預設對外開放等於預設外洩。這也是專案唯一一處 `node:http` 的
**伺服端**用法——出站網路仍然只准出現在 `src/http/github.ts`。

三個設計決定，都由實測事實推出來而不是美感偏好：

1. **意圖欄替每一次改動保留一格，沒有證據的就留白。** 理由是稀有的
   （Osiris 4.0% 的 commit 說得出為什麼）。把空格填滿、或把空的摺疊掉，
   都會讓畫面看起來比資料更有把握。標頭直接印「N / M 次改動說得出為什麼」。
2. **整個介面是等寬字，只有逐字引文用比例字體並放大。** 路徑、符號、sha、
   tier 都是機器座標；引文是人說的話。排版的分野就是認識論的分野。
3. **版面上唯一的暖色只給逐字引文。** 看到那個顏色就是看到有人真的寫下了
   那句話。其餘一律冷灰——顏色在這裡是語意，不是分類抽籤。

`change_level` 由左邊界的粗細表達（`raw` 是細線，`shape`／`birth`／`death` 是
粗線）。那是四層雜湊階梯的裁決，不是裝飾。

資料層（`src/ui/data.ts`）**不重寫查詢**：時間軸走 `timelineOf`，相關性抑制
因此自動沿用 `suppressUnrelatedRationale`。另寫一份 SQL 的話，畫面與
`ostracon why` 遲早會對同一個 entity 給出兩種說法。意圖與改動**一次查完**，
因為兩欄必須逐列對齊——對齊錯了就是把 A 改動的理由印在 B 底下。

Chrome 實測抓到兩個只靠 DOM 存在性測試看不到的問題：第一版只同步「演化 → 意圖」
的捲動，從意圖欄滾動會立即拆開；`offsetHeight` 又會把每列的子像素捨入，長時間軸
累積出不到一像素但真實存在的漂移。現在兩欄雙向同步，列高用實際渲染矩形量測。

API 的錯誤一律回 4xx／5xx 而**不是空陣列**：空陣列在這個畫面上的意思是
「查過了，真的沒有」，拿它當失敗值就是讓畫面說謊。

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

### 取回以「目標」為單位，不以 reference row 為單位

同一個 PR 被多個 commit 提到是常態：create-t3-app 有 1,310 條 reference 卻只指向 1,085 個相異目標，逐 row 取回等於 **17% 的請求是重複的**。單趟內以 `to_key` 為鍵快取即可。

鍵**不含 `to_kind`**：GitHub 的 issue 與 PR 共用同一組編號，所以編號本身就唯一標定討論串；而且 `to_kind` 在取回之前一律是 `issue`，放進鍵就永遠命不中。命中時只快取種類、不快取文件內容——該目標的 `source_doc` 早就寫進去了，重寫一次是完全相同的內容。

**命中仍必須修正該列的 `to_kind`。** 省請求不得省掉這一步，否則第二個 commit 的那一列會永遠留著錯的 `issue`，而查詢層靠它分辨 PR。

同理，`reference_link` 的 UNIQUE **不含 `to_kind`**。身分是「哪個 commit、提到哪個編號、用哪種方法」；種類是取回後才知道的衍生事實。把衍生欄位放進身分的後果是 extract 與 linked 交替執行會產生重複列（Osiris 實測 23 列變 28 列），而下一次 linked 要修正那份重複列時會 UNIQUE 衝突並整趟 crash。

### 暫時性失敗要重試，rate limit 不要

demo 語料的 linked 收取跑了 51 分鐘、3,229 個請求，其中出現 **4 次 `fetch failed`**（TLS `ECONNRESET` 之類）。每一次都足以讓整趟拋例外中止。per-commit transaction 與水位線讓它不會損壞資料、可以續跑，但要人守著重跑四次才做得完。

重試是**可組合的包裝**而不是 adapter 的一部分：`createGitHubFetcher` 是純粹的 HTTP adapter，加上重試會讓它同時負責兩件事；包裝自己不碰網路，所以「網路只准出現在一個檔案」不受影響。順序是 `record(retry(live))`——錄下來的必須是成功的回應而不是中途的失敗；replay 不包，離線重播不會有暫時性失敗。

**4xx 一律不重試，429 尤其不能。** rate limit 由呼叫端的 `stopped` 路徑優雅處理：讀 `x-ratelimit-reset`、保住水位線、讓人稍後續跑。在這裡用幾秒的退避去重試，等於把「暫停，稍後再來」變成盲目敲門，而 reset 可能在一小時之後。404 也不重試——那是「這個 issue 不存在」的事實。只有 5xx 與丟出來的網路錯誤會重試。

用完次數時**把原始錯誤照原樣拋出**（包一層會蓋掉 `ECONNRESET` 這種對排查有用的資訊），5xx 則照原樣回傳讓 `stopped` 接手。重試不靜默：每一次都印出來——看不見的降級等於沒有降級。

### 理由屬於 commit，時間軸屬於 entity

一次 commit 的理由是關於整次改動的，但時間軸是逐 entity 呈現的。於是一個提到 6 個 issue 的 commit，會讓 6 條引文全部掛到某個 entity 的一列 `無變更` 底下。引文逐字為真、編號正確、span 驗證通過——**但那個 entity 在該 commit 什麼都沒發生，而使用者沒有任何辦法察覺這條因果是假的**。

demo 語料實測：6,367 次引文顯示裡有 **41.7% 落在 `change_level = 'none'` 的列上**，兩項都乾淨（有實際改動且引文有內容）的只有 44.9%。

判準用 `change_level != 'none'`。**曾經考慮拿 `file_hunk` 的行範圍與 `revision` 的行區間相交，實作出來量過之後放棄**：兩者幾乎等價（`shape`／`alpha`／`death`／`raw`／`token` 100% 有交集、`none` 98.7% 無交集），而在不一致的地方 `change_level` 更精確——那 32 條「`none` 但有交集」是 hunk 觸及了行區間、但改的是上下文行，實體本身逐字未變，hunk 規則會誤收。既然現成的欄位更準，就不要另外蓋一套還要處理合併無 hunk 與邊界語意的比對邏輯。

**保留指標、抑制引文。**「這個 commit 提到 PR #123」是關於 commit 的事實，對導覽有用；被抑制的只是被當成理由讀的那段文字。

**方向偏保守：寧可濾掉，不可留錯。** 誤濾的話使用者少看到一條解釋，但參照還在，他可以自己去讀那個 PR；漏濾的話他會相信一個關於別段程式碼的理由。與「誤報斷層比漏報嚴重」同一個道理。代價實測：44 個 entity（12.5%）完全失去引文。

**抑制與「交代抑制了什麼」必須由同一段程式碼負責。** 第一版把 stated 的抑制寫成 SQL 的 WHERE 條件、而標頭只數 linked 參照，結果「只有 commit message 理由、沒有任何 PR 參照」的列被靜默丟掉（Osiris 17 列、create-t3-app 3 列）。靜默丟掉與靜默誤植同樣不誠實——前者讓使用者以為沒有理由可查，而其實有。兩者分岔的根因就是邏輯被拆在兩個地方。

抑制在**查詢層**而不是寫入層：`evidence` 列是事實（這段文字逐字存在於那份文件），歸屬是判斷。判斷寫進資料庫等於把門檻烤進儲存資料，而且規則一改就要重建索引。

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
