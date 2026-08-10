# 黃金測試集規格 v0.1

這份東西的唯一目的：**在第三到第六週，客觀回答「我剛才的改動讓系統變好還是變壞」。**

沒有它，匹配階梯的門檻、construct extractor 的粒度、迂迴偵測的強度分級，全部只能憑感覺調。憑感覺調參的結果是：第五週你會發現準確率下降，但不知道是哪一次改動造成的。

---

## 一、一條不可違反的規則：錨點必須是 git 原生座標

Fixture **絕對不可以引用索引器產生的任何 ID**（`entity.id`、`revision.id`、甚至 `entity.stable_key`）。那是循環論證——你用系統的輸出來驗證系統的輸出。

錨點只能用 git 本身就存在、且與你的實作無關的座標：

```yaml
anchor:
  commit: 4f2c8a1e9b3d5f7a2c4e6b8d0f1a3c5e7b9d1f3a   # 完整 SHA，不用短碼
  path: src/worker/dispatch.ts                        # 該 commit 當下的路徑
  symbol: RequestDispatcher.handle                    # 限定名稱
  occurrence: 0                                       # 同名多個時的序號，從 0 起
  # 以下兩欄不參與比對，只為了讓人審 fixture 時不必 checkout：
  line_hint: 142
  snippet_head: "  async handle(req: Request): Promise<Response> {"
```

`snippet_head` 同時是漂移偵測器：如果哪天它對不上實際檔案內容，代表 fixture 或 repo 有問題，測試應該報錯而不是靜默通過。

---

## 二、Repo 必須釘死

```yaml
fixture_version: 1
repo:
  name: some-project
  clone_url: https://github.com/org/some-project.git
  # 索引邊界。超過這個 commit 的歷史一律不納入，否則上游一更新，
  # 你的召回率就會無緣無故變動。
  index_until: 9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b
  language: typescript
labeled_by: <你的名字或 handle>
labeled_at: 2026-07-26
```

---

## 三、五種標註類型

### A. lineage — 血緣鏈（核心）

一條血緣是一串 anchor，加上每一段轉換的類型與預期最低匹配層級。

```yaml
- id: lin-001
  kind: lineage
  difficulty: hard          # easy | hard | adversarial
  label_confidence: certain # certain | probable | ambiguous
  rationale: >
    2024-03 從 utils.ts 搬到 worker/dispatch.ts 並改名，
    同一個 commit 內 body 也大改（約六成 token 不同），
    L2/L3 都會失效，只剩相似度匹配。這是最容易斷掉的一段。
  chain:
    - anchor: {commit: aaa..., path: src/utils.ts, symbol: dispatchRequest, occurrence: 0}
    - anchor: {commit: bbb..., path: src/utils.ts, symbol: dispatchRequest, occurrence: 0}
      transition: {type: edit, expect_tier_at_most: L1}
    - anchor: {commit: ccc..., path: src/worker/dispatch.ts, symbol: RequestDispatcher.handle, occurrence: 0}
      transition: {type: move_rename_rewrite, expect_tier_at_most: L5}
```

`expect_tier_at_most` 是「不得比這個更弱」，順序為
`L1 < L2 < L3 < L3b < L4 < L5`。L3b 是同檔案、唯一 1:1 候選的
`hash_alpha_self` 精確匹配。寫 `L1` 表示這段必須被最強的規則接住；寫 `L5`
表示允許退到跨檔案相似度。這讓你能偵測到「雖然接對了，但用了比預期更脆弱的
路徑」——那是未來會斷的地方。

### B. discontinuity — 斷層（正例與**負例**）

路徑重現案例裁決的是 Git 的 `D`→`A` 版控事實，不宣稱檔案曾從工作目錄消失；
停止追蹤但保留在 gitignore 中也屬於 present。slot 的 symbol 必須落在既定 entity
抽取邊界內，不能用 evaluator 忽略 symbol 來讓檔案級事件假裝對到不存在的 slot。

```yaml
- id: dis-001
  kind: discontinuity
  difficulty: easy
  expect: present            # present | absent
  slot: {path: src/auth.ts, symbol: validateToken}
  at_commit: ddd...
  rationale: 整個函式被刪除重寫，新舊實作沒有任何共同結構。

- id: dis-002
  kind: discontinuity
  difficulty: adversarial
  expect: absent             # ← 負例：改動很大但不是斷層
  slot: {path: src/cache.ts, symbol: LruCache.get}
  at_commit: eee...
  rationale: >
    body 幾乎全改（換了資料結構），但簽名、職責、呼叫者都沒變，
    是同一個東西的演化。如果系統在這裡報斷層，等於叫使用者忽略
    真實的歷史——這比漏報嚴重得多。
```

**負例的數量至少要跟正例一樣多。** 只標正例的黃金測試集，會養出一個召回率 100%、精確率糟糕的系統，而且你在指標上看不出來。

### C. change_level — 雜湊階梯分類

最便宜、應該最多的一類。直接測第三節的四層階梯。

```yaml
- id: chg-001
  kind: change_level
  difficulty: easy
  entity: {path: src/log.ts, symbol: formatLine}
  at_commit: fff...
  expect: raw                # none|raw|token|alpha|shape|birth|death
  rationale: prettier 全庫格式化，token 序列完全相同。

- id: chg-002
  kind: change_level
  difficulty: hard
  entity: {path: src/http.ts, symbol: retry}
  at_commit: 111...
  expect: alpha
  rationale: >
    只把 setTimeout 換成 sleep()、重試次數字面量 3 改成 5，
    控制流結構完全沒動。誤判成 shape 會白花 LLM 的錢。
```

### D. construct — 構造生命週期

```yaml
- id: con-001
  kind: construct
  difficulty: hard
  entity: {path: src/worker/dispatch.ts, symbol: RequestDispatcher.handle}
  description: 以 mutex 保護共享佇列的做法
  expect:
    born_at: 222...
    died_at: 333...
  rationale: 2024-05 引入 mutex，2024-07 換成 channel 後移除。
```

`description` 是給人看的，不參與比對——比對用的是 `born_at` / `died_at`。因為 extractor 內部的 `semantic_key` 是實作細節，會隨版本改變，不能寫進 fixture（同樣是循環論證）。

比對規則：系統只要在該 entity 內找到**任何一個** construct，其 birth/death 與標註相符，即算命中。

### E. excursion — 被放棄的方案

```yaml
- id: exc-001
  kind: excursion
  difficulty: easy
  entity: {path: src/worker/dispatch.ts, symbol: RequestDispatcher.handle}
  expect: present
  introduce_at: 222...
  remove_at: 333...
  expect_strength_at_least: B
  rationale: PR #442 明確說明改回舊做法的原因，應該能到 B 級。

- id: exc-002
  kind: excursion
  difficulty: adversarial
  entity: {path: src/flags.ts, symbol: isEnabled}
  expect: absent
  rationale: >
    有一個只活了三週的 feature flag 分支，符合「短命構造」的結構特徵，
    但那是預定要移除的過渡設計，不是試錯後回退。系統若報成迂迴即為誤判。
```

### F. evidence — 證據 span（**已實作**）

錨點是 `at_commit` 加上來源文件的種類。commit message 的 `external_id` 就是
commit sha，所以整條案例只用 git 原生座標，不引用索引器產生的 ID（不變量 14）。

```yaml
- id: evd-001
  kind: evidence
  difficulty: hard
  at_commit: 333...
  expect_spans:
    - source: {type: pr_body, external_id: "442"}
      contains: "lock contention under load"    # 子字串比對即可，不必逐字全等
      tier: linked
  rationale: commit message 只寫 "refactor dispatcher"，真正的理由在 PR body。
```

**正負兩種語意刻意不對稱：**

- `expect_spans: []` 是**負例，而且是窮舉的**——這則訊息一條引文都不得產出。
  過度抽取正是抽取器的主要失效模式，所以負例不留餘地。這種案例的 polarity
  自動算成 `negative`，不必另外寫 `expect: absent`。
- 有列出 span 的是**正例，只要求列出的都在**，不禁止另有別的。span 的右邊界
  是抽取器的自由度，窮舉正例會讓 fixture 在無關的調整上碎掉。

**「文件沒被收進來」與「文件在、但沒有引文」是兩件事**：前者是覆蓋不足
（`missing`），後者是一個真實的觀測值。混為一談會讓覆蓋率失去意義。

`must_not_infer` 尚未實作——`claim` 層還沒解禁，`inferred` 目前不會被產生。

**負例是這一類案例的主要價值。** `controlled-typescript` 的
`evd-zh-negation-outside-span` 守的是：原文「版本字串**沒有**理由改變」不得
被抽成「理由改變。」。那條引文逐字為真、span 斷言通過、意思相反——
**span 斷言擋不住這一類，只有 fixture 擋得住**。

---

## 四、`label_confidence: ambiguous` 的用途

有些案例**沒有唯一正確答案**。最典型的是函式一分為二且兩半對等——哪一半是「延續」？

不要硬做決定然後讓系統去擬合你的武斷判斷。標成 ambiguous 並列出所有可接受答案：

```yaml
- id: lin-007
  kind: lineage
  label_confidence: ambiguous
  accept_any_of:
    - chain: [...]   # 選項一：視 parseHeader 為延續
    - chain: [...]   # 選項二：視 parseBody 為延續
  rationale: 兩半程式碼量相當、都保留了原有職責的一部分，無客觀依據可分。
```

Ambiguous 的案例**不計入主要指標**，但要單獨報告命中了哪個選項——當系統的選擇在版本間跳動時，那本身是不穩定的訊號。

---

## 五、要報告的指標

不要只看一個總準確率，它會把所有有用的訊息平均掉。

| 標註類型 | 指標 | 為什麼 |
|---|---|---|
| lineage | **鏈級完整率**（整條血緣端到端全對的比例） | 一個環節斷掉，整條時間軸就錯了。這比逐段準確率更貼近使用者體驗 |
| lineage | 逐段 precision / recall，**按 tier 分開** | 看得出是哪一層在失效 |
| lineage | 「用了比預期更弱的 tier」的數量 | 現在還沒斷、但將來會斷的地方 |
| discontinuity | precision 與 recall **分開報** | 誤報斷層比漏報嚴重：它會叫使用者忽略真實歷史 |
| change_level | **混淆矩陣**，不是準確率 | shape 誤判成 raw = 漏掉真實變更；raw 誤判成 shape = 白燒 token。代價完全不同 |
| construct | 生命週期端點的準確率（容許 ±1 commit） | 端點差一個 commit 通常無害 |
| excursion | precision 為主，並按 strength 分層 | 這是最容易產生幻覺式結論的地方，寧可漏報 |

**所有指標都要按 difficulty 分層報告。** 混在一起的話，easy 案例會把 hard 案例的退步蓋掉。

---

## 六、Runner 契約

```
fixtures/*.yaml  →  runner  →  report.json + report.md
```

- Runner 讀 fixture、對照資料庫查詢結果、輸出報告
- **絕對不可以**讓 runner 有任何「修正」或「容錯」邏輯去遷就系統輸出
- 每次執行要記錄 `indexer_version` 與 `extractor_version`，報告可跨版本比對
- CI 閘門：**hard 與 adversarial 層的指標不得下降**；easy 層允許波動（通常是雜訊）

---

## 七、情境清單

打勾的是 W3–W4 必須覆蓋的；其餘可以邊做邊補。

### 匹配與血緣

- [x] 1. 純編輯：同檔同名，body 改動 — baseline
- [x] 2. 純改名：body 完全不變
- [x] 3. 純搬檔：路徑變、body 不變
- [x] 4. 改名 + 搬檔同時
- [x] 5. **改名 + 大幅編輯同時** — L2/L3 全失效，只剩相似度。最容易斷的一種
- [x] 6. 函式抽取：一個變兩個
- [ ] 7. 函式內聯：兩個變一個
- [x] 8. 對等拆分 — 標成 ambiguous
- [x] 9. **整體重寫** — 應該報斷層，不應連起來
- [x] 10. 刪除後在別處重建同名函式 — 不應誤連
- [ ] 11. 同名不同簽名的多載
- [ ] 12. 巢狀函式與閉包
- [ ] 13. git 判定為 rename、但實際內容大改的檔案
- [ ] 14. 一個檔案拆成兩個，函式散落各處

### 成本與雜訊（直接決定 LLM 花費）

- [x] 15. **全庫格式化 commit**（prettier / gofmt 一次跑完）— 所有實體都應落在 `raw` 層。這條沒過，你的 token 成本會失控
- [x] 16. 只加註解
- [x] 17. 只改縮排或換行
- [x] 18. 只改局部變數名 — 應落在 `token` 層
- [x] 19. 只改字串或數字字面量 — 應落在 `alpha` 層
- [ ] 20. 改呼叫目標（`foo()` → `bar()`）— `alpha` 層邊界案例
- [x] 21. 加入 try/catch 或迴圈 — 應落在 `shape` 層
- [ ] 22. 合併 commit 帶衝突解決
- [ ] 23. vendored / generated code 的大量搬移

### 構造與迂迴

- [x] 24. 明確 `git revert` — A 級
- [x] 25. 手動反向修改（沒用 git revert）— 應該仍能到 A 或 B
- [x] 26. **部分放棄**：引入 A+B，只移除 A — 這是實體層級相似度看不見、構造層級才抓得到的案例，是這個設計的存在理由
- [x] 27. **短命但非放棄**（過渡期 feature flag）— 負例
- [ ] 28. 長期存在後才移除（技術演進，非試錯）
- [ ] 29. 死而復生：構造移除後又加回來

### 證據（W5 起）

- [ ] 30. commit message 有明確理由 — stated
- [ ] 31. commit message 無意義（"fix"），理由在 PR — linked
- [ ] 32. commit message 與 PR 說法衝突 — 應並列，不得擇一
- [ ] 33. issue 連結存在但不相關 — 誤連負例

---

## 八、首批標註的兩個半小時

先讓 miner 把「該去哪裡找」整理成清單；它不會提供任何標註答案：

```bash
node mine-candidates.mjs /path/to/repo --limit 20 > candidates.txt
```

1. **先掃完所有 `change_level`。** 一條通常只需約兩分鐘，而且真實案例會立即暴露四層雜湊的邊界，例如「改呼叫目標算 alpha 還是 shape」。
2. **後半段再標 lineage。** 每一條都需要閱讀完整歷史，先完成 3–5 條就足以開始實作匹配器。
3. **盯住 `git log -L` 斷掉的位置。** 那是 Git 原生追蹤的極限，也是 Ostracon 必須超越的位置；這些案例全部標成 `difficulty: hard`。
4. **收工前執行驗證器。** commit、path 或 `snippet_head` 解析失敗都是 exit 1，不會被靜默略過：

```bash
node validate-fixtures.mjs fixtures --repos <name>=/path/to/repo
```

驗證器也會比較可判定正負性的案例；負例少於正例的一半就警告。只標「應該連起來」的案例，會養出一個過度連線、精確率持續下降的匹配器。

實話：首批有 3–5 條血緣加 15–20 條 change_level 就夠產生第一組數字。這是活文件，第三週跑第一次匹配器時，每發現一個判錯的案例就補一條進來，測試集會自己長大。

### 手工標註的工具

```bash
# 追蹤某個函式的變更歷史（git 原生支援，不需要你的索引器）
git log -L :RequestDispatcher.handle:src/worker/dispatch.ts

# 跨檔案追蹤，含搬移與改名偵測
git log --follow -M -C --stat -- src/worker/dispatch.ts

# 只列出格式化類的大型 commit（找第 15 條的素材）
git log --shortstat --oneline | grep -B1 "files changed" | sort -k5 -rn | head
```

第一條是關鍵——`git log -L` 本身就會做函式邊界追蹤，可以直接當作人工標註的參考底稿。但要注意：它的追蹤能力比你要做的弱得多（遇到改名就斷），所以**它斷掉的地方，正是你最該標成 hard 的地方**。

---

## 九、Repo 怎麼挑

不要挑最有名的，挑**你最熟的**。標註品質完全取決於你能不能判斷兩段程式碼是不是同一個東西，而那需要領域理解。

三個 repo，各自負責不同的壓力：

1. 一個你自己寫過或深入讀過的中型 TS 專案 — 血緣標註的主力
2. 一個歷史上有過大規模重構的專案 — 情境 5、9、26 的素材
3. 一個有過全庫格式化 commit 的專案 — 情境 15，成本控制的關鍵驗證

第三個也可以自己造：clone 任何 repo，跑一次 prettier，commit。人工製造的測試案例完全合法，而且能精確控制變因。
