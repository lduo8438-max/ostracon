import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { verifyParserAdapters } from "../src/ast/parser.ts";
import { indexGit, INDEXER_VERSION } from "../src/git/index.ts";
import { indexRepoStructure } from "../src/index/repo-pass.ts";

/**
 * **增量索引的產出必須與全量索引到同一個終點完全相同。**
 *
 * 不變量 12（索引必須增量）與不變量 7（相同輸入相同輸出）合起來就是這件事。
 * 先前唯一相關的測試是「空批次重跑不重複寫入」——那是 0 個新 commit 的
 * trivial case，完全擋不住真正的續跑。
 *
 * 實測 create-t3-app 先索引到中繼點再續 100 個 commit：多出 **169 個 entity**
 * （574 對 405）。`matches` 與 tier 分佈完全正常，所以除了 entity 數以外沒有
 * 任何指標看得出來。成因是兩張記憶體 Map（`entityAt` / `revisionAt`）每次呼叫
 * 都重建，續跑時必定落空，於是「匹配到了但這一趟還沒見過它」被誤判成誕生。
 *
 * 使用者看到的是水位線處一次假的「誕生」，外加一句「這個檔案的歷史上有 2 個
 * 不同的實體」——憑空報告一個不存在的斷層。而 `why` 本身就是增量的。
 */

function makeRepo(commits: number): string {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-incr-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), body);
  };
  const commit = (msg: string) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg, "--no-gpg-sign");
  };

  const fn = (name: string, n: number) => `export function ${name}(input: number): number {
  const scaled = input * ${n};
  const shifted = scaled + 1;
  return shifted;
}`;

  write("src/stable.ts", `${fn("stable", 2)}\n`);
  write("src/churn.ts", `${fn("churn", 1)}\n`);
  write("src/doomed.ts", `${fn("doomed", 7)}\n`);
  commit("c0");

  for (let i = 1; i <= commits; i++) {
    // churn 每次都改；stable 完全不動——「未被觸及的檔案」正是續跑最容易漏掉的一類。
    write("src/churn.ts", `${fn("churn", i + 1)}\n`);
    if (i === Math.floor(commits / 2)) {
      // 中途刪掉一個檔案：死亡分支也讀那兩張 Map，同樣會在續跑時落空。
      execFileSync("git", ["-C", repo, "rm", "-q", path.join(repo, "src/doomed.ts")]);
    }
    commit(`c${i}`);
  }
  return repo;
}

async function indexTo(dbPath: string, repo: string, until: string): Promise<void> {
  const report = indexGit(repo, { dbPath, until });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  await indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION);
  db.close();
}

function freshDb(): string {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-incr-db-")), "i.db");
  const init = new DatabaseSync(dbPath);
  init.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  init.close();
  return dbPath;
}

/** 拿來逐項比對的產出快照。`stable_key` 是對外身份，必須逐個相同。 */
function snapshot(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const one = (q: string) => (db.prepare(q).get() as { n: number }).n;
  const out = {
    revisions: one("SELECT COUNT(*) AS n FROM revision"),
    entities: one("SELECT COUNT(*) AS n FROM entity"),
    matches: one("SELECT COUNT(*) AS n FROM revision_match WHERE accepted = 1"),
    deaths: one("SELECT COUNT(*) AS n FROM entity WHERE death_commit_id IS NOT NULL"),
    changes: one("SELECT COUNT(*) AS n FROM revision_change"),
    stableKeys: (db.prepare(
      "SELECT stable_key AS k FROM entity ORDER BY stable_key",
    ).all() as Array<{ k: string }>).map((r) => r.k),
  };
  db.close();
  return out;
}

describe("增量索引與全量索引必須產出相同結果", () => {
  it("**續跑之後每一個 stable_key 都要與全量相同**", async () => {
    await verifyParserAdapters();
    const repo = makeRepo(8);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    const shas = git("rev-list", "--topo-order", "--reverse", "HEAD").split("\n");
    const mid = shas[4]!;
    const tip = shas[shas.length - 1]!;

    const incremental = freshDb();
    await indexTo(incremental, repo, mid);
    await indexTo(incremental, repo, tip);

    const full = freshDb();
    await indexTo(full, repo, tip);

    const a = snapshot(incremental);
    const b = snapshot(full);
    assert.deepEqual(a.stableKeys, b.stableKeys, "entity 的對外身份必須逐個相同");
    assert.equal(a.entities, b.entities, "續跑不得多生出 entity");
    assert.equal(a.revisions, b.revisions, "續跑不得多寫 revision");
    assert.equal(a.matches, b.matches);
    assert.equal(a.deaths, b.deaths, "死亡必須記在原本的 entity 上，不是新生的");
    assert.equal(a.changes, b.changes);
  });

  it("分成很多小批次續跑，結果仍與一次全量相同", async () => {
    // 一次一個 commit 是最嚴苛的情況：每一批的記憶體 Map 都是空的。
    await verifyParserAdapters();
    const repo = makeRepo(6);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    const shas = git("rev-list", "--topo-order", "--reverse", "HEAD").split("\n");

    const stepwise = freshDb();
    for (const sha of shas) await indexTo(stepwise, repo, sha);

    const full = freshDb();
    await indexTo(full, repo, shas[shas.length - 1]!);

    assert.deepEqual(snapshot(stepwise), snapshot(full));
  });
});
