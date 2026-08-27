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
- **W5 剩餘原功能**：✅ 已完成。加 Python（逼出四個寫死的 TypeScript 假設）、
  成本控制（重新定義並以內容定址兌現；計價模型後續再被 nestjs/nest 修正成兩項）、
  攪動熱點（`ostracon hotspots`，entity 層級、只算結構改動——檔案層級量過
  之後否決，那等於重做 `git log`）。issue／PR 連結解析更早就完成了。
- **W6 發布收斂**：✅ 已完成。四項都有實測撐著：封裝（打包後在封裝外安裝並實跑
  `why` 與 `hotspots`）、README 與架構文件（各掃出一處同源的轉述失真）、
  demo 語料重建性（逐檔比對 1,964 個檔案）、陌生人安裝路徑（從零 clone 六步全綠）。
  另外多做了排程上沒有的一件事：**跑第一個沒碰過的語料**（nestjs/nest），
  而它推翻了前一天才寫進 README 的成本模型，並抓到 `ostracised` 首屏的日期缺陷。
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

**成本有兩項：commit 與 revision。** 這一節原本以 commit 為單一軸，2026-08-22 改成
以 revision 為單一軸，2026-08-23 再改成兩項——**兩次都是量測推翻的，第二次推翻的是
我自己前一天下的結論**。經過見 `status.md`。

| 操作 | 預算 |
|---|---|
| pass 1–2 索引一萬個 commit（中型 TS repo，筆電） | < 10 分鐘（**依密度 1.5–4.0 分鐘**） |
| 同上，但 3.8 萬 commit ／ 170 萬 revision | **破表**：實測 239 分鐘、RSS 3.5 GB、未跑完 |
| 增量索引一百個新 commit | < 10 秒（**實測 1.0 秒**，create-t3-app） |
| 單一實體的時間軸查詢 | < 100 ms |
| 「已消失的構造」清單查詢 | < 300 ms |
| 索引體積 | **每個 revision 0.36–0.68 KB**（三套大語料） |

時間軸查詢依賴 `idx_change_entity(entity_id, commit_id)`；動到那條索引前先確認查詢計畫。
實測 0.15 ms（44 個 revision），遠在預算內。

### 兩項成本模型（2026-08-23 實測，同一台機器同一輪）

| 語料 | commit | revision | rev/commit | 秒 | ms/commit | ms/rev | KB/rev |
|---|---:|---:|---:|---:|---:|---:|---:|
| osiris | 99 | 1,579 | 15.9 | 4.2 | 42.4 | 2.66 | 1.01 |
| create-t3-app | 1,378 | 3,606 | 2.6 | 8.6 | 6.2 | 2.38 | 1.27 |
| psf/requests | 6,491 | 148,199 | 22.8 | 100.1 | 15.4 | 0.68 | 0.36 |
| vuejs/core | 7,156 | 233,665 | 32.7 | 165.8 | 23.2 | 0.71 | 0.41 |
| **nestjs/nest** | **21,648** | **144,746** | **6.7** | **203.5** | **9.4** | **1.41** | **0.68** |
| **angular/angular** | **38,278** | **1,697,002** | **44.3** | **14,357** | **375.1** | **8.46** | **0.46** |

**angular 那一列不要拿來擬合，它是用來否證外推的。** 兩項模型（用 nest 與 vue 解）
對它預測 18.7 分鐘，實測 239.3 分鐘——**低估 12.8 倍**。ms/revision 從 0.68–1.41
跳到 8.46，峰值 RSS 從 1.2 GB 跳到 3.5 GB。**成本在這個規模上不是線性的**，
而成因（記憶體壓力？索引深度？匹配器的候選池？）還沒定位。

**而且那一趟沒跑完**：結構層寫完 170 萬筆 revision 之後被訊號中止，
迂迴偵測一條都沒跑。所以 239 分鐘是**下界**，其餘四套語料的秒數都含迂迴。
兩者不可直接相比。

**「單一計價單位」這個框架在內容定址之後就不成立了**，而那句話在這裡站了一天。
軸的判定用的是**內容定址之前**的量測，同一批三套語料前後對照：

| | ms/commit 離散度 | ms/revision 離散度 |
|---|---:|---:|
| 內容定址之前 | 6.4 倍 | **2.0 倍** |
| 內容定址之後 | 3.7 倍 | **3.5 倍** |

內容定址砍掉的是**每列的寫入成本**（634 bytes、三條大索引），那全部落在 revision
那一側；每 commit 的走訪與交易成本幾乎沒動。於是 revision 軸原有的優勢被抹平，
兩個軸現在一樣差。先前這裡寫著「內容定址沒有改變哪個變數在驅動成本」——
**那句話是錯的，而且用當時手上的數字就能算出來，不需要新語料。**

nestjs/nest（21,648 commit）給了不需要任何模型的反證：**它與 psf/requests 的
revision 數只差 2.4%（144,746 對 148,199），索引時間卻差一倍**（203.5 秒對
100.1 秒）。差別在 commit 數：21,648 對 6,491。

**成本有兩項**：每個 commit 的走訪與交易，加上每個 revision 的解析與雜湊。
以 nest 與 vue 解出來是 **5.86 ms/commit + 0.53 ms/revision**，對 t3 與 requests
的預測誤差 16–17%，對 osiris 低估 66%（99 個 commit 攤不掉行程啟動的固定成本）。

**預算重新表述**：一萬 commit 以 vue 的密度（32.7 rev/commit）計約
`10,000 × 5.86ms + 327,000 × 0.53ms` ≈ **4.0 分鐘**；以 nest 的密度
（6.7 rev/commit）計約 **1.5 分鐘**。**估自己的 repo 時兩項都要帶**——
只用 revision 外推，在低密度 repo 上會低估一倍。

**但這個擬合只在約 25 萬 revision 以內成立。** angular 有 170 萬，而擬合低估
12.8 倍。「一萬 commit」這個表述本身也該退休：它是從第一版預算沿用下來的，
而 commit 數在四套語料之間對應到 3,606 至 1,697,002 個 revision——**同一個
「一萬 commit」可以差 470 倍的工作量**。要問的是 revision 數，不是 commit 數。

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
7. **數萬 commit 的 repo 現在跑不完**（angular/angular 實測 239 分鐘未完、RSS 3.5 GB）。
   成本在約 25 萬 revision 之後不是線性的，成因未定位。
8. ~~**全 repo 結構 pass 沒有中途檢查點**~~ ✅ 已修（2026-08-24）：水位線改為寫進
   每一顆 commit 的 transaction 內，中斷之後接得回來。開銷在雜訊內（見 `status.md`）。

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
