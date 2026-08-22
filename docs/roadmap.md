# 排程、預算與已知限制

> 現況在 `status.md`；demo 語料執行記錄在 `plan-demo-corpus.md`。

---

## 1. 八週排程

- **W1 地基**：✅ 已完成（提前）
- **W2 端到端**：✅ 已完成。結構 → 演化 → 意圖的三欄 UI 已跑通；
  `abandoned_reason` 也把 ostracised approach 接到意圖層，全程零 LLM。
- **原 W3–4 的三根主樑**：✅ 已提前完成大半，不再佔兩整週：跨檔案／跨重構
  entity 追蹤（L3c／L5 + golden）、entity 層級迂迴偵測（含搬移守門）、
  結構與證據的增量水位線都已落地並在 1,000+ commit 語料實測。
- **W3 可信度收斂**：用 fresh DB 重跑 Osiris／create-t3-app 的完整端到端路徑，
  專攻「同一功能兩種執行方式」的靜默分岔；量化 `abandoned_reason` 的 entity
  相關性與高密度 commit 呈現，不為數字放寬門檻。
- **W4 demo 前移**：把原 W7 的高風險工作提前——預先索引三到五個知名開源 repo、
  做可直接玩的線上 demo 與 GIF。這比再加索引功能更早暴露題目級問題。
  **選材是互補展示，不是挑數字好看的**：Osiris 展示 subject-line 語料上的意圖層；
  create-t3-app 展示跨重構追蹤與迂迴偵測，以及**面對 squash 歷史時誠實留白**；
  第三個語料**已用量測選定為 vuejs/core**：7,156 commit、零聚合 commit。
  `abandoned_reason` 在加上 entity 綁定守門後是 **10 條**（原先的 104 條只來自
  18 條引文，其中一條掛到 36 個 entity，不足以支持 entity 級宣稱）。
  **demo 建立在這 10 條上，不是 104 條。** 細節見 `status.md`。
  **不為了 demo 保住那 253 條無法歸因的宣稱。**
- **W5 剩餘原功能**：攪動熱點視圖、成本控制、加 Python 驗證架構。
  issue／PR 連結解析已提前完成，不再重排一次。
- **W6 發布收斂**：README／架構文件、安裝與封裝摩擦、demo 語料重建性；
  CI、`corpus:fetch`、Node 24／FTS5 探測與 npm 封裝已提前完成，只補實測缺口。
- **W7 release candidate**：凍結功能，以陌生人安裝與真實 repo 回饋修阻斷問題。
- **W8**：發布 + 修爆掉的東西

多出來的產能應該投進「把差異化的 20% 做深」、「在真實大型 repo 上測試」、
「W7 的 demo 品質」，**不是加功能**。功能清單保持原樣。

---

## 2. W2 的執行順序

1. **diff-hunk 約束**（✅ 完成，見 `plan-diff-hunk.md`）
2. **CLI 第一個真實輸出**：`why <path>:<symbol>` 印出時間軸（✅ 完成）。
   這是第一次能**用眼睛看**這個系統做得對不對——測試證明程式碼行為正確，
   但看不出「這條時間軸對使用者有沒有意義」，而那是題目層級的訊號。

   **這一步立刻兌現了它的價值**：第一次跑 Osiris 就用眼睛看到同一個 entity
   誕生兩次，追下去是 `ensureEntity` 用 slot 重用 entity，把兩段不同血緣合併
   成一個——違反不變量 2，而全部測試與黃金測試集都沒抓到。

   **全 repo 結構 pass 已補上**（`--full`）：跨檔案的搬移與抽取現在看得見。
   Osiris 實測抓到 `isRateLimited` 從 `api/scanner/route.ts` 搬到 `lib/ssrf-guard.ts`
   的 L5 配對，與黃金測試集的 `lin-rate-limiter-extraction-j77` 獨立吻合。
3. **span 斷言機制**（✅ 完成）：只用 commit message，抽取式，程式驗證 span 確實
   存在於原文。這是整個信譽架構的基石，越早試錯越好。**不要先接 API。**

   已實作的是**驗證那一半**，零 LLM、零網路：`src/evidence/span.ts`（純函式斷言）
   與 `src/evidence/store.ts`（收 commit message、候選 staging、升格 evidence）。
   Osiris 實測 99 則訊息 13 ms 收完；40 條規則式候選全部通過，編造的候選被
   `text_not_found` 擋下。

   後續已補上規則式因果抽取、中文詞界裁決與 linked 文件抽取；所有候選仍走同一
   span 斷言，沒有第二套較寬鬆的規則。
4. **意圖層與最醜的三欄 UI**（✅ 完成）：證據確定式升格為分型 claim，畫面逐列
   呈現結構／演化／意圖。Chrome 實測後修正雙向捲動同步與子像素列高漂移；
   `abandoned_reason` 以 `excursion_id` 為主體，顯示在迂迴的移除 commit。

---

## 3. 效能預算（超出即為 bug）

**成本的計價單位是 revision，不是 commit。** 這一節原本以 commit 為軸，
2026-08-17 就懷疑挑錯了變數，2026-08-22 用四套語料在同一台機器上量完定案。

| 操作 | 預算 |
|---|---|
| pass 1–2 索引一萬個 commit（中型 TS repo，筆電） | < 10 分鐘（**vuejs/core 的密度外推 6.9 分鐘**） |
| 增量索引一百個新 commit | < 10 秒（**實測 1.0 秒**，create-t3-app） |
| 單一實體的時間軸查詢 | < 100 ms |
| 「已消失的構造」清單查詢 | < 300 ms |
| 索引體積 | **每個 revision 約 1.25 KB**（兩套大語料一致） |

時間軸查詢依賴 `idx_change_entity(entity_id, commit_id)`；動到那條索引前先確認查詢計畫。
實測 0.15 ms（44 個 revision），遠在預算內。

### 為什麼軸是 revision（2026-08-22 實測，同一台機器同一輪）

| 語料 | commit | entity | revision | 秒 | ms/commit | ms/entity | ms/rev | KB/rev |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| osiris | 99 | 307 | 1,579 | 4.2 | 42.6 | 13.7 | 2.67 | 1.95 |
| create-t3-app | 1,378 | 405 | 3,606 | 8.8 | 6.4 | 21.8 | 2.45 | 2.30 |
| psf/requests | 6,491 | 3,409 | 148,199 | 180.8 | 27.8 | 53.0 | **1.22** | **1.25** |
| vuejs/core | 7,156 | 6,561 | 233,665 | 293.6 | 41.0 | 44.7 | **1.26** | **1.24** |

三套真實語料的離散度（最大／最小）：**ms/commit 6.4 倍、ms/entity 2.4 倍、
ms/revision 2.0 倍**。而兩套大語料的 ms/revision 只差 3%，KB/revision 只差 1%——
小語料的 2.4–2.7 ms 是固定成本（行程啟動、wasm 載入、git spawn）攤不掉，不是
單位成本較高。

**為什麼 commit 是壞軸**：每 commit 的 revision 數在四套語料之間是
2.6／15.9／22.8／32.7，**差 12.6 倍**。用 commit 外推等於假設這個比值是常數，
而它不是。「一萬 commit 約一分鐘」那句話的形式本身就是錯的，不只是數字過時。

**預算重新表述**：以最密的語料（vuejs/core，32.7 rev/commit）計，一萬 commit
約 327,000 個 revision × 1.26 ms ≈ **6.9 分鐘**。仍在 10 分鐘內，但餘裕是 1.45 倍
而不是先前以為的九倍。比 vue 更密的 repo 會破預算——那是已知的邊界，不是意外。

2026-08-02 的 `create-t3-app` 1.07 分鐘與 `pmndrs/zustand` 1.21 分鐘保留為歷史
紀錄：兩者都是 1,300 出頭的 commit、每 commit 密度分別是 2.6 與 8.7，用它們外推
一萬 commit 的問題正是上面說的那一個。**不因數字變好或變壞而調 matcher 門檻。**

---

## 4. 已知限制（都要進 README，不能只留在註解裡）

**全部已進 README（2026-08-02）**，另補了迂迴偵測那一條。這裡保留清單本身，
內文以 README 為準。

1. **平行分支上的血緣**：維護的是全域 path → lineage 對照表而非逐 commit 樹狀態。
   同一路徑在兩條分支各自演化再合併時歸屬可能出錯。完全正確需要逐 commit 樹快照，
   成本高一到兩個數量級。`--first-parent` 走訪在原理上可完全避開，但**尚未實作**。
2. **合併不做改名偵測**（git combined diff 的限制）。
3. **alpha 層是名稱比對非作用域解析**（過度正規化，方向保守：會少送 LLM，不會多送）。
4. **`ctrl-position-ambiguous` 類的位置歧義無解**（不是難解）。diff-hunk 約束也解不了，
   因為 git 的 diff 演算法面對同一個歧義；hunk 只是把歧義從我們的匹配器轉移到 Myers。
5. **`node:sqlite` 仍是 experimental**（Node v24.14.1 實測仍會發出 ExperimentalWarning），
   且需要編進 FTS5 的 build。
6. **迂迴偵測只到 entity 層級、沒有 B 級**，「同名者仍存在」是純名稱比對會有雜訊。

---

## 5. 命名與基礎設施（已定案）

| 項目 | 值 |
|---|---|
| 專案名 | Ostracon（古代書寫用的陶片，也是 ostracise「放逐」的字源） |
| npm 套件 | `ostracon`（已確認可用） |
| GitHub Org | `ostracon-dev`（`ostracon` 個人帳號與 Org 均已被佔） |
| 網域 | `ostracon.org` |
| CLI 動詞 | `why`，例：`why src/auth.ts:validateToken` |

README 開場的定位敘事：ostraca 是被丟棄的陶片碎片——收據、便條、抱怨——如今卻成了
我們了解古代日常生活最重要的記錄。「你的 commit message 就是 ostraca。」
被推翻的方案在 UI／文件中稱為 **ostracised approaches**。
