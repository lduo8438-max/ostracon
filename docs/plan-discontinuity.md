# 下一步：斷層偵測（`slot_discontinuity`）

狀態：已完成（2026-08-01）。Osiris 32 pass / 0 fail / 1 missing；完整歷史最終
產生 7 條斷層（6 路徑重現、1 佔用者置換）。

---

## 1. 為什麼是這個

黃金測試集有兩條 missing：`discontinuity` 與 `excursion`。兩者都落在
`evaluate.ts` 的 `"${c.kind} 查詢尚未接入"`，所以 `actual = null`。
先做斷層，理由有三個：

1. **這個能力已經在真實資料上被看見了。** `why` CLI 現在會印「fetchQuote 在這個
   檔案的歷史上有 2 個不同的實體（slot 延續但內容血緣斷開）」——那句話就是斷層，
   只是沒有被記進 `slot_discontinuity`，也沒有被黃金測試集守住。
2. **它是這個產品最獨特的宣稱之一。** slot 與 entity 分歧的位置就是「這裡的歷史
   斷掉了，不要以為前面那段是同一回事」。沒有別的工具說這句話。
3. 它比 excursion 小：excursion 需要 pass 2 的構造抽取（`construct_span`），
   那還不存在。斷層只需要既有的 slot / entity / revision。

---

## 2. 動手前必須先解決的模型張力

**這是這份計畫最重要的一節。先想清楚再寫程式。**

黃金案例 `dis-scanner-server-recreated` 錨在
`slot: {path: scanner/server.js, symbol: checkRate}`、`at_commit: b287966`。

> 實作時重新裁決：原錨點 `server` 是 `http.createServer(...)` 的回傳值，initializer
> 為 call expression，不在既定的函式／類別 entity 邊界內。若為它放寬抽取器，會把
> 大量普通 const 一起變成 entity；若 evaluator 忽略 symbol，則是假通過。因此改錨在
> 同檔刪除前後皆存在的 `checkRate`。path、commit 與 D→A 的獨立證據均未改變。
實際的 git 歷史（已核對）是：

```
dfa1905  A  scanner/server.js
745663a  D  scanner/server.js     ← 刪除
b287966  A  scanner/server.js     ← 重現，fixture 的 at_commit
86ff5b0  D  scanner/server.js
```

而血緣層的既有規則是**「刪除後同路徑重現是新血緣，不是同一個」**
（`lineage.ts` 有測試守住，不要動它）。`slot` 的唯一鍵是
`(repo_id, lineage_id, qualified_name, disambiguator)`，所以：

- 舊的化身 → slot A（血緣 1、`server`）
- 新的化身 → slot B（血緣 2、`server`）

但 `slot_discontinuity(slot_id, commit_id, prev_entity, next_entity, similarity)`
**只有一個 `slot_id`**，而沒有任何一個 slot 橫跨那個缺口。

### 兩種選擇，選第一種

**(a) 記在新的 slot 上。** `slot_id` = slot B、`commit_id` = b287966、
`prev_entity` = 舊化身最後一個 revision 的 entity、`next_entity` = 新 entity。
語意是「**這個位置現在的佔用者，與先前住在同一條路徑上的那個不連續**」。
既有 schema 完全夠用，不必改。

**(b) 讓 slot 橫跨路徑重現。** 這會推翻血緣層那條刻意的規則與它的測試。
**不要做。**

### 由此得到兩種斷層，evidence 不同

| 類型 | 觸發 | 證據 | 例子 |
|---|---|---|---|
| **路徑重現** | 同路徑先 `D` 後 `A`，血緣因此換號 | **結構事實，不需門檻**——git 說它死過 | `scanner/server.js` |
| **佔用者置換** | 同血緣同名，但 entity 換了 | matcher 沒接起來 + 相似度 | `fetchQuote` → 新 dispatcher |

兩者都寫進 `slot_discontinuity`，都是零 LLM。`similarity` 欄位在第一種是
**資訊性的**（多低代表多有把握），在第二種是**判定依據**。

---

## 3. 不變量 2 是這一步的主約束

> **誤報斷層比漏報嚴重**——假斷層會叫使用者忽略真實歷史，門檻應偏保守。

具體到實作：

- **路徑重現**：git 的 `D` 然後 `A` 是硬事實，但**要小心 `.gitignore` 的情況**。
  這條 fixture 的 commit message 正好是「Remove scanner backend from tracking
  (stays gitignored)」——檔案沒有消失，只是不再被追蹤。從 git 的視角這仍是
  刪除與重現，fixture 也裁決為 present，所以照記。但**要在 rationale 裡寫清楚
  這個限制**：工具看到的是版控事實，不是檔案系統事實。
- **佔用者置換**：不要因為 matcher 沒接起來就記斷層。matcher 接不起來的原因很多
  （候選池不完整、門檻、bug）。**建議先量一次全歷史會產生幾條**，如果數量遠超
  直覺，就是門檻太鬆。這個專案已經有前例：51 條「任意配對」量完才發現不是錯的。

---

## 4. 實作步驟

### 4.1 寫入（`src/index/repo-pass.ts` 與 `lineage-pass.ts`）

兩種偵測都發生在既有的 per-commit 迴圈裡，且都在同一個 transaction 內。

**路徑重現**：處理某個 commit 的某個 `change_type === 'A'` 時，查一下同一個
`repo_id` 下有沒有**更早的、已關閉的**血緣走過同一條路徑。有的話，
對新血緣裡的每一個宣告（如果舊化身有同名的），寫一筆 `slot_discontinuity`。

查詢大致是「`path_lineage_segment` 裡 `path` 相同、`to_commit_id` 非 NULL、
且 `to_commit_id` 的 `topo_order` 小於本次 commit」。**請先讀
`path_lineage_segment` 的實際內容再寫**，不要照這句話直接編 SQL。

**佔用者置換**：`repo-pass.ts` 現有的迴圈裡，next 宣告沒有匹配到前像時會走
`createEntity`（birth）。若**同一個 slot 在此之前已經有別的 entity**，
那就是置換。`ensureSlot` 已經回傳 `slot_id`，查一下該 slot 最後一個 revision 的
`entity_id` 是否不同即可。

`similarity` 用既有的 `exactJaccard(prev.exactNgrams, next.exactNgrams)`；
沒有前像內容可比時（路徑重現且舊檔已無法解析）用 0，並在註解寫明 0 代表
「無法比較」而不是「完全不同」。

### 4.2 評估（`src/golden/evaluate.ts`）

加一個 `evaluateDiscontinuity`，在 `evaluateFixtureCase` 裡分派。

fixture 的錨點是 `slot: {path, symbol}` 與 `at_commit`，判定是
`expect: present` / `absent`。查詢要把 `(path, symbol, at_commit)` 對到
`slot_discontinuity`——注意 `path` 要對到**該 commit 當下**的路徑，
可以參考 `evaluateChangeLevel` 用 `revision.path` 的寫法。

`FixtureCase` 介面目前沒有 `slot` 欄位（只有 `entity`），要補上。
**型別檢查會抓到**，照它給的訊息改。

### 4.3 fixture 驗證器

`validate-fixtures.mjs` 兩份都要看一下 `kind: discontinuity` 的必要欄位有沒有
被驗證（`slot`、`at_commit`）。錨點解析失敗必須是硬錯誤。

---

## 5. 驗證

### 5.1 先量，再定門檻

**動門檻之前先跑一次全歷史，數會產生幾條斷層**，並人工看前十條。
這個專案的既有做法是量測優先——`plan-diff-hunk.md` §5 就是因為先量才發現
整個計畫的前提是錯的。

如果「佔用者置換」在 Osiris 99 個 commit 上產生幾十條，那幾乎確定是誤報，
因為真實的斷層應該是稀有事件。

### 5.2 黃金測試集

```bash
pnpm test
pnpm typecheck
# 兩套 golden，逐案例比對 reports/osiris-slice4.json
```

`dis-scanner-server-recreated` 應該從 **missing 變成 pass**，覆蓋率
31/33 → 32/33。**其他 31 條案例不得有任何變動**——這是純新增能力，
不該影響既有判定。

### 5.3 必須新增的測試

1. **路徑重現**：受控 repo，建檔 → 刪檔 → 同路徑重建，斷言在重建的 commit
   有一筆 `slot_discontinuity`，且 `prev_entity ≠ next_entity`。
2. **不得誤報**：同一個檔案連續修改（沒有刪除），斷言**零**斷層。
   這條比第一條重要——它守的是不變量 2。
3. **佔用者置換**：`why.test.ts` 已經有一個現成的場景
   （`compute` 改名為 `computeCore`、同名新函式補上），斷言那個 commit
   產生一筆斷層。
4. **`similarity` 的語意**：無法比較時是 0，且該情況要能與「真的完全不同」
   區分——如果區分不了，就在 schema 加一個 nullable 欄位或改用 NULL，
   **但那要提升 schema 版本**，先評估值不值得。

---

## 6. 這一步之後

`excursion`（被推翻的做法）是最後一條 missing，也是這個專案的命名由來
（ostracised approaches）。但它需要 pass 2 的構造抽取（`construct_span`），
那是一個獨立的子系統，不要在這一片裡順手做。

---

## 7. 與此無關但同樣重要的平行工作：換 demo 語料

2026-07-31 實測：Osiris 的 linked 層把理由覆蓋率從 4% 提到 7.1%
（stated ∪ linked = 10–11%），但**天花板就在 10%**——99 個 commit 裡只有
10 個提到 issue/PR。

Osiris 繼續當**黃金測試集語料**是合適的（它的價值在結構層的邊界案例：
四個同名 closure、跨檔案抽取、複製偵測）。但它**不該同時當 demo 語料**——
W7 需要一個 PR 文化好的 repo，每個改動都有 PR、PR 有描述、有 review 討論。
那種語料上 linked 層可能是 40–60%，而那才是這個產品真正的樣子。

這件事不需要寫程式，但需要盡早決定：**選語料會影響 W7 的每一個 demo 畫面**。
