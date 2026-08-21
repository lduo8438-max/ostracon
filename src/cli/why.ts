#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verifyParserAdapters } from "../ast/parser.ts";
import { affectedEntityCounts, scopeOf } from "../claim/scope.ts";
import { unwrapQuote } from "../evidence/span.ts";
import { indexGit, INDEXER_VERSION } from "../git/index.ts";
import { repoConsolidationNotice } from "../git/persist.ts";
import { indexLineage } from "../index/lineage-pass.ts";
import { indexRepoStructure, REBUILD_NOTICE } from "../index/repo-pass.ts";
import {
  detectExcursions,
  type ExcursionMethod,
  type ExcursionStrength,
} from "../index/excursion.ts";
import {
  assertNoCrossRepoRows,
  git,
  lineageIdAt,
  lineagesEverAt,
} from "../index/structural.ts";
import {
  extractFromCommitMessages,
  extractFromLinkedDocuments,
  staleEvidenceNotice,
  ingestCommitMessages,
} from "../evidence/store.ts";

/**
 * `why <path>:<symbol>` — 印出一段程式碼的演化史。
 *
 * 這是系統第一個能用眼睛驗證的輸出。測試證明程式碼行為正確，但看不出
 * 「這條時間軸對使用者有沒有意義」，而那是題目層級的訊號。
 *
 * 目前只索引目標檔案所屬的那一條路徑血緣，不是整個 repo。
 */

export interface TimelineRow {
  sha: string;
  shortSha: string;
  committedAt: string;
  authorName: string;
  subject: string;
  changeLevel: string;
  tier: string | null;
  ambiguitySize: number | null;
  path: string;
  lineStart: number;
  lineEnd: number;
  signature: string;
  /** 該版本當下的限定名稱。改名時會變——那正是這個工具要說的事。 */
  symbol: string;
  /**
   * 該 commit 的訊息裡已驗證的理由引文，用 \x1f 分隔。
   *
   * 這是**逐字引用**，不是摘要：每一段都通過了 span 斷言，可以點回原文對位。
   * 沒有就是沒有——多數 commit message 不解釋為什麼，這裡不會替它編一個。
   */
  rationale: string | null;
  /** 同一 provenance_root 在查詢時只留一個代表引用；原始 evidence 列不刪。 */
  linked: LinkedRationale[];
  /**
   * 因為「這個 entity 在這次 commit 沒有變更」而被抑制的參照。
   *
   * **保留指標，不保留引文。** 「這個 commit 提到 PR #123」是關於 commit 的事實，
   * 對導覽有用；但把該 commit 的理由印在一個什麼都沒發生的 entity 底下，
   * 是主動斷言一個不存在的因果。理由見 `suppressUnrelatedRationale`。
   */
  suppressedReferences: LinkedReference[];
  /**
   * 因為同一個原因被抑制的 commit message 引文條數。
   *
   * 與 `suppressedReferences` 分開記，是因為一列可能**只有** stated 理由而沒有任何
   * linked 參照。第一版把 stated 的抑制寫在 SQL 的 WHERE 裡，標頭只數 linked，
   * 於是這種列被靜默丟掉——而「不得靜默丟掉」正是這整個機制的前提。
   */
  suppressedStatedQuotes: number;
  /**
   * 這顆 commit 有幾次相關改動——也就是這一列的引文同時被歸給幾個宣告。
   *
   * `> 1` 代表那句話是**整批改動的共同理由**，不是專講這個宣告的。畫面早就
   * 這樣標了，CLI 沒標的話同一條引文在兩個介面上的份量不一樣——而「兩個介面
   * 對同一件事各說各話」正是這個專案反覆出事的那條線。
   */
  affectedEntities: number;
}

/** `rationale` 欄位裡多段引文的分隔符。SQL 端用 `char(31)` 串接。 */
export const RATIONALE_SEPARATOR = "\u001f";

/** 指向一則討論串，不含任何被當成「理由」讀的文字。 */
export interface LinkedReference {
  provenanceRoot: string;
  kind: "pr" | "issue";
  referenceKey: string;
  method: string;
  confidence: number;
}

export interface LinkedRationale extends LinkedReference {
  quote: string;
  /** 除代表文件外，另有幾份同串文件也產生了有效 evidence。 */
  additionalDocuments: number;
}

/** 一個 entity 的完整時間軸，依拓撲序。熱查詢，靠 idx_change_entity。 */
export function timelineOf(db: DatabaseSync, entityId: number): TimelineRow[] {
  const rows = db.prepare(
    `SELECT c.sha AS sha,
            substr(c.sha, 1, 10) AS shortSha,
            c.committed_at AS committedAt,
            c.author_name  AS authorName,
            -- commit message 的第一行。全文留在 git_commit.message，
            -- 證據層之後要對它做 span 引用，這裡只取標題顯示。
            CASE WHEN instr(c.message, char(10)) > 0
                 THEN substr(c.message, 1, instr(c.message, char(10)) - 1)
                 ELSE c.message END AS subject,
            rc.change_level AS changeLevel,
            m.tier AS tier,
            m.ambiguity_size AS ambiguitySize,
            COALESCE(nr.path, pr.path) AS path,
            COALESCE(nr.line_start, pr.line_start) AS lineStart,
            COALESCE(nr.line_end, pr.line_end) AS lineEnd,
            COALESCE(nr.signature, pr.signature) AS signature,
            COALESCE(ns.qualified_name, ps.qualified_name) AS symbol,
            -- 這裡照實取回。抑制**全部**在 suppressUnrelatedRationale 一個地方做，
            -- 不拆到 SQL：第一版把 stated 的抑制寫成這裡的 WHERE 條件，結果標頭
            -- 只數得到 linked 那一半，只有 stated 理由的列被靜默丟掉
            -- （Osiris 17 列、create-t3-app 3 列）。抑制與「交代抑制了什麼」
            -- 必須由同一段程式碼負責，否則兩者一定會分岔。
            (SELECT group_concat(e.quoted_text, char(31))
               FROM evidence e
               JOIN source_doc d ON d.id = e.source_doc_id
              WHERE d.doc_type = 'commit_message'
                AND d.external_id = c.sha
                AND e.tier = 'stated') AS rationale
       FROM revision_change rc
       JOIN git_commit c ON c.id = rc.commit_id
       LEFT JOIN revision nr ON nr.id = rc.next_revision
       LEFT JOIN revision pr ON pr.id = rc.prev_revision
       LEFT JOIN slot ns ON ns.id = nr.slot_id
       LEFT JOIN slot ps ON ps.id = pr.slot_id
       LEFT JOIN revision_match m
              ON m.prev_revision = rc.prev_revision
             AND m.next_revision = rc.next_revision
             AND m.accepted = 1
      WHERE rc.entity_id = ?
      ORDER BY c.topo_order`,
  ).all(entityId) as unknown as Array<Omit<TimelineRow, "linked">>;

  const linked = db.prepare(
    `WITH ranked_reference AS (
       SELECT c.sha AS commitSha, c.topo_order AS topoOrder, r.repo_id AS repoId,
              r.to_kind AS kind, r.to_key AS referenceKey,
              r.method, r.confidence,
              -- 只依 to_key 分群。GitHub 的 issue 與 PR 共用同一組編號，所以
              -- 編號本身就唯一標定討論串；把 to_kind 一起放進去的話，一列尚未
              -- 修正的 'issue' 與一列已修正的 'pr' 會落在兩個分群，同一個討論串
              -- 就會顯示兩次、其中一次還標錯種類。
              row_number() OVER (
                PARTITION BY r.to_key
                ORDER BY r.confidence DESC, c.topo_order, r.method, r.id
              ) AS referenceRank
         FROM revision_change rc
         JOIN git_commit c ON c.id = rc.commit_id
         JOIN reference_link r ON r.repo_id = c.repo_id
                              AND r.from_kind = 'commit'
                              AND r.from_key = c.sha
        WHERE rc.entity_id = ?
     ),
     linked_evidence AS (
       SELECT rr.commitSha, d.provenance_root AS provenanceRoot,
              e.quoted_text AS quote, d.id AS sourceDocId,
              d.created_at AS createdAt, e.char_start AS charStart,
              e.id AS evidenceId, rr.kind, rr.referenceKey,
              rr.method, rr.confidence
         FROM ranked_reference rr
         JOIN source_doc d ON d.repo_id = rr.repoId
                          AND d.provenance_root = rr.kind || ':' || rr.referenceKey
         JOIN evidence e ON e.source_doc_id = d.id
                        AND e.repo_id = d.repo_id
                        AND e.tier = 'linked'
                        AND e.doc_body_sha = d.body_sha256
        WHERE rr.referenceRank = 1
     ),
     ranked_evidence AS (
       SELECT *,
              row_number() OVER (
                PARTITION BY provenanceRoot
                ORDER BY createdAt IS NULL, createdAt, sourceDocId, charStart, evidenceId
              ) AS evidenceRank
         FROM linked_evidence
     )
     SELECT le.commitSha, le.provenanceRoot, le.quote, le.kind,
            le.referenceKey, le.method, le.confidence,
            (SELECT COUNT(DISTINCT other.sourceDocId) - 1
               FROM linked_evidence other
              WHERE other.provenanceRoot = le.provenanceRoot) AS additionalDocuments
       FROM ranked_evidence le
      WHERE le.evidenceRank = 1
      ORDER BY le.commitSha, le.provenanceRoot`,
  ).all(entityId) as unknown as Array<LinkedRationale & { commitSha: string }>;
  const linkedByCommit = new Map<string, LinkedRationale[]>();
  for (const item of linked) {
    const { commitSha, ...rationale } = item;
    const bucket = linkedByCommit.get(commitSha) ?? [];
    bucket.push(rationale);
    linkedByCommit.set(commitSha, bucket);
  }
  // 尺度用共用的那支算，不在這裡另寫一份 SQL。repoId 由 entity 反查——
  // `timelineOf` 的呼叫端手上不一定有它。
  const repoId = (db.prepare("SELECT repo_id AS r FROM entity WHERE id = ?")
    .get(entityId) as { r: number } | undefined)?.r;
  const affected = repoId === undefined
    ? new Map<string, number>()
    : affectedEntityCounts(db, repoId);
  return rows.map((row) =>
    suppressUnrelatedRationale({
      ...row,
      linked: linkedByCommit.get(row.sha) ?? [],
      suppressedReferences: [],
      suppressedStatedQuotes: 0,
      affectedEntities: affected.get(row.sha) ?? 1,
    })
  );
}

/**
 * 把「這個 entity 在這次 commit 沒有變更」的列上的引文抽掉，只留指標。
 *
 * **為什麼需要這件事**：一次 commit 的理由是關於整次改動的，但時間軸是逐 entity
 * 呈現的。`7fc02862b8` 一次提到 6 個 issue，於是 6 條引文全部掛到一列
 * `無變更 [L1]` 底下——引文逐字為真、issue 編號正確、span 驗證通過，
 * 但那個 entity 在該 commit 什麼都沒發生。
 *
 * demo 語料實測：6,367 次引文顯示裡有 **41.7% 落在 `change_level = 'none'` 的列上**。
 *
 * **為什麼用 `change_level`，而不是 hunk 與行區間相交**：兩者實測幾乎等價
 * （`shape`/`alpha`/`death`/`raw`/`token` 全部 100% 有交集，`none` 有 98.7% 無交集），
 * 而不一致的地方 `change_level` 更精確——那 32 條「`none` 但有交集」是 hunk 觸及了
 * 行區間、但改的是上下文行，實體本身逐字未變。既然現成欄位更準，就不要另外蓋一套
 * 需要處理 merge 無 hunk 與邊界語意的比對邏輯。
 *
 * **方向偏保守：寧可濾掉，不可留錯。** 誤濾的話使用者少看到一條解釋，但參照還在，
 * 他可以自己去讀那個 PR；漏濾的話他會讀到一個關於別段程式碼的理由，而且
 * **沒有任何辦法察覺那是錯的**。與「誤報斷層比漏報嚴重」同一個道理。
 *
 * 在查詢層做而不是寫入層：`evidence` 列是事實（這段文字逐字存在於那份文件），
 * 歸屬是判斷。判斷寫進資料庫等於把門檻烤進儲存資料，而且規則一改就要重建索引。
 */
export function suppressUnrelatedRationale(row: TimelineRow): TimelineRow {
  if (row.changeLevel !== "none") return row;
  return {
    ...row,
    rationale: null,
    linked: [],
    suppressedStatedQuotes: row.rationale === null
      ? 0
      : row.rationale.split(RATIONALE_SEPARATOR).length,
    suppressedReferences: row.linked.map(
      ({ provenanceRoot, kind, referenceKey, method, confidence }) => ({
        provenanceRoot,
        kind,
        referenceKey,
        method,
        confidence,
      }),
    ),
  };
}

/**
 * 找出要說哪一個 entity 的故事。
 *
 * 同名宣告可能有多個 entity（同一個 slot 在歷史上被換過內容）。回傳全部，
 * 由呼叫端決定怎麼呈現——**不得**替使用者挑一個而不說明。
 */
/**
 * 這條血緣上叫這個名字的實體。
 *
 * **`repoId` 是必要的，不是防禦性的多餘參數。** `lineage_id` 全域唯一，但只用它
 * 過濾的話，資料庫裡任何一列指向同一血緣的舊資料都會被算進來——同一段程式碼
 * 於是變成多個實體，輸出印成「slot 延續但內容血緣斷開」。那是**假斷層**，
 * 不變量 2 指名的最嚴重失效模式：它會叫使用者忽略真實歷史。
 *
 * 身分正規化（`canonicalRepoPath`）擋的是「別再產生重複的 repo 列」；這一層
 * 擋的是「已經有重複列的舊資料庫也不能得到錯答案」。兩者都要，因為存下來的
 * 相對路徑無法還原成正規路徑，舊列不保證清得掉。
 */
export function entitiesFor(
  db: DatabaseSync,
  repoId: number,
  lineageId: number,
  symbol: string,
): Array<{ entityId: number; stableKey: string; revisions: number }> {
  return db.prepare(
    `SELECT r.entity_id AS entityId, e.stable_key AS stableKey,
            COUNT(*) AS revisions
       FROM revision r
       JOIN slot   s ON s.id = r.slot_id
       JOIN entity e ON e.id = r.entity_id
      WHERE r.repo_id = ? AND r.lineage_id = ? AND s.qualified_name = ?
      GROUP BY r.entity_id, e.stable_key
      ORDER BY COUNT(*) DESC, e.stable_key`,
  ).all(repoId, lineageId, symbol) as unknown as Array<
    { entityId: number; stableKey: string; revisions: number }
  >;
}

/**
 * 「這個做法是不是被推翻了」的裁決，或「還答不出來」。
 *
 * **`undefined` 與 `needs-full-scan` 是兩件不同的事，不可合併。** 前者是
 * 「掃過整個 repo，這不是迂迴」；後者是「沒掃過，不知道」。把不知道印成
 * 「不是」，就是憑空替使用者排除了一段歷史。
 */
export type ExcursionVerdict =
  | {
    kind: "excursion";
    strength: ExcursionStrength;
    method: ExcursionMethod;
    durationDays: number;
    /**
     * 同名但仍存活的 entity 所在路徑。
     *
     * 搬移守門比對的是內容雜湊，所以「名稱還在、實作被改寫」它抓不到——實測
     * create-t3-app 的 71 條 A 級裡有 11 條（15%）屬於這種。這不是假的
     * 「這段程式碼消失了」，但**使用者會讀成「這個想法被放棄了」**，而那是錯的。
     * 唯一誠實的做法是把仍活著的同名者一併顯示，讓讀者自己看到它還在。
     */
    survivingNamesakes: string[];
  }
  | { kind: "needs-full-scan" };

/** 這個 entity 有沒有被判為迂迴。只有跑過全 repo pass 的資料庫才問得出答案。 */
export function excursionOf(
  db: DatabaseSync,
  repoId: number,
  entityId: number,
  symbol: string,
): ExcursionVerdict | undefined {
  const row = db.prepare(
    `SELECT strength, method, duration_days AS durationDays
       FROM excursion WHERE entity_id = ? LIMIT 1`,
  ).get(entityId) as
    | { strength: ExcursionStrength; method: ExcursionMethod; durationDays: number }
    | undefined;
  if (row === undefined) return undefined;

  const namesakes = db.prepare(
    `SELECT DISTINCT r.path AS path
       FROM entity e
       JOIN revision r ON r.entity_id = e.id
       JOIN slot s ON s.id = r.slot_id
      WHERE e.repo_id = ? AND e.death_commit_id IS NULL
        AND e.id <> ? AND s.qualified_name = ?
      ORDER BY r.path`,
  ).all(repoId, entityId, symbol) as unknown as Array<{ path: string }>;

  return {
    kind: "excursion",
    ...row,
    survivingNamesakes: namesakes.map((n) => n.path),
  };
}

/** 判定依據要說人話——使用者不必懂 `method` 這個欄位就該看得懂為什麼。 */
const METHOD_LABEL: Record<ExcursionMethod, string> = {
  git_revert: "移除它的那次 commit 本身就是 revert",
  inverse_diff: "移除掉的內容與當初加入的逐字相同",
  short_lifecycle: "只被觀測到一次就消失，沒有任何反向證據",
  trajectory: "改過幾次之後才被整段移除，沒有反向證據",
};

/** 同名存活者最多列幾個。超過只給總數——長列表是雜訊不是證據。 */
const NAMESAKE_LIMIT = 3;

const LEVEL_LABEL: Record<string, string> = {
  birth: "誕生",
  death: "消亡",
  none: "無變更",
  raw: "格式／註解",
  token: "局部變數改名",
  alpha: "字面量或呼叫目標",
  shape: "結構重構",
};

/** 純函式：把時間軸轉成可讀文字。不碰資料庫，方便測試。 */
export function renderTimeline(
  target: { path: string; symbol: string; stableKey: string },
  rows: TimelineRow[],
  verdict?: ExcursionVerdict,
): string {
  const out: string[] = [];
  const first = rows[0];
  const last = rows[rows.length - 1];
  out.push(`${target.path}:${first?.symbol ?? target.symbol}`);
  out.push(`entity ${target.stableKey.slice(0, 12)}　共 ${rows.length} 次改動`);
  if (last && first && last.symbol !== first.symbol) {
    // 改名是這個工具的核心賣點之一，不能只在某一行悄悄變掉。
    out.push(`現在叫 ${last.symbol}`);
  }
  // 被抑制的引文要有交代。**靜默丟掉與靜默誤植同樣不誠實**——前者讓使用者以為
  // 沒有理由可查，而其實有。只放在標頭不逐列印：長時間軸本來就已經被
  // `[L1] 無變更` 淹沒，每列再加一行會讓真正有內容的列更難找。
  const suppressedCommits = rows.filter(
    (r) => r.suppressedReferences.length > 0 || r.suppressedStatedQuotes > 0,
  );
  if (suppressedCommits.length > 0) {
    const roots = new Set(
      suppressedCommits.flatMap((r) => r.suppressedReferences.map((s) => s.provenanceRoot)),
    );
    const statedCount = suppressedCommits.reduce((n, r) => n + r.suppressedStatedQuotes, 0);
    // 兩種來源分開講。只講其中一種的話，另一種就變成靜默丟掉——
    // 而第一版正是只數了 linked，讓「只有 commit message 理由」的列無聲消失。
    const parts = [
      roots.size > 0 ? `${roots.size} 則 PR／issue` : "",
      statedCount > 0 ? `${statedCount} 段 commit message 理由` : "",
    ].filter((p) => p !== "");
    out.push(
      `另有 ${suppressedCommits.length} 次改動的 commit 帶著 ${parts.join(" 與 ")}，`
        + "但沒有修改到這個實體——它們的理由不會掛在下面的時間軸上。",
    );
  }
  // 「這個做法被推翻了」放在標頭而不是埋在最後一列：它是關於整段歷史的結論，
  // 而且是使用者來問 why 最想知道的那件事（ostracised approaches 是專案的命名由來）。
  if (verdict?.kind === "excursion") {
    const days = verdict.durationDays.toFixed(1);
    // A 是結構上可獨立驗證的確證，可以直述；C 只有生命週期符合，
    // **必須標「疑似」**，不得作為結論陳述（architecture.md §5）。
    out.push(
      verdict.strength === "A"
        ? `這個做法被推翻了：存活 ${days} 天後整段移除`
        : `疑似被推翻：存活 ${days} 天後整段移除（僅結構符合，未經證實）`,
    );
    out.push(`　　依據：${METHOD_LABEL[verdict.method]}（${verdict.strength} 級）`);
    // 「實作被換掉」與「概念被放棄」是兩件事，讀錯的代價是相信一段沒發生的歷史。
    //
    // **這是純名稱比對，不是語意判定。** `createInnerTRPCContext` 這種名字命中的
    // 確實是同一個概念，但 `Home`／`Options` 這種泛用名字會撈到毫不相干的宣告
    // （create-t3-app 實測 `Home` 有 39 個同名存活者）。所以措辭一律是「不必然」，
    // 而且**只列前三個**——39 條路徑不是資訊，是雜訊。
    const namesakes = verdict.survivingNamesakes;
    if (namesakes.length > 0) {
      const shown = namesakes.slice(0, NAMESAKE_LIMIT).join("、");
      const rest = namesakes.length > NAMESAKE_LIMIT
        ? `等 ${namesakes.length} 處`
        : "";
      out.push(
        `　　但同名的 ${target.symbol} 目前仍存在於 ${shown}${rest}`
          + "——被換掉的是這個實作，不必然是這個想法。",
      );
    }
  } else if (verdict?.kind === "needs-full-scan") {
    // 沉默會被讀成「不是迂迴」。說不知道比讓使用者自己誤會誠實。
    out.push(
      "這段程式碼已消失，但還無法判斷是被推翻還是搬到別處——"
        + "加 --full 重跑，搬移守門必須看得到整個 repo 才能分辨。",
    );
  }
  out.push("");
  let shownSymbol = first?.symbol;
  for (const row of rows) {
    const level = LEVEL_LABEL[row.changeLevel] ?? row.changeLevel;
    // tier 是「為什麼系統認為這兩個版本是同一個東西」的判定依據。
    // 這是產品信譽的來源，必須印出來而不是藏起來。
    const why = row.tier === null
      ? ""
      : `　[${row.tier}${
        row.ambiguitySize !== null && row.ambiguitySize > 1
          ? `，${row.ambiguitySize} 個等價候選`
          : ""
      }]`;
    out.push(`${row.shortSha}  ${row.committedAt.slice(0, 10)}  ${level}${why}`);
    out.push(`            ${row.subject}`);
    // 已驗證的逐字引用。前綴用「理由」而不是把它混進 subject，
    // 是為了讓「作者說的」與「我們整理的」在視覺上就分得開。
    // 整批理由要標出來。畫面標了而這裡沒標的話，同一條引文在兩個介面上
    // 的份量不一樣——那是這個專案反覆出事的那條線。
    const batch = scopeOf(row.affectedEntities) === "batch"
      ? `（整批：這次 commit 同時改了 ${row.affectedEntities} 處）`
      : "";
    for (const quote of row.rationale ? row.rationale.split(RATIONALE_SEPARATOR) : []) {
      // 跨行的引文在儲存層是逐字的；印成一行時硬換行要收掉，否則版面撐斷。
      out.push(`            理由「${unwrapQuote(quote)}」${batch}`);
    }
    for (const linked of row.linked) {
      const source = linked.kind === "pr"
        ? `PR #${linked.referenceKey}`
        : `issue #${linked.referenceKey}`;
      const additional = linked.additionalDocuments > 0
        ? `；另有 ${linked.additionalDocuments} 則同串留言`
        : "";
      out.push(
        `            關聯「${unwrapQuote(linked.quote)}」`
          + `（${source}；${linked.method} ${linked.confidence.toFixed(1)}${additional}）`,
      );
    }
    if (row.symbol !== shownSymbol) {
      out.push(`            改名：${shownSymbol} → ${row.symbol}`);
      shownSymbol = row.symbol;
    }
    out.push(`            ${row.path}:${row.lineStart}-${row.lineEnd}`);
    out.push("");
  }
  if (rows.length === 0) {
    out.push("（沒有找到任何改動——這個符號可能從未被索引到）");
  }
  return out.join("\n");
}

function parseTarget(raw: string): { path: string; symbol: string } {
  const at = raw.lastIndexOf(":");
  if (at <= 0 || at === raw.length - 1) {
    throw new Error(`無法解析目標 ${raw}；格式應為 <path>:<symbol>`);
  }
  return { path: raw.slice(0, at), symbol: raw.slice(at + 1) };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export interface WhyOptions {
  /**
   * 索引整個 repo 而不是只索引目標檔案的血緣。
   *
   * 差別是**能力**不是效能：跨檔案的搬移與抽取（L5）只有在候選池涵蓋一次改動的
   * 所有檔案時才可能被看見。單一血緣的快路徑對「這個函式在這個檔案裡怎麼演化」
   * 已經夠用，代價是搬進來的程式碼會看起來像憑空誕生。
   */
  full?: boolean;
}

export async function why(
  repo: string,
  targetRaw: string,
  dbPath: string,
  until: string,
  options: WhyOptions = {},
): Promise<string> {
  const target = parseTarget(targetRaw);

  if (!existsSync(dbPath)) {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const schema = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
    const init = new DatabaseSync(dbPath);
    init.exec(schema);
    init.close();
  }

  await verifyParserAdapters();
  const gitReport = indexGit(repo, { dbPath, until });
  // until 可能是 HEAD、分支名或 tag，但資料庫裡的座標一律是 sha。
  const untilSha = git(repo, ["rev-parse", `${until}^{commit}`]);

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    // 先問「此刻誰擁有這個路徑」；檔案已被刪除時才回頭問「以前誰擁有過」。
    // 順序不能反過來——路徑還活著時 `lineageIdAt` 才是正確答案。
    const current = lineageIdAt(db, gitReport.repoId, untilSha, target.path);
    const lineageIds = current !== undefined
      ? [current]
      : lineagesEverAt(db, gitReport.repoId, untilSha, target.path);
    const resurrected = current === undefined && lineageIds.length > 1;
    if (lineageIds.length === 0) {
      throw new Error(
        `在 ${until} 找不到路徑 ${target.path} 的血緣。`
        + "路徑要相對 repo 根目錄，且該檔案必須在索引範圍內存在過。",
      );
    }

    let rebuilt = false;
    if (options.full) {
      // 這個資料庫如果是快路徑建的，全 repo pass 會先把結構層作廢重建——否則
      // 它算出來的跨檔案配對會撞上既有的 revision 列而被丟掉，`--full` 就成了
      // 靜默無效（實測：Osiris 的 isRateLimited 仍只顯示搬移後的 1 次改動）。
      rebuilt = (await indexRepoStructure(db, repo, gitReport.repoId, INDEXER_VERSION))
        .mode === "rebuilt";
      // 迂迴偵測**只在全 repo 索引之後跑**。搬移守門的判準是「這段內容是不是還
      // 存在於別的 entity 上」，候選池只有一條血緣時它看不到別的檔案，會把搬移
      // 通通判成迂迴——create-t3-app 實測那是 41% 的候選。
      // 水位線 `pass_name='excursion'` 與 `declarations` 分開，重跑會自行跳過。
      detectExcursions(db, gitReport.repoId, { scope: "repo" });
    } else {
      // 路徑重建過的話每一條血緣都要索引，否則較早那一段會查不到 revision。
      for (const id of lineageIds) {
        await indexLineage(db, repo, gitReport.repoId, id, INDEXER_VERSION);
      }
    }
    // 寫入端的不變式：這個 repo 的列不得指向別的 repo 的 commit。共用歷史的
    // repo（上游與 fork、clone、worktree）落進同一個資料庫時，以 sha 為鍵而
    // 不綁 repo 的查詢會靜默挑錯——那類汙染是潛伏的，輸出還是對的，所以只能
    // 在這裡擋，不能等某個查詢開始說謊。
    assertNoCrossRepoRows(db, gitReport.repoId);

    // 證據層：零網路、零 LLM。commit message 已經在資料庫裡，規則式抽取器只挑
    // 有明確理由標記的行，全部通過 span 斷言才會出現在時間軸上。
    ingestCommitMessages(db, gitReport.repoId);
    const stated = extractFromCommitMessages(db, gitReport.repoId);
    const linked = extractFromLinkedDocuments(db, gitReport.repoId);
    const staleEvidence = stated.discarded.evidence + linked.discarded.evidence;

    // 多條血緣時合併，但同一個 entity 可能橫跨數條（跨檔案搬移），必須去重。
    // 排序在合併之後重做一次，否則輸出順序會隨血緣的列舉順序漂移。
    const byEntity = new Map<number, ReturnType<typeof entitiesFor>[number]>();
    for (const id of lineageIds) {
      for (const entity of entitiesFor(db, gitReport.repoId, id, target.symbol)) {
        const seen = byEntity.get(entity.entityId);
        if (seen === undefined || entity.revisions > seen.revisions) {
          byEntity.set(entity.entityId, entity);
        }
      }
    }
    const entities = [...byEntity.values()].sort((a, b) =>
      b.revisions - a.revisions || a.stableKey.localeCompare(b.stableKey)
    );
    if (entities.length === 0) {
      return `${target.path}:${target.symbol}\n（這條血緣裡沒有這個符號）`;
    }

    const shownProvenanceRoots = new Set<string>();
    const sections = entities.map((entity) => {
      const rows = timelineOf(db, entity.entityId);
      for (const row of rows) {
        row.linked = row.linked.filter((linked) => {
          if (shownProvenanceRoots.has(linked.provenanceRoot)) return false;
          shownProvenanceRoots.add(linked.provenanceRoot);
          return true;
        });
      }
      // 沒跑全 repo 就答不出迂迴，但也不能沉默——沉默會被讀成「不是迂迴」。
      const verdict = options.full
        ? excursionOf(db, gitReport.repoId, entity.entityId, target.symbol)
        : rows[rows.length - 1]?.changeLevel === "death"
          ? ({ kind: "needs-full-scan" } as const)
          : undefined;
      return renderTimeline(
        { path: target.path, symbol: target.symbol, stableKey: entity.stableKey },
        rows,
        verdict,
      );
    });
    const notes: string[] = [];
    if (gitReport.consolidation.absorbed.length > 0) {
      // 合併掉使用者資料庫裡的列必須說出來，而且要說是哪幾條。
      notes.push(repoConsolidationNotice(gitReport.consolidation));
    }
    if (rebuilt) {
      // 丟掉使用者既有的索引是一件必須說出來的事，即使那份索引本來就答不出
      // 他現在問的問題。沉默會讓「為什麼這次跑比較久」變成一個謎。
      notes.push(REBUILD_NOTICE);
    }
    if (staleEvidence > 0) {
      // 同上：引文是舊版抽取器產生的，這次已重抽。不說的話，使用者會以為
      // 時間軸上少掉的那幾條引文是資料掉了。
      notes.push(staleEvidenceNotice(staleEvidence));
    }
    if (current === undefined) {
      // 使用者問的是一個在終點已經不存在的路徑。不說的話，時間軸看起來會像
      // 「這個檔案還在，只是最近沒動過」——那是完全相反的意思。
      notes.push(
        `注意：${target.path} 在 ${until} 已經不存在，以下是它消失前的歷史。`,
      );
    }
    if (resurrected) {
      // 路徑被刪除後又重建。挑最近那一條會讓更早的整段歷史靜默消失。
      notes.push(
        `這個路徑在歷史上被 ${lineageIds.length} 條血緣先後佔用過`
          + "（刪除後又重建）。以下把每一條都列出來，不替你挑一條。",
      );
    }
    // 同名多實體時全部列出並說明，不替使用者挑一個。
    if (entities.length > 1) {
      notes.push(
        `${target.symbol} 在這個檔案的歷史上有 ${entities.length} 個不同的實體`
          + `（slot 延續但內容血緣斷開）。以下依改動次數排序全部列出。`,
      );
    }
    const header = notes.length > 0 ? `${notes.join("\n")}\n\n` : "";
    return header + sections.join("\n");
  } finally {
    db.close();
  }
}

export async function main(args: string[]): Promise<void> {
  const target = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--repo"
    && args[args.indexOf(a) - 1] !== "--db" && args[args.indexOf(a) - 1] !== "--until");
  const repo = valueAfter(args, "--repo") ?? process.cwd();
  const dbPath = valueAfter(args, "--db") ?? ".ostracon/index.db";
  const until = valueAfter(args, "--until") ?? "HEAD";
  if (!target) {
    console.error(
      "用法：ostracon why <path>:<symbol> [--repo <path>] [--db <file>] [--until <sha>] [--full]\n"
      + "  --full  索引整個 repo，跨檔案的搬移與抽取才看得見（慢很多）",
    );
    process.exitCode = 2;
    return;
  }
  console.log(await why(repo, target, dbPath, until, { full: args.includes("--full") }));
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main(process.argv.slice(2));
}
