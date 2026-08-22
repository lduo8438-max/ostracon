import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { reconcileEntityDeaths } from "../src/index/structural.ts";
import { INSERT_CONTENT_FIXTURE, REVISION_COLUMNS, revisionValues } from "./db-fixture.ts";

/**
 * `entity.death_commit_id` 是**衍生欄位**，真相在 `revision_change` 的 `death` 列。
 *
 * 原本兩個 pass 在寫死亡時就地更新，而且帶著 `AND death_commit_id IS NULL`——
 * 那條件本意是防覆寫，實際效果是**死而復生時死亡點永遠停在第一次**。實測
 * vuejs/core 有 176 個 entity（10.8%）的死亡點早於它自己最後一個 revision，
 * 連帶產生 44 條假的 A 級迂迴。**兩套黃金語料都是 0，所以它活到現在。**
 */

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const commits = [1, 2, 3, 4].map((n) =>
    `(${n}, 1, 'c${n}', '2026-01-0${n}', '2026-01-0${n}', 'm${n}', ${n})`).join(",");
  const rev = (id: number, commit: number) =>
    revisionValues({ id, commitId: commit });
  db.exec(
    `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/r', '2026-01-01');
     INSERT INTO path_lineage (id, repo_id) VALUES (1, 1);
     INSERT INTO git_commit
       (id, repo_id, sha, authored_at, committed_at, message, topo_order)
       VALUES ${commits};
     INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind)
       VALUES (1, 1, 1, 'alpha', 'function');
     INSERT INTO entity (id, repo_id, stable_key, birth_commit_id)
       VALUES (1, 1, 'k1', 1);
     ${INSERT_CONTENT_FIXTURE}
     INSERT INTO revision ${REVISION_COLUMNS}
       VALUES ${rev(1, 1)}, ${rev(3, 3)};`,
  );
  return db;
}

const deathOf = (db: DatabaseSync) =>
  (db.prepare("SELECT death_commit_id AS d FROM entity WHERE id = 1")
    .get() as { d: number | null }).d;

describe("entity 的死亡點依 revision_change 重算", () => {
  it("**死而復生的要回到存活**", () => {
    // 這正是 vuejs/core 上的形狀：死在 topo 2，卻在 topo 3 又有 revision。
    const db = fixture();
    db.exec(
      `INSERT INTO revision_change (id, prev_revision, commit_id, entity_id, change_level)
         VALUES (1, 1, 2, 1, 'death');
       UPDATE entity SET death_commit_id = 2 WHERE id = 1`,
    );
    assert.equal(deathOf(db), 2, "前提：舊寫法把死亡點停在第一次");
    reconcileEntityDeaths(db, 1);
    assert.equal(deathOf(db), null, "topo 3 還有 revision，所以它還活著");
    db.close();
  });

  it("**又死一次時取最後那一次，不是第一次**", () => {
    const db = fixture();
    db.exec(
      `INSERT INTO revision_change (id, prev_revision, commit_id, entity_id, change_level)
         VALUES (1, 1, 2, 1, 'death'), (2, 3, 4, 1, 'death');
       UPDATE entity SET death_commit_id = 2 WHERE id = 1`,
    );
    reconcileEntityDeaths(db, 1);
    assert.equal(deathOf(db), 4, "最後一次死亡才是真的死亡點");
    db.close();
  });

  it("一直活著的不得被標成死亡", () => {
    const db = fixture();
    reconcileEntityDeaths(db, 1);
    assert.equal(deathOf(db), null);
    db.close();
  });

  it("真的死了的照樣記錄", () => {
    const db = fixture();
    db.exec(
      `INSERT INTO revision_change (id, prev_revision, commit_id, entity_id, change_level)
         VALUES (1, 3, 4, 1, 'death')`,
    );
    reconcileEntityDeaths(db, 1);
    assert.equal(deathOf(db), 4);
    db.close();
  });

  it("是冪等的", () => {
    const db = fixture();
    db.exec(
      `INSERT INTO revision_change (id, prev_revision, commit_id, entity_id, change_level)
         VALUES (1, 3, 4, 1, 'death')`,
    );
    reconcileEntityDeaths(db, 1);
    const once = deathOf(db);
    reconcileEntityDeaths(db, 1);
    assert.equal(deathOf(db), once);
    db.close();
  });

  it("只碰指定的 repo", () => {
    const db = fixture();
    db.exec(
      `INSERT INTO repo (id, root_path, created_at) VALUES (2, '/other', '2026-01-01');
       INSERT INTO git_commit
         (id, repo_id, sha, authored_at, committed_at, message, topo_order)
         VALUES (9, 2, 'z9', '2026-01-01', '2026-01-01', 'm', 0);
       INSERT INTO entity (id, repo_id, stable_key, birth_commit_id, death_commit_id)
         VALUES (2, 2, 'k2', 9, 9)`,
    );
    reconcileEntityDeaths(db, 1);
    assert.equal(
      (db.prepare("SELECT death_commit_id AS d FROM entity WHERE id = 2")
        .get() as { d: number | null }).d,
      9,
      "別的 repo 的列不得被動到",
    );
    db.close();
  });
});
