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
  另找一個非 release-squash、PR 歷史較完整的真實 repo 作意圖層的正面展示。
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

| 操作 | 預算 |
|---|---|
| pass 1–2 索引一萬個 commit（中型 TS repo，筆電） | < 10 分鐘（**目前實測外推約 1.00 分鐘**） |
| 增量索引一百個新 commit | < 10 秒（**實測 1.0 秒**，create-t3-app） |
| 單一實體的時間軸查詢 | < 100 ms |
| 「已消失的構造」清單查詢 | < 300 ms |

時間軸查詢依賴 `idx_change_entity(entity_id, commit_id)`；動到那條索引前先確認查詢計畫。
實測 0.15 ms（44 個 revision），遠在預算內。

**兩個 1,000+ commit 語料獨立驗證，餘裕充足**（2026-08-02，MinHash 修正後）：

| 語料 | commits | revisions | 總耗時 | 外推一萬 commit |
|---|---:|---:|---:|---:|
| `create-t3-app` | 1,378 | 3,606 | 8.88 s | **1.07 分鐘** |
| `pmndrs/zustand` | 1,372 | 11,940 | 9.93 s | **1.21 分鐘** |

zustand 的每 commit revision 密度是 create-t3-app 的 3.3 倍，且大量觸發 L2／L3c／L4，
是明顯更難的語料——它仍在 1.21 分鐘。細節見 `status.md`。

Osiris 99 commits 外推的 9.15 分鐘保留為「小語料外推不可靠」的歷史紀錄，不再是
目前預算判斷。不同 repo 的單次 commit 大小仍可能差很多，所以不把一分鐘宣稱成
普遍保證，也不因數字變好而調 matcher 門檻。

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
