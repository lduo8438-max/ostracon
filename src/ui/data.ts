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
import { unwrapQuote } from "../evidence/span.ts";
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
              AS withBatchIntent
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
  ).all(repoId, repoId, repoId, repoId, limit) as unknown as EntityRow[];
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

  return timelineOf(db, entityId).map(({ rationale, ...row }) => ({
    ...row,
    quotes: rationale === null
      ? []
      : rationale.split(RATIONALE_SEPARATOR).map(unwrapQuote),
    intent: byCommit.get(row.sha) ?? [],
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
  const ostracised = ostracisedFor(db, repoId);
  return {
    repoId,
    ...row,
    aggregate: unattributableEvidence(db, repoId),
    ostracised: {
      shown: ostracised.rows.length,
      hiddenTests: ostracised.hiddenTests,
      suspected: ostracised.suspected,
    },
  };
}
