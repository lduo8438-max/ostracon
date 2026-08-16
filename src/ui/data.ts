import type { DatabaseSync } from "node:sqlite";
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
  revisions: number;
  /** 這個 entity 有幾次改動說得出為什麼。稀疏是語料的性質，要能被看見。 */
  withIntent: number;
}

/**
 * 結構欄：這個 repo 裡有歷史可說的宣告。
 *
 * 依「改動次數」排序而不是字母序——使用者打開這個工具是想看演化，
 * 動得最多的東西最可能是他要找的。
 */
export function listEntities(
  db: DatabaseSync,
  repoId: number,
  limit = 400,
): EntityRow[] {
  return db.prepare(
    `SELECT e.id AS entityId, e.stable_key AS stableKey,
            last.path AS path, last.symbol AS symbol,
            COUNT(DISTINCT rc.id) AS revisions,
            COUNT(DISTINCT CASE WHEN cl.id IS NOT NULL THEN rc.id END) AS withIntent
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
       LEFT JOIN v_presentable_claim cl ON cl.revision_change_id = rc.id
      WHERE e.repo_id = ?
      GROUP BY e.id
      ORDER BY revisions DESC, last.path, last.symbol
      LIMIT ?`,
  ).all(repoId, repoId, limit) as unknown as EntityRow[];
}

export interface IntentRow {
  claimType: string;
  text: string;
  tier: string;
  confidence: number;
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
            cl.tier AS tier, cl.confidence AS confidence
       FROM v_presentable_claim cl
       JOIN revision_change rc ON rc.id = cl.revision_change_id
       JOIN git_commit gc ON gc.id = rc.commit_id
      WHERE cl.repo_id = ? AND rc.entity_id = ?
      ORDER BY gc.topo_order, cl.claim_type, cl.id`,
  ).all(repoId, entityId) as unknown as Array<IntentRow & { sha: string }>;

  const byCommit = new Map<string, IntentRow[]>();
  for (const { sha, ...intent } of claims) {
    const bucket = byCommit.get(sha) ?? [];
    // 同一次改動可能被多份文件說中同一件事。逐字重複的沒有新資訊，
    // 但**不同的說法都要留**——證據衝突要並列，不可擇一（不變量 10）。
    if (!bucket.some((existing) => existing.text === intent.text)) bucket.push(intent);
    byCommit.set(sha, bucket);
  }

  return timelineOf(db, entityId).map(({ rationale, ...row }) => ({
    ...row,
    quotes: rationale === null ? [] : rationale.split(RATIONALE_SEPARATOR),
    intent: byCommit.get(row.sha) ?? [],
  }));
}

export interface RepoSummary {
  repoId: number;
  rootPath: string;
  /** 有 claim 的改動數 ／ 全部改動數。**稀疏本身就是要說的事。** */
  changesWithIntent: number;
  changes: number;
}

export function repoSummary(db: DatabaseSync, repoId: number): RepoSummary {
  const row = db.prepare(
    `SELECT r.root_path AS rootPath,
            (SELECT COUNT(*) FROM revision_change rc
               JOIN entity e ON e.id = rc.entity_id WHERE e.repo_id = r.id) AS changes,
            (SELECT COUNT(DISTINCT cl.revision_change_id)
               FROM v_presentable_claim cl WHERE cl.repo_id = r.id) AS changesWithIntent
       FROM repo r WHERE r.id = ?`,
  ).get(repoId) as
    | { rootPath: string; changes: number; changesWithIntent: number }
    | undefined;
  if (row === undefined) throw new Error(`資料庫裡沒有 repo ${repoId}`);
  return { repoId, ...row };
}
