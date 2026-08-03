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
  declarationIndexerVersion,
  indexRepoStructure,
} from "../src/index/repo-pass.ts";
import {
  blobShaOf,
  discontinuitySimilarity,
  inTransaction,
  readBlobsBatch,
  trySourceBytes,
} from "../src/index/structural.ts";

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-repopass-"));
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
    return git("rev-parse", "HEAD");
  };
  return { repo, git, write, commit };
}

function freshDb(): string {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-repopass-db-")), "i.db");
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.close();
  return dbPath;
}

const HELPER = `export function normalizeRegion(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const collapsed = trimmed.replace(/\\s+/g, "-");
  if (collapsed.length === 0) return "unknown";
  return collapsed.startsWith("region-") ? collapsed : \`region-\${collapsed}\`;
}`;

describe("全 repo 結構 pass", () => {
  it("斷層規則版本會進 declarations 水位線", () => {
    assert.match(declarationIndexerVersion("walk-v1"), /discontinuity-1\.0\.0\+jaccard0\.25/);
  });

  it("路徑刪除後重現會在新 slot 記下斷層", async () => {
    const { repo, git, write, commit } = makeRepo();
    write("src/recreated.ts", "export function serve(): number { return 1; }\n");
    commit("加入 serve");
    git("rm", "-q", "src/recreated.ts");
    commit("刪除 serve");
    write("src/recreated.ts", "export function serve(): number { return 2; }\n");
    const recreated = commit("同路徑重建 serve");

    const dbPath = freshDb();
    await verifyParserAdapters();
    const report = indexGit(repo, { dbPath });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    await indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION);

    const rows = db.prepare(
      `SELECT d.prev_entity AS prevEntity, d.next_entity AS nextEntity
         FROM slot_discontinuity d
         JOIN git_commit c ON c.id = d.commit_id
         JOIN slot s ON s.id = d.slot_id
        WHERE c.sha = ? AND s.qualified_name = 'serve'`,
    ).all(recreated) as unknown as Array<{ prevEntity: number; nextEntity: number }>;
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.prevEntity, rows[0]!.nextEntity);
    db.close();
  });

  it("同一檔案連續修改不得誤報斷層", async () => {
    const { repo, write, commit } = makeRepo();
    write("src/continuous.ts", "export function stable(x: number): number { return x + 1; }\n");
    commit("加入 stable");
    write("src/continuous.ts", "export function stable(x: number): number { return x + 2; }\n");
    commit("連續修改 stable");

    const dbPath = freshDb();
    await verifyParserAdapters();
    const report = indexGit(repo, { dbPath });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    await indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION);
    const count = db.prepare("SELECT COUNT(*) AS n FROM slot_discontinuity").get() as { n: number };
    assert.equal(count.n, 0, "連續演化即使內容改變，也不是斷層");
    db.close();
  });

  it("跨檔案搬移由同一個 entity 延續——單一血緣的候選池不可能做到", async () => {
    const { repo, write, commit } = makeRepo();
    write("src/a.ts", `${HELPER}\n\nexport function unrelated(): number {\n  return 1;\n}\n`);
    commit("加入 normalizeRegion");

    // 把函式整段搬到另一個檔案。兩個檔案在同一個 commit 內改動，
    // 所以只有跨檔案的候選池能看到這對配對。
    write("src/a.ts", "export function unrelated(): number {\n  return 1;\n}\n");
    write("src/shared/region.ts", `${HELPER}\n`);
    const moved = commit("把 normalizeRegion 搬到 shared/region.ts");

    const dbPath = freshDb();
    await verifyParserAdapters();
    const report = indexGit(repo, { dbPath });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const pass = await indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION);

    assert.ok(pass.crossFileMatches >= 1, "跨檔案配對必須出現");

    // 同一個 entity 在兩個不同路徑上各有一個 revision，就是「程式碼搬家了」。
    const paths = db.prepare(
      `SELECT r.path AS p FROM revision r
         JOIN slot s ON s.id = r.slot_id
        WHERE s.qualified_name = 'normalizeRegion'
          AND r.entity_id = (
            SELECT entity_id FROM revision r2 JOIN slot s2 ON s2.id = r2.slot_id
             WHERE s2.qualified_name = 'normalizeRegion' ORDER BY r2.id LIMIT 1)
        ORDER BY r.path`,
    ).all() as Array<{ p: string }>;
    assert.deepEqual(
      paths.map((x) => x.p),
      ["src/a.ts", "src/shared/region.ts"],
      "搬移後必須仍是同一個 entity，而不是一死一生",
    );

    // 搬移不是誕生：新檔案裡那一份不得被記成 birth。
    const births = db.prepare(
      `SELECT COUNT(*) AS n FROM revision_change rc
         JOIN git_commit c ON c.id = rc.commit_id
         JOIN revision r ON r.id = rc.next_revision
         JOIN slot s ON s.id = r.slot_id
        WHERE c.sha = ? AND s.qualified_name = 'normalizeRegion'
          AND rc.change_level = 'birth'`,
    ).get(moved) as { n: number };
    assert.equal(births.n, 0, "搬移被記成誕生就是假斷層");
    db.close();
  });

  it("水位線讓重跑成為空批次，且不重複寫入", async () => {
    const { repo, write, commit } = makeRepo();
    write("src/a.ts", `${HELPER}\n`);
    commit("first");

    const dbPath = freshDb();
    await verifyParserAdapters();
    const report = indexGit(repo, { dbPath });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");

    const first = await indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION);
    assert.equal(first.mode, "full");
    assert.ok(first.revisions > 0);
    const count = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM revision").get() as { n: number }).n;
    const afterFirst = count();

    const second = await indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION);
    assert.equal(second.mode, "incremental");
    assert.equal(second.commitsScanned, 0, "沒有新 commit 就不該再掃一次");
    assert.equal(count(), afterFirst, "重跑不得新增任何列");

    // 新 commit 之後只處理新的那一個
    write("src/a.ts", `${HELPER}\n\nexport const version = 2;\n`);
    commit("second");
    indexGit(repo, { dbPath });
    const third = await indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION);
    assert.equal(third.mode, "incremental");
    assert.equal(third.commitsScanned, 1, "只掃水位線之後的 commit");
    db.close();
  });

  it("合併 commit 一律跳過", async () => {
    const { repo, git, write, commit } = makeRepo();
    write("src/a.ts", `${HELPER}\n`);
    commit("base");
    git("checkout", "-qb", "side");
    write("src/a.ts", `${HELPER}\n\nexport const side = 1;\n`);
    commit("side");
    git("checkout", "-q", "main");
    write("src/a.ts", `${HELPER}\n\nexport const main = 1;\n`);
    commit("main");
    try {
      git("-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "side");
    } catch {
      // 預期衝突
    }
    write("src/a.ts", `${HELPER}\n\nexport const resolved = 1;\n`);
    commit("resolve");

    const dbPath = freshDb();
    await verifyParserAdapters();
    const report = indexGit(repo, { dbPath });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const pass = await indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION);
    assert.equal(pass.mergesSkipped, 1, "combined diff 沒有可靠的單一父");
    db.close();
  });
});

describe("discontinuitySimilarity", () => {
  it("不可比較是 NULL，與精確比較後完全不同的 0 分開", () => {
    assert.equal(discontinuitySimilarity(undefined, new Set([1])), null);
    assert.equal(discontinuitySimilarity(new Set([1]), new Set([2])), 0);
  });
});

describe("blobShaOf", () => {
  it("與 git 自己算的 blob id 相同", () => {
    const { repo, write, commit } = makeRepo();
    write("src/a.ts", `${HELPER}\n`);
    const sha = commit("first");
    const bytes = execFileSync("git", ["-C", repo, "show", `${sha}:src/a.ts`], {
      maxBuffer: 1 << 24,
    });
    const fromGit = execFileSync("git", ["-C", repo, "rev-parse", `${sha}:src/a.ts`], {
      encoding: "utf8",
    }).trim();
    // 本地算是為了省掉每筆 revision 一次 git spawn；算錯的話 blob_sha 會全錯，
    // 而那是可攜模式回去讀內容的唯一鑰匙。
    assert.equal(blobShaOf(bytes), fromGit);
  });

  it("對非 ASCII 內容也正確——雜湊的是原始位元組", () => {
    const { repo, write, commit } = makeRepo();
    write("src/b.ts", "// 中文註解與 emoji 🤖\nexport const x = 1;\n");
    const sha = commit("unicode");
    const bytes = execFileSync("git", ["-C", repo, "show", `${sha}:src/b.ts`], {
      maxBuffer: 1 << 24,
    });
    const fromGit = execFileSync("git", ["-C", repo, "rev-parse", `${sha}:src/b.ts`], {
      encoding: "utf8",
    }).trim();
    assert.equal(blobShaOf(bytes), fromGit);
  });
});

describe("readBlobsBatch", () => {
  it("missing 只消耗自己的 header，後續 blob 不會錯位", () => {
    const { repo, write, commit } = makeRepo();
    write("src/a.ts", "export const a = 1;\n");
    write("src/b.ts", "export const b = 2;\n");
    const sha = commit("two files");
    const specs = [
      `${sha}:src/a.ts`,
      `${sha}:src/missing.ts`,
      `${sha}:src/b.ts`,
    ];

    const blobs = readBlobsBatch(repo, specs);
    assert.equal(blobs.get(specs[0]!)?.toString("utf8"), "export const a = 1;\n");
    assert.equal(blobs.has(specs[1]!), false);
    assert.equal(
      blobs.get(specs[2]!)?.toString("utf8"),
      "export const b = 2;\n",
      "missing 後的下一筆仍必須對到自己的內容",
    );
  });

  it("批次邊界不改變結果", () => {
    const { repo, write, commit } = makeRepo();
    write("src/a.ts", "export const a = 1;\n");
    write("src/b.ts", "export const b = 2;\n");
    write("src/c.ts", "export const c = 3;\n");
    const sha = commit("three files");
    const specs = ["a", "b", "c"].map((name) => `${sha}:src/${name}.ts`);

    assert.deepEqual(
      [...readBlobsBatch(repo, specs, 1)],
      [...readBlobsBatch(repo, specs, 200)],
    );
  });

  it("內容與逐一 git show 完全相同，包含非 ASCII 與 emoji", () => {
    const { repo, write, commit } = makeRepo();
    write("src/a.ts", "export const a = 1;\n");
    write("src/unicode.ts", "// 中文註解 🤖\nexport const 答案 = 42;\n");
    const sha = commit("unicode");
    const specs = [`${sha}:src/a.ts`, `${sha}:src/unicode.ts`];
    const blobs = readBlobsBatch(repo, specs);

    for (const spec of specs) {
      assert.deepEqual(blobs.get(spec), trySourceBytes(repo, spec));
    }
  });
});

describe("inTransaction", () => {
  const memDb = () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    return db;
  };
  const count = (db: DatabaseSync) =>
    (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;

  it("成功時提交，回傳工作的結果", () => {
    const db = memDb();
    const got = inTransaction(db, () => {
      db.prepare("INSERT INTO t (v) VALUES ('a')").run();
      db.prepare("INSERT INTO t (v) VALUES ('b')").run();
      return "done";
    });
    assert.equal(got, "done");
    assert.equal(count(db), 2);
    db.close();
  });

  it("**失敗時整批回滾並把例外往上拋**", () => {
    // 這是包 transaction 之後新增的失敗模式：半批寫入必須不留痕跡，
    // 否則水位線沒前進、重跑時又多一份，冪等性就破了。
    const db = memDb();
    db.prepare("INSERT INTO t (v) VALUES ('before')").run();
    assert.throws(
      () =>
        inTransaction(db, () => {
          db.prepare("INSERT INTO t (v) VALUES ('mid')").run();
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(count(db), 1, "只該剩下 transaction 之前那一筆");
    db.close();
  });

  it("回滾之後連線仍可繼續使用", () => {
    // ROLLBACK 沒發出去的話，下一個 BEGIN 會以「transaction 已開啟」失敗，
    // 而那會在真實索引中變成連鎖崩潰。
    const db = memDb();
    try {
      inTransaction(db, () => {
        throw new Error("first");
      });
    } catch {
      // 預期
    }
    inTransaction(db, () => {
      db.prepare("INSERT INTO t (v) VALUES ('after')").run();
    });
    assert.equal(count(db), 1);
    db.close();
  });
});
