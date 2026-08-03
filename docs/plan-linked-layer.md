# 下一步：`linked` 層（PR / issue 討論串）

狀態：切片 0–3 已完成（2026-07-31）。

---

## 1. 為什麼，以及先確認值不值得做

`stated` 層在 Osiris 上的理由覆蓋率只有 **4%**（99 則 commit message 只有 4 則
寫了為什麼）。那不是抽取器的問題——原文裡沒有的理由，換成任何模型都變不出來。
唯一能把這個數字提上來的途徑是 PR 與 issue 討論串，那需要網路。

目前已有 **23 條 `reference_link`**（18 條 `closes #N` 高信心、5 條裸參照），
它們就是要去取的清單。

### 動手前先做「切片 0」：確認語料裡真的有東西

**不要先蓋管線。** 花二十分鐘寫一支丟棄式腳本，把那 23 個編號抓下來，數：

- 有幾個真的存在（編號可能指向別的 repo，或根本不是 issue）
- 其中幾個是 PR、幾個是 issue（GitHub 的編號是共用的，目前抽取器一律猜 `issue`，
  這是**已知的錯誤標記**，見第 4 節）
- body 非空的有幾個、字數中位數
- 用現成的 `extractRationale` 跑一遍，看能抽出幾條理由

**如果答案是「23 個裡只有 3 個有實質內容」，整層的價值在動工前就知道了**，
可以決定改抓別的 repo 當語料，或直接跳過這一層。這一步的成本遠低於蓋完才發現。

Osiris 的 origin 是 `https://github.com/simplifaisoul/osiris.git`。
**先確認它是公開的**——如果是私有，別人無法重現你的黃金測試集，那會違反
「fixture 必須可在別台機器重建」的既有約定。

### 切片 0 實測結果（2026-07-31）

Osiris 是公開 repo。釘死的 99 commits 仍產生 23 條、且是 23 個不同編號：

| 指標 | 值 |
|---|---|
| API 確實存在 | 23 / 23 |
| 實際 PR / issue | 5 / 18 |
| body 非空 | 22 / 23 |
| 非空 body 字數中位數 | 401 |
| `extractRationale` 命中的文件 | 13 / 23 |
| 候選 span | 22 |

因此語料價值足以進切片 1；而 5 個 PR 也實證了規則式 `to_kind='issue'` 的錯標。
探測腳本在決策完成後刪除，避免產品樹出現第二個直接 `fetch` 呼叫。

---

## 2. 核心設計問題：網路會破壞可重現性

這個專案目前所有東西都能離線、決定性地跑完。`linked` 層是第一個引入外部相依的
地方，**如果直接在 store 裡呼叫 `fetch`，黃金測試集就再也無法離線重跑**，
CI 也會需要 token。

### 解法：注入式 fetcher + 錄放

照這個專案已經在用的模式（`matchLadder` 吃 `verify` callback、`createObserver`
可注入），定義一個介面而不是直接呼叫網路：

```ts
export interface HttpFetcher {
  (url: string): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
}
```

- **產品路徑**注入 GitHub adapter（用 Node 內建的全域 `fetch`，**零新相依**）。
- **測試路徑**注入 replay fetcher：從 `fixtures/http/` 讀已錄好的回應。
- 另寫一支 `--record` 模式的腳本，把真實回應存成 fixture。
  錄的時候**必須把 token 從 header 濾掉**再寫檔。

`pnpm test` 與兩套 golden 一律走 replay，**永遠不需要網路或 token**。
這是硬條件，不是偏好。

---

## 3. 切片

| # | 狀態 | 範圍 |
|---|---|---|
| 0 | 完成 | 丟棄式探測腳本：量語料值不值得做（見第 1 節） |
| 1 | 完成 | `HttpFetcher` 介面、GitHub adapter、錄放機制、`linked` 文件收進 `source_doc` |
| 2 | 完成 | 對 linked 文件跑抽取器，以 `linked` tier 升格 evidence |
| 3 | 完成 | `why` 時間軸呈現 linked 證據，並依 `provenance_root` 去重 |

每一片都要能獨立通過 `pnpm test` 與兩套 golden。

---

## 4. 切片 1：取回文件

### 4.1 要取什麼

對每一條 `reference_link`（`from_kind='commit'` → `to_kind` issue/pr）：

| 端點 | 產生的 `doc_type` |
|---|---|
| `GET /repos/{owner}/{repo}/issues/{n}` | `issue_body` 或 `pr_body` |
| `GET /repos/{owner}/{repo}/issues/{n}/comments` | `issue_comment` / `pr_comment` |
| `GET /repos/{owner}/{repo}/pulls/{n}/reviews` | `pr_review`（僅 PR） |

**GitHub 的 issue 與 PR 共用同一組編號**，`/issues/{n}` 對 PR 也會回應，
回應裡有 `pull_request` 欄位就代表它是 PR。**這正是修正 `to_kind` 的地方**：
規則式抽取器只看得到 `#105`，一律標成 `issue`；API 回來才知道真相。
修正之後要更新 `reference_link.to_kind`，否則 `provenance_root` 會標錯
（`issue:105` vs `pr:105`），而那是證據去重的鍵。

請對照 GitHub REST API 現行文件確認端點與欄位名，不要照抄這張表。
建議帶 `Accept: application/vnd.github+json` 與 `X-GitHub-Api-Version`。

### 4.2 `source_doc` 的欄位怎麼填

```
doc_type        依上表
provenance_root 'pr:105' 或 'issue:88'   ← 去重的鍵，同一串共用
external_id     全域唯一，建議 'pr:105:body'、'pr:105:comment:12345'
                （UNIQUE 是 (repo_id, doc_type, external_id)，
                 同一個 PR 的多則留言必須有不同的 external_id）
url             留著，UI 要能點回原文
author          留言者
created_at      上游時間
body            **一字不改**，span 位移是對它算的
body_sha256     sha256(body)
```

`ingestCommitMessages` 已經是這個形狀，照它寫。

### 4.3 認證與速率限制

- token 從環境變數讀（`GITHUB_TOKEN`），**絕不寫進資料庫、絕不寫進 fixture**。
- 未認證只有 60 req/hr，實務上不可用；認證後 5000 req/hr。
- 要處理 403/429 與 `retry-after`；GitHub 另有次級速率限制。
- **只對 `repo.origin_url` 解析出來的那一個 repo 發請求。** 不要因為
  commit message 裡出現別的編號就去打別人的 repo。

### 4.4 可恢復

用 `pass_state` 的 `pass_name = 'linked'` 記水位線。網路會失敗，這一層必須
可以中斷後續跑——與 `declarations` pass 同樣的設計，可以直接抄
`repo-pass.ts` 的水位線寫法。

---

## 5. 切片 2：抽取與升格

**大部分工作已經做完了。** `extractRationale` 是純函式，吃 body 吐 span；
`submitCandidates` 已經有完整的驗證與 staging。差別只有一個參數：

```ts
tier: "linked"   // 不是 "stated"
```

`stated` 是「作者在 commit message 裡自己說的」，`linked` 是「透過 issue／PR
關聯推導出來的」。兩者的可信度不同，schema 已經分開，不要混用。

### 這裡是 `revalidateEvidence` 第一次真的有用

commit message 不會變，所以 `body_sha256` 快照到目前為止只是保險。
**PR 與 issue 的內文可以被編輯**——這一層上線之後，`revalidateEvidence`
回報的 stale 數就是真實訊號。記得在切片 2 加一條測試：改掉 `source_doc.body`
之後，對應的 evidence 必須被回報為失效。

### 抽取器可能要調

commit message 是行導向的短文本；PR 描述是 Markdown 長文，有標題、清單、
程式碼區塊、引用他人的區塊。現在的「命中因果標記的那一行」規則在長文上
可能會抓到雜訊（例如程式碼區塊裡的註解、或引用別人說的話）。

**先量再改**：切片 0 的探測腳本就會給你第一批樣本。若精確率明顯下降，
考慮先排除 ``` 圍起來的區塊與 `>` 引用行——但**不要為了覆蓋率放寬因果標記**，
那會讓 `linked` 層從引用退化成摘要。

---

## 6. 切片 3：呈現與去重

不變量 11：**證據獨立性依 `provenance_root` 去重**。同一個 PR 討論串裡三個人
說同一件事，是**一份**證據。

**這是查詢時的事，不是寫入時的事。** 三則留言各自是合法的 `evidence` 列，
照存；呈現層才依 `provenance_root` 收斂。不要在寫入時就丟掉資料——
那會讓「這串裡有幾個人提到」這個資訊永久消失。

`why` 的時間軸目前只查 `doc_type='commit_message'` 且 `tier='stated'`
（見 `src/cli/why.ts` 的 `timelineOf`）。加上 linked 之後：

- 兩種 tier 要**視覺上分得開**：`理由「…」` vs `關聯「…」（PR #105）`
- 同一個 `provenance_root` 只顯示一次，並註明「另有 N 則同串留言」
- commit 與 PR 的關聯是怎麼推出來的（`reference_link.method` 與 `confidence`）
  應該可查——`message_ref` 的 0.4 與 0.9 是不同強度的宣稱

---

## 7. 驗證

每一片都要：

```bash
pnpm test          # 必須零網路、零 token
pnpm typecheck
# 兩套 golden 逐案例比對，見 CLAUDE.md
```

另外針對這一層：

1. **離線硬條件**：把網路關掉跑 `pnpm test`，必須全綠。做不到就是設計錯了。
2. **token 不得外洩**：加一條測試，斷言錄下來的 fixture 檔案裡不含
   `Authorization` header 或任何看起來像 token 的字串。
3. **`external_id` 唯一性**：同一個 PR 的多則留言必須產生不同的 `external_id`，
   否則 UNIQUE 會讓後面的留言被靜默丟掉（`source_doc.external_id` 曾經因為
   可為 NULL 而讓去重完全失效，見 `status.md`，同一個坑不要再踩一次）。
4. **`to_kind` 修正**：測試一個「規則式標成 issue、實際是 PR」的案例，
   斷言修正後 `provenance_root` 是 `pr:N`。
5. **抽取器在 linked 文件上仍不得產出自己的驗證器會拒絕的 span**——
   既有的性質測試要擴充到 Markdown 長文。

---

## 8. 這一層會第一次讓專案有外部相依

寫進 README 的已知限制：

- `stated` 層完全離線；`linked` 層需要網路與 GitHub token。
- 沒有 token 時系統仍應正常運作，只是 `linked` 層是空的——
  **不得因為抓不到 PR 就讓整個索引失敗**。
- GitHub 以外的平台（GitLab、自架）目前不支援，且不在非目標清單上，
  是「還沒做」而不是「不做」。

---

## 9. 給實作者的三個提醒

1. **切片 0 先做完再決定要不要做切片 1。** 這是整份計畫裡最重要的一句話。
2. **`fetch` 只能出現在 adapter 一個檔案裡。** 其他任何地方出現網路呼叫，
   離線測試就守不住了。
3. **零新相依。** Node 內建的全域 `fetch` 夠用；為了 HTTP client 加一個套件
   會違反「不增加執行期相依」的禁令。
