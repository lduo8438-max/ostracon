import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { assertNotShallow, indexGit } from "../src/git/index.ts";

/**
 * 淺層 clone 的偵測。
 *
 * 這一組用**真的** `git clone --depth` 產生淺層 repo，不是假造 `.git/shallow`：
 * 要守的是「git 說它是淺層時我們有沒有停下來」，而 git 怎麼判定淺層是它自己的事，
 * 假造出來的狀態不保證與真實一致。
 */

function makeRepo(commits: number): string {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-shallow-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (let i = 0; i < commits; i++) {
    writeFileSync(
      path.join(repo, "a.ts"),
      `export function f${i}(): number {\n  return ${i};\n}\n`,
    );
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `c${i}`, "--no-gpg-sign");
  }
  return repo;
}

function shallowCloneOf(source: string, depth: number): string {
  const target = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-clone-")), "repo");
  execFileSync("git", [
    "clone",
    "--quiet",
    "--depth",
    String(depth),
    // 本地路徑預設走 hardlink 而不是真的協定，那樣不會產生淺層 repo。
    "--no-local",
    `file://${source}`,
    target,
  ], { stdio: "ignore" });
  return target;
}

const freshDb = (): string => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-shallow-db-")), "i.db");
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.close();
  return dbPath;
};

describe("淺層 clone 偵測", () => {
  it("**完整 clone 不受影響**", () => {
    const repo = makeRepo(3);
    assert.doesNotThrow(() => assertNotShallow(repo));
  });

  it("**淺層 clone 必須拒絕，而不是印警告**", () => {
    // 警告會捲過去，而時間軸照樣把截斷點當成「誕生」印出來，
    // 使用者分不出哪一條誕生是真的。
    const source = makeRepo(5);
    const shallow = shallowCloneOf(source, 2);
    assert.equal(
      execFileSync("git", ["-C", shallow, "rev-parse", "--is-shallow-repository"], {
        encoding: "utf8",
      }).trim(),
      "true",
      "測試前提：clone 出來的必須真的是淺層",
    );
    assert.throws(() => assertNotShallow(shallow), /淺層/);
  });

  it("錯誤訊息要說得出怎麼修", () => {
    const shallow = shallowCloneOf(makeRepo(4), 1);
    assert.throws(() => assertNotShallow(shallow), (error: unknown) => {
      const message = String(error);
      assert.match(message, /git fetch --unshallow/, "要給得出可執行的指令");
      assert.match(message, /誕生/, "要說出後果，不只說「不支援」");
      return true;
    });
  });

  it("**indexGit 在寫入任何東西之前就擋下來**", () => {
    // 與其產生一個會說謊的索引再叫人重建，不如一開始就不要寫。
    const shallow = shallowCloneOf(makeRepo(5), 2);
    const dbPath = freshDb();
    assert.throws(() => indexGit(shallow, { dbPath }), /淺層/);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const commits = db.prepare("SELECT COUNT(*) AS n FROM git_commit").get() as { n: number };
    const repos = db.prepare("SELECT COUNT(*) AS n FROM repo").get() as { n: number };
    db.close();
    assert.equal(commits.n, 0, "不得寫入任何 commit");
    assert.equal(repos.n, 0, "連 repo 列都不該建立");
  });

  it("不是 git repo 時不誤判成淺層", () => {
    // rev-parse 會失敗，tryGit 回 undefined——那不是 "true"，所以不該擋。
    // 真正的「這不是 repo」錯誤由後面的走訪自己報，訊息比較準確。
    const notARepo = mkdtempSync(path.join(tmpdir(), "ostracon-notgit-"));
    assert.doesNotThrow(() => assertNotShallow(notARepo));
  });
});
