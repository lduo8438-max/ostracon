# angular/angular 全量索引的原始量測（2026-08-27）

`roadmap.md` §3 與 README 的效能表引用的數字就出自這裡。**留著原始紀錄是因為
那些數字現在是公開宣稱**——而重跑一次要三小時，沒有人會為了查證一個數字去跑。

語料：`angular/angular`，38,278 commit，HEAD `915a03ae`（2026-08-25）。
工具：`pnpm profile:angular`（`src/golden/profile-angular.ts`）。

## 檔案

| 檔案 | 內容 |
|---|---|
| `main.jsonl` / `main.out` | 正式長跑。每 5,000 顆 commit 一筆 `progress`，含耗時、RSS、DB 大小、**該區間最慢的 commit** |
| `main-resume*.out` | 兩次續跑 |
| `gate.jsonl` / `gate-resume.out` | 續跑閘門：刻意在 topo 4,999 中止，再續跑到 10,000 |
| `state.jsonl` | supervisor 的視角：中斷、拒絕、續跑、完成 |
| `first-run.time` / `first-run.out` | **第一趟（2026-08-26，被訊號中止）的 `/usr/bin/time -l` 計量。** 索引本身的數字已被上面那趟取代，但這裡是唯一的資源計量紀錄——`status.md` §「成因未定位」引用的 24.5M page reclaims、188 萬次非自願 context switch、239.3 分鐘、峰值 3,479 MiB 都只出自這個檔案，profile 工具不記這些 |

## 三件值得記住的事

**一、非線性集中在兩顆 commit，不是隨資料量惡化。**
`66f49c24`（1,637 個 TS 檔的 revert）26:49、`e41a5228`（3,015 個檔的 revert）
69:35，**合計佔全程 52%**。扣掉之後其餘 38,276 顆是 89 分鐘、1.86 ms/revision。

**二、`database is locked` 不是缺陷。**
`state.jsonl` 有一次 `main-resume` 在原程序還活著時啟動並失敗。supervisor 隨後
確認原程序仍在 99.4% CPU 上跑——**SQLite 正確擋下了併發寫入**。這是設計檢查點
時沒想到的一種中斷形狀，而它自己處理對了。

**三、最終兩條水位線都到 HEAD。**
`structural` 與 `declarations` 皆為 topo 38,277，`quick_check = ok`。
2,919,032 revision、118,194 entity、DB 1.20 GiB。

## 重跑

```bash
pnpm profile:angular -- --repo <angular> --db <fresh.db> --progress-every 5000
```

資料庫是可重建的衍生物，所以不留；這些 log 不可重建，所以留。

`first-run.*` 是同一條規則的延伸：那一趟的資料庫已刪、語料副本已刪，但它的資源
計量支撐著 `status.md` 裡一個**尚未定位的成因假說**（記憶體壓力）。假說被推翻或
證實之前，證據不能只存在於暫存目錄。
