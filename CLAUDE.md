# CLAUDE.md

這份檔案每個工作階段開始時都會被讀。**這裡只放規則與不變量**，超過 200 行
就代表該把細節移到 `docs/`。

進度、本機路徑與個人工作節奏在 `CLAUDE.local.md`（不進版控）。
**這份檔案裡不該出現任何絕對路徑或只在某一台機器成立的事實。**

| 我要找 | 去哪 |
|---|---|
| 規則背後的定義與理由 | `docs/architecture.md` |
| 資料模型的唯一真相 | `db/schema.sql` |
| 模組地圖與實測基準 | `docs/status.md` |
| 排程、效能預算、已知限制 | `docs/roadmap.md` |
| 黃金測試集規格 | `docs/golden-fixtures-spec.md` |
| 進行中工作的細部設計 | `docs/plan-*.md` |
| 現在該做什麼、不該碰什麼 | `CLAUDE.local.md` |

**先讀實際檔案，不要依文件重建程式碼。** 動 `src/git/persist.ts`、`src/git/index.ts`、
`src/git/walk.ts`、`src/git/lineage.ts`、`src/golden/materialize.ts`、
`src/match/ladder.ts` 之前一定要先讀它們本身。

---

## 專案是什麼

從 git history 重建程式碼的**決策演化史**：一段程式碼何時誕生、被哪幾次改動重塑、
每次的理由是什麼、以及哪些做法試過又被推翻。

不是「問答你的 repo」。差別在於：問答工具描述程式碼的**現況**，這個工具描述它的**演化**。

判準：任何讓「抽掉 LLM 之後還剩什麼」這個答案變弱的功能，都不做。抽掉 LLM 後仍剩下
AST 解析、四層雜湊、匹配演算法、圖遍歷、增量索引引擎。

---

## 工作方式

- **實測，不要只推論。** 每一段程式碼都要實際跑過再交出來。這個專案已經有多個 bug
  是「邏輯看起來對、實跑才發現錯」抓到的。
- **設計會被逐條審查並收到反對意見。** 判斷錯了就直接糾正並附上理由；
  不要為了順從而讓步。實務上兩個方向的推翻都發生過。
- **不要為了讓數字好看而遷就測試集。** 系統判錯就修系統，fixture 判錯就重新裁決
  並更新 `rationale`。
- **回覆與程式碼註解都用繁體中文**，且註解要寫「為什麼」而非「做什麼」。
- 任務切到**單一 PR 的粒度**。一次交出整個子系統會失去對程式碼的理解。
- 動到匹配器、抽取器或偵測器之前，先跑一次黃金測試集記下基準；改完再跑一次比對。
  **任何演算法改動都必須附上前後指標對照。**

---

## 不變量（違反即為 bug，不是風格問題）

### 身份

1. `entity.id` 一旦建立不可變更。對外 API、fixture、URL 一律使用 `entity.stable_key`，
   因為全量重建索引會讓 rowid 改變。
2. **slot 與 entity 是兩個不同的身份概念**，不可合併。slot 是「這個位置」的職責
   連續性；entity 是「這段程式碼」的血緣。兩者分歧處即 `slot_discontinuity`。
   **誤報斷層比漏報嚴重**——假斷層會叫使用者忽略真實歷史，門檻應偏保守。
3. 每一條匹配都必須記錄 `tier` 與判定依據。L4/L5 靠相似度召回，接受前必須完成
   精確驗證（`exact_verified = 1`）。L1–L3b 是 slot／雜湊相等，不得填寫相似度欄位；
   L3b 另須同檔且前後候選唯一。
4. **每一層都做雙端 bucket 唯一性檢查**：前後候選都恰好 1 筆才接受，否則記
   `ambiguity` 並往下掉。往下掉的代價是零——L4/L5 有精確驗證，Jaccard 是 1.0 照樣
   接得起來；任意配對的代價卻是 `stable_key` 每次重建索引都漂移。

### 確定性

5. **結構層（pass: structural、lifecycle）零 LLM。** 索引器內不得出現任何模型呼叫。
   這是「抽掉 LLM 還剩什麼」這個賣點的物理保證。
6. `what_changed` 由四層雜湊階梯確定式導出。模型只允許把已產生的 `what_struct`
   翻成人話，不得引入其中沒有的任何資訊。
7. 相同輸入必須產生相同輸出。任何雜湊、`semantic_key`、`stable_key`、匹配門檻或
   diff 演算法的變更都必須提升對應的 `*_version` 欄位。

### 誠信

8. **`stated` / `linked` 層是抽取式，不是生成式。** 模型回傳原文 span 的字元起訖，
   程式必須斷言該 span 確實存在於 `source_doc.body`；對不上就整條丟棄，不得降級使用。
9. `inferred` 只存在於 `claim`，永遠不進 `v_presentable_claim`。不得以「信心夠高」
   為由讓推測混入可信歷史敘事。
10. 證據衝突要並列顯示，不可由模型擇一。commit message 說 A、PR 說 B，兩者都呈現。
11. 證據獨立性依 `provenance_root` 去重。同一個 PR 討論串裡三個人說同一件事，
    是一份證據。

### 工程

12. 索引必須增量。四個 pass（structural / lifecycle / evidence / claim）各有水位線，
    可獨立、可恢復地重跑。
13. `PRAGMA foreign_keys = ON` 是**每連線**設定。應用層每開一條連線都要執行一次。
14. 黃金測試集的錨點只能是 git 原生座標（`commit_sha` / `path` / `symbol` /
    `occurrence`）。**任何情況下都不得引用索引器產生的 ID**——那是用系統的輸出
    驗證系統的輸出。

---

## 禁令

- 不引入圖資料庫。關聯用一般表存，SQLite 足夠。
- 不增加執行期相依。安裝摩擦是開源專案的頭號死因；每新增一個相依都要論證。
- 不在結構層呼叫 LLM。
- runner／評估層不得從 `message`、`detail` 或其他人類文字解析 expected/actual；
  判定語意必須明確存在於結構化 `binary: { expected, actual }`。
- **不修改 fixture 去遷就系統輸出。**
- 不放寬 CI 閘門。hard / adversarial 層的指標不得下降。
- **`disambiguator` 目前恆為 NULL**（TypeScript candidate 中為 `undefined`），
  不因看到 schema 保留它就自行補實作。同名宣告交由 L1 的 bucket 唯一性與內容導向
  的 L2/L3/L4 處理。golden materializer 用 fixture `occurrence` 當 SQLite anchor
  的內部儲存座標，**不得餵回 matcher**。51 條 L4/Jaccard=1 的配對證明的是「現有
  資訊不足」，不是 occurrence 序號可修——先評估 diff hunk 約束，再考慮階層式
  scope matching。
- 不做非目標清單上的任何東西。

**明確非目標**（現在不做，寫下來是為了拒絕自己）：多語言全面支援、雲端版、團隊
協作、VS Code 外掛、即時 watch 模式、程式碼編輯／生成、PR 自動審查。W1–W6 只支援
TypeScript；W5 加 Python 僅為驗證架構沒有寫死在單一語言。

---

## 開發指令

**開發與測試一律走 `node --experimental-strip-types`，不經過建置。**
`pnpm build`（`tsconfig.build.json`）只在發布時用，`prepublishOnly` 會自動跑。

**`src/golden/` 不進封裝**——`files` 白名單只有 `dist`、`db/schema.sql`、README、
LICENSE。它是評估工具不是產品（它 import devDependency `yaml`），要跑 golden 的人
是 clone 整個 repo。

**CLI 的 script 叫 `why:cli`，不是 `why`。** `pnpm why` 是 pnpm 內建指令，會蓋掉
同名 script 而不報錯。對外介面是 `ostracon why`，由 `src/cli/main.ts` 分派到各支的
`main(args)`——那也是各支直接執行時走的同一個函式。

```bash
pnpm install
pnpm typecheck                  # tsc --noEmit，零錯誤是硬門檻
pnpm test                       # 先跑 typecheck，再跑 node --test
                                # 全部測試由 test/index.test.ts 匯入

# 依 fixture 裡的 clone_url / index_until 取回語料到 corpora/，並驗證 HEAD
# 語料座標的唯一真相是 fixture，不得在別處另抄一份 SHA
pnpm corpus:fetch [-- --dir <目錄>]

# 建立黃金案例需要的 revision/match，再跑 runner
# --baseline 是閘門的必要條件，少了它 exit code 恆為 0
pnpm golden:index -- --repo corpora/osiris --fixture fixtures/osiris.yaml --db <fresh.db>
pnpm golden       -- --fixture fixtures/osiris.yaml --db <fresh.db> \
                     --baseline fixtures/baselines/osiris.json --report reports/<name>.json

# 印出一段程式碼的演化史（會自行建索引，只索引該檔案所屬的血緣）
pnpm why:cli -- '<path>:<symbol>' --repo <repo-path> --db <db> [--until <sha>] [--full]
#   預設只索引該檔案的血緣（快）；--full 索引整個 repo，跨檔案搬移才看得見（慢）
#   路徑在 --until 已被刪除也查得到（fallback 到曾經擁有它的血緣）

# 列出被推翻的做法。一律跑全 repo pass——搬移守門在單一血緣下是瞎的
pnpm ostracised -- --repo <repo-path> --db <db> [--until <sha>] [--strength A|C]

# 證據層：收 commit message、規則式抽取、驗證後升格（零網路、零 LLM）
pnpm evidence:extract -- --db <db>

# linked 文件：live 需 token；測試／golden 使用 --replay-dir，永遠不需網路或 token
pnpm evidence:linked -- --db <db> [--record-dir fixtures/http | --replay-dir fixtures/http]

# 審計完整歷史中 matcher 實際產生的非 L1 配對（人工裁決負例）
pnpm golden:audit -- --repo <repo-path> --until <sha> --output reports/audit.json

# 把可疑無資訊量的引文分組列出供人工裁決（列完整聯集，不抽樣）
pnpm quotes:audit -- --db <db> --output reports/quote-audit.md --json reports/quote-audit.json

# 建立只改宣告自身名稱的可重現 L3b fixture repo
pnpm fixtures:controlled -- <output-directory>

# 首批標註：先挖候選，再驗證 fixture 本身
pnpm mine:candidates      <repo-path> --limit 20 > candidates.txt
pnpm fixtures:validate    fixtures --repos <name>=<repo-path>
```

跑單一測試檔：`node --experimental-strip-types --test test/ladder.test.ts`；
單一案例：加 `--test-name-pattern '<pattern>'`。

### 完成的定義

一個模組算完成，需要：通過型別檢查、有單元測試、**黃金測試集無退步**、
`docs/architecture.md` 中對應章節已更新。

### CI 與 baseline

`.github/workflows/ci.yml` 執行「不放寬 CI 閘門」這條規則：FTS5 檢測 → 型別檢查 →
單元測試 → 兩套黃金測試集逐案例比對 `fixtures/baselines/*.json`。

**閘門只在「baseline 裡 pass 的案例變成 fail 或 missing」時失敗**，而且
**只看 hard / adversarial 層**（`easy` 被 `findRegressions` 跳過）。
沒有 `--baseline` 時 exit code 恆為 0——所以任何少了 `--baseline` 的 golden 呼叫
都是一道不會擋任何東西的假閘門。

覆蓋率提升導致本來 missing 的案例開始 fail **不算退步**，那是新資訊。
真的要更新 baseline 時，重新產生並在 PR 說明為什麼那不是退步。

---

## 目前階段

**進度、當前切片與「現在不要碰什麼」在 `CLAUDE.local.md`。**
那些每週都變，而且只在作者的機器上成立；放在版控裡會讓每一次進度更新
都變成一筆與程式碼無關的 diff。

長期成立的階段性限制寫在這裡：

- **W1–W6 只支援 TypeScript。** W5 加 Python 僅為驗證架構沒有寫死在單一語言。
- **`claim` 相關的表尚未解禁**，意圖層還沒開始。
- **網路只准出現在 `src/http/github.ts`。** 其餘任何檔案出現 `fetch` 都是 bug。

實測基準（測試數、golden 覆蓋率、效能）一律看 `docs/status.md`，不要在這裡複述——
複述的那一份一定會先過期。
