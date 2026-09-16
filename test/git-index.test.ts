import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  attachHunks,
  buildLineages,
  collectHunksForCommits,
  indexGit,
  INDEXER_VERSION,
  indexerVersion,
  openDb,
  persistWalk,
  walkCommits,
} from "../src/git/index.ts";
import { lineageIdAt, recreatedPathPredecessor } from "../src/index/structural.ts";

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE repo (
    id INTEGER PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, origin_url TEXT,
    default_branch TEXT, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE git_commit (
    id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repo(id),
    sha TEXT NOT NULL, author_name TEXT, author_email TEXT, authored_at TEXT NOT NULL,
    committed_at TEXT NOT NULL, message TEXT NOT NULL, is_merge INTEGER NOT NULL,
    topo_order INTEGER, UNIQUE (repo_id, sha)
  ) STRICT;
  CREATE TABLE git_commit_parent (
    child_id INTEGER NOT NULL REFERENCES git_commit(id),
    parent_id INTEGER NOT NULL REFERENCES git_commit(id), ordinal INTEGER NOT NULL,
    PRIMARY KEY (child_id, ordinal)
  ) STRICT;
  CREATE TABLE pass_state (
    repo_id INTEGER NOT NULL REFERENCES repo(id), pass_name TEXT NOT NULL,
    last_commit_id INTEGER REFERENCES git_commit(id), indexer_version TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (repo_id, pass_name)
  ) STRICT;
  CREATE TABLE path_lineage (
    id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repo(id)
  ) STRICT;
  CREATE TABLE path_lineage_segment (
    lineage_id INTEGER NOT NULL REFERENCES path_lineage(id), path TEXT NOT NULL,
    from_commit_id INTEGER NOT NULL REFERENCES git_commit(id),
    to_commit_id INTEGER REFERENCES git_commit(id),
    PRIMARY KEY (lineage_id, from_commit_id)
  ) STRICT;
  CREATE INDEX idx_segment_open ON path_lineage_segment(lineage_id)
    WHERE to_commit_id IS NULL;
  CREATE TABLE path_lineage_event (
    repo_id INTEGER NOT NULL REFERENCES repo(id),
    commit_id INTEGER NOT NULL REFERENCES git_commit(id),
    path TEXT NOT NULL,
    lineage_id INTEGER REFERENCES path_lineage(id),
    PRIMARY KEY (repo_id, commit_id, path)
  ) STRICT;
  CREATE TABLE file_change (
    id INTEGER PRIMARY KEY, commit_id INTEGER NOT NULL REFERENCES git_commit(id),
    lineage_id INTEGER NOT NULL REFERENCES path_lineage(id), path TEXT NOT NULL,
    old_path TEXT, change_type TEXT NOT NULL, rename_score INTEGER, blob_sha TEXT,
    UNIQUE (commit_id, path)
  ) STRICT;
  CREATE TABLE lineage_anomaly (
    repo_id INTEGER NOT NULL REFERENCES repo(id),
    commit_id INTEGER NOT NULL REFERENCES git_commit(id),
    path TEXT NOT NULL, reason TEXT NOT NULL,
    PRIMARY KEY (repo_id, commit_id, path, reason)
  ) STRICT;
  CREATE TABLE file_hunk (
    file_change_id INTEGER NOT NULL REFERENCES file_change(id) ON DELETE CASCADE,
    hunk_index INTEGER NOT NULL, old_start INTEGER NOT NULL, old_count INTEGER NOT NULL,
    new_start INTEGER NOT NULL, new_count INTEGER NOT NULL,
    PRIMARY KEY (file_change_id, hunk_index)
  ) STRICT, WITHOUT ROWID;
`;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function write(repo: string, relative: string, content: string): void {
  const target = path.join(repo, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commit(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

function makeRepo(file = "a.ts"): string {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-indexer-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Ostracon Tests");
  git(repo, "config", "user.email", "tests@ostracon.dev");
  write(repo, file, "one\n");
  commit(repo, "first");
  return repo;
}

function makeDb(): string {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-index-db-")), "index.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  db.close();
  return dbPath;
}

test("兩個 repo 的 lineage 主鍵不碰撞，也不會跨 repo 引用", () => {
  const dbPath = makeDb();
  const first = makeRepo("a.ts");
  const second = makeRepo("b.ts");
  indexGit(first, { dbPath });
  indexGit(second, { dbPath });

  const db = new DatabaseSync(dbPath);
  const mismatches = db.prepare(
    `SELECT COUNT(*) AS n
       FROM file_change f
       JOIN git_commit c ON c.id = f.commit_id
       JOIN path_lineage l ON l.id = f.lineage_id
      WHERE c.repo_id <> l.repo_id`,
  ).get() as { n: number };
  const lineageIds = db.prepare("SELECT id FROM path_lineage ORDER BY id").all() as
    Array<{ id: number }>;
  db.close();

  assert.equal(mismatches.n, 0);
  assert.deepEqual(lineageIds.map((row) => row.id), [1, 2]);
});

test("增量批次延續 topo_order、parent edge 並寫入 tombstone event", () => {
  const dbPath = makeDb();
  const repo = makeRepo();
  indexGit(repo, { dbPath });

  write(repo, "a.ts", "two\n");
  commit(repo, "second");
  indexGit(repo, { dbPath });

  git(repo, "rm", "-q", "a.ts");
  const death = commit(repo, "third");
  indexGit(repo, { dbPath });
  indexGit(repo, { dbPath }); // 空批次重跑不得重複 file_change

  const db = new DatabaseSync(dbPath);
  const topo = db.prepare(
    "SELECT topo_order AS n FROM git_commit ORDER BY topo_order",
  ).all() as Array<{ n: number }>;
  const parents = db.prepare("SELECT COUNT(*) AS n FROM git_commit_parent").get() as { n: number };
  const changes = db.prepare("SELECT COUNT(*) AS n FROM file_change").get() as { n: number };
  const tombstone = db.prepare(
    `SELECT c.sha AS sha, event.lineage_id AS lineageId
       FROM path_lineage_event event
       JOIN git_commit c ON c.id = event.commit_id
      WHERE event.path = 'a.ts' AND event.lineage_id IS NULL`,
  ).get() as { sha: string; lineageId: null };
  const segmentCount = db.prepare("SELECT COUNT(*) AS n FROM path_lineage_segment")
    .get() as { n: number };
  db.close();

  assert.deepEqual(topo.map((row) => row.n), [0, 1, 2]);
  assert.equal(parents.n, 2);
  assert.equal(changes.n, 3);
  assert.equal(tombstone.sha, death);
  assert.equal(tombstone.lineageId, null);
  assert.equal(segmentCount.n, 0, "v5 不得再把 DAG state 投影成會說謊的 topo 區間");
});

test("hunk 寫進 file_hunk，且二進位與合併不留任何列", () => {
  const dbPath = makeDb();
  const repo = makeRepo("src/a.ts");

  write(repo, "src/a.ts", "one\ntwo\nthree\n");
  writeFileSync(path.join(repo, "logo.png"), Buffer.from([0, 1, 2, 0, 3]));
  commit(repo, "text and binary");

  // 有衝突解決的合併：乾淨合併的 combined diff 是空的，測不到「有 change 沒 hunk」。
  git(repo, "checkout", "-qb", "side");
  write(repo, "src/a.ts", "side\n");
  commit(repo, "side");
  git(repo, "checkout", "-q", "main");
  write(repo, "src/a.ts", "main\n");
  commit(repo, "main");
  spawnSync("git", ["-C", repo, "merge", "--no-ff", "side"], { encoding: "utf8" });
  write(repo, "src/a.ts", "resolved\n");
  const mergeSha = commit(repo, "resolve");

  const report = indexGit(repo, { dbPath });
  assert.equal(report.hunkOrphans, 0, "orphan 代表路徑解析錯了");
  assert.ok(report.hunkRows > 0);

  const db = new DatabaseSync(dbPath);
  const rowsFor = (sha: string, filePath: string) =>
    db.prepare(
      `SELECT h.hunk_index AS i, h.old_start AS os, h.old_count AS oc,
              h.new_start AS ns, h.new_count AS nc
         FROM file_hunk h
         JOIN file_change f ON f.id = h.file_change_id
         JOIN git_commit c ON c.id = f.commit_id
        WHERE c.sha = ? AND f.path = ? ORDER BY h.hunk_index`,
    ).all(sha, filePath) as Array<Record<string, number>>;

  const total = db.prepare("SELECT COUNT(*) AS n FROM file_hunk").get() as { n: number };
  const binary = rowsFor(git(repo, "rev-parse", "HEAD~3"), "logo.png");
  const merged = rowsFor(mergeSha, "src/a.ts");
  const firstTextCommit = rowsFor(git(repo, "rev-parse", "HEAD~3"), "src/a.ts");
  db.close();

  assert.equal(total.n, report.hunkRows, "報告的列數必須與資料庫實際列數一致");
  // 二進位與合併都必須是「零列」＝沒有 hunk 證據。消費端靠這個決定不套用約束；
  // 若這裡寫成「零個新增行」，被修改的宣告就會被誤判成 birth（假斷層）。
  assert.deepEqual(binary, [], "git 判定為 binary 的檔案不得有 hunk");
  assert.deepEqual(merged, [], "合併的 combined diff 沒有可靠的單一父 hunk");
  assert.ok(firstTextCommit.length > 0, "一般文字檔必須有 hunk");
  assert.deepEqual(firstTextCommit.map((r) => r.i), [0], "hunk_index 從 0 連號");
});

test("同一批資料重跑不會重複插入 file_hunk", () => {
  const dbPath = makeDb();
  const repo = makeRepo("src/a.ts");
  write(repo, "src/a.ts", "one\ntwo\n");
  commit(repo, "edit");

  // indexGit 走增量，第二次的範圍是空的，永遠踩不到重複插入。
  // 但「重跑不會炸」不該只靠呼叫端自律，所以直接對 persistWalk 送同一批兩次。
  const commits = walkCommits(repo);
  attachHunks(commits, collectHunksForCommits(repo, commits.map((c) => c.sha)));
  const db = openDb(dbPath);
  const first = persistWalk(db, repo, commits, buildLineages(commits));
  const after = db.prepare("SELECT COUNT(*) AS n FROM file_hunk").get() as { n: number };
  const second = persistWalk(db, repo, commits, buildLineages(commits));
  const afterRerun = db.prepare("SELECT COUNT(*) AS n FROM file_hunk").get() as { n: number };
  db.close();

  assert.ok(first.hunkRows > 0);
  assert.equal(after.n, first.hunkRows);
  assert.equal(second.hunkRows, first.hunkRows, "第二次仍會嘗試寫同樣多的列");
  assert.equal(afterRerun.n, after.n, "但資料庫的列數不得增加");
});

test("水位線不再是新 HEAD 的祖先時拒絕混接歷史", () => {
  const dbPath = makeDb();
  const repo = makeRepo();
  indexGit(repo, { dbPath });

  git(repo, "checkout", "--orphan", "rewritten");
  git(repo, "rm", "-q", "-f", "a.ts");
  write(repo, "new.ts", "rewritten\n");
  commit(repo, "rewritten root");

  assert.throws(
    () => indexGit(repo, { dbPath }),
    /歷史可能已被改寫/,
  );
});

test("合併依 combined 狀態保留 A/D/M，且永遠不產生 R/C", () => {
  const repo = makeRepo("src/text.ts");
  write(repo, "src/shared.ts", "shared\n");
  commit(repo, "add shared file");

  git(repo, "checkout", "-qb", "feature");
  write(repo, "src/text.ts", "feature\n");
  write(repo, "src/branch-only.ts", "feature\n");
  const featureSha = commit(repo, "feature changes");

  git(repo, "checkout", "-q", "main");
  write(repo, "src/text.ts", "main\n");
  commit(repo, "main changes");

  const merge = spawnSync("git", ["-C", repo, "merge", "feature"], { encoding: "utf8" });
  assert.notEqual(merge.status, 0, "測試必須先製造衝突");
  write(repo, "src/text.ts", "resolved\n");
  write(repo, "src/merge-only.ts", "evil merge addition\n");
  rmSync(path.join(repo, "src/shared.ts"));
  rmSync(path.join(repo, "src/branch-only.ts"));
  const mergeSha = commit(repo, "resolve merge");

  const walked = walkCommits(repo);
  const record = walked.find((candidate) => candidate.sha === mergeSha);
  assert.ok(record?.isMerge);
  const byPath = new Map(record.changes.map((change) => [change.path, change.changeType]));
  assert.equal(byPath.get("src/text.ts"), "M");
  assert.equal(byPath.get("src/merge-only.ts"), "A");
  assert.equal(byPath.get("src/shared.ts"), "D");
  assert.equal(
    byPath.has("src/branch-only.ts"),
    false,
    "只存在單一父版本、合併時刪除的路徑對另一父版本無差異，因此 combined diff 不可見",
  );
  assert.equal(
    record.changes.some((change) => ["R", "C"].includes(change.changeType)),
    false,
  );

  const feature = walked.find((candidate) => candidate.sha === featureSha);
  assert.ok(
    feature?.changes.some(
      (change) => change.path === "src/branch-only.ts" && change.changeType === "A",
    ),
    "combined diff 不可見的路徑仍應在分支自己的 commit 留下紀錄",
  );
});

test("merge 從另一父帶進來的路徑保存 state event，且沿用分支原 lineage", () => {
  const dbPath = makeDb();
  const repo = makeRepo("src/root.ts");
  git(repo, "checkout", "-qb", "feature");
  write(repo, "src/branch.ts", "branch one\n");
  const branchAdd = commit(repo, "add branch file");
  git(repo, "checkout", "-q", "main");
  write(repo, "src/root.ts", "main two\n");
  commit(repo, "advance main");
  git(repo, "merge", "--no-ff", "-qm", "merge feature", "feature");
  const mergeSha = git(repo, "rev-parse", "HEAD");
  write(repo, "src/branch.ts", "branch two\n");
  const child = commit(repo, "edit imported file");

  const walked = walkCommits(repo);
  const merge = walked.find((candidate) => candidate.sha === mergeSha);
  assert.ok(merge);
  assert.equal(
    merge.changes.some((change) => change.path === "src/branch.ts"),
    false,
    "乾淨帶入的分支檔案不是 merge 自己的 combined contribution",
  );
  assert.equal(
    merge.stateChanges?.some(
      (change) => change.path === "src/branch.ts" && change.changeType === "A",
    ),
    true,
    "但第一父到 merge 結果的 state diff 必須看得見它",
  );

  const report = indexGit(repo, { dbPath });
  const db = new DatabaseSync(dbPath);
  const lineageForChange = (sha: string) => (db.prepare(
    `SELECT fc.lineage_id AS id
       FROM file_change fc JOIN git_commit c ON c.id = fc.commit_id
      WHERE c.sha = ? AND fc.path = 'src/branch.ts'`,
  ).get(sha) as { id: number }).id;
  const branchLineage = lineageForChange(branchAdd);
  assert.equal(lineageForChange(child), branchLineage);
  assert.equal(lineageIdAt(db, report.repoId, mergeSha, "src/branch.ts"), branchLineage);
  assert.equal(lineageIdAt(db, report.repoId, child, "src/branch.ts"), branchLineage);
  const mergeEvent = db.prepare(
    `SELECT event.lineage_id AS id
       FROM path_lineage_event event JOIN git_commit c ON c.id = event.commit_id
      WHERE c.sha = ? AND event.path = 'src/branch.ts'`,
  ).get(mergeSha) as { id: number };
  assert.equal(mergeEvent.id, branchLineage);
  db.close();
});

test("增量批次外的分支 parent 從事件表懶讀，與全量 lineage 相同", () => {
  const incrementalDb = makeDb();
  const fullDb = makeDb();
  const repo = makeRepo("src/shared.ts");
  const root = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-qb", "feature");
  write(repo, "src/shared.ts", "feature two\n");
  const feature = commit(repo, "edit on feature");
  git(repo, "checkout", "-q", "main");
  write(repo, "src/main.ts", "main only\n");
  const watermark = commit(repo, "advance main");

  indexGit(repo, { dbPath: incrementalDb, until: watermark });
  git(repo, "merge", "--no-ff", "-qm", "merge feature", "feature");
  const tip = git(repo, "rev-parse", "HEAD");
  const incremental = indexGit(repo, { dbPath: incrementalDb });
  const full = indexGit(repo, { dbPath: fullDb });
  assert.equal(incremental.mode, "incremental");

  const ids = (dbPath: string) => {
    const db = new DatabaseSync(dbPath);
    const repoId = (db.prepare("SELECT id FROM repo").get() as { id: number }).id;
    const result = {
      root: lineageIdAt(db, repoId, root, "src/shared.ts"),
      feature: lineageIdAt(db, repoId, feature, "src/shared.ts"),
      tip: lineageIdAt(db, repoId, tip, "src/shared.ts"),
    };
    db.close();
    return result;
  };
  assert.deepEqual(ids(incrementalDb), ids(fullDb));
  assert.equal(ids(fullDb).root, ids(fullDb).feature);
  assert.equal(full.anomalies, 0);
});

test("旁支曾刪除的路徑不冒充主線日後新增的 predecessor", () => {
  const dbPath = makeDb();
  const repo = makeRepo("src/root.ts");
  git(repo, "checkout", "-qb", "side");
  write(repo, "src/transient.ts", "side only\n");
  commit(repo, "add transient on side");
  git(repo, "rm", "-q", "src/transient.ts");
  commit(repo, "delete transient on side");
  git(repo, "checkout", "-q", "main");
  write(repo, "src/main.ts", "main only\n");
  commit(repo, "advance main");
  git(repo, "merge", "--no-ff", "-qm", "merge side", "side");
  write(repo, "src/transient.ts", "main birth\n");
  const birth = commit(repo, "add transient on main");

  const report = indexGit(repo, { dbPath });
  const db = new DatabaseSync(dbPath);
  const lineageId = lineageIdAt(db, report.repoId, birth, "src/transient.ts");
  assert.ok(lineageId);
  assert.equal(
    recreatedPathPredecessor(db, report.repoId, lineageId, "src/transient.ts", birth),
    undefined,
    "second-parent branch history is not a D → A transition on the current timeline",
  );
  db.close();
});

test("indexer_version 由實際選項算出，改門檻就換版本", () => {
  // 寫死版本字串的話，改了改名門檻卻沿用同一個版本，新舊產出會混進同一個
  // 資料庫而不報錯——那正是不變量 7 要防的事。
  assert.equal(indexerVersion(), INDEXER_VERSION, "無選項時等同預設常數");
  assert.notEqual(indexerVersion({ renameThreshold: 50 }), INDEXER_VERSION);
  assert.notEqual(indexerVersion({ copyThreshold: 60 }), INDEXER_VERSION);
  assert.notEqual(indexerVersion({ findCopiesHarder: true }), INDEXER_VERSION);
  // 明確給預設值必須與不給完全相同，否則同樣的設定會被當成兩個版本。
  assert.equal(
    indexerVersion({ renameThreshold: 30, copyThreshold: 40, findCopiesHarder: false }),
    INDEXER_VERSION,
  );
  assert.ok(INDEXER_VERSION.includes("histogram"), "diff 演算法必須進版本字串");
});

test("換走訪門檻續跑時拒絕混接，而不是靜默混入", () => {
  const dbPath = makeDb();
  const repo = makeRepo();
  indexGit(repo, { dbPath });

  write(repo, "a.ts", "two\n");
  commit(repo, "second");

  assert.throws(
    () => indexGit(repo, { dbPath, renameThreshold: 50 }),
    /indexer_version/,
    "門檻變了就是不同的產出，必須要求重建",
  );
});
