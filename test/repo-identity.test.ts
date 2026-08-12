import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { canonicalRepoPath, indexGit } from "../src/git/index.ts";
import { consolidateRepoPaths } from "../src/git/persist.ts";
import { entitiesFor, why } from "../src/cli/why.ts";

/**
 * repo 的身分先前是 `--repo` 的**原字串**，所以同一個 repo 的不同拼法會在同一個
 * 資料庫裡各建一列。那不只是浪費：`lineageIdAt` 與 `entitiesFor` 都不綁 repo，
 * 於是同一段程式碼變成多個 entity，`why` 印出「slot 延續但內容血緣斷開」——
 * **假斷層**，不變量 2 指名的最嚴重失效模式。
 *
 * 實測 `ostracon why X` 之後再 `ostracon why X --repo .` 就會發生，
 * 不需要 `--db` 也不需要任何特殊參數。
 */
function makeRepo(): { repo: string; sub: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-identity-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  execFileSync("mkdir", ["-p", path.join(repo, "src")]);
  writeFileSync(
    path.join(repo, "src/account.ts"),
    "export function formatAccount(input: string): string {\n"
    + "  return input.trim().toLowerCase();\n}\n",
  );
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "add", "--no-gpg-sign");
  writeFileSync(
    path.join(repo, "src/account.ts"),
    "export function serializeAccount(input: string): string {\n"
    + "  return input.trim().toLowerCase();\n}\n",
  );
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "rename", "--no-gpg-sign");
  return { repo, sub: path.join(repo, "src") };
}

/** `openDb` 不建 schema，呼叫端負責——`why` 與 golden materializer 都自己來。 */
const freshDbPath = (): string => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-db-")), "i.db");
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.close();
  return dbPath;
};

const repoRows = (dbPath: string): string[] => {
  const db = new DatabaseSync(dbPath);
  const rows = (db.prepare("SELECT root_path AS p FROM repo ORDER BY id").all() as
    unknown as { p: string }[]).map((r) => r.p);
  db.close();
  return rows;
};

describe("repo 的身分", () => {
  it("三種拼法都收斂到同一個正規路徑", () => {
    const { repo, sub } = makeRepo();
    const canonical = canonicalRepoPath(repo);

    // 子目錄：`--repo` 預設是 process.cwd()，從 repo 內的子目錄跑就是子目錄字串。
    assert.equal(canonicalRepoPath(sub), canonical, "子目錄要收斂到 repo 根");

    // symlink：macOS 的 /tmp 就是 symlink，而 path.resolve 不會跟隨它。
    const link = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-link-")), "l");
    symlinkSync(repo, link);
    assert.equal(canonicalRepoPath(link), canonical, "symlink 要收斂到實體路徑");

    // path.resolve 只解得開第一種。這條斷言是「為什麼不用 path.resolve」的證據。
    assert.notEqual(path.resolve(sub), canonical);
  });

  it("**同一個 repo 的兩種拼法只建一列，輸出逐字相同**", async () => {
    const { repo } = makeRepo();
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-db-")), "i.db");
    const target = "src/account.ts:serializeAccount";

    const first = await why(repo, target, dbPath, "HEAD");
    // 第二種拼法：同一個 repo，經 symlink。舊行為會在這裡插第二列。
    const link = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-link2-")), "l");
    symlinkSync(repo, link);
    const second = await why(link, target, dbPath, "HEAD");

    assert.deepEqual(repoRows(dbPath), [canonicalRepoPath(repo)], "只該有一列 repo");
    assert.equal(second, first, "同一個問題、兩種拼法，答案必須逐字相同");
    // 假斷層是這條測試真正要擋的東西，單獨斷言一次讓失敗訊息說得清楚。
    assert.doesNotMatch(second, /不同的實體/);
  });

  it("**清不掉的重複列也不得汙染答案**", () => {
    // 存下來的相對 root_path 無從還原成正規路徑（不知道當初是哪個 cwd），
    // 所以收斂不保證清得乾淨。身分正規化擋的是「別再產生重複」；查詢層綁 repo
    // 擋的是「已經有重複的舊資料庫也要給對的答案」。兩層都要。
    //
    // 真實的重複長這樣：每個 repo 有**自己的** git_commit 與 slot 列
    // （`revision` 的 UNIQUE(commit_id, slot_id) 讓它不可能是別的形狀），
    // 但 `lineage_id` 全域唯一因而共用。只用 lineage_id 過濾就會把兩邊都撈出來，
    // 同一段程式碼於是被算成兩個實體——假斷層。
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
    db.exec(
      `INSERT INTO repo (id, root_path, created_at) VALUES
         (1, '/canonical', '2026-01-01'), (2, 'stale/relative', '2026-01-01');
       INSERT INTO path_lineage (id, repo_id) VALUES (7, 1);
       INSERT INTO git_commit
         (id, repo_id, sha, authored_at, committed_at, message, topo_order) VALUES
         (1, 1, 'aaa', '2026-01-01', '2026-01-01', 'x', 0),
         (2, 2, 'aaa', '2026-01-01', '2026-01-01', 'x', 0);
       INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind) VALUES
         (1, 1, 7, 'serializeAccount', 'function'),
         (2, 2, 7, 'serializeAccount', 'function');
       INSERT INTO entity (id, repo_id, stable_key, birth_commit_id) VALUES
         (1, 1, 'key', 1), (2, 2, 'key', 2);
       INSERT INTO revision
         (id, repo_id, commit_id, slot_id, entity_id, lineage_id, path, blob_sha,
          byte_start, byte_end, line_start, line_end, hash_raw, hash_token,
          hash_alpha, hash_alpha_self, hash_shape, shape_profile,
          node_count, token_count, similarity_recall_mode, exact_ngram_hashes) VALUES
         (1, 1, 1, 1, 1, 7, 'src/account.ts', 'b', 0, 1, 1, 2,
          'r','t','a','as','sh','p', 30, 10, 'exact', x'00'),
         (2, 2, 2, 2, 2, 7, 'src/account.ts', 'b', 0, 1, 1, 2,
          'r','t','a','as','sh','p', 30, 10, 'exact', x'00');`,
    );

    assert.deepEqual(
      entitiesFor(db, 1, 7, "serializeAccount").map((e) => e.entityId),
      [1],
      "只該看到自己 repo 的實體",
    );
    assert.deepEqual(
      entitiesFor(db, 2, 7, "serializeAccount").map((e) => e.entityId),
      [2],
    );
    db.close();
  });

  it("既有資料庫裡的舊拼法被收斂，而不是再插一列", () => {
    const { repo } = makeRepo();
    const dbPath = freshDbPath();
    indexGit(repo, { dbPath });

    // 假裝這個資料庫是舊版建的：把身分改回未正規化的拼法。
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare("UPDATE repo SET root_path = ?").run(path.join(repo, "src"));
    db.close();

    const report = indexGit(repo, { dbPath });
    assert.equal(report.consolidation.migrated, 1, "舊列該被改寫，不是被略過");
    assert.deepEqual(repoRows(dbPath), [canonicalRepoPath(repo)]);
  });

  it("解不開的舊列不刪除——無從證明它是同一個 repo", () => {
    const { repo } = makeRepo();
    const dbPath = freshDbPath();
    indexGit(repo, { dbPath });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(
      "INSERT INTO repo (root_path, created_at) VALUES ('somewhere/else', '2026-01-01')",
    ).run();
    // 目錄不存在時 canonicalise 回 undefined，該列必須原封不動。
    // 那可能是別台機器搬過來的資料庫，刪掉就是刪掉使用者的東西。
    const result = consolidateRepoPaths(db, canonicalRepoPath(repo), () => undefined);
    assert.deepEqual(result, { migrated: 0, absorbed: [] });
    db.close();
    assert.equal(repoRows(dbPath).length, 2);
  });
});
