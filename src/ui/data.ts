import type { DatabaseSync } from "node:sqlite";
import {
  unattributableEvidence,
  type UnattributableSummary,
} from "../claim/derive.ts";
import { affectedEntityCounts, scopeOf, type ClaimScope } from "../claim/scope.ts";
import {
  isTestDeclaration,
  listOstracised,
  type OstracisedRow,
} from "../cli/ostracised.ts";
import { touches } from "../match/position.ts";
import {
  readSnippets,
  type Snippet,
  type SnippetRequest,
} from "./snippets.ts";
import { sha256, unwrapQuote } from "../evidence/span.ts";
import { timelineOf, type TimelineRow, RATIONALE_SEPARATOR } from "../cli/why.ts";

/**
 * 三欄 UI 的資料層。**這裡不重寫查詢，只組裝既有的。**
 *
 * 時間軸走 `timelineOf`，相關性抑制走 `suppressUnrelatedRationale`（已經包在
 * 裡面）。另寫一份 SQL 的話，畫面與 `ostracon why` 遲早會對同一個 entity
 * 給出兩種說法——而這個專案已經因為「兩份實作分岔」踩過好幾次。
 */

export interface EntityRow {
  entityId: number;
  stableKey: string;
  path: string;
  symbol: string;
  /**
   * 真正改到這個宣告的次數（`change_level <> 'none'`）。
   *
   * **不含 `none`**：那是「這個檔案動了，但這個宣告沒動」。把它算成改動會讓
   * 數字誇大一個數量級——實測 vuejs/core 的 revision_change 有 88.5% 是 `none`，
   * `ExtractPropTypes` 的 168 列裡有 156 列是。
   */
  revisions: number;
  /** 這個宣告沒動、但所屬檔案動了的次數。時間軸仍會列出來，只是不算改動。 */
  untouched: number;
  /**
   * 有幾次改動有**專屬於這個宣告**的理由（引文只歸給它一個）。
   *
   * 與 `withBatchIntent` 分開數，因為合起來會誇大：實測 vuejs/core 的 722 條
   * 一般 claim 裡有 684 條來自扇出 >1 的引文，最大一條同時歸給 72 個宣告。
   */
  withEntityIntent: number;
  /** 有幾次改動只有整批共用的理由。 */
  withBatchIntent: number;
  /**
   * 這個宣告已經不在了。
   *
   * **這份清單不是「現存的宣告」**——它收的是所有有歷史可說的宣告，已消亡的
   * 也在裡面。實測 vuejs/core 4,000 筆裡有 1,453 筆已消亡，其中 916 筆連
   * 「被推翻的做法」那份名單都不在（C 級疑似、或在測試檔裡）。**只留存活者
   * 會讓那 916 筆兩個名單都到不了**，而它們是 `parseChildren`、`parseTag`
   * 這種實在的歷史。所以不過濾，改成逐列標示。
   */
  dead: boolean;
}

/**
 * 結構欄：這個 repo 裡有歷史可說的宣告。
 *
 * 依「改動次數」排序而不是字母序——使用者打開這個工具是想看演化，
 * 動得最多的東西最可能是他要找的。
 */
export interface ListEntitiesOptions {
  /**
   * 只列出**有意圖可看**的宣告。
   *
   * 預設的「依改動次數排序取前 N 筆」對瀏覽是對的，對匯出卻會反過來挑到雜訊
   * 最多的那一端：實測 vuejs/core 匯出前 400 筆時，門檻是 11 次改動，而
   * `generateCodeFrame`（10 次改動、1 條具體的約束理由、訊噪比最好）**剛好被
   * 擠掉**。demo 的內容不能被一個與內容無關的排序決定。
   */
  onlyWithIntent?: boolean;
}

export function listEntities(
  db: DatabaseSync,
  repoId: number,
  limit = 400,
  options: ListEntitiesOptions = {},
): EntityRow[] {
  return db.prepare(
    `WITH claim_change AS (
       SELECT cl.id AS claim_id, rc.id AS revision_change_id
         FROM v_presentable_claim cl
         JOIN revision_change rc ON rc.id = cl.revision_change_id
        WHERE cl.repo_id = ?
       UNION ALL
       SELECT cl.id AS claim_id, rc.id AS revision_change_id
         FROM v_presentable_claim cl
         JOIN excursion x ON x.id = cl.excursion_id
         JOIN revision_change rc ON rc.entity_id = x.entity_id
                                AND rc.commit_id = x.remove_commit
                                AND rc.change_level = 'death'
        WHERE cl.repo_id = ?
     ),
     -- 一次改動的尺度取它擁有的**最強**證據：只要有一條專屬理由就算 entity 級。
     scoped AS (
       SELECT cc.revision_change_id AS revision_change_id,
              MIN(CASE WHEN affected.n <= 1 THEN 0 ELSE 1 END) AS batch_only
         FROM claim_change cc
         JOIN revision_change rc2 ON rc2.id = cc.revision_change_id
         JOIN (SELECT rc3.commit_id AS commit_id, COUNT(*) AS n
                 FROM revision_change rc3
                WHERE rc3.change_level <> 'none'
                GROUP BY rc3.commit_id) affected
              ON affected.commit_id = rc2.commit_id
        GROUP BY cc.revision_change_id
     )
     SELECT e.id AS entityId, e.stable_key AS stableKey,
            last.path AS path, last.symbol AS symbol,
            COUNT(DISTINCT CASE WHEN rc.change_level <> 'none' THEN rc.id END)
              AS revisions,
            COUNT(DISTINCT CASE WHEN rc.change_level = 'none' THEN rc.id END)
              AS untouched,
            COUNT(DISTINCT CASE WHEN sc.batch_only = 0 THEN rc.id END)
              AS withEntityIntent,
            COUNT(DISTINCT CASE WHEN sc.batch_only = 1 THEN rc.id END)
              AS withBatchIntent,
            (e.death_commit_id IS NOT NULL) AS dead
       FROM entity e
       JOIN revision_change rc ON rc.entity_id = e.id
       JOIN (SELECT r.entity_id AS entity_id, r.path AS path,
                    s.qualified_name AS symbol,
                    row_number() OVER (
                      PARTITION BY r.entity_id ORDER BY r.id DESC
                    ) AS rn
               FROM revision r JOIN slot s ON s.id = r.slot_id
              WHERE r.repo_id = ?) last
            ON last.entity_id = e.id AND last.rn = 1
       LEFT JOIN scoped sc ON sc.revision_change_id = rc.id
      WHERE e.repo_id = ?
      GROUP BY e.id
      ${options.onlyWithIntent === true
        ? "HAVING withEntityIntent > 0 OR withBatchIntent > 0"
        : ""}
      ORDER BY revisions DESC, last.path, last.symbol
      LIMIT ?`,
  ).all(repoId, repoId, repoId, repoId, limit).map((row) => ({
    ...(row as unknown as EntityRow),
    // SQLite 沒有布林；不轉的話畫面會拿到 0 / 1，而 `0` 是 falsy 但
    // `"0"` 不是——這種東西一旦流到樣板裡就會安靜地永遠為真。
    dead: Number((row as { dead: number }).dead) === 1,
  }));
}

/**
 * `stable_key` → rowid。**只在程序內部用**：rowid 是儲存細節，
 * 對外一律用 `stable_key`（不變量 1）。查詢綁 repo——同一把鍵在別的 repo
 * 是別的東西。
 */
export function entityIdForStableKey(
  db: DatabaseSync,
  repoId: number,
  stableKey: string,
): number | undefined {
  const row = db.prepare(
    "SELECT id FROM entity WHERE repo_id = ? AND stable_key = ?",
  ).get(repoId, stableKey) as { id: number } | undefined;
  return row?.id;
}

export interface IntentRow {
  claimType: string;
  text: string;
  tier: string;
  confidence: number;
  /** 非 NULL 代表這不是單次改動的理由，而是整段迂迴的放棄理由。 */
  excursionId: number | null;
  /** `batch` 代表這句話同時被歸給該 commit 的多次改動，不是這個宣告專屬的。 */
  scope: ClaimScope;
  /** 這句話在該 commit 裡總共被歸給幾次改動。 */
  affectedEntities: number;
}

export interface EvolutionRow extends Omit<TimelineRow, "rationale"> {
  /** 這次改動的 hunk 有沒有碰到這個宣告。三態，見 `HunkEvidence`。 */
  hunkEvidence: HunkEvidence;
  /** 這一次改動已驗證的逐字引文，拆成陣列——分隔符是儲存細節，不該外洩。 */
  quotes: string[];
  /** 這一次改動的分型意圖。空陣列是**真實的觀測值**，不是缺資料。 */
  intent: IntentRow[];
}

/**
 * 演化欄 + 意圖欄。**一次查完，因為兩欄必須逐列對齊。**
 *
 * 分兩次查的話，前端得自己把 claim 對回改動，而對齊錯了的後果是把 A 改動的
 * 理由印在 B 底下——那是這個工具最不能犯的錯。
 */
/**
 * 這次改動有沒有真的碰到這個宣告。**三態，不是布林。**
 *
 * - `touched`：這顆 commit 對這個檔案的 hunk 裡，有一個與宣告的行範圍相交。
 * - `untouched`：有 hunk，但沒有一個碰到它——**檔案動了，這段沒動**。
 *   這正是「改動 306 次、其中 62 次完全沒變」那個數字的來源。
 * - `unknown`：這次改動**沒有 hunk 資料**（純改名、二進位、或 git 沒給出
 *   hunk）。它不是「沒碰到」——把不知道說成沒碰到，就是把沒有證據當成
 *   最強的負證據，與 `slot_discontinuity.similarity` 的 NULL／0 同一條規則。
 */
export type HunkEvidence = "touched" | "untouched" | "unknown";

/**
 * 一個 entity 的每一次改動，hunk 有沒有碰到它。
 *
 * **判準用 `touches`，與 matcher 共用同一支函式**——L3c 成立的前提就是
 * 「宣告未被任何 hunk 碰到」，畫面若另寫一份，兩邊遲早給出相反的答案。
 *
 * 一次查完整條時間軸而不是逐列查：306 列就是 306 次查詢，而它們掃的是同一
 * 組索引。`file_change` 的 UNIQUE (commit_id, path) 保證每次改動至多一列。
 */
function hunkEvidenceFor(
  db: DatabaseSync,
  repoId: number,
  entityId: number,
): Map<string, HunkEvidence> {
  const rows = db.prepare(
    `SELECT c.sha AS sha, r.line_start AS lineStart, r.line_end AS lineEnd,
            fh.old_start AS oldStart, fh.old_count AS oldCount,
            fh.new_start AS newStart, fh.new_count AS newCount
       FROM revision r
       JOIN git_commit c ON c.id = r.commit_id
       JOIN file_change fc ON fc.commit_id = r.commit_id AND fc.path = r.path
       LEFT JOIN file_hunk fh ON fh.file_change_id = fc.id
      WHERE r.repo_id = ? AND r.entity_id = ?`,
  ).all(repoId, entityId) as unknown as Array<{
    sha: string;
    lineStart: number;
    lineEnd: number;
    oldStart: number | null;
    oldCount: number | null;
    newStart: number | null;
    newCount: number | null;
  }>;

  const evidence = new Map<string, HunkEvidence>();
  for (const row of rows) {
    if (evidence.get(row.sha) === "touched") continue;
    // LEFT JOIN 的 NULL 代表這次改動一個 hunk 都沒有——那是「不知道」。
    if (row.newStart === null) {
      if (!evidence.has(row.sha)) evidence.set(row.sha, "unknown");
      continue;
    }
    const hit = touches(
      {
        oldStart: row.oldStart!,
        oldCount: row.oldCount!,
        newStart: row.newStart,
        newCount: row.newCount!,
      },
      row.lineStart,
      row.lineEnd,
    );
    evidence.set(row.sha, hit ? "touched" : "untouched");
  }
  return evidence;
}

export function evolutionOf(
  db: DatabaseSync,
  repoId: number,
  entityId: number,
): EvolutionRow[] {
  const claims = db.prepare(
    `SELECT gc.sha AS sha, cl.claim_type AS claimType, cl.text AS text,
            cl.tier AS tier, cl.confidence AS confidence,
            cl.excursion_id AS excursionId
       FROM v_presentable_claim cl
       LEFT JOIN revision_change rc ON rc.id = cl.revision_change_id
       LEFT JOIN excursion x ON x.id = cl.excursion_id
       JOIN git_commit gc ON gc.id = COALESCE(rc.commit_id, x.remove_commit)
      WHERE cl.repo_id = ? AND COALESCE(rc.entity_id, x.entity_id) = ?
      ORDER BY gc.topo_order, cl.claim_type, cl.id`,
  ).all(repoId, entityId) as unknown as Array<
    Omit<IntentRow, "scope" | "affectedEntities"> & { sha: string }
  >;

  // 尺度用共用的那支算，不在這裡另寫一份 SQL。
  const affected = affectedEntityCounts(db, repoId);
  const byCommit = new Map<string, IntentRow[]>();
  // 硬換行收成空白：與 `ostracon why` 用同一支 `unwrapQuote`，兩個介面才不會
  // 對同一條引文長出兩種樣子。儲存層仍然是逐字的。
  for (const { sha, ...raw } of claims) {
    // 放棄理由已由綁定守門保證只歸給一個 entity，不必再看扇出。
    const reach = raw.excursionId === null ? affected.get(sha) ?? 1 : 1;
    const intent: IntentRow = {
      ...raw,
      text: unwrapQuote(raw.text),
      scope: scopeOf(reach),
      affectedEntities: reach,
    };
    const bucket = byCommit.get(sha) ?? [];
    // 同一次改動可能被多份文件說中同一件事。逐字重複的沒有新資訊，
    // 但**不同的說法都要留**——證據衝突要並列，不可擇一（不變量 10）。
    if (!bucket.some((existing) => existing.text === intent.text)) bucket.push(intent);
    byCommit.set(sha, bucket);
  }

  const hunks = hunkEvidenceFor(db, repoId, entityId);
  return timelineOf(db, entityId).map(({ rationale, ...row }) => ({
    ...row,
    quotes: rationale === null
      ? []
      : rationale.split(RATIONALE_SEPARATOR).map(unwrapQuote),
    intent: byCommit.get(row.sha) ?? [],
    hunkEvidence: hunks.get(row.sha) ?? "unknown",
  }));
}

/**
 * 被推翻的做法，畫面版。
 *
 * **與 `ostracon ostracised` 走同一個 `listOstracised` 與同一個
 * `isTestDeclaration`。** 各寫一份的話，landing 上的數字與點進去看到的清單
 * 會是兩個母體——這個專案這一季已經因為「兩份實作分岔」出過三次事
 * （CLI 說 5 顆聚合 commit／畫面說 6 顆、分子分母數不同的東西、
 * 標頭寫 710 而 CLI 顯示 537）。
 */
export interface OstracisedView {
  /**
   * 實際列出的：**A 級確證，且不在測試檔裡**。這才是「被推翻的做法」的產品語意。
   *
   * C 級刻意不進這份清單，也不進頭條數字——它是「僅生命週期符合、未經證實」，
   * 放進頭條就是把疑似當成確證呈現。
   */
  rows: OstracisedRow[];
  /** 被排除的測試檔宣告數。排除不得靜默。 */
  hiddenTests: number;
  /** C 級疑似的數量。報出來，但不混進頭條。 */
  suspected: number;
}

export function ostracisedFor(db: DatabaseSync, repoId: number): OstracisedView {
  const all = listOstracised(db, repoId);
  const confirmed = all.filter((row) => row.strength === "A");
  return {
    rows: confirmed.filter((row) => !isTestDeclaration(row)),
    hiddenTests: confirmed.filter(isTestDeclaration).length,
    suspected: all.length - confirmed.length,
  };
}

export interface RepoSummary {
  repoId: number;
  rootPath: string;
  /**
   * 有**專屬**理由的改動數。**稀疏本身就是要說的事**，而把整批理由算進來
   * 會讓這個數字誇大一個數量級——實測 vuejs/core 是 34 對 508。
   */
  changesWithEntityIntent: number;
  /** 只有整批共用理由的改動數。 */
  changesWithBatchIntent: number;
  /**
   * 真正的改動數。**分子與分母必須數同一種東西**——claim 的相關性判準是
   * `change_level <> 'none'`，分母把 `none` 也算進來的話，那個比例是在比較
   * 兩個不同的母體。實測 vuejs/core 有 88.5% 的列是 `none`，分母因此虛胖九倍。
   */
  changes: number;
  /** 「檔案動了但這個宣告沒動」的列數。時間軸看得到，但不是改動。 */
  untouched: number;
  /**
   * 存在但無法歸因的證據。**沒有這個數字，使用者會把空白讀成「沒有人寫理由」**，
   * 而真相是有人寫了、只是 squash 把「哪句話對應哪次改動」銷毀了。
   *
   * 由 `unattributableEvidence` 提供，與 `deriveClaims` 走同一份候選——畫面
   * 自己數的話會漏掉 `change_level <> 'none'` 那道前置過濾，把相關性抑制造成
   * 的空白也算到 squash 頭上。
   */
  aggregate: UnattributableSummary;
  /**
   * 被推翻的做法的計數。**由 `ostracisedFor` 產生，不是另外數一次**——
   * landing 的頭條數字與清單必須是同一個母體。
   */
  ostracised: { shown: number; hiddenTests: number; suspected: number };
  /**
   * 這份索引的規模。**畫面標頭一定要能標出自己在看哪一套語料**——先前的
   * mock 標題寫 vuejs/core、數字卻是 angular 的，而那種錯只有把數字接回
   * 資料庫才不會再發生。
   */
  counts: { commits: number; revisions: number; entities: number };
  /** `schema_migration` 記的版本。是這個資料庫的實況，不是編譯時的常數。 */
  schemaVersion: number | null;
  /**
   * 改動層級的分佈。`none` 佔 88.5%（vuejs/core 實測）是熱點排序**只算
   * `shape`** 的理由，畫面要講得出這件事就需要分母。
   */
  changeLevels: Record<string, number>;
}

/**
 * 三個可達性契約。**不要再用一句「所有 entity 都查得到」同時描述伺服器、
 * 靜態匯出與 demo**——那句話在三套小語料上剛好成立，在 pypa/pip 上是
 * 400 / 21,409（1.9%），在 playwright 上是 400 / 42,512（0.94%）。
 *
 * | 契約 | 定義 |
 * |---|---|
 * | `indexed` | 資料庫裡存在的全部 entity |
 * | `discoverable` | 能由清單或搜尋找到，**而且知道它有沒有理由** |
 * | `inspectable` | 打得開完整時間軸 |
 */
export interface EntityCoverage {
  indexed: number;
  discoverable: number;
  inspectable: number;
  /** 選取規則。使用者要能判斷「我要的那個為什麼不在」。 */
  rule: string;
  /** 沒被收進來的那些去了哪裡。全部都在時為 `null`。 */
  absentReason: string | null;
}

/**
 * 建一份可達性報告。
 *
 * **`discoverable` 與 `inspectable` 必須由呼叫端提供，沒有預設值。** 只有
 * 決定上限的那一層知道真正的數字：伺服器知道它送出幾筆、匯出知道它寫了幾個
 * 檔案。給一個「等於 indexed」的預設值等於把先前那句假宣稱寫回型別裡。
 */
export function entityCoverage(
  db: DatabaseSync,
  repoId: number,
  served: Omit<EntityCoverage, "indexed">,
): EntityCoverage {
  const indexed = (db.prepare(
    "SELECT COUNT(*) AS n FROM entity WHERE repo_id = ?",
  ).get(repoId) as { n: number }).n;
  // 大於總數只可能是算錯了。**寧可吵，也不要送出一個看起來合理的錯數字。**
  if (served.discoverable > indexed || served.inspectable > indexed) {
    throw new Error(
      `可達性數字大於索引總數：discoverable=${served.discoverable}` +
      ` inspectable=${served.inspectable} indexed=${indexed}`,
    );
  }
  return { indexed, ...served };
}

/**
 * 一條理由，以及它涵蓋的範圍。
 *
 * **扇出是 scope，不是品質。** 一條引文指向 72 個 entity，要表達的是
 * 「這是一條整批理由，涵蓋 72 個 entity」，不是「72 條獨立理由」。先前畫面
 * 逐列顯示，於是同一句話被印 72 次——實測 pip 6,866 列只來自 762 條引文
 * （9.0 倍），playwright 6,982 列只來自 490 條（14.2 倍）。
 *
 * **主鍵是（引文, commit），不是引文本身。** 一句話在兩顆 commit 裡說是兩次
 * 陳述；合併會把甲 commit 的 entity 掛到乙的引文上，而那正是這個專案在防的
 * 歸屬錯誤。代價量過：pip 762 條引文裡只有 8 條出現在多顆 commit（最多 3 顆），
 * playwright 是 0 條——**分開的代價是 9 列，合併的代價是一類錯誤。**
 */
export interface RationaleGroup {
  /** 穩定且可放進網址：`sha256(text + NUL + sha)` 的前 16 個十六進位字元。 */
  quoteId: string;
  /** 已過 `unwrapQuote`。儲存層仍然逐字。 */
  text: string;
  kind: string;
  commitSha: string;
  /** commit 主旨。讀者需要脈絡才判斷得了這句話在講什麼。 */
  subject: string;
  /**
   * `entity` = 只涵蓋一個宣告；`batch` = 涵蓋多個。
   * **由 `entities` 導出**，與 `reach` 同一個陣列——標頭數字與清單分岔在這個
   * 專案已經出過事（CLI 說 5 顆聚合 commit、UI 說 6 顆）。
   */
  scope: ClaimScope;
  /** 涵蓋到的 `stable_key`。**完整清單，不截斷**——折疊是呈現層的事。 */
  entities: string[];
  /** `= entities.length`。不得另算。 */
  reach: number;
}

/**
 * 把可呈現的理由依（引文, commit）分組。
 *
 * 一般 claim 掛在 `revision_change` 上，`abandoned_reason` 掛在 `excursion` 上，
 * 兩者的 entity 與 commit 都要 COALESCE 出來——與 `evolutionOf` 同一套接法。
 */
export function rationaleGroups(
  db: DatabaseSync,
  repoId: number,
): RationaleGroup[] {
  const rows = db.prepare(
    `SELECT cl.text AS text, cl.claim_type AS kind, gc.sha AS sha,
            gc.message AS message, gc.topo_order AS topoOrder,
            e.stable_key AS stableKey
       FROM v_presentable_claim cl
       LEFT JOIN revision_change rc ON rc.id = cl.revision_change_id
       LEFT JOIN excursion x ON x.id = cl.excursion_id
       JOIN git_commit gc ON gc.id = COALESCE(rc.commit_id, x.remove_commit)
       JOIN entity e ON e.id = COALESCE(rc.entity_id, x.entity_id)
      WHERE cl.repo_id = ?
      ORDER BY gc.topo_order, cl.claim_type, e.stable_key`,
  ).all(repoId) as unknown as Array<{
    text: string;
    kind: string;
    sha: string;
    message: string;
    topoOrder: number;
    stableKey: string;
  }>;

  const groups = new Map<string, RationaleGroup & { topoOrder: number }>();
  for (const row of rows) {
    const text = unwrapQuote(row.text);
    const key = `${text}\u0000${row.sha}\u0000${row.kind}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        quoteId: sha256(key).slice(0, 16),
        text,
        kind: row.kind,
        commitSha: row.sha,
        subject: subjectOf(row.message),
        scope: "entity",
        entities: [],
        reach: 0,
        topoOrder: row.topoOrder,
      };
      groups.set(key, group);
    }
    // 同一個 entity 可能被同一顆 commit 的多次改動命中；清單要是集合。
    if (!group.entities.includes(row.stableKey)) group.entities.push(row.stableKey);
  }
  return [...groups.values()]
    .map(({ topoOrder: _topoOrder, ...group }) => ({
      ...group,
      reach: group.entities.length,
      scope: scopeOf(group.entities.length),
    }))
    .sort((a, b) => a.reach - b.reach || a.commitSha.localeCompare(b.commitSha));
}

/** commit 主旨＝第一行。**要同時吃 LF 與 CRLF**，否則 CRLF 語料會留一個尾端 CR。 */
function subjectOf(message: string): string {
  return message.split(/\r?\n/, 1)[0]?.replace(/\r$/, "") ?? "";
}

export function repoSummary(db: DatabaseSync, repoId: number): RepoSummary {
  const row = db.prepare(
    `WITH claim_change AS (
       SELECT rc.id AS revision_change_id
         FROM v_presentable_claim cl
         JOIN revision_change rc ON rc.id = cl.revision_change_id
        WHERE cl.repo_id = ?
       UNION
       SELECT rc.id AS revision_change_id
         FROM v_presentable_claim cl
         JOIN excursion x ON x.id = cl.excursion_id
         JOIN revision_change rc ON rc.entity_id = x.entity_id
                                AND rc.commit_id = x.remove_commit
                                AND rc.change_level = 'death'
        WHERE cl.repo_id = ?
     ),
     scoped AS (
       SELECT cc.revision_change_id AS revision_change_id,
              MIN(CASE WHEN affected.n <= 1 THEN 0 ELSE 1 END) AS batch_only
         FROM claim_change cc
         JOIN revision_change rc2 ON rc2.id = cc.revision_change_id
         JOIN (SELECT rc3.commit_id AS commit_id, COUNT(*) AS n
                 FROM revision_change rc3
                WHERE rc3.change_level <> 'none'
                GROUP BY rc3.commit_id) affected
              ON affected.commit_id = rc2.commit_id
        GROUP BY cc.revision_change_id
     )
     SELECT r.root_path AS rootPath,
            (SELECT COUNT(*) FROM revision_change rc
               JOIN entity e ON e.id = rc.entity_id
              WHERE e.repo_id = r.id AND rc.change_level <> 'none') AS changes,
            (SELECT COUNT(*) FROM revision_change rc
               JOIN entity e ON e.id = rc.entity_id
              WHERE e.repo_id = r.id AND rc.change_level = 'none') AS untouched,
            (SELECT COUNT(*) FROM scoped WHERE batch_only = 0) AS changesWithEntityIntent,
            (SELECT COUNT(*) FROM scoped WHERE batch_only = 1) AS changesWithBatchIntent
       FROM repo r WHERE r.id = ?`,
  ).get(repoId, repoId, repoId) as
    | {
      rootPath: string;
      changes: number;
      untouched: number;
      changesWithEntityIntent: number;
      changesWithBatchIntent: number;
    }
    | undefined;
  if (row === undefined) throw new Error(`資料庫裡沒有 repo ${repoId}`);

  // 規模與層級分佈另外查：它們與上面那段 claim 的 CTE 無關，混進去只會讓
  // 一個本來就要 300 ms 的查詢更難讀，也更難單獨量。
  const rawCounts = db.prepare(
    `SELECT (SELECT COUNT(*) FROM git_commit WHERE repo_id = ?) AS commits,
            (SELECT COUNT(*) FROM revision   WHERE repo_id = ?) AS revisions,
            (SELECT COUNT(*) FROM entity     WHERE repo_id = ?) AS entities`,
  ).get(repoId, repoId, repoId) as
    { commits: number; revisions: number; entities: number };
  // node:sqlite 回的是 null-prototype 物件。JSON 序列化沒差，但直接交出去會讓
  // 呼叫端的 deepEqual 與 instanceof 行為出乎意料，所以在邊界攤成一般物件。
  const counts = {
    commits: rawCounts.commits,
    revisions: rawCounts.revisions,
    entities: rawCounts.entities,
  };

  const changeLevels: Record<string, number> = {};
  for (
    const level of db.prepare(
      `SELECT rc.change_level AS level, COUNT(*) AS n
         FROM revision_change rc
         JOIN entity e ON e.id = rc.entity_id
        WHERE e.repo_id = ?
        GROUP BY rc.change_level`,
    ).all(repoId) as unknown as Array<{ level: string; n: number }>
  ) changeLevels[level.level] = level.n;

  const schemaVersion = (db.prepare(
    "SELECT MAX(version) AS v FROM schema_migration",
  ).get() as { v: number | null } | undefined)?.v ?? null;

  const ostracised = ostracisedFor(db, repoId);
  return {
    repoId,
    ...row,
    counts,
    schemaVersion,
    changeLevels,
    aggregate: unattributableEvidence(db, repoId),
    ostracised: {
      shown: ostracised.rows.length,
      hiddenTests: ostracised.hiddenTests,
      suspected: ostracised.suspected,
    },
  };
}

/**
 * `ambiguity_size > 1` 在不同層代表**不同的事**，所以 payload 自己帶語意。
 *
 * - `unique-by-construction`（L1–L3b）：那幾層的前提就是雙端 bucket 唯一，
 *   不唯一時根本不會接受，所以這個數字必定是 0。
 * - `content-class-size`（L3c）：**內容等價類的大小，不是「曖昧」。**
 *   走到 L3c 恰恰是因為內容 bucket 不唯一，而唯一的是位置——位置錨定把它解掉了。
 * - `tied-candidates`（L4／L5）：接受當下同分且仍可用的前像數，這才是真的曖昧。
 *
 * **一個欄位三種意思，統一叫「ambiguous」會逐字為真而意思相反。** 這個專案
 * 被同型的東西咬過：`版本字串沒有理由改變` 抽出 `理由改變。`——span 斷言通過、
 * 逐字為真、意思相反。
 */
export type AmbiguityMeaning =
  | "unique-by-construction"
  | "content-class-size"
  | "tied-candidates";

/**
 * 匹配階梯的一層。
 *
 * `verified` 只對 L4／L5 有意義，其餘層是 `null` **而不是 0**——L1–L3c 是雜湊
 * 相等或位置錨定，「精確驗證過幾次」對它們不成立，填 0 會被讀成「一次都沒驗證」。
 * 這與 `slot_discontinuity.similarity` 的 NULL／0 是同一條規則：
 * **沒有證據不是最強的負證據。**
 */
export interface LadderTier {
  tier: string;
  accepted: number;
  /** `ambiguity_size > 1` 的筆數。**讀它之前先看 `ambiguityMeaning`。** */
  multiCandidate: number;
  ambiguityMeaning: AmbiguityMeaning;
  /** 靠相似度召回並完成精確驗證的筆數；L1–L3c 不適用。 */
  verified: number | null;
}

/** 一次跨檔案搬移：同一段程式碼在這顆 commit 換了檔案。 */
export interface CrossFileMove {
  stableKey: string;
  symbol: string;
  fromPath: string;
  toPath: string;
  shortSha: string;
  committedAt: string;
  subject: string;
  tier: string;
  exactJaccard: number | null;
  /** 接受這條配對時同分且仍可用的前像數。1 = 唯一。 */
  ambiguitySize: number | null;
}

export interface LadderView {
  tiers: LadderTier[];
  totalAccepted: number;
  /** 跨檔案搬移的總數；`moves` 可能因為上限而較少。 */
  crossFileTotal: number;
  moves: CrossFileMove[];
}

/**
 * 匹配階梯的分佈，以及跨檔案搬移的實際清單。
 *
 * **這是整個工具最無法被取代的一頁。** 實測 vuejs/core：22.7 萬次配對裡
 * L1 17.8 萬、L5 只有 **128**——而那 128 條正是「問答工具描述現況、這個工具
 * 描述演化」的具體證據。它先前只存在資料庫裡，畫面上一個字都沒有。
 *
 * 這是全 repo 的彙總，所以掃全表是對的計畫，不是缺索引
 * （對照 `previousPathEntity`：那條是每次誕生呼叫一次，全表掃描就是缺陷）。
 */
/** 見 `AmbiguityMeaning`：判準寫在 `src/match/ladder.ts` 的 `Match.ambiguitySize`。 */
function ambiguityMeaningOf(tier: string): AmbiguityMeaning {
  if (tier === "L3c") return "content-class-size";
  if (tier === "L4" || tier === "L5") return "tied-candidates";
  return "unique-by-construction";
}

export function ladderStats(
  db: DatabaseSync,
  repoId: number,
  moveLimit = 500,
): LadderView {
  const tiers = db.prepare(
    `SELECT m.tier AS tier,
            COUNT(*) AS accepted,
            SUM(CASE WHEN m.ambiguity_size > 1 THEN 1 ELSE 0 END) AS multiCandidate,
            SUM(m.exact_verified) AS verified
       FROM revision_match m
       JOIN revision r ON r.id = m.next_revision
      WHERE r.repo_id = ? AND m.accepted = 1
      GROUP BY m.tier
      ORDER BY m.tier`,
  ).all(repoId) as unknown as Array<
    { tier: string; accepted: number; multiCandidate: number; verified: number }
  >;

  const moves = db.prepare(
    `SELECT e.stable_key AS stableKey, s.qualified_name AS symbol,
            pr.path AS fromPath, nr.path AS toPath,
            SUBSTR(c.sha, 1, 10) AS shortSha, c.committed_at AS committedAt,
            c.message AS message, m.tier AS tier, m.exact_jaccard AS exactJaccard,
            m.ambiguity_size AS ambiguitySize
       FROM revision_match m
       JOIN revision pr ON pr.id = m.prev_revision
       JOIN revision nr ON nr.id = m.next_revision
       JOIN entity e ON e.id = nr.entity_id
       JOIN slot s ON s.id = nr.slot_id
       JOIN git_commit c ON c.id = nr.commit_id
      WHERE nr.repo_id = ? AND m.accepted = 1 AND m.tier = 'L5'
        AND pr.path <> nr.path
      ORDER BY c.topo_order DESC
      LIMIT ?`,
  ).all(repoId, moveLimit) as unknown as Array<
    Omit<CrossFileMove, "subject"> & { message: string }
  >;

  const crossFileTotal = (db.prepare(
    `SELECT COUNT(*) AS n
       FROM revision_match m
       JOIN revision pr ON pr.id = m.prev_revision
       JOIN revision nr ON nr.id = m.next_revision
      WHERE nr.repo_id = ? AND m.accepted = 1 AND m.tier = 'L5'
        AND pr.path <> nr.path`,
  ).get(repoId) as { n: number }).n;

  return {
    tiers: tiers.map((t) => ({
      tier: t.tier,
      accepted: t.accepted,
      multiCandidate: t.multiCandidate,
      ambiguityMeaning: ambiguityMeaningOf(t.tier),
      // L1–L3c 沒有「驗證過幾次」這回事，見 LadderTier 的註解。
      verified: t.tier === "L4" || t.tier === "L5" ? t.verified : null,
    })),
    totalAccepted: tiers.reduce((sum, t) => sum + t.accepted, 0),
    crossFileTotal,
    moves: moves.map(({ message, ...rest }) => ({
      ...rest,
      subject: message.split("\n", 1)[0] ?? "",
    })),
  };
}

/**
 * 一次身份斷層：同一個 slot，前後兩個 revision 屬於不同的 entity。
 *
 * `similarity` 的 **NULL 與 0 不可混為一談**（schema 的 CHECK 就是為此而寫）：
 * NULL 是「舊內容無法解析，沒有可比較的 token 集合」，0 是「確實比較過、
 * 完全無交集」。前者是沒有證據，後者是最強的負證據。
 */
export interface DiscontinuityRow {
  path: string;
  symbol: string;
  shortSha: string;
  committedAt: string;
  subject: string;
  similarity: number | null;
  prevStableKey: string;
  nextStableKey: string;
  /** 斷層之前那一版的原始碼。索引不存原始碼，這是讀取時從 git blob 切出來的。 */
  before?: Snippet;
  /** 斷層之後那一版。 */
  after?: Snippet;
}

export interface DiscontinuityView {
  total: number;
  /**
   * 片段為什麼在或不在。**抑制不得靜默**——沒有片段時畫面要說得出原因，
   * 而不是留下一塊沒有解釋的空白。
   *
   * - `included`：讀到了。
   * - `not-requested`：匯出時沒有給 `--repo`。
   * - `repo-unavailable`：給了但讀不到（路徑不在、不是 git repo、blob 被 gc）。
   */
  snippets: "included" | "not-requested" | "repo-unavailable";
  /** 其中 `similarity` 為 NULL（無法比較）的筆數。**抑制不能靜默。** */
  incomparable: number;
  rows: DiscontinuityRow[];
}

/**
 * 身份斷層清單。
 *
 * schema 把它稱作「專案最有價值的輸出之一」：**它告訴使用者「斷層以前的討論
 * 與現在無關」**。slot 是「這個位置」的職責連續性，entity 是「這段程式碼」的
 * 血緣，兩者分歧處就是這裡（不變量 2）。實測 vuejs/core 有 421 條。
 *
 * `repoRoot` 給了才讀前後片段。**不給不是錯誤**——靜態匯出可能在沒有語料的
 * 機器上跑——但 payload 一定要說出是哪一種情況。
 */
export function discontinuitiesFor(
  db: DatabaseSync,
  repoId: number,
  limit = 500,
  repoRoot?: string,
): DiscontinuityView {
  const totals = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN d.similarity IS NULL THEN 1 ELSE 0 END) AS incomparable
       FROM slot_discontinuity d
       JOIN entity e ON e.id = d.next_entity
      WHERE e.repo_id = ?`,
  ).get(repoId) as { total: number; incomparable: number };

  const rows = db.prepare(
    // 路徑不在 slot 上（slot 只有 lineage 與限定名稱），而在該 commit 當下的
    // revision 上。`revision` 的 UNIQUE (commit_id, slot_id) 保證這一接恰好一列，
    // 而且拿到的是**斷層發生當下**的路徑，不是現在的路徑——檔案後來再搬走也不會
    // 讓這條紀錄改口。
    `SELECT nr.path AS path, s.qualified_name AS symbol,
            SUBSTR(c.sha, 1, 10) AS shortSha, c.committed_at AS committedAt,
            c.message AS message, d.similarity AS similarity,
            pe.stable_key AS prevStableKey, ne.stable_key AS nextStableKey,
            hex(nr.blob_sha) AS afterBlob, nr.byte_start AS afterStart,
            nr.byte_end AS afterEnd,
            hex(pr.blob_sha) AS beforeBlob, pr.byte_start AS beforeStart,
            pr.byte_end AS beforeEnd
       FROM slot_discontinuity d
       JOIN slot s ON s.id = d.slot_id
       JOIN git_commit c ON c.id = d.commit_id
       JOIN revision nr ON nr.commit_id = d.commit_id AND nr.slot_id = d.slot_id
       -- 斷層「之前」那一版：同一個 slot、topo 序最靠近且更早的那一列。
       -- **不能用 prev_entity 的最後一版**——那個 entity 可能在別的 slot
       -- 繼續活著，取到的就不是這個位置上被換掉的那一段。
       LEFT JOIN revision pr ON pr.id = (
         SELECT r2.id FROM revision r2
           JOIN git_commit c2 ON c2.id = r2.commit_id
          WHERE r2.slot_id = d.slot_id AND c2.topo_order < c.topo_order
          ORDER BY c2.topo_order DESC LIMIT 1
       )
       JOIN entity pe ON pe.id = d.prev_entity
       JOIN entity ne ON ne.id = d.next_entity
      WHERE ne.repo_id = ?
      ORDER BY c.topo_order DESC
      LIMIT ?`,
  ).all(repoId, limit) as unknown as Array<
    Omit<DiscontinuityRow, "subject" | "before" | "after"> & {
      message: string;
      afterBlob: string; afterStart: number; afterEnd: number;
      beforeBlob: string | null; beforeStart: number | null; beforeEnd: number | null;
    }
  >;

  const requests: SnippetRequest[] = [];
  if (repoRoot !== undefined) {
    rows.forEach((row, index) => {
      requests.push({
        id: `a${index}`,
        blobSha: row.afterBlob.toLowerCase(),
        byteStart: row.afterStart,
        byteEnd: row.afterEnd,
      });
      if (row.beforeBlob !== null) {
        requests.push({
          id: `b${index}`,
          blobSha: row.beforeBlob.toLowerCase(),
          byteStart: row.beforeStart!,
          byteEnd: row.beforeEnd!,
        });
      }
    });
  }
  const read = repoRoot === undefined
    ? undefined
    : readSnippets(repoRoot, requests);
  const snippets = read?.snippets ?? new Map<string, Snippet>();

  return {
    total: totals.total,
    incomparable: totals.incomparable ?? 0,
    // **判準是「語料讀不讀得到」，不是「有沒有讀到東西」。** 0 個斷層的語料
    // 沒有任何片段要讀，那不代表讀不到——create-t3-app 實測踩到過。
    snippets: read === undefined
      ? "not-requested"
      : read.readable
        ? "included"
        : "repo-unavailable",
    rows: rows.map((
      { message, afterBlob, afterStart, afterEnd, beforeBlob, beforeStart, beforeEnd, ...rest },
      index,
    ) => {
      const before = snippets.get(`b${index}`);
      const after = snippets.get(`a${index}`);
      return {
        ...rest,
        subject: message.split("\n", 1)[0] ?? "",
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
      };
    }),
  };
}
