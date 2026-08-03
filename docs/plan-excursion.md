# 下一步：entity 層級的 A 級迂迴偵測

狀態：**已完成**（2026-08-01）。Osiris 黃金測試集 **33/33（100%）**。

實作與計畫的兩處差異，都是動手後才發現的：

1. **搬移守門的判準寫錯過一次。** 原本查「有 revision 落在死亡之後」，但
   `revision` 只在檔案被觸及時才寫入，搬過去的副本若之後沒再改動就查不到。
   改成「另一個 entity 在我們死亡時仍活著」。修正後 create-t3-app 的排除率
   從錯誤的 13% 變成 **41%（78/189）**——原本的數字是嚴重低估。
2. **`duration_days` 必須用 `authored_at`。** committer 時間會被 rebase 重寫；
   fixture 案例的引入與移除 commit 的 committer 時間完全相同，算出來是 0 天。

**動手前的探測已經做完**（2026-08-01，create-t3-app 1,378 commit），
結論與一個非做不可的守門條件記在第 2 節。

---

## 1. 範圍比原先估計的小

先前假設 excursion 需要 pass 2 的構造抽取（`construct_span`）。**那是錯的。**
schema 的 `excursion` 表是 `entity_id` XOR `construct_id`：

```sql
entity_id     INTEGER REFERENCES entity(id) ON DELETE CASCADE,
construct_id  INTEGER REFERENCES construct(id) ON DELETE CASCADE,
CHECK ((entity_id IS NOT NULL) + (construct_id IS NOT NULL) = 1),
method        TEXT NOT NULL CHECK (method IN
                ('git_revert','inverse_diff','short_lifecycle','trajectory')),
```

**entity 層級用現有的 `entity` / `revision` 就夠**，零新資料來源、零 LLM。
construct 層級留給以後，不要在這一片順手做。

`architecture.md` §5 的強度定義：

| 強度 | 判準 |
|---|---|
| A 確證 | `git revert`，或返回 commit 的 diff 與引入 commit 的 diff 呈近似反向匹配 |
| B 高可信 | 生命週期符合 + 有文字證據明確提及（需 pass 3） |
| C 疑似 | 僅結構符合 → UI 必須標「疑似」，不得作為結論陳述 |

`duration_days` **記錄但不作門檻**——三週後撤掉是試錯，三年後撤掉是技術演進。

---

## 2. 探測結果，以及一個非做不可的守門

在 create-t3-app（1,378 commit、405 entity）上量到：

| 指標 | 值 |
|---|---|
| 誕生與死亡都在觀測範圍內的 entity | 189 |
| **內容從引入到移除逐字未變**（`hash_raw` 首=末） | **117（62%）** |
| 僅局部改名後被移除（`hash_alpha` 首=末） | 2 |
| 結構相同但內容改過 | 11 |
| 結構也不同（活躍演化後才移除） | 59 |
| 死亡於 `git revert` commit | **0** |

「內容逐字未變即被移除」就是 `inverse_diff` 的 entity 層形式：
**移除掉的，正是當初加入的。**

### 守門：內容是否仍存在於別處

**117 個候選裡有 15 個（13%）是 matcher 漏接的搬移，不是迂迴。**

實例：`template-prisma/src/pages/_app.tsx` 的 `MyApp` 被判定「移除」，
但它在終點仍然存在於 `cli/template/extras/src/pages/_app/base.tsx`——
那次是大規模的模板目錄重構，L5 沒接上（同名 `MyApp` 在多個模板變體中重複，
bucket 唯一性失敗）。

**所以宣告迂迴之前必須查：這段內容在死亡當下或之後，是否仍以相同 `hash_raw`
（或 `hash_alpha`）出現在別的 entity 上。** 有的話是搬移，直接排除。

加上這道守門後：**117 → 102 個真正消失的候選（87%）**。

這道查詢是單次索引查找，成本可忽略：

```sql
SELECT 1 FROM revision r JOIN git_commit c ON c.id = r.commit_id
 WHERE r.hash_raw = ? AND r.entity_id <> ? AND c.topo_order >= ?
 LIMIT 1
```

**沒有這道守門，13% 的迂迴會是假的**，而「這個做法被推翻了」講錯的代價，
與誤報斷層同級：它會讓使用者相信一段從未發生的歷史。

---

## 3. 實作步驟

### 3.1 偵測（新檔 `src/index/excursion.ts`，純函式優先）

在全 repo pass 跑完之後，對 `entity` 做一次掃描（不必進 per-commit 迴圈）：

1. 取所有 `birth_commit_id` 與 `death_commit_id` 都非 NULL 的 entity。
2. 取其第一與最後一個 `revision` 的 `hash_raw` / `hash_alpha`。
3. **A 級 `inverse_diff`**：首末 `hash_raw` 相同 **且** 通過第 2 節的守門。
4. **A 級 `git_revert`**：死亡 commit 的 subject 以 `Revert` 開頭。
   （create-t3-app 上是 0 個，但 Osiris 的 fixture 案例正是這種，必須支援。）
5. 其餘符合生命週期但無上述確證的 → **C 級**，`method` 依情況記
   `short_lifecycle` 或 `trajectory`。
6. `duration_days` 由兩個 commit 的 `committed_at` 相減。

**B 級這一片不做**：它需要文字證據與 entity 的關聯，而現有的 evidence 是
掛在 commit 上而不是 entity 上（眼檢已經發現「理由引文 span-correct 但未必
entity-relevant」）。硬接會產生看似有據實則無關的宣稱。

### 3.2 水位線

用 `pass_state` 的 `pass_name = 'excursion'`，與 `declarations` 分開。
版本字串要含守門規則與強度判準——換了判準就必須重算。

### 3.3 評估（`src/golden/evaluate.ts`）

`evaluateFixtureCase` 目前對 `excursion` 落到「查詢尚未接入」。加
`evaluateExcursion`，錨點是 `entity: {path, symbol}` + `introduce_at` +
`remove_at` + `expect_strength_at_least`。

`FixtureCase` 要補 `introduce_at` / `remove_at` / `expect_strength_at_least`
欄位——**型別檢查會抓到**。強度比較要有順序（A > B > C），與 `TIER_ORDER`
同樣的寫法。

### 3.4 先獨立核對既有 fixture

`exc-balloons-get-git-revert` 錨在 Osiris 的
`src/app/api/balloons/route.ts:GET`，要求 A 級。

**動程式碼之前先自己查證** git 事實：`1e17e0f5` 引入、`8d9ca43c` 移除，
確認後者確實是 revert（或 diff 呈反向），且 `GET` 在既有抽取邊界內。
上一次做斷層時就是這樣發現 `server` 根本不是宣告的——**不要假設 fixture 是對的**。
若 fixture 有誤，重新裁決並更新 `rationale`，不要改抽取器去遷就。

---

## 4. 驗證

```bash
pnpm test && pnpm typecheck
# 兩套 golden 逐案例比對 reports/osiris-slice4.json
```

- `exc-balloons-get-git-revert` 應由 **missing 變 pass**，Osiris 覆蓋率
  32/33 → **33/33**。
- **其他 32 條案例不得有任何變動**。

### 必須新增的測試

1. **搬移不得被記成迂迴**——受控 repo：宣告從 A 檔搬到 B 檔且 L5 沒接上時，
   守門必須排除它。**這條最重要**，它守的是第 2 節量到的 13%。
2. 內容逐字未變即被移除 → A 級 `inverse_diff`。
3. 死於 `Revert ...` commit → A 級 `git_revert`。
4. 活躍演化後才移除 → **C 級**，不得標成 A。
5. `duration_days` 不作門檻：造一個存活很久的真迂迴，斷言仍被偵測到。

### 完成後要量的

在 create-t3-app 上跑一次，記進 `docs/status.md`：A/B/C 各幾條、
守門排除了幾條、以及**人工看十條 A 級**確認它們讀起來真的像「試過又推翻」。

---

## 5. 這一步之後

`excursion` 是最後一條 missing 的黃金案例。做完之後 Osiris 應該是 33/33，
W1–W2 的結構與生命週期能力全部到齊，剩下的是意圖層與 UI。

---

## 6. 接線（2026-08-02，已完成）

偵測器完成當時只有 golden materializer 呼叫它，產品路徑零引用——演算法成立但
使用者看不到。接線已完成：`why --full` 在全 repo pass 之後跑偵測，時間軸標頭
呈現裁決；`scope` 必填並進版本字串；翻盤的舊列會被刪除。測試 193 → 202，
Osiris golden 維持 33/33、逐案例零差異。實測與三個設計決定記在 `status.md`。

**但接線後量到一個更關鍵的缺口**：111 條迂迴裡有 **91 條（82%）在釘死的 SHA 上
無法用 `why` 定址**，因為 `lineageIdAt` 解析的是「路徑在該 commit 屬於哪條血緣」，
而迂迴的定義就是檔案已經不在了。使用者必須先知道它什麼時候死的，才問得出它為什麼死。

---

## 7. 已消失的構造（2026-08-02，已完成）

定址與清單一起做——清單吐出 `path:symbol` 座標，`why` 接不住的話清單就是一份
點不進去的名單。`lineagesEverAt()` 讓已刪路徑可定址（**20/111 → 111/111**），
D→A 時全部血緣一併列出；`pnpm ostracised` 提供入口，查詢 2.6 ms。
`lineageIdAt` 的語意未動。實測與設計決定記在 `status.md`。
