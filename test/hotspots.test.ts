import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  hotspots,
  listHotspots,
  renderHotspots,
  type HotspotRow,
} from "../src/cli/hotspots.ts";
import { INSERT_CONTENT_FIXTURE, REVISION_COLUMNS, revisionValues } from "./db-fixture.ts";

/**
 * 攪動熱點：**只算真的動到結構的改動，而且是 entity 層級**。
 *
 * 兩個判準都是量出來才決定的，所以兩個都要有測試釘住：
 *
 *  - 檔案層級的熱點等於 `git log` 數 commit（實測 vuejs/core，依全部改動排檔案
 *    與依結構改動排檔案 top-10 重疊 8/10），沒有做的價值。entity 層級才不同：
 *    同一份語料前 15 名分佈在 12 個檔案，而 `renderer.ts` 一個檔案裡有三個
 *    獨立熱點。
 *  - vuejs/core 有 88.5% 的 `revision_change` 是 `none`。把那些算進攪動，
 *    分子會虛胖九倍。
 */

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-hot-"));
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

/**
 * 一個真的被重構三次的函式，配一個只被加註解的函式。
 *
 * **兩個宣告刻意放在同一個檔案。** 檔案層級的計數對它們給不出任何差別——
 * 每一次 commit 都同時碰到兩者。能分辨的只有 entity 層級加上 change_level。
 */
function makeChurnRepo() {
  const { repo, git, write, commit } = makeRepo();
  // 註解要加在**函式體內**。加在宣告外面的話宣告的位元組範圍完全沒變，
  // change_level 是 `none` 而不是 `raw`——那樣這條測試就只證明了「沒動的不算」，
  // 證明不了「只改註解的也不算」。這是前提檢查抓出來的。
  const stable = (comments: number) =>
    "export function stable(n: number): number {\n"
    + "  // 說明\n".repeat(comments)
    + "  return n + 1;\n}\n";
  const churned = [
    "export function churned(xs: number[]): number {\n"
    + "  let total = 0;\n  for (const x of xs) total += x;\n  return total;\n}\n",
    "export function churned(xs: number[]): number {\n"
    + "  return xs.reduce((a, b) => a + b, 0);\n}\n",
    "export function churned(xs: number[]): number {\n"
    + "  if (xs.length === 0) return 0;\n"
    + "  return xs.reduce((a, b) => a + b, 0);\n}\n",
    "export function churned(xs: number[]): number {\n"
    + "  if (xs.length === 0) return 0;\n"
    + "  let total = 0;\n"
    + "  for (const x of xs) {\n    if (x > 0) total += x;\n  }\n"
    + "  return total;\n}\n",
  ];
  for (const [index, body] of churned.entries()) {
    // 每一次 commit 都同時改兩個宣告：churned 動結構，stable 只多一行註解。
    write("src/a.ts", `${stable(index)}\n${body}`);
    commit(`第 ${index + 1} 版`);
  }
  return { repo, head: git("rev-parse", "HEAD") };
}

const freshDb = () =>
  path.join(mkdtempSync(path.join(tmpdir(), "ostracon-hot-db-")), "i.db");

const row = (over: Partial<HotspotRow> = {}): HotspotRow => ({
  stableKey: "k",
  path: "src/a.ts",
  symbol: "fn",
  structural: 1,
  observed: 1,
  days: 10,
  firstAt: "2026-01-01T00:00:00Z",
  lastAt: "2026-01-11T00:00:00Z",
  dead: false,
  ...over,
});

describe("攪動熱點", () => {
  it("**只有動到結構的改動算攪動，碰過但沒變的不算**", async () => {
    await verifyParserAdaptersOnce();
    const { repo, head } = makeChurnRepo();
    const dbPath = freshDb();
    const out = await hotspots(repo, dbPath, head, { limit: 10 });

    // churned 被重構三次；stable 從頭到尾只多了註解。
    assert.match(out, /src\/a\.ts:churned/);
    assert.doesNotMatch(
      out,
      /src\/a\.ts:stable/,
      "只加註解的宣告不得出現在攪動名單裡——那是 raw 級改動，不是重構",
    );

    // **前提檢查**：stable 真的被記了好幾次改動，只是沒有一次是 shape。
    // 少了這一段，上面那條斷言在「stable 根本沒進索引」時也會通過，
    // 於是測試證明的是索引壞掉而不是判準正確。
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const levels = db.prepare(
      `SELECT rc.change_level AS level, COUNT(*) AS n
         FROM revision_change rc
         JOIN revision r ON r.id = COALESCE(rc.next_revision, rc.prev_revision)
         JOIN slot s ON s.id = r.slot_id
        WHERE s.qualified_name = 'stable'
        GROUP BY rc.change_level`,
    ).all() as unknown as Array<{ level: string; n: number }>;
    db.close();
    const total = levels.reduce((sum, l) => sum + l.n, 0);
    assert.ok(total >= 3, `stable 應該被觀察過多次，實際 ${total}`);
    assert.equal(
      levels.find((l) => l.level === "shape"),
      undefined,
      "stable 不該有任何 shape 級改動，否則這條測試的前提不成立",
    );
    assert.ok(
      levels.some((l) => l.level === "raw"),
      "stable 應該有 raw 級改動（只多了註解）",
    );
  });

  it("**母數、抑制數量與清單來自同一份資料**", () => {
    const rows = [
      row({ symbol: "hot", structural: 9 }),
      row({ symbol: "spec", path: "src/__tests__/a.spec.ts", structural: 8 }),
      row({ symbol: "warm", structural: 7 }),
    ];
    const text = renderHotspots(rows, { limit: 1 });
    // 母數是「排除測試檔之後」的 2，不是全部的 3，也不是被 limit 截成的 1。
    assert.match(text, /^2 個宣告動過結構；以下是攪動最高的 1 個/m);
    assert.match(text, /另有 1 條在測試檔裡/);
    assert.match(text, /src\/a\.ts:hot/);
    assert.doesNotMatch(text, /warm/, "limit 之外的不印");
  });

  it("測試檔預設排除，--include-tests 看得回來", () => {
    const rows = [
      row({ symbol: "spec", path: "src/__tests__/a.spec.ts", structural: 9 }),
      row({ symbol: "hot", structural: 7 }),
    ];
    assert.doesNotMatch(renderHotspots(rows, { limit: 5 }), /a\.spec\.ts/);
    const all = renderHotspots(rows, { limit: 5, includeTests: true });
    assert.match(all, /a\.spec\.ts:spec/);
    assert.doesNotMatch(all, /另有 .* 在測試檔裡/, "全部都顯示時不該再報抑制");
  });

  /**
   * 速率排名量過並否決：`createRenderer.processSuspense` 9 次改動除以 52 天
   * 等於每年 63 次，會排在 `compileScript` 217 次之上。小分母的陷阱這個專案
   * 已經踩過一次（稀疏度的分母把「沒動」算成改動），不再踩第二次。
   *
   * **這條必須打在查詢上，不能打在 renderHotspots 上。** 排序發生在 SQL，
   * 而純函式只是照著印——第一版寫成對 `renderHotspots` 斷言，把 ORDER BY 改成
   * 速率之後它照樣通過，是一道什麼都沒守到的假閘門。
   */
  it("**排序是絕對次數，不是速率**", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
    // longLived：4 次結構改動攤在 2,000 天。shortBurst：2 次擠在 5 天。
    // 依絕對次數 longLived 在前；依速率則相反（0.002/天 vs 0.4/天）。
    const commits = [
      [1, "2020-01-01"], [2, "2020-01-06"],
      [3, "2020-01-01"], [4, "2025-06-24"],
      [5, "2021-01-01"], [6, "2022-01-01"],
    ].map(([id, at]) =>
      `(${id}, 1, 'c${id}', '${at}', '${at}', 'm', ${id})`).join(",");
    db.exec(
      `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/r', '2020-01-01');
       INSERT INTO path_lineage (id, repo_id) VALUES (1, 1);
       INSERT INTO git_commit
         (id, repo_id, sha, authored_at, committed_at, message, topo_order)
         VALUES ${commits};
       INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind) VALUES
         (1, 1, 1, 'shortBurst', 'function'), (2, 1, 1, 'longLived', 'function');
       INSERT INTO entity (id, repo_id, stable_key, birth_commit_id) VALUES
         (1, 1, 'k1', 1), (2, 1, 'k2', 3);
       ${INSERT_CONTENT_FIXTURE}
       INSERT INTO revision ${REVISION_COLUMNS} VALUES
         ${revisionValues({ id: 1, commitId: 1, slotId: 1, entityId: 1 })},
         ${revisionValues({ id: 2, commitId: 2, slotId: 1, entityId: 1 })},
         ${revisionValues({ id: 3, commitId: 3, slotId: 2, entityId: 2 })},
         ${revisionValues({ id: 4, commitId: 4, slotId: 2, entityId: 2 })},
         ${revisionValues({ id: 5, commitId: 5, slotId: 2, entityId: 2 })},
         ${revisionValues({ id: 6, commitId: 6, slotId: 2, entityId: 2 })};
       INSERT INTO revision_change
         (id, next_revision, commit_id, entity_id, change_level) VALUES
         (1, 1, 1, 1, 'shape'), (2, 2, 2, 1, 'shape'),
         (3, 3, 3, 2, 'shape'), (4, 4, 4, 2, 'shape'),
         (5, 5, 5, 2, 'shape'), (6, 6, 6, 2, 'shape');`,
    );
    const rows = listHotspots(db, 1);
    db.close();
    assert.deepEqual(
      rows.map((r) => r.symbol),
      ["longLived", "shortBurst"],
      "高頻短命的不得壓過高量長命的",
    );
    // 前提檢查：速率確實是相反的順序，否則這條測試分辨不出兩種排法。
    const rate = (r: HotspotRow) => r.structural / Math.max(r.days, 1);
    assert.ok(
      rate(rows[1]!) > rate(rows[0]!),
      "前提不成立：shortBurst 的速率必須高於 longLived",
    );
  });

  it("已消亡的要標出來", () => {
    assert.match(renderHotspots([row({ dead: true })], { limit: 5 }), /已消亡/);
    assert.doesNotMatch(renderHotspots([row()], { limit: 5 }), /已消亡/);
  });

  it("沒有任何結構改動時說得清楚，不印一份空清單", () => {
    assert.match(renderHotspots([], { limit: 5 }), /沒有任何宣告動過結構/);
  });
});

/** parser 的自檢只需要跑一次，但每個 it 都可能先到。 */
let verified: Promise<void> | undefined;
async function verifyParserAdaptersOnce(): Promise<void> {
  verified ??= (async () => {
    const { verifyParserAdapters } = await import("../src/ast/parser.ts");
    await verifyParserAdapters();
  })();
  return verified;
}
