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
  assertExcursionScope,
  detectExcursions,
} from "../src/index/excursion.ts";
import { indexRepoStructure } from "../src/index/repo-pass.ts";
import { lineageIdAt, lineagesEverAt } from "../src/index/structural.ts";
import {
  isTestDeclaration,
  listOstracised,
  renderOstracised,
  type OstracisedRow,
} from "../src/cli/ostracised.ts";
import { why } from "../src/cli/why.ts";

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-gone-"));
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

async function indexAll(repo: string) {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-gone-db-")), "i.db");
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

const HELPER = `export function experimentalCache(key: string): string {
  const normalized = key.trim().toLowerCase();
  const bucket = normalized.length % 8;
  return \`cache-\${bucket}-\${normalized}\`;
}`;

const listRow = (over: Partial<OstracisedRow> = {}): OstracisedRow => ({
  stableKey: "k1",
  strength: "A",
  method: "inverse_diff",
  durationDays: 100,
  path: "src/gone.ts",
  symbol: "gone",
  bornAt: "2024-01-01T00:00:00Z",
  diedAt: "2024-04-10T00:00:00Z",
  diedSha: "a".repeat(40),
  diedSubject: "移除",
  ...over,
});

describe("renderOstracised（純函式）", () => {
  it("A 與 C 必須分段，且 C 那段標明未經證實", () => {
    // 混在同一份清單裡就是把疑似當確證呈現。
    const text = renderOstracised([
      listRow({ strength: "A", symbol: "確證的" }),
      listRow({ strength: "C", method: "trajectory", symbol: "疑似的" }),
    ]);
    assert.match(text, /A 確證（1）/);
    assert.match(text, /C 疑似（1）：僅生命週期符合，未經證實，不得當成結論/);
    assert.ok(
      text.indexOf("確證的") < text.indexOf("疑似的"),
      "A 段必須在 C 段之前",
    );
  });

  it("空清單要說明那通常是語料的性質，不是查詢失敗", () => {
    const text = renderOstracised([]);
    assert.match(text, /沒有找到被推翻的做法/);
    assert.match(text, /語料/);
  });

  it("**過濾時標頭不得暗示沒查的那一段是零**", () => {
    // `--strength C` 印出「A 確證 0」會被讀成「這個 repo 沒有 A 級的」，
    // 但實際上 create-t3-app 有 71 條。沒查與沒有是兩件事。
    const text = renderOstracised([listRow({ strength: "C" })], { strength: "C" });
    assert.match(text, /1 個 C 級的紀錄（已用 --strength 過濾）/);
    assert.doesNotMatch(text, /A 確證 0/);
    const empty = renderOstracised([], { strength: "A" });
    assert.match(empty, /沒有 A 級的紀錄/);
    assert.doesNotMatch(empty, /語料/, "過濾出空集合不代表語料沒有痕跡");
  });

  it("每一條都給得出 why 的座標，否則名單點不進去", () => {
    const text = renderOstracised([listRow({ path: "a/b.ts", symbol: "Foo" })]);
    assert.match(text, /a\/b\.ts:Foo/);
    assert.match(text, /why <path>:<symbol> --full/);
  });
});

describe("已消失的構造：定址與清單", () => {
  it("**已刪除的路徑必須查得到**——迂迴的定義就是已經消失", async () => {
    const { repo, write, remove, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/tried.ts", `${HELPER}\n`);
    commit("試一個做法");
    remove("src/tried.ts");
    commit("移除那個做法");
    // **終點必須在刪除之後。** 停在刪除 commit 上時 `file_change` 裡還有那個路徑，
    // `lineageIdAt` 照樣解析得到——那不是「已消失」的情境，測不到 fallback。
    write("src/keep.ts", "export const keep = 2;\n");
    const tip = commit("後續的無關改動");

    const { db, dbPath, repoId } = await indexAll(repo);
    // 前提：舊的解析方式在這裡必然失敗，否則這條測試沒有在測東西。
    assert.equal(
      lineageIdAt(db, repoId, tip, "src/tried.ts"),
      undefined,
      "路徑已刪除，lineageIdAt 本來就該回 undefined",
    );
    assert.equal(lineagesEverAt(db, repoId, tip, "src/tried.ts").length, 1);
    detectExcursions(db, repoId, { scope: "repo" });
    db.close();

    const text = await why(repo, "src/tried.ts:experimentalCache", dbPath, tip, {
      full: true,
    });
    assert.match(text, /已經不存在/, "不說的話會被讀成「這個檔案還在」");
    assert.match(text, /這個做法被推翻了/);
  });

  it("**路徑被刪除後又重建時，兩條血緣都要列出**，不替使用者挑一條", async () => {
    // 挑「最近的一條」會讓更早的整段歷史靜默消失，那與誤報斷層同級：
    // 它讓使用者相信一段不完整的歷史。與 entitiesFor 面對同名多實體的處理一致。
    const { repo, write, remove, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/twice.ts", `${HELPER}\n`);
    commit("第一次");
    remove("src/twice.ts");
    commit("刪掉");
    write("src/twice.ts", `${HELPER.replace("% 8", "% 32")}\n`);
    commit("又建回來");
    remove("src/twice.ts");
    commit("再刪一次");
    write("src/keep.ts", "export const keep = 2;\n");
    const tip = commit("後續的無關改動");

    const { db, dbPath, repoId } = await indexAll(repo);
    const all = lineagesEverAt(db, repoId, tip, "src/twice.ts");
    assert.equal(all.length, 2, "同一路徑被兩條血緣先後佔用");
    detectExcursions(db, repoId, { scope: "repo" });
    db.close();

    const text = await why(repo, "src/twice.ts:experimentalCache", dbPath, tip, {
      full: true,
    });
    assert.match(text, /2 條血緣先後佔用過/);
    assert.match(text, /不替你挑一條/);
    // 兩條血緣各自的 entity 都要出現，一條都不能被吃掉。
    assert.equal(
      text.match(/^entity /gm)?.length,
      2,
      "兩個實體都必須列出來",
    );
  });

  it("路徑還活著時走原本的解析，不受 fallback 影響", async () => {
    const { repo, write, commit } = makeRepo();
    write("src/live.ts", `${HELPER}\n`);
    const tip = commit("加入");

    const { db, dbPath, repoId } = await indexAll(repo);
    assert.notEqual(
      lineageIdAt(db, repoId, tip, "src/live.ts"),
      undefined,
      "活著的路徑必須由 lineageIdAt 命中",
    );
    db.close();

    const text = await why(repo, "src/live.ts:experimentalCache", dbPath, tip, {
      full: true,
    });
    assert.doesNotMatch(text, /已經不存在/);
    assert.doesNotMatch(text, /血緣先後佔用/);
  });

  it("清單依強度分組並可過濾，排序是確定的", async () => {
    const { repo, write, remove, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/a.ts", `${HELPER}\n`);
    commit("加入 A");
    write("src/b.ts", `${HELPER.replace("experimentalCache", "otherThing")}\n`);
    commit("加入 B");
    write("src/b.ts", `${HELPER.replace("experimentalCache", "otherThing").replace("% 8", "% 4")}\n`);
    commit("改過 B");
    remove("src/a.ts");
    remove("src/b.ts");
    commit("兩個都移除");

    const { db, repoId } = await indexAll(repo);
    detectExcursions(db, repoId, { scope: "repo" });

    const all = listOstracised(db, repoId);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((r) => r.strength), ["A", "C"], "A 排在 C 之前");
    assert.equal(listOstracised(db, repoId, { strength: "A" }).length, 1);
    assert.equal(listOstracised(db, repoId, { strength: "C" }).length, 1);
    // 重複查詢必須逐欄相同——排序不確定的話 demo 每次跑都不一樣。
    assert.deepEqual(listOstracised(db, repoId), all);
    db.close();
  });

  it("**scope 不是 repo 就拒絕輸出清單**，不給半套名單", async () => {
    // 搬移守門瞎掉時名單會混進只是被搬走的東西（實測 41%），而使用者無從分辨
    // 名單是完整的還是殘缺的——錯的那一半看起來與對的一模一樣。
    const { repo, write, remove, commit } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/tried.ts", `${HELPER}\n`);
    commit("加入");
    remove("src/tried.ts");
    commit("移除");

    const { db, repoId } = await indexAll(repo);
    assert.throws(
      () => assertExcursionScope(db, repoId),
      /還沒跑過迂迴偵測/,
      "沒跑過就該直說",
    );

    detectExcursions(db, repoId, { scope: "lineage" });
    assert.throws(
      () => assertExcursionScope(db, repoId),
      /搬移守門必須看得到整個 repo/,
    );

    detectExcursions(db, repoId, { scope: "repo" });
    assert.doesNotThrow(() => assertExcursionScope(db, repoId));
    db.close();
  });
});

describe("名單的排序與測試檔", () => {
  const row = (over: Partial<OstracisedRow> = {}): OstracisedRow => ({
    stableKey: "k1",
    strength: "A",
    method: "inverse_diff",
    durationDays: 5,
    path: "src/a.ts",
    symbol: "alpha",
    bornAt: "2026-01-01T00:00:00Z",
    diedAt: "2026-01-06T00:00:00Z",
    diedSha: "aaaaaaaaaaaa",
    diedSubject: "drop it",
    ...over,
  });

  it("**測試檔的宣告預設不在名單裡**", () => {
    // 實測 vuejs/core 的 A 級 710 條裡有 173 條（24%）是 __tests__ 的
    // App.render / testRender.makeApp 這類。它們確實誕生又消亡，
    // 但沒有人「試過這個設計然後推翻它」。
    const out = renderOstracised([
      row({ symbol: "realThing" }),
      row({ path: "packages/x/__tests__/render.spec.ts", symbol: "App.render" }),
    ]);
    assert.match(out, /realThing/);
    assert.doesNotMatch(out, /App\.render/);
  });

  it("**排除不得靜默**", () => {
    // 整段藏起來的話，使用者會以為這個 repo 的試錯比實際少。
    const out = renderOstracised([
      row({ symbol: "realThing" }),
      row({ path: "packages/x/__tests__/render.spec.ts", symbol: "App.render" }),
    ]);
    assert.match(out, /另有 1 條在測試檔裡/);
    assert.match(out, /--include-tests/);
  });

  it("`--include-tests` 看得回來", () => {
    const rows = [row({ path: "src/__tests__/a.spec.ts", symbol: "App.render" })];
    assert.match(renderOstracised(rows, { includeTests: true }), /App\.render/);
  });

  it("全部都是測試檔時仍要說明，而不是回報「沒有」", () => {
    const out = renderOstracised([
      row({ path: "src/__tests__/a.spec.ts", symbol: "App.render" }),
    ]);
    assert.match(out, /沒有找到被推翻的做法/);
    assert.match(out, /另有 1 條在測試檔裡/);
  });

  it("測試檔的判準只認路徑上的測試位置", () => {
    assert.equal(isTestDeclaration(row({ path: "packages/a/__tests__/x.spec.ts" })), true);
    assert.equal(isTestDeclaration(row({ path: "src/x.test.ts" })), true);
    assert.equal(isTestDeclaration(row({ path: "e2e/flow.ts" })), true);
    // 產品程式碼不得被誤殺——`latest.ts` 結尾是 test 但不是測試檔。
    assert.equal(isTestDeclaration(row({ path: "src/latest.ts" })), false);
    assert.equal(isTestDeclaration(row({ path: "src/protest/x.ts" })), false);
    assert.equal(isTestDeclaration(row({ path: "src/contest.ts" })), false);
  });
});
