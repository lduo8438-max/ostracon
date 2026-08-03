# 固定 demo 語料並在其上量測

狀態：**執行中（2026-08-01）**。語料、結構／stated 基準與十條眼檢已完成；
唯一阻塞是本機沒有有效 `GITHUB_TOKEN`，linked 基準尚未跑。執行結果見
`status.md` 的「Demo 語料基準」。

**這一步幾乎不寫程式，但它會決定 W7 的每一個 demo 畫面，越晚做代價越大。**

---

## 1. 為什麼現在做

Osiris 的實測天花板已經很清楚：

| 指標 | Osiris |
|---|---|
| commit 數 | 99 |
| 有 stated 理由 | 4（4.0%） |
| 有 linked 理由 | 7（7.1%） |
| 兩者聯集 | 10–11（10–11%） |
| **提到 issue/PR 的 commit** | **10（上限就在這）** |
| 斷層 | 7 |

99 個 commit 裡只有 10 個提到 issue/PR，**所以 linked 層在這個語料上永遠不可能超過 10%**。
這不是工具的問題，是單人 vibe-coded 專案的性質。

下一個要做的功能是 `excursion`（被推翻的做法），它是專案的命名由來
（ostracised approaches），也是最後一條 missing 的黃金案例。但它的價值
**高度依賴語料**——如果 repo 裡根本沒有「試過又推翻」的痕跡，做完只會得到
另一個 4%。**先選語料，excursion 才能在能證明它價值的地方開發。**

### Osiris 不退場

Osiris 繼續當**黃金測試集語料**。它的價值在結構層的邊界案例，而且那些都經過
人工裁決：四個同名 closure、跨檔案抽取、複製偵測、路徑重現、L3c 位置錨定。
**不要用新語料取代它**——那些 fixture 是資產。

兩者職責分開：Osiris 守正確性，新語料證明價值。

---

## 2. 步驟一：選定語料

### 硬性條件

1. **TypeScript**（`.ts` / `.tsx` 為主）。目前只支援這個。
2. **公開**。fixture 與量測必須能在別台機器重建。
3. **規模適中：500–3000 commit。** 太小看不出 PR 文化，太大讓你在效能上
   卡住而不是在題目上。
4. **PR 文化好**：多數改動經由 PR、PR 有描述、有 review 討論。
5. **有可見的「試過又推翻」痕跡**：revert commit、feature flag 被移除、
   方案 A 換成方案 B、實驗性目錄被刪掉。

**第 5 項最重要，而且最容易被忽略。** 它正是 excursion 要偵測的東西——
選語料時就該確認它存在，不要等做完偵測器才發現沒東西可偵測。

### 怎麼快速篩掉不合格的候選

對每個候選跑這幾個 git 查詢（clone 之後，全部離線、幾秒鐘）：

```bash
# 規模
git rev-list --count HEAD

# PR 文化：多少 commit 提到 PR/issue 編號
git log --format=%B | grep -cE '#[0-9]+'

# 合併 PR 的比例（GitHub squash/merge 的典型訊息）
git log --format=%s | grep -cE '\(#[0-9]+\)$|^Merge pull request'

# 「試過又推翻」的痕跡
git log --format=%s | grep -ciE '^revert|revert "'
git log --diff-filter=D --name-only --format= | grep -cE '\.tsx?$'

# TypeScript 佔比
git ls-files | grep -cE '\.tsx?$'
git ls-files | wc -l
```

**判準**：PR 編號提及率明顯高於 Osiris 的 10%（目標 50%+）、revert 至少有幾條、
被刪除的 `.ts` 檔至少數十個。任何一項太低就換下一個候選。

### 記錄選擇的理由

選定之後，在 `docs/status.md` 加一節寫清楚：repo URL、釘死的 `index_until` sha、
規模、上面那幾個數字、**以及為什麼選它而不是別的**。六週後你會需要這段。

**釘死一個 sha**，理由與 Osiris 相同：語料會繼續演化，量測必須可重現。

---

## 3. 步驟二：跑完整鏈路並記基準線

```bash
# 1. 結構層（全 repo，跨檔案搬移才看得見）
#    先看規模：這是效能預算的真實檢驗
node --experimental-strip-types -e '...'   # 參考 plan-catfile-batch.md §5.1 的腳本

# 2. stated 證據
pnpm evidence:extract -- --db <db>

# 3. linked 證據（需要 token，見下方警告）
GITHUB_TOKEN=... pnpm evidence:linked -- --db <db> --record-dir fixtures/http

# 4. 時間軸
pnpm why:cli -- '<path>:<symbol>' --repo <repo> --db <db> --full
```

### 要記下來的數字

| 類別 | 指標 |
|---|---|
| 規模 | commit 數、`.ts` 檔數、revision 數 |
| **效能** | **pass 1–2 總耗時、峰值 RSS、外推一萬 commit 的分鐘數** |
| 匹配 | tier 分佈（L1/L2/L3b/L3c/L4/L5）、跨檔案配對數 |
| 證據 | stated 覆蓋率、linked 覆蓋率、聯集、`provenance_root` 去重後的獨立證據數 |
| 斷層 | 總數、路徑重現 vs 佔用者置換的比例 |

### 效能是這一步的隱藏重點

目前「一萬 commit 約 9.15 分鐘」是從 **99 個 commit** 外推的，可信度有限。
一個 1000–3000 commit 的 repo 是第一次真實壓力測試。

**如果外推值大幅惡化，那是新資訊不是退步**——記下來，不要為了讓數字好看而
回頭改門檻。可能的原因：檔案更大、單一 commit 觸及的檔案更多、
`OBSERVER_CACHE_LIMIT`（64）在大 commit 上失效。

### linked 層的速率限制警告

一個 1000+ commit 的 repo 若有數百條 PR 參照，完整收取可能是**數千次 API 請求**。
認證後是 5000 req/hr。

- **先數**：`SELECT COUNT(DISTINCT to_key) FROM reference_link` 乘以 3
  （body + comments + reviews）就是大致的請求數。
- 超過額度就分批跑——`pass_state` 的 `linked` 水位線本來就支援續跑。
- `--record-dir` 會把回應錄成 fixture。**新語料的 fixture 量可能很大**，
  評估一下要不要全錄，或只錄 demo 會用到的那幾條。

---

## 4. 步驟三：用眼睛看十條時間軸

**這一步不能省，而且不能用指標代替。**

挑十個有代表性的實體：改動最多的、被改名過的、跨檔案搬移過的、有斷層的、
有 linked 理由的、以及**兩三個隨機的**（隨機的最重要——精心挑選的樣本會騙人）。

每一條問自己三個問題：

1. **讀起來像不像一段真實的決策史？** 還是只是 git log 換個排版？
2. **`[L4]`、`[L3c，4 個等價候選]` 這些判定依據，對使用者有意義嗎？**
   還是只有實作者看得懂？
3. **理由引文有沒有真的解釋「為什麼」？** 還是只是把標題抄一遍？

把答案寫進 `docs/status.md`。**如果十條裡有八條讀起來乾巴巴，那是題目層級的
訊號，比任何指標都重要**——它可能意味著時間軸的呈現方式要改，或意味著
「決策演化史」需要的資訊比 git 裡有的更多。

現在發現，比做完 UI 才發現便宜十倍。

---

## 5. 完成的定義

- [x] 語料選定，`docs/status.md` 記了 URL、釘死的 sha、篩選數字與選擇理由
- [ ] 完整鏈路跑通，上表的所有數字進 `docs/status.md`（linked 待有效 token）
- [x] 效能外推值更新到 `docs/roadmap.md`（無論變好變壞）
- [x] 十條時間軸的眼檢結論寫進 `docs/status.md`
- [x] Osiris 的黃金測試集**完全不動**（fresh DB 實測仍為 32/33）

最後一項是硬條件：這一步不碰任何產品程式碼，golden 沒有理由變動。
