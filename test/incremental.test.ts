import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { verifyParserAdapters } from "../src/ast/parser.ts";
import { indexGit, INDEXER_VERSION } from "../src/git/index.ts";
import {
  DECLARATIONS_PASS_NAME,
  indexRepoStructure,
} from "../src/index/repo-pass.ts";

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

  /**
   * **中途被打斷之後，已完成的工作要接得回來。**
   *
   * 資料本來就是逐 commit 提交的（每顆一個 transaction），但水位線原本只在整趟
   * 迴圈跑完的最後一行才寫入。於是中斷之後 `resolveResumePoint` 看不到
   * declarations 那一列、判成 `full`，下一趟從第一顆 commit 重來——資料列因為
   * `UNIQUE (commit_id, slot_id)` 冪等不會重複，但每個 blob 都要重新解析。
   *
   * 實測 angular/angular（38,278 commit）被訊號中止時，170 萬筆 revision 已經
   * 寫進資料庫，四小時的工作卻一秒都接不回來。牴觸不變量 12 的「可恢復地重跑」。
   *
   * **這條測試不模擬中斷，它直接檢查水位線有沒有跟著資料前進**——中斷發生在
   * 哪一顆 commit 是隨機的，而「水位線落後於已提交的資料」才是缺陷本身。
   */
  it("**中途炸掉之後，已完成的 commit 要接得回來**", async () => {
    await verifyParserAdapters();
    const repo = makeRepo(8);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    const shas = git("rev-list", "--topo-order", "--reverse", "HEAD").split("\n");
    const tip = shas[shas.length - 1]!;

    const dbPath = freshDb();
    const report = indexGit(repo, { dbPath, until: tip });
    const real = new DatabaseSync(dbPath);
    real.exec("PRAGMA foreign_keys = ON");

    // **在 db 這個既有的接縫上注入失敗，不動產品程式碼。** `prep` 對每個 SQL
    // 只呼叫一次 `db.prepare` 並快取語句，所以包一層 Proxy 就能數 `run` 的次數
    // 並在第 N 次丟例外——那是一次發生在迴圈中途、transaction 內的中斷，
    // 與 angular 上被訊號砍掉的形狀相同。
    let inserts = 0;
    const BOOM_AT = 4;
    const db = new Proxy(real, {
      get(target, prop) {
        // 原生方法要綁回真實物件：`Reflect.get` 回傳的是未綁定的函式，
        // 用 Proxy 當 `this` 呼叫 `exec` 會得到 Illegal invocation。
        if (prop !== "prepare") {
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("INSERT INTO revision (")) return statement;
          return new Proxy(statement, {
            get(st, p) {
              if (p !== "run") {
                const value = Reflect.get(st, p);
                return typeof value === "function" ? value.bind(st) : value;
              }
              return (...args: unknown[]) => {
                if (++inserts === BOOM_AT) throw new Error("注入的中斷");
                return (st.run as (...a: unknown[]) => unknown)(...args);
              };
            },
          });
        };
      },
    }) as DatabaseSync;

    await assert.rejects(
      () => indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION),
      /注入的中斷/,
      "前提：注入的失敗必須真的把 pass 打斷",
    );

    // **這才是缺陷本身**：資料是逐 commit 提交的，水位線卻只在整趟跑完的最後
    // 一行寫入。中斷之後沒有那一列 → `resolveResumePoint` 判成 full → 下一趟
    // 從第一顆重來。angular 上那是四小時的工作。
    const mark = real.prepare(
      `SELECT c.id AS id, c.topo_order AS topo
         FROM pass_state p JOIN git_commit c ON c.id = p.last_commit_id
        WHERE p.repo_id = ? AND p.pass_name = ?`,
    ).get(report.repoId, DECLARATIONS_PASS_NAME) as
      { id: number; topo: number } | undefined;
    assert.ok(mark, "中斷之後仍須留下 declarations 水位線，否則下一趟從頭再來");

    // 水位線指的那顆必須真的寫過 revision，而且不是 tip——它得停在中斷之前。
    const written = (real.prepare(
      "SELECT COUNT(*) AS n FROM revision WHERE commit_id = ?",
    ).get(mark.id) as { n: number }).n;
    assert.ok(written > 0, "水位線指的 commit 必須真的有資料");
    const tipTopo = (real.prepare(
      "SELECT MAX(topo_order) AS n FROM git_commit WHERE repo_id = ?",
    ).get(report.repoId) as { n: number }).n;
    assert.ok(mark.topo < tipTopo, `水位線該停在中斷之前，實際 ${mark.topo}/${tipTopo}`);

    // 炸掉的那一顆整個 transaction 回滾：水位線不得超前它自己的資料。
    const orphan = (real.prepare(
      `SELECT COUNT(*) AS n FROM git_commit c
        WHERE c.repo_id = ? AND c.topo_order > ?
          AND EXISTS (SELECT 1 FROM revision r WHERE r.commit_id = c.id)`,
    ).get(report.repoId, mark.topo) as { n: number }).n;
    assert.equal(orphan, 0, "水位線之後不得有已寫入的 revision");

    // **接回去的結果必須與一次跑完的相同。** 水位線留下來只是必要條件；
    // 使用者要的是「中斷之後再跑一次，拿到的東西跟沒中斷過一樣」。
    const resumed = await indexRepoStructure(real, repo, report.repoId, INDEXER_VERSION);
    assert.equal(resumed.mode, "incremental", "接得回來的話這一趟是增量，不是重頭");
    assert.ok(
      resumed.commitsScanned < shas.length,
      `增量只該掃剩下的，實際掃了 ${resumed.commitsScanned}/${shas.length}`,
    );
    real.close();

    const full = freshDb();
    await indexTo(full, repo, tip);
    assert.deepEqual(
      snapshot(dbPath),
      snapshot(full),
      "中斷後續跑的產出必須與一次跑完逐項相同",
    );
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
