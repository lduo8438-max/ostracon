import type { DatabaseSync } from "node:sqlite";
import { grammarForPath } from "../ast/languages.ts";
import { buildLineages } from "./lineage.ts";
import { LINEAGE_HEALTH_VERSION } from "./persist.ts";
import type { CommitRecord, FileChangeRecord } from "./types.ts";

/**
 * 已知的平行分支血緣風險。
 *
 * `buildLineages` 目前用一張全域 path → lineage 狀態走拓撲序；非 merge commit 的
 * name-status 卻是相對於它自己的唯一 parent。若這兩者矛盾，代表全域狀態已被另一
 * 條分支改寫。這不是一般的「不規則 git 歷史」：在完整、非 shallow 的索引上，
 * A/M/D/R 對 parent 的語意足以把它判為 parent-state divergence。
 *
 * 這份健康值刻意從已保存的 git_commit/file_change 重算，不讀本次 indexGit report。
 * 否則第一次索引會警告，第二次 no-op 就回到 0，既有匯出更完全看不見風險。
 */
export interface ParallelLineageRisk {
  /** false = 舊索引只存得下可重建的下限；下次全量重建後才會變 true。 */
  complete: boolean;
  /** 非 merge commit 上，全域 path 狀態與該 commit parent 狀態矛盾的事件數。 */
  divergences: number;
  /** 受影響的不重複路徑數。 */
  affectedPaths: number;
  /** 路徑屬於目前支援語言的事件數。 */
  parsedPathDivergences: number;
  /** 已索引資料中，落在這些 commit/path 上且真的改動的 revision_change 列。 */
  changedEntityRows: number;
  /** 上述列涵蓋的不重複 entity。部分索引時這只是已觀察下限。 */
  distinctEntities: number;
}

interface CommitRow {
  id: number;
  sha: string;
  isMerge: number;
  topoOrder: number;
}

interface ChangeRow {
  commitId: number;
  path: string;
  oldPath: string | null;
  changeType: FileChangeRecord["changeType"];
  renameScore: number | null;
}

interface EntityChangeRow {
  id: number;
  sha: string;
  entityId: number;
  prevPath: string | null;
  nextPath: string | null;
}

interface AnomalyRow {
  sha: string;
  path: string;
  reason: string;
}

export function parallelLineageRisk(db: DatabaseSync, repoId: number): ParallelLineageRisk {
  // `ostracon ui` 與 `export` 是刻意只讀的，也允許直接打開 v3 DB。不能要求它們先
  // 寫 migration 才能顯示「這份索引尚未完成新診斷」；表不存在就是最舊、最明確
  // 的 incomplete 狀態。
  const hasSavedAnomalies = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lineage_anomaly'",
  ).get() !== undefined;
  const complete = db.prepare(
    `SELECT 1
       FROM pass_state health
       JOIN pass_state structural
         ON structural.repo_id = health.repo_id
        AND structural.pass_name = 'structural'
        AND structural.last_commit_id = health.last_commit_id
      WHERE health.repo_id = ?
        AND health.pass_name = 'lineage-health'
        AND health.indexer_version = ?`,
  ).get(repoId, LINEAGE_HEALTH_VERSION) !== undefined;
  const saved = hasSavedAnomalies
    ? db.prepare(
      `SELECT c.sha AS sha, a.path AS path, a.reason AS reason
         FROM lineage_anomaly a
         JOIN git_commit c ON c.id = a.commit_id
        WHERE a.repo_id = ? AND c.is_merge = 0`,
    ).all(repoId) as unknown as AnomalyRow[]
    : [];

  let divergences = saved;
  if (!complete) {
    const commitRows = db.prepare(
      `SELECT id, sha, is_merge AS isMerge, topo_order AS topoOrder
         FROM git_commit
        WHERE repo_id = ?
        ORDER BY topo_order, id`,
    ).all(repoId) as unknown as CommitRow[];
    const byId = new Map<number, CommitRecord>();
    const commits: CommitRecord[] = commitRows.map((row) => {
      const commit: CommitRecord = {
        sha: row.sha,
        parents: [],
        authorName: "",
        authorEmail: "",
        authoredAt: "",
        committedAt: "",
        message: "",
        isMerge: Boolean(row.isMerge),
        topoOrder: row.topoOrder,
        changes: [],
      };
      byId.set(row.id, commit);
      return commit;
    });
    const changeRows = db.prepare(
      `SELECT fc.commit_id AS commitId,
              fc.path AS path,
              fc.old_path AS oldPath,
              fc.change_type AS changeType,
              fc.rename_score AS renameScore
         FROM file_change fc
         JOIN git_commit c ON c.id = fc.commit_id
        WHERE c.repo_id = ?
        ORDER BY c.topo_order, fc.id`,
    ).all(repoId) as unknown as ChangeRow[];
    for (const row of changeRows) {
      byId.get(row.commitId)?.changes.push({
        changeType: row.changeType,
        path: row.path,
        ...(row.oldPath === null ? {} : { oldPath: row.oldPath }),
        ...(row.renameScore === null ? {} : { score: row.renameScore }),
      });
    }
    const mergeShas = new Set(commits.filter((commit) => commit.isMerge).map((commit) => commit.sha));
    const replayed = buildLineages(commits).anomalies
      // Combined merge diff 本來就沒有可靠的單一 parent；它的 anomaly 不是本缺陷訊號。
      .filter((anomaly) => !mergeShas.has(anomaly.sha));
    const union = new Map<string, AnomalyRow>();
    for (const anomaly of [...saved, ...replayed]) {
      union.set(`${anomaly.sha}\0${anomaly.path}\0${anomaly.reason}`, anomaly);
    }
    divergences = [...union.values()];
  }
  const affectedPaths = new Set(divergences.map((anomaly) => anomaly.path));
  const parsed = divergences.filter((anomaly) => grammarForPath(anomaly.path) !== undefined);

  if (parsed.length === 0) {
    return {
      complete,
      divergences: divergences.length,
      affectedPaths: affectedPaths.size,
      parsedPathDivergences: 0,
      changedEntityRows: 0,
      distinctEntities: 0,
    };
  }

  // 一次載入再用 key 對齊，避免每個 divergence 都各打一趟同步 SQLite 查詢。
  // prev/next 都收：D 的路徑在 prev，A 在 next，M/R 可能兩端都有。
  const changesByLocation = new Map<string, Set<number>>();
  const entityByChange = new Map<number, number>();
  const entityRows = db.prepare(
    `SELECT rc.id AS id,
            c.sha AS sha,
            rc.entity_id AS entityId,
            prev.path AS prevPath,
            next.path AS nextPath
       FROM revision_change rc
       JOIN git_commit c ON c.id = rc.commit_id
       LEFT JOIN revision prev ON prev.id = rc.prev_revision
       LEFT JOIN revision next ON next.id = rc.next_revision
      WHERE c.repo_id = ? AND rc.change_level <> 'none'`,
  ).all(repoId) as unknown as EntityChangeRow[];
  for (const row of entityRows) {
    entityByChange.set(row.id, row.entityId);
    for (const path of new Set([row.prevPath, row.nextPath])) {
      if (path === null) continue;
      const key = `${row.sha}\0${path}`;
      const ids = changesByLocation.get(key) ?? new Set<number>();
      ids.add(row.id);
      changesByLocation.set(key, ids);
    }
  }

  const riskyChanges = new Set<number>();
  for (const anomaly of parsed) {
    for (const id of changesByLocation.get(`${anomaly.sha}\0${anomaly.path}`) ?? []) {
      riskyChanges.add(id);
    }
  }
  const riskyEntities = new Set(
    [...riskyChanges].flatMap((id) => {
      const entityId = entityByChange.get(id);
      return entityId === undefined ? [] : [entityId];
    }),
  );

  return {
    complete,
    divergences: divergences.length,
    affectedPaths: affectedPaths.size,
    parsedPathDivergences: parsed.length,
    changedEntityRows: riskyChanges.size,
    distinctEntities: riskyEntities.size,
  };
}

export function parallelLineageRiskNotice(risk: ParallelLineageRisk): string | undefined {
  if (risk.complete && risk.parsedPathDivergences === 0) return undefined;
  if (!risk.complete && risk.parsedPathDivergences === 0) {
    return "注意：這份索引建立於 lineage-health 診斷持久化之前；目前未見支援語言路徑分岔，"
      + "但這只是可重建的下限。全量重建後才能完成審核。";
  }
  const observed = risk.changedEntityRows > 0
    ? `；目前索引中有 ${risk.changedEntityRows} 次宣告改動、${risk.distinctEntities} 個 entity 落在這些位置`
    : "";
  const completeness = risk.complete ? "" : "（舊索引可重建下限）";
  return `注意：偵測到 ${risk.parsedPathDivergences} 次支援語言路徑的平行分支狀態分岔${completeness}${observed}。`
    + "目前的全域路徑血緣模型可能把其中一部分歸到錯誤身份；數字是風險範圍，不是假裝已修正的結果。";
}
