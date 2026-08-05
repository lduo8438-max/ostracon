import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { indexGit } from "../src/git/index.ts";
import { walkCommits } from "../src/git/walk.ts";

/**
 * 非 ASCII 檔名。
 *
 * git 預設 `core.quotePath=true`，所以 `--name-status` 會輸出
 * `"my \346\252\224\346\241\210.ts"`。先前走訪層直接採用那個字串，於是路徑帶著
 * 引號與八進位逸出存進資料庫，而 `grammarForPath` 用 `/\.ts$/` 判副檔名——
 * 結尾是 `.ts"` 就永遠不匹配，**那些檔案完全不被解析**。
 */

const TS = 'export function hello(): string {\n  return "a";\n}\n';

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-path-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(repo, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "f", "--no-gpg-sign");
  return repo;
}

function indexed(repo: string): DatabaseSync {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-path-db-")), "i.db");
  const init = new DatabaseSync(dbPath);
  init.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  init.close();
  indexGit(repo, { dbPath });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

const paths = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT path FROM file_change ORDER BY path").all() as Array<{ path: string }>)
    .map((r) => r.path);

describe("非 ASCII 與特殊字元檔名", () => {
  it("**中文檔名不得帶著引號與八進位逸出存進資料庫**", () => {
    // 測試前提：git 真的會輸出引號形式，否則這條測試什麼都沒守到。
    const repo = repoWith({ "my 檔案.ts": TS });
    const raw = execFileSync("git", ["-C", repo, "log", "--name-status", "--format="], {
      encoding: "utf8",
    });
    assert.match(raw, /\\346/, "測試前提：git 預設會輸出八進位逸出");

    const db = indexed(repo);
    assert.deepEqual(paths(db), ["my 檔案.ts"]);
    db.close();
  });

  it("**副檔名判定要看得懂，檔案才會被解析**", () => {
    // 這是這個 bug 真正的傷害：不是「查不到」，是 revision 根本不存在。
    const db = indexed(repoWith({ "src/日本語.ts": TS, "src/plain.ts": TS }));
    const n = db.prepare("SELECT COUNT(*) AS n FROM file_change").get() as { n: number };
    assert.equal(n.n, 2);
    assert.deepEqual(paths(db), ["src/plain.ts", "src/日本語.ts"]);
    db.close();
  });

  it("重音、西里爾字母與 emoji 同樣要還原", () => {
    const names = ["café.ts", "Привет.ts", "🚀.ts"];
    const db = indexed(repoWith(Object.fromEntries(names.map((n) => [n, TS]))));
    assert.deepEqual(paths(db), [...names].sort());
    db.close();
  });

  it("ASCII 檔名不受影響（去引號不得動到本來就沒引號的路徑）", () => {
    const db = indexed(repoWith({ "a.ts": TS, "b/c.ts": TS }));
    assert.deepEqual(paths(db), ["a.ts", "b/c.ts"]);
    db.close();
  });

  it("走訪層本身回傳的就是還原後的路徑", () => {
    // 不經過資料庫也要對——persist 只是把它存下來，不負責修。
    const repo = repoWith({ "測試.ts": TS });
    const commits = walkCommits(repo);
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0]!.changes.map((c) => c.path), ["測試.ts"]);
  });

  it("改名時新舊路徑都要還原", () => {
    const repo = repoWith({ "old.ts": TS });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("mv", "old.ts", "新名.ts");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "rename", "--no-gpg-sign");

    const renamed = walkCommits(repo)[1]!.changes.find((c) => c.changeType === "R");
    assert.ok(renamed, "應該偵測到改名");
    assert.equal(renamed.path, "新名.ts");
    assert.equal(renamed.oldPath, "old.ts");
  });
});
