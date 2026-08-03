# 下一步：用 `git cat-file --batch` 取代逐檔 `git show`

狀態：**已完成（2026-07-31）**。

實測結果（Osiris 99 commit，同一 bundled Node、同機前後比較）：

| 指標 | 修改前 | 修改後 |
|---|---:|---:|
| 全 repo 結構 pass | 8,932 ms | **7,168 ms** |
| RSS | 577 MB | 585 MB |
| blob 取檔隔離量測 | 1.83–1.86 s（574 次 `git show`） | **0.307–0.308 s**（90 次 `cat-file`） |

產出維持 revisions 1579 / matches 1272 / crossFileMatches 1 / births 307 /
deaths 130；tier 維持 L1 1162 / L2 46 / L3c 51 / L4 12 / L5 1。
Osiris 與 controlled fixture 的逐案例結果也完全一致。

原先 22 ms 是把全部 spec 近乎全域合批的微基準；正式實作按 commit prefetch，
以有界快取控制記憶體，因此仍有 90 次 git spawn。它省下 1.76 s（19.7%），
但外推一萬 commit 仍約 12.1 分鐘，尚未達到 10 分鐘預算。

---

## 1. 為什麼

全 repo 結構 pass 目前 11.5 s / 99 commit（Osiris），外推一萬 commit 約 20 分鐘，
超出 `roadmap.md` 的 10 分鐘預算約 2 倍。實測的成本分佈：

| 項目 | 耗時 |
|---|---|
| **`git show` 逐檔 spawn** | **2.8 s** |
| tree-sitter 解析 | 1.0 s |
| MinHash（`buildSignature`） | 2.0 s |
| 其餘（SQLite 寫入、匹配、雜湊） | 約 5.7 s |

`git show` 是最大的單一項目，而且成本幾乎全是程序啟動而非 I/O：357 個 spec
要 spawn 357 次 git。

### 已實測的效益

同一組 357 個 spec，同一台機器：

| 做法 | 耗時 |
|---|---|
| 逐一 `git show` | 2432 ms |
| `cat-file --batch`，批次 50 | 65 ms |
| `cat-file --batch`，批次 200 | **22 ms** |
| `cat-file --batch`，批次 1000 | 13 ms |

**約 110 倍。** 批次 200 已經吃到絕大部分效益，再往上邊際報酬很小而記憶體壓力
變大，所以建議 200。

### 但這一步不會讓預算達標

省下約 2.4 s，11.5 s → 約 9.1 s，外推一萬 commit 約 15–16 分鐘，**仍超出 10 分鐘**。
這是最便宜的一步，不是最後一步。剩下的大宗是 MinHash 與 SQLite 寫入，那兩個要
另外設計（例如只對超過門檻的宣告算 MinHash、或把寫入包進單一 transaction）。

先講清楚這件事，是為了避免做完之後以為問題解決了。

---

## 2. 動手前先記基準線

`CLAUDE.md` 要求動效能相關程式碼前後都要有數字。**先跑這三個，把輸出存下來。**

```bash
# 1. 測試與型別
pnpm test

# 2. 黃金測試集（兩個語料都要）
pnpm golden:index -- --repo <osiris-checkout> --fixture fixtures/osiris.yaml --db /tmp/base-a.db
pnpm golden       -- --fixture fixtures/osiris.yaml --db /tmp/base-a.db --report /tmp/base-a.json

pnpm fixtures:controlled -- /tmp/ctrl
pnpm golden:index -- --repo /tmp/ctrl --fixture fixtures/controlled-typescript.yaml --db /tmp/base-b.db
pnpm golden       -- --fixture fixtures/controlled-typescript.yaml --db /tmp/base-b.db --report /tmp/base-b.json
```

**3. 全 repo pass 的效能與產出基準線**：見本文第 5 節的驗證腳本，先跑一次記下
`elapsedMs`、`revisions`、`matches`、`crossFileMatches`、`births`、`deaths`
與 tier 分佈。這幾個數字在優化前後**必須完全相同**——這是純效能改動，
任何一個數字變了就是有 bug。

目前的值（2026-07-28）：

```
elapsedMs ~11500, revisions 1579, matches 1272, crossFileMatches 1,
births 307, deaths 130
tier: L1 1162 / L2 46 / L3c 51 / L4 12 / L5 1
```

---

## 3. `git cat-file --batch` 的協定（已實測確認）

輸入：每行一個 spec（可用 `<sha>:<path>`），從 stdin 送進去。
輸出是**位元組流**，每筆一格：

```
<oid> SP <type> SP <size> LF
<內容，恰好 size 個位元組>
LF
```

物件不存在時，那一筆變成：

```
<原樣的 spec> SP missing LF
```

**沒有內容、也沒有額外的 LF。**

三個必須照做的細節：

1. **用 Buffer 解析，不要先轉字串。** 內容是任意位元組，轉成字串後 `size`
   就對不上（多位元組字元會讓長度不同），整個流會錯位。
2. **讀完 `size` 個位元組後要跳過一個 LF。** 少跳一個，下一筆的 header 就會
   從內容的最後一個位元組開始讀。
3. **`missing` 那一格只前進到換行為止。** 這是最危險的一條：Osiris 就有
   十筆 `missing`（刪除的檔案去問父版本以外的情況）。處理錯了不會報錯，
   而是從那一筆開始**後面每個檔案都拿到別人的內容**——雜湊、匹配、時間軸
   全部靜默錯掉。

參考解析（實測可用）：

```ts
let i = 0;
while (i < out.length) {
  const nl = out.indexOf(0x0a, i);
  const header = out.subarray(i, nl).toString("utf8");
  if (header.endsWith(" missing")) { i = nl + 1; continue; }
  const [oid, type, size] = header.split(" ");
  const start = nl + 1;
  const end = start + Number(size);
  const bytes = out.subarray(start, end);
  i = end + 1;                    // +1 是內容後面那個 LF
}
```

**附帶好處**：header 裡的 `oid` 就是 blob id，可以拿來與 `blobShaOf` 對照，
當成一條免費的自我檢查。

---

## 4. 實作步驟

### 4.1 `src/index/structural.ts`：加一個批次讀取函式

在 `trySourceBytes` 旁邊加：

```ts
export function readBlobsBatch(
  repo: string,
  specs: string[],
): Map<string, Buffer>
```

- 用 `execFileSync("git", ["-C", repo, "cat-file", "--batch"], { input, maxBuffer })`。
  **不需要 spawn／串流**：一次把該批 spec 全送進去，git 寫完就結束，
  `execFileSync` 直接給你整個 Buffer。
- 內部依 `CATFILE_BATCH_SIZE`（建議 200，`export` 出來讓測試可以調）分批，
  形狀比照 `collectHunksForCommits` 的分批寫法。
- `missing` 的 spec **不放進 Map**（缺鍵＝沒有那個版本），呼叫端就能沿用
  現有的 `undefined` 語意。

### 4.2 `createObserver`：加 prefetch

目前的 observer 是拉取式（`observe(commit, path)` 用到才抓）。批次需要先知道要抓
什麼，所以加一個方法：

```ts
export function createObserver(repo: string, limit = OBSERVER_CACHE_LIMIT): {
  observe: (commit: string, pathName: string) => Promise<ObservedDeclaration[]>;
  prefetch: (pairs: Array<[commit: string, pathName: string]>) => void;
}
```

- `prefetch` 過濾掉已在快取的，其餘一次 `readBlobsBatch` 取回，然後把
  **已解析好的 Promise** 塞進同一個快取，讓 `observe` 直接命中。
- 解析（`parseSource` 等）仍在 `observe` 那條路徑上做也可以；重點是省掉 spawn。

**這是介面變更**，`lineage-pass.ts`、`repo-pass.ts`、`materialize.ts` 三個呼叫端
都要改（目前都是 `const observe = createObserver(repo)`）。
改成 `const { observe, prefetch } = createObserver(repo)`。

### 4.3 `src/index/repo-pass.ts`：在觀察前 prefetch

在每個 commit 的 `for (const change of changes)` 迴圈**之前**，先組出這個 commit
需要的全部 `(commit, path)` 對，呼叫一次 `prefetch`：

- next 側：`(commit.sha, change.path)`，除了 `changeType === "D"`
- prev 側：`(parent, parentPath)`，條件與現有的 `hasParentVersion` 一致
  （`!== "A"` 且 `!== "C"`；改名才用 `oldPath`）

**別把這段條件重寫一遍**——現在的 `parentPath` / `hasParentVersion` 邏輯是修過
bug 的（複製 `C` 的目的檔是新血緣、沒有前像版本）。抽成一個小函式讓 prefetch
與觀察共用，避免兩邊漂移。

### 4.4 快取容量

`OBSERVER_CACHE_LIMIT` 目前是 64。一個 commit 若動到超過 32 個 TS 檔，
prefetch 進去的東西會在同一輪就被自己擠掉，變成白做工。

建議：prefetch 時若該批超過上限的一半，就臨時把上限提高到 `2 × 本批數量`，
或直接把上限改成 `max(64, 本批數量 × 2)`。**記得記憶體**：無上限時 Osiris 就吃掉
750 MB，這是實測過的。

---

## 5. 驗證

### 5.1 正確性（必須逐項相同）

```bash
node --experimental-strip-types -e '
const {DatabaseSync}=require("node:sqlite");
const fs=require("node:fs");
Promise.all([
  import("./src/git/index.ts"),
  import("./src/index/repo-pass.ts"),
  import("./src/ast/parser.ts"),
]).then(async ([g,rp,parser])=>{
  const dbPath="/tmp/perf.db"; fs.rmSync(dbPath,{force:true});
  const init=new DatabaseSync(dbPath);
  init.exec(fs.readFileSync("db/schema.sql","utf8")); init.close();
  await parser.verifyParserAdapters();
  const gr=g.indexGit("<osiris-checkout>",
    {dbPath,until:"994a5dcd69385e97cf7d1faa1263e5a51987da6b"});
  const db=new DatabaseSync(dbPath); db.exec("PRAGMA foreign_keys = ON");
  const r=await rp.indexRepoStructure(db,"<osiris-checkout>",gr.repoId,g.INDEXER_VERSION);
  console.log(JSON.stringify(r));
  console.log("RSS MB:",(process.memoryUsage().rss/1048576).toFixed(0));
  console.log("tier:",JSON.stringify(db.prepare(
    "SELECT tier,COUNT(*) n FROM revision_match WHERE accepted=1 GROUP BY tier ORDER BY tier").all()));
  db.close();
});
'
```

`revisions` / `matches` / `crossFileMatches` / `births` / `deaths` 與 tier 分佈
**必須與第 2 節記下的完全一樣**。只有 `elapsedMs` 該變小。

### 5.2 黃金測試集不得退步

重跑第 2 節的四條 golden 指令，然後逐案例比對：

```bash
node -e '
const fs=require("fs");
const a=JSON.parse(fs.readFileSync("/tmp/base-a.json","utf8"));
const b=JSON.parse(fs.readFileSync("/tmp/after-a.json","utf8"));
const ma=new Map((a.cases||[]).map(r=>[r.id,r.status]));
let d=0; for(const r of (b.cases||[])) if(ma.get(r.id)!==r.status){d++;console.log("CHANGED",r.id);}
console.log(d===0?"逐案例一致":d+" 個差異");
'
```

### 5.3 測試

`pnpm test` 全綠、`tsc --noEmit` 零錯誤。**另外要新增的測試**：

1. **`missing` 不會讓流錯位**——這是最危險的失敗模式，必須有測試。
   造一批 spec，中間夾一個不存在的路徑，斷言後面每一個都拿到正確內容。
   （沒有這條測試，錯位會靜默地毀掉所有後續檔案。）
2. **批次邊界**：用 `CATFILE_BATCH_SIZE = 1` 或 2 跑真實 repo，
   結果必須與大批次完全相同。這與 `hunks.test.ts` 裡「分批取 hunk 的結果與
   一次取完完全相同」是同一個套路，可以直接抄形狀。
3. **`readBlobsBatch` 回傳的內容與 `trySourceBytes` 逐一取的相同**，
   包含非 ASCII 與 emoji 檔案。
4. 可選但便宜：斷言 header 的 `oid` 等於 `blobShaOf(bytes)`——兩條獨立路徑
   互相印證。

---

## 6. 完成之後

更新這三處，數字用你實測的：

- `docs/status.md` 的「全 repo 結構 pass 的效能」表與優化清單
- `docs/roadmap.md` 的預算註記（如果仍未達標，**照實寫**）
- 本文件狀態改為完成，並記下新的成本分佈

如果做完發現數字與預期差很多，**先回頭量，不要猜**。我在這個專案上已經猜錯過
一次瓶頸（以為是快取，其實是每筆 revision 一次 `git rev-parse`），量測比推論可靠。
