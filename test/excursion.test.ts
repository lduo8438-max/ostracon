import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { verifyParserAdapters } from "../src/ast/parser.ts";
import { indexGit, INDEXER_VERSION } from "../src/git/index.ts";
import { detectExcursions } from "../src/index/excursion.ts";
import { indexRepoStructure } from "../src/index/repo-pass.ts";

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-exc-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), body);
  };
  const remove = (rel: string) => git("rm", "-q", path.join(repo, rel));
  const commit = (msg: string) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg, "--no-gpg-sign");
    return git("rev-parse", "HEAD");
  };
  return { repo, git, write, remove, commit };
}

async function index(repo: string) {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-exc-db-")), "i.db");
  const init = new DatabaseSync(dbPath);
  init.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  init.close();
  await verifyParserAdapters();
  const report = indexGit(repo, { dbPath });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  await indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION);
  return { db, dbPath, repoId: report.repoId };
}

const rows = (db: DatabaseSync) =>
  db.prepare(
    `SELECT x.strength AS strength, x.method AS method, x.duration_days AS days,
            (SELECT s.qualified_name FROM revision r JOIN slot s ON s.id = r.slot_id
              WHERE r.entity_id = x.entity_id LIMIT 1) AS sym
       FROM excursion x`,
  ).all() as Array<{ strength: string; method: string; days: number; sym: string }>;

const HELPER = `export function experimentalCache(key: string): string {
  const normalized = key.trim().toLowerCase();
  const bucket = normalized.length % 8;
  return \`cache-\${bucket}-\${normalized}\`;
}`;

describe("迂迴偵測（entity 層級）", () => {
  it("**搬移不得被記成迂迴**——內容仍存在於別處就排除", async () => {
    // 實測 create-t3-app：117 個「內容逐字未變即被移除」的候選裡有 15 個（13%）
    // 其實是 matcher 漏接的搬移。少了這道守門，13% 的迂迴會是假的，
    // 而「這個做法被推翻了」講錯的代價與誤報斷層同級。
    const { repo, write, commit } = makeRepo();
    write("src/a.ts", `${HELPER}\n`);
    commit("加入 experimentalCache");

    // 同一個函式在另一個檔案重新出現，且舊檔在**更後面**才被刪除，
    // 讓 matcher 不容易把它接成跨檔案搬移。
    write("src/moved.ts", `${HELPER}\n`);
    commit("複製到 moved.ts");
    write("src/a.ts", "export const placeholder = 1;\n");
    commit("從 a.ts 移除");

    const { db, repoId } = await index(repo);
    const report = detectExcursions(db, repoId, { scope: "repo" });
    assert.ok(report.excludedAsMoved >= 1, "內容還在別處，必須被守門擋下");
    assert.equal(
      rows(db).some((r) => r.sym === "experimentalCache"),
      false,
      "搬移不是迂迴",
    );
    db.close();
  });

  it("內容逐字未變即被移除 → A 級 inverse_diff", async () => {
    const { repo, write, remove, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/tried.ts", `${HELPER}\n`);
    commit("試一個做法");
    write("src/keep.ts", "export const keep = 2;\n");
    commit("無關的改動");
    remove("src/tried.ts");
    commit("移除那個做法");

    const { db, repoId } = await index(repo);
    detectExcursions(db, repoId, { scope: "repo" });
    const found = rows(db).find((r) => r.sym === "experimentalCache");
    assert.ok(found, "應該偵測到");
    assert.equal(found.strength, "A");
    assert.equal(found.method, "inverse_diff", "移除掉的正是當初加入的");
    db.close();
  });

  it("死於 Revert commit → A 級 git_revert", async () => {
    const { repo, write, remove, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/tried.ts", `${HELPER}\n`);
    commit("加入");
    // 內容改過，所以 inverse_diff 不成立；只有 revert 標題能給 A 級。
    write("src/tried.ts", `${HELPER.replace("% 8", "% 16")}\n`);
    commit("調整 bucket 數");
    remove("src/tried.ts");
    commit('Revert "加入"');

    const { db, repoId } = await index(repo);
    detectExcursions(db, repoId, { scope: "repo" });
    const found = rows(db).find((r) => r.sym === "experimentalCache");
    assert.ok(found);
    assert.equal(found.strength, "A");
    assert.equal(found.method, "git_revert");
    db.close();
  });

  it("活躍演化後才移除 → C 級，不得標成 A", async () => {
    // 沒有 revert、內容也改過：只有生命週期符合，沒有任何反向證據。
    // 標成 A 就是把「疑似」當成「確證」，那是這一層最不能犯的錯。
    const { repo, write, remove, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/tried.ts", `${HELPER}\n`);
    commit("加入");
    write("src/tried.ts", `${HELPER.replace("% 8", "% 16")}\n`);
    commit("調整");
    remove("src/tried.ts");
    commit("清掉不需要的東西");

    const { db, repoId } = await index(repo);
    detectExcursions(db, repoId, { scope: "repo" });
    const found = rows(db).find((r) => r.sym === "experimentalCache");
    assert.ok(found);
    assert.equal(found.strength, "C");
    assert.equal(found.method, "trajectory");
    db.close();
  });

  it("仍存活的 entity 永遠不是候選", async () => {
    const { repo, write, commit } = makeRepo();
    write("src/a.ts", `${HELPER}\n`);
    commit("加入");
    write("src/a.ts", `${HELPER}\nexport const extra = 1;\n`);
    commit("再改一次");

    const { db, repoId } = await index(repo);
    const report = detectExcursions(db, repoId, { scope: "repo" });
    assert.equal(report.candidates, 0, "還活著的東西不可能是迂迴");
    assert.equal(rows(db).length, 0);
    db.close();
  });

  it("重跑不重複寫入", async () => {
    const { repo, write, remove, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/tried.ts", `${HELPER}\n`);
    commit("加入");
    remove("src/tried.ts");
    commit("移除");

    const { db, repoId } = await index(repo);
    detectExcursions(db, repoId, { scope: "repo" });
    const first = rows(db).length;
    assert.ok(first > 0, "先確認真的有列，否則這條測試會空轉");
    // 水位線會讓第二趟整個跳過，所以要把它清掉才測得到寫入本身的冪等。
    // 少了這一步，這條測試只是在測「跳過」而不是測 ON CONFLICT。
    db.exec("DELETE FROM pass_state WHERE pass_name = 'excursion'");
    detectExcursions(db, repoId, { scope: "repo" });
    assert.equal(rows(db).length, first, "ON CONFLICT 必須讓重跑冪等");
    db.close();
  });

  it("水位線在頂端就整趟跳過，但仍照實回報既有的列", async () => {
    const { repo, write, remove, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/tried.ts", `${HELPER}\n`);
    commit("加入");
    remove("src/tried.ts");
    commit("移除");

    const { db, repoId } = await index(repo);
    const first = detectExcursions(db, repoId, { scope: "repo" });
    assert.equal(first.status, "detected");
    assert.equal(first.byStrength.A, 1);

    const second = detectExcursions(db, repoId, { scope: "repo" });
    assert.equal(second.status, "up-to-date");
    assert.equal(second.candidates, 0, "沒掃描就不該假裝掃過");
    assert.equal(second.byStrength.A, 1, "跳過不等於沒有結果，仍要讀得出既有的列");
    db.close();
  });

  it("**scope 從 lineage 升級到 repo 必須重算**，不得沿用瞎守門的結果", async () => {
    // 搬移守門在 lineage scope 下看不到別的檔案，答案可能完全相反。
    // 兩者不是同一份產出，混進同一個資料庫而不重算就違反不變量 7。
    const { repo, write, commit } = makeRepo();
    write("src/a.ts", `${HELPER}\n`);
    commit("加入");
    write("src/moved.ts", `${HELPER}\n`);
    commit("複製到 moved.ts");
    write("src/a.ts", "export const placeholder = 1;\n");
    commit("從 a.ts 移除");

    const { db, repoId } = await index(repo);
    const lineageRun = detectExcursions(db, repoId, { scope: "lineage" });
    assert.equal(lineageRun.status, "detected");

    const repoRun = detectExcursions(db, repoId, { scope: "repo" });
    assert.equal(repoRun.status, "detected", "版本不同就必須重掃，不得跳過");
    assert.ok(repoRun.candidates > 0);
    db.close();
  });

  it("**判定翻盤時舊列必須消失**——不能留著一段沒發生的歷史", async () => {
    // 先在只有一個檔案時判成迂迴，之後內容在別處出現，守門就該把它排除。
    // 若只做 ON CONFLICT upsert 而不刪，資料庫會永遠留著那條假迂迴。
    const { repo, write, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/tried.ts", `${HELPER}\n`);
    commit("加入");
    write("src/tried.ts", "export const placeholder = 1;\n");
    commit("移除");

    const { db, dbPath, repoId } = await index(repo);
    detectExcursions(db, repoId, { scope: "repo" });
    assert.equal(
      rows(db).filter((r) => r.sym === "experimentalCache").length,
      1,
      "這個階段它確實看起來像迂迴",
    );

    // 同樣的內容在後面的 commit 出現在別的檔案：那是搬移，不是迂迴。
    write("src/moved.ts", `${HELPER}\n`);
    commit("其實只是搬走了");
    const report2 = indexGit(repo, { dbPath });
    await indexRepoStructure(db, repo, report2.repoId, INDEXER_VERSION);
    const after = detectExcursions(db, repoId, { scope: "repo" });

    assert.ok(after.excludedAsMoved >= 1);
    assert.equal(
      rows(db).some((r) => r.sym === "experimentalCache"),
      false,
      "翻盤後那條假迂迴必須被刪掉，不能只是不更新",
    );
    db.close();
  });
});
