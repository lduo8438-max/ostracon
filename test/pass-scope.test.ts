import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { verifyParserAdapters } from "../src/ast/parser.ts";
import { indexGit, INDEXER_VERSION } from "../src/git/index.ts";
import { indexLineage } from "../src/index/lineage-pass.ts";
import {
  declarationIndexerVersion,
  DECLARATIONS_PASS_NAME,
  indexRepoStructure,
} from "../src/index/repo-pass.ts";
import { lineageIdAt } from "../src/index/structural.ts";
import { why } from "../src/cli/why.ts";
import { ostracised } from "../src/cli/ostracised.ts";

/**
 * 兩個結構層 pass 的候選池不同（`indexLineage` 只看一條血緣，`indexRepoStructure`
 * 看整個 commit），**同一個 entity 會拿到不同的 `stable_key`**。實測 Osiris：
 * `isRateLimited` 在 repo scope 下誕生於 `route.ts`（6 次改動），在 lineage scope
 * 下誕生於它被搬進 `ssrf-guard.ts` 的那一刻（1 次改動）。
 *
 * 混在同一個資料庫裡的後果是 `--full` 靜默無效：全 repo pass 會重算整趟、L5
 * 也確實配對到了，但每一次寫入都撞上快路徑留下的 `revision` 列而直接回傳既有 id。
 * `--db` 預設是 `.ostracon/index.db`，所以「先 why 再 why --full」這個最自然的
 * 序列不需要任何旗標就會踩到。
 */

function makeMoveRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-scope-"));
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
  // 一個構造在 route.ts 誕生、被改一次，然後**抽取**到 guard.ts——
  // route.ts 本身活下來，所以這不是 git 的改名，兩邊是不同的路徑血緣。
  //
  // 第一版寫成 `git rm route.ts` + 新增 guard.ts，git 判成改名、兩者變成同一條
  // 血緣，於是快路徑也看得見整段歷史，測試的前提檢查當場擋下來了。跨檔案搬移
  // 要真的跨血緣才是 L5 的題目。
  const limiter = (limit: number) => `export function isRateLimited(hits: number): boolean {
  const ceiling = ${limit};
  if (hits < 0) return false;
  return hits > ceiling;
}
`;
  const handler = `export function handleRequest(url: string): string {
  const trimmed = url.trim();
  return trimmed.length === 0 ? "/" : trimmed;
}
`;
  write("src/route.ts", limiter(10) + "\n" + handler);
  commit("誕生");
  write("src/route.ts", limiter(25) + "\n" + handler);
  commit("調整上限");
  write("src/route.ts", handler);
  write("src/guard.ts", limiter(25));
  commit("抽取到 guard");
  return { repo, git };
}

function freshDb(): string {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-scope-db-")), "i.db");
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.close();
  return dbPath;
}

function open(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** 每個 entity 的身份與改動次數。計數相同而身份不同一樣是壞的，所以兩個都比。 */
function shape(db: DatabaseSync): string[] {
  return (db.prepare(
    `SELECT e.stable_key AS k, COUNT(*) AS n
       FROM entity e JOIN revision r ON r.entity_id = e.id
      GROUP BY e.id ORDER BY e.stable_key`,
  ).all() as unknown as { k: string; n: number }[]).map((r) => `${r.k}:${r.n}`);
}

async function fastPass(repo: string, dbPath: string, at: string, file: string) {
  const report = indexGit(repo, { dbPath, until: at });
  const db = open(dbPath);
  const lineageId = lineageIdAt(db, report.repoId, at, file);
  assert.ok(lineageId !== undefined, `${file} 在 ${at} 沒有血緣`);
  await indexLineage(db, repo, report.repoId, lineageId, INDEXER_VERSION);
  return { db, repoId: report.repoId };
}

describe("結構層的 scope", () => {
  it("快路徑建的資料庫，--full 會作廢重建，產出與乾淨的 --full 逐一相同", async () => {
    await verifyParserAdapters();
    const { repo, git } = makeMoveRepo();
    const head = git("rev-parse", "HEAD");

    // 乾淨的全 repo pass：基準答案。
    const cleanPath = freshDb();
    const cleanReport = indexGit(repo, { dbPath: cleanPath, until: head });
    const clean = open(cleanPath);
    await indexRepoStructure(clean, repo, cleanReport.repoId, INDEXER_VERSION);
    const expected = shape(clean);
    clean.close();

    // 先跑快路徑，再跑全 repo pass——使用者實際會打的那個序列。
    const mixedPath = freshDb();
    const { db: mixed, repoId } = await fastPass(repo, mixedPath, head, "src/guard.ts");
    const fastOnly = shape(mixed);

    const pass = await indexRepoStructure(mixed, repo, repoId, INDEXER_VERSION);
    assert.equal(pass.mode, "rebuilt", "快路徑的產出必須被作廢，不能續跑");
    assert.deepEqual(shape(mixed), expected);

    // 前提檢查：兩種 scope 的答案真的不同，否則這條測試什麼都沒證明。
    assert.notDeepEqual(fastOnly, expected);
    mixed.close();
  });

  it("全 repo pass 之後的快路徑不觸發無謂重建", async () => {
    await verifyParserAdapters();
    const { repo, git } = makeMoveRepo();
    const head = git("rev-parse", "HEAD");
    const dbPath = freshDb();
    const report = indexGit(repo, { dbPath, until: head });
    const db = open(dbPath);

    await indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION);
    const before = shape(db);

    // repo scope 的產出對單一血緣的問題已經更完整，快路徑一列都插不進去。
    const lineageId = lineageIdAt(db, report.repoId, head, "src/guard.ts");
    await indexLineage(db, repo, report.repoId, lineageId!, INDEXER_VERSION);

    const again = await indexRepoStructure(db, repo, report.repoId, INDEXER_VERSION);
    assert.equal(again.mode, "incremental");
    assert.deepEqual(shape(db), before);
    db.close();
  });

  it("lineage scope 不謊稱 commit 覆蓋率", async () => {
    await verifyParserAdapters();
    const { repo, git } = makeMoveRepo();
    const head = git("rev-parse", "HEAD");
    const { db } = await fastPass(repo, freshDb(), head, "src/guard.ts");

    const row = db.prepare(
      `SELECT last_commit_id AS lastCommitId, indexer_version AS version
         FROM pass_state WHERE pass_name = ?`,
    ).get(DECLARATIONS_PASS_NAME) as
      { lastCommitId: number | null; version: string };
    // 它做完的是「這幾條血緣」而不是「到某個 commit 為止的全部」。寫一個 topo
    // 進去會是謊話，而下一趟續跑會信它。
    assert.equal(row.lastCommitId, null);
    assert.equal(row.version, declarationIndexerVersion(INDEXER_VERSION, "lineage"));
    db.close();
  });

  // 作廢重建刪掉的是使用者既有的索引。這件事在兩支指令裡都必須說出來，而
  // 「呼叫存在」與「話真的印出來」是兩件事——這個專案已經被「拿掉呼叫、
  // 全部測試照過」咬過兩次，所以走完整路徑斷言輸出，不斷言中間狀態。
  it("**why --full 的重建必須真的出現在輸出裡，而且答案要換成對的**", async () => {
    await verifyParserAdapters();
    const { repo, git } = makeMoveRepo();
    const head = git("rev-parse", "HEAD");
    const dbPath = freshDb();

    const fast = await why(repo, "src/guard.ts:isRateLimited", dbPath, head);
    assert.doesNotMatch(fast, /作廢重建/);
    // 快路徑看不到 route.ts，所以誕生記在搬移那一刻。
    assert.doesNotMatch(fast, /route\.ts/);

    const full = await why(repo, "src/guard.ts:isRateLimited", dbPath, head, { full: true });
    assert.match(full, /作廢重建/);
    assert.match(full, /route\.ts/, "重建之後必須追得回真正的誕生");
  });

  it("**ostracised 的重建也必須說出來**", async () => {
    await verifyParserAdapters();
    const { repo, git } = makeMoveRepo();
    const head = git("rev-parse", "HEAD");
    const dbPath = freshDb();

    await why(repo, "src/guard.ts:isRateLimited", dbPath, head);
    // 搬移守門在單一血緣下是瞎的，所以這支指令沒重建的話名單本身是錯的，
    // 不只是比較短——沉默的代價比 why 更高。
    assert.match(await ostracised(repo, dbPath, head), /作廢重建/);
  });

  it("外鍵關著時拒絕作廢，不留半個殘骸", async () => {
    await verifyParserAdapters();
    const { repo, git } = makeMoveRepo();
    const head = git("rev-parse", "HEAD");
    const dbPath = freshDb();
    const { db, repoId } = await fastPass(repo, dbPath, head, "src/guard.ts");
    db.close();

    // 不變量 13：foreign_keys 是每連線設定。關著的連線上做級聯刪除只會刪掉
    // 一半，留下比重建前更難察覺的殘骸。
    //
    // `node:sqlite` 目前預設就把它打開（SQLite 的 C 預設是關的），所以這道
    // 斷言是深度防禦而不是承重牆——測試必須明確關掉才試得到。留著它是因為
    // 「哪天驅動改了預設」的失敗方式是靜默的半刪除。
    const bare = new DatabaseSync(dbPath);
    bare.exec("PRAGMA foreign_keys = OFF");
    await assert.rejects(
      () => indexRepoStructure(bare, repo, repoId, INDEXER_VERSION),
      /foreign_keys/,
    );
    const survived = (bare.prepare("SELECT COUNT(*) AS n FROM revision").get() as
      { n: number }).n;
    assert.ok(survived > 0, "拒絕之後既有資料必須原封不動");
    bare.close();
  });
});
