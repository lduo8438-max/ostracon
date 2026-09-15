import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parallelLineageRisk, parallelLineageRiskNotice } from "../src/git/health.ts";
import { buildLineages } from "../src/git/lineage.ts";
import { persistWalk } from "../src/git/persist.ts";
import type { CommitRecord, FileChangeRecord } from "../src/git/types.ts";
import { INSERT_CONTENT_FIXTURE, REVISION_COLUMNS, revisionValues } from "./db-fixture.ts";

function dbWithParallelBranch(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.exec(`
    INSERT INTO repo (id, root_path, created_at) VALUES (1, '/r', '2026-01-01');
    INSERT INTO path_lineage (id, repo_id) VALUES (1, 1), (2, 1);
    INSERT INTO git_commit
      (id, repo_id, sha, authored_at, committed_at, message, is_merge, topo_order) VALUES
      (1, 1, 'root', '2026-01-01', '2026-01-01', 'add x', 0, 0),
      (2, 1, 'delete-branch', '2026-01-02', '2026-01-02', 'delete x', 0, 1),
      (3, 1, 'modify-sibling', '2026-01-03', '2026-01-03', 'modify x', 0, 2);
    INSERT INTO git_commit_parent (child_id, parent_id, ordinal) VALUES
      (2, 1, 0), (3, 1, 0);
    INSERT INTO file_change (id, commit_id, lineage_id, path, change_type) VALUES
      (1, 1, 1, 'src/x.ts', 'A'),
      (2, 2, 1, 'src/x.ts', 'D'),
      (3, 3, 2, 'src/x.ts', 'M');
    INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind)
      VALUES (1, 1, 2, 'x', 'function');
    INSERT INTO entity (id, repo_id, stable_key, birth_commit_id)
      VALUES (1, 1, '${"a".repeat(64)}', 3);
    ${INSERT_CONTENT_FIXTURE}
    INSERT INTO revision ${REVISION_COLUMNS}
      VALUES ${revisionValues({ id: 1, commitId: 3, lineageId: 2, path: "src/x.ts" })};
    INSERT INTO revision_change (id, next_revision, commit_id, entity_id, change_level)
      VALUES (1, 1, 3, 1, 'birth');
  `);
  return db;
}

test("平行分支的 parent state 分岔可從既有 DB 重算，不依賴本次 index report", () => {
  const db = dbWithParallelBranch();
  assert.deepEqual(parallelLineageRisk(db, 1), {
    complete: false,
    divergences: 1,
    affectedPaths: 1,
    parsedPathDivergences: 1,
    changedEntityRows: 1,
    distinctEntities: 1,
  });
  assert.match(parallelLineageRiskNotice(parallelLineageRisk(db, 1)) ?? "", /平行分支/);
  db.close();
});

test("merge combined diff 的不確定性不冒充平行分支 parent-state 分岔", () => {
  const db = dbWithParallelBranch();
  db.exec(`
    UPDATE git_commit SET is_merge = 1 WHERE id = 3;
    INSERT INTO git_commit_parent (child_id, parent_id, ordinal) VALUES (3, 2, 1);
  `);
  const risk = parallelLineageRisk(db, 1);
  assert.equal(risk.divergences, 0);
  assert.match(parallelLineageRiskNotice(risk) ?? "", /審核/,
    "merge 不得冒充分岔，但未完成的舊索引仍不可宣稱 verified");
  db.close();
});

test("只讀開啟 v3 索引時，沒有 anomaly 表也能回報可重建下限", () => {
  const db = dbWithParallelBranch();
  db.exec("DROP TABLE lineage_anomaly");
  const risk = parallelLineageRisk(db, 1);
  assert.equal(risk.complete, false);
  assert.equal(risk.parsedPathDivergences, 1);
  db.close();
});

test("沒有 lineage_id 而進不了 file_change 的異常仍會被持久保存", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const change = (changeType: FileChangeRecord["changeType"]): FileChangeRecord =>
    ({ changeType, path: "src/x.ts" });
  const commit = (
    sha: string,
    parents: string[],
    topoOrder: number,
    changeType: FileChangeRecord["changeType"],
  ): CommitRecord => ({
    sha,
    parents,
    topoOrder,
    changes: [change(changeType)],
    authorName: "t",
    authorEmail: "t@example.com",
    authoredAt: "2026-01-01T00:00:00Z",
    committedAt: "2026-01-01T00:00:00Z",
    message: sha,
    isMerge: false,
  });
  const commits = [
    commit("root", [], 0, "A"),
    commit("delete-a", ["root"], 1, "D"),
    commit("delete-b", ["root"], 2, "D"),
  ];
  const lineage = buildLineages(commits);
  assert.equal(lineage.anomalies.length, 1);
  persistWalk(db, "/persisted", commits, lineage, {
    structuralWatermark: { sha: "delete-b", indexerVersion: "test" },
    lineageHealthComplete: true,
  });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM file_change").get() as { n: number }).n,
    2,
    "異常刪除沒有 lineage_id，仍然不能假裝它已進 file_change",
  );
  assert.deepEqual(parallelLineageRisk(db, 1), {
    complete: true,
    divergences: 1,
    affectedPaths: 1,
    parsedPathDivergences: 1,
    changedEntityRows: 0,
    distinctEntities: 0,
  });
  db.close();
});
