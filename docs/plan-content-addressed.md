# 內容定址的 revision 儲存

> 動機與量測在 `status.md` §成本控制重新定義。這份只寫設計與取捨。
> **發布前最後一個資料模型變更窗口**（2026-08-22 作者裁定）。

---

## 1. 要解決的事實

| 事實 | requests | vue |
|---|---:|---:|
| `revision` 表加索引佔資料庫 | 86.7% | 85.9% |
| `revision` 每列欄位內容 | 約 692 bytes | 約 694 bytes |
| **相異的內容向量** | **11,001（7.4%）** | **22,789（9.8%）** |

九成以上的 `revision` 列，其內容衍生欄位與另一列逐位元相同——差別只在 commit、
路徑與位置。位置**確實會變**（同一段程式碼會因為檔案別處的改動而位移），
所以不能直接刪列；能做的是把內容那一半抽出去共用。

另外量到兩件事，一併處理：

- **五個雜湊以 64 字元 hex 存**，佔每列內容的 44%。改存 32 bytes 的 BLOB 直接砍半。
  `blob_sha` 同理（40 → 20）。
- **`hash_shape` 與 `hash_alpha_self` 在 SQL 上沒有任何讀者**，
  `idx_revision_shape` 與 `idx_revision_alpha_self`（requests 上合計 21.4 MB）
  因此是純成本。匹配階梯讀的是 `buildPool` 現場觀察出來的記憶體候選池，
  不是資料庫。

---

## 2. 設計

### 2.1 內容表

```sql
CREATE TABLE declaration_content (
  id            INTEGER PRIMARY KEY,
  content_key   BLOB NOT NULL UNIQUE,   -- sha256(整個內容向量)
  hash_raw      BLOB NOT NULL,          -- 32 bytes，不再是 64 字元 hex
  ...            -- 五個雜湊、shape_profile、signature、各種 count、簽章資料
) STRICT;
```

`revision` 只留身分與位置，加一個 `content_id` 外鍵。

### 2.2 為什麼鍵是整個向量的摘要，不是 `hash_raw`

直覺上 `hash_raw` 就夠了——內容一樣，其餘欄位是內容的函數。**但實測 vue 上
相異 `hash_raw` 是 22,774、相異 `(hash_raw, shape_profile)` 是 22,789**：有 15 組
逐字相同的宣告落在不同的剖面上（`.ts` 與 `.tsx` 各一份 grammar），
它們的 `hash_shape` 不同。

而且「同一份文字在同一個剖面下必定解析成同一棵樹」這句話我不敢保證——
同樣的字面文字出現在不同的語法脈絡裡（類別方法 vs 物件字面值），
節點型別可能不同。**與其論證它不會發生，不如讓鍵涵蓋全部欄位**：
`content_key = sha256(向量)` 之後，碰撞在密碼學意義上不可能，
不需要任何「應該不會」的推論。

實測 requests 與 vue 上，相異向量數與相異 `(hash_raw, shape_profile)` 數**相同**，
所以這個更保守的鍵沒有付出任何去重率的代價。

### 2.3 索引怎麼搬

| 原索引 | 去向 | 理由 |
|---|---|---|
| `idx_revision_entity` | 留在 `revision` | 時間軸查詢（預算 100 ms）靠它 |
| `idx_revision_slot` | 留在 `revision` | `previousSlotEntity` 靠它 |
| `idx_revision_alpha` | 搬到內容表 | 迂迴的搬移守門查它；列數降到 7.4% |
| `idx_revision_shape` | **刪除** | 無讀者 |
| `idx_revision_alpha_self` | **刪除** | 無讀者，且它的 `lineage_id` 前綴在內容表上不存在 |
| （新）`idx_content_raw` | 內容表 | 搬移守門的 `hash_raw` 查詢**原本沒有索引**，是全表掃描 |
| （新）`idx_revision_content` | `revision` | 守門從內容表 join 回 revision 要用 |

**刪掉兩條索引是刻意的**，不是順手。它們沒有讀者，而「機制拿掉還過的就是下一個
死旗標」這條規則對索引同樣成立。哪天真的要做資料庫端的匹配，那個設計會自己
定義它需要什麼索引，屆時再加——現在留著只是每個使用者都付 12% 的體積。

### 2.4 編碼只在持久化邊界轉換

`hashDeclaration` 仍回傳 hex 字串，匹配器仍比字串。hex ↔ Buffer 的轉換只發生在
寫入與讀出的那一層。**雜湊值本身一個位元都沒變**，所以驗收條件是
「解碼後與改動前逐位元相同」，不是「允許有差異」。

### 2.5 舊資料庫怎麼辦

`schema_migration` 表從 v0.5 起就存在，但**從來沒有任何程式讀寫它**。這次啟用它：
建庫時寫入版本，開庫時比對，不符就拋出與剖面版本守門同一種訊息（說出「請刪除
`--db` 指向的檔案後重跑」）。

沒有這道檢查的話，舊資料庫的失敗方式是 `no such column: content_id`——
那個訊息不會告訴任何人原因。

建庫邏輯目前在 `why.ts`／`ostracised.ts`／`materialize.ts` 各抄一份，
順手收斂成一個 `openIndexDatabase`；三份平行實作遲早分岔，而這次要在裡面加檢查。

---

## 3. 不做的事

- **不動 `revision.path`。** 它是冗餘欄位（schema 自己這麼註明），但有查詢在用，
  而且它不是內容衍生的，不屬於這次的題目。
- **不調 `exact_ngram_hashes` 的 200 門檻。** 那會改變召回語意，是拿精確度換空間。
- **不刪 `minhash` 與 `exact_ngram_hashes` 欄位**，雖然實測它們寫進去之後
  **從來沒有被讀出來過**（沒有 `decodeMinhash` / `decodeExact`）。去重之後它們的
  成本從 34 MB 掉到 2.6 MB，已經不值得為了省那一點而移除一個未來可能要用的欄位。
  **這件事寫在這裡是為了讓它可見**：若哪天確認不需要，刪掉是另一個決定。

---

## 4. 驗收

1. `tsc --noEmit` 零錯誤、單元測試全過。
2. **四套 TypeScript 語料 5,222 筆 revision 的雜湊指紋，解碼後與改動前逐位元相同。**
3. 五套黃金測試集逐案例無退步。
4. 前後對照：資料庫體積、索引時間（不得因為多一次雜湊與一次查表而破預算）。
