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
  const commit = (msg: string, dates?: { author: string; committer: string }) => {
    git("add", "-A");
    if (dates === undefined) {
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg, "--no-gpg-sign");
    } else {
      // author 與 committer 時間分開設定：長命 PR、cherry-pick 與 rebase 都會
      // 讓兩者脫鉤，而那正是 duration 用錯時鐘會變成負數的來源。
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t",
        "commit", "-qm", msg, "--no-gpg-sign"], {
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_DATE: dates.author, GIT_COMMITTER_DATE: dates.committer },
      });
    }
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
  /**
   * `duration_days` 用 `committed_at` 不是 `authored_at`（迂迴演算法 1.2.0）。
   *
   * 這一條是跑 nestjs/nest 時發現的：`ostracised` 的第一條印著
   * 「0 天　2023-02-01 → 2023-01-06」——死亡日期早於誕生日期。根因是 author
   * 時間與 commit 進入這份歷史的時間是兩個時鐘，長命 PR／cherry-pick／rebase
   * 都會讓它們脫鉤，於是相減可以是負的，再被 `Math.max(0, …)` 夾成 0。
   *
   * **而清單由短到長排序，所以那些列坐在第一個畫面的最上面**：vuejs/core 的
   * A 級前十名有十條是這種，那正是線上 demo 顯示的東西。
   */
  it("**author 與 commit 時間脫鉤時，存活天數不得被夾成 0**", async () => {
    const { repo, write, remove, commit } = makeRepo();
    write("src/util.ts", HELPER);
    // author 6 月、committer 1 月：一個寫了很久才合併進來的 PR。
    commit("引入", { author: "2020-06-01T00:00:00Z", committer: "2020-01-01T00:00:00Z" });
    remove("src/util.ts");
    write("src/keep.ts", "export const keep = 1;\n");
    // author 1 月中：早於引入的 author 時間。committer 2 月：晚於引入的 committer。
    commit("移除", { author: "2020-01-15T00:00:00Z", committer: "2020-02-01T00:00:00Z" });

    const { db, repoId } = await index(repo);
    detectExcursions(db, repoId, { scope: "repo" });
    const found = rows(db).filter((r) => r.sym === "experimentalCache");
    assert.equal(found.length, 1, "前提：這是一條迂迴");
    // committed_at 相差 31 天。用 authored_at 的話是 -138 天，會被夾成 0。
    assert.ok(
      found[0]!.days > 30 && found[0]!.days < 32,
      `存活天數應該是 31 天上下，實際 ${found[0]!.days}`,
    );
    db.close();
  });

  it("**同一個 commit 刪掉的相同內容不得互相抑制**", async () => {
    // 守門原本寫 `dc.topo_order >= ?`（死得不比我早），而同一個 commit 的
    // topo_order 相等——於是 N 份相同內容一起被刪時，每一份都認為其他的還活著，
    // 全部被排除。但它們全都消失了。刪掉一整個重複的樣板目錄正是這個模式。
    //
    // create-t3-app 實測：77 個排除裡有 65 個（84%）只被已死的 entity 抑制。
    // 最清楚的一對是兩個 380-node 的 Home，互相抑制、同死於一個 commit、
    // 終點兩個檔案都不存在。
    const { repo, write, remove, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/copy-a.ts", `${HELPER}\n`);
    write("src/copy-b.ts", `${HELPER}\n`);
    commit("兩份逐字相同的拷貝");

    // 關鍵：**同一個 commit** 刪掉兩份。
    remove("src/copy-a.ts");
    remove("src/copy-b.ts");
    commit("一次刪掉兩份");

    const { db, repoId } = await index(repo);
    const report = detectExcursions(db, repoId, { scope: "repo" });
    assert.equal(
      report.excludedAsMoved,
      0,
      "兩份都消失了，沒有任何一份活得比另一份久，不該有排除",
    );
    assert.equal(
      rows(db).filter((r) => r.sym === "experimentalCache").length,
      2,
      "兩份都必須被判為迂迴——內容確實離開了 repo",
    );
    db.close();
  });

  it("搬移後再刪除時，迂迴只報在內容真正離開的那一刻", async () => {
    // A 搬到 B（A 死）、之後 B 才死。A 被 B 抑制、B 不被抑制，
    // 所以一次放棄只報一次，而且報在正確的時間點。
    const { repo, write, remove, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/a.ts", `${HELPER}\n`);
    commit("加入");
    write("src/b.ts", `${HELPER}\n`);
    remove("src/a.ts");
    commit("搬到 b.ts");
    write("src/keep.ts", "export const keep = 2;\n");
    commit("無關的改動");
    remove("src/b.ts");
    const finalSha = commit("真正移除");

    const { db, repoId } = await index(repo);
    detectExcursions(db, repoId, { scope: "repo" });
    const found = rows(db).filter((r) => r.sym === "experimentalCache");
    assert.equal(found.length, 1, "一次放棄只該報一次");

    const at = db.prepare(
      `SELECT c.sha AS sha FROM excursion x
         JOIN git_commit c ON c.id = x.remove_commit LIMIT 1`,
    ).get() as { sha: string };
    assert.equal(at.sha, finalSha, "要報在內容真正離開 repo 的那次 commit");
    db.close();
  });

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
