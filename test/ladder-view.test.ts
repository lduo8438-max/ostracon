import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { discontinuitiesFor, ladderStats } from "../src/ui/data.ts";
import {
  DISCONTINUITIES_PATH,
  LADDER_PATH,
  startUiServer,
} from "../src/ui/server.ts";
import { exportStaticSite } from "../src/ui/export.ts";
import { INSERT_CONTENT_FIXTURE, REVISION_COLUMNS, revisionValues } from "./db-fixture.ts";

const K = (n: number) => String(n).padStart(64, "0");

/**
 * 一個小語料：三個 entity、四顆 commit，涵蓋每一層都要驗到的形狀——
 * L1（bucket 唯一）、L3c（內容等價類 > 1 但位置唯一）、L5（跨檔案搬移），
 * 外加兩條斷層：一條比較得出相似度、一條比較不了。
 */
function fixtureDb(): string {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-ladder-")), "i.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const rev = (
    id: number,
    commitId: number,
    extra: { path?: string; slotId?: number; entityId?: number; lineageId?: number },
  ) => revisionValues({ id, commitId, ...extra });
  db.exec(`
    INSERT INTO repo (id, root_path, created_at) VALUES (1, '/tmp/x', '2026-01-01');
    INSERT INTO git_commit (id, repo_id, sha, authored_at, committed_at, message, topo_order)
      VALUES (1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', '2026-01-01', '2026-01-01', 'feat: start', 1),
             (2, 1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2', '2026-01-02', '2026-01-02', 'refactor: tidy up', 2),
             (3, 1, 'ccccccccccccccccccccccccccccccccccccccc3', '2026-01-03', '2026-01-03', 'refactor: move helper to utils', 3),
             (4, 1, 'ddddddddddddddddddddddddddddddddddddddd4', '2026-01-04', '2026-01-04', 'feat: replace the body wholesale', 4);
    INSERT INTO path_lineage (id, repo_id) VALUES (1, 1), (2, 1), (3, 1);
    INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind)
      VALUES (1, 1, 1, 'helper', 'function'),
             (2, 1, 2, 'helper', 'function'),
             (3, 1, 1, 'shared', 'function'),
             (4, 1, 3, 'helper', 'function');
    INSERT INTO entity (id, repo_id, stable_key, birth_commit_id)
      VALUES (1, 1, '${K(1)}', 1), (2, 1, '${K(2)}', 3),
             (3, 1, '${K(3)}', 4), (4, 1, '${K(4)}', 4);
    ${INSERT_CONTENT_FIXTURE}
    INSERT INTO revision ${REVISION_COLUMNS} VALUES
      ${rev(1, 1, { path: "a.ts" })},
      ${rev(2, 2, { path: "a.ts" })},
      ${rev(3, 3, { path: "b.ts", slotId: 2, entityId: 1, lineageId: 2 })},
      ${rev(4, 3, { path: "a.ts", slotId: 3, entityId: 2 })},
      ${rev(5, 4, { path: "a.ts", slotId: 3, entityId: 3 })},
      ${rev(6, 4, { path: "a.ts", slotId: 4, entityId: 4, lineageId: 3 })};
    INSERT INTO revision_match (prev_revision, next_revision, tier, accepted, ambiguity_size)
      VALUES (1, 2, 'L1', 1, 1);
    INSERT INTO revision_match (prev_revision, next_revision, tier, accepted, ambiguity_size)
      VALUES (2, 4, 'L3c', 1, 4);
    INSERT INTO revision_match
      (prev_revision, next_revision, tier, accepted, ambiguity_size, exact_jaccard, exact_verified)
      VALUES (2, 3, 'L5', 1, 1, 0.875, 1);
    -- **L5 但路徑相同**：檔案被刪掉之後又以同名重建，那是新的血緣、同一個路徑。
    -- 配對成立（內容確實延續），但它**不是搬移**——畫面說「從 a.ts 搬到 a.ts」
    -- 是胡說。這一列存在就是為了讓那道守門有東西可守。
    INSERT INTO revision_match
      (prev_revision, next_revision, tier, accepted, ambiguity_size, exact_jaccard, exact_verified)
      VALUES (2, 6, 'L5', 1, 1, 0.910, 1);
    -- 兩條斷層：一條比較得出來、一條比較不了。**NULL 與 0 不可混為一談。**
    INSERT INTO slot_discontinuity (slot_id, commit_id, prev_entity, next_entity, similarity)
      VALUES (3, 4, 2, 3, 0.0);
    INSERT INTO slot_discontinuity (slot_id, commit_id, prev_entity, next_entity, similarity)
      VALUES (1, 2, 1, 1, NULL);
  `);
  db.close();
  return dbPath;
}

const open = (p: string) => {
  const db = new DatabaseSync(p, { readOnly: true });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
};

describe("匹配階梯的資料層", () => {
  it("**同一個欄位在不同層是不同的意思，payload 要自己講清楚**", () => {
    const view = ladderStats(open(fixtureDb()), 1);
    const byTier = new Map(view.tiers.map((t) => [t.tier, t]));
    // 走到 L3c 恰恰是因為內容 bucket 不唯一（這裡是 4），唯一的是位置。
    // 叫它「曖昧」會逐字為真而意思相反。
    assert.equal(byTier.get("L3c")!.multiCandidate, 1);
    assert.equal(byTier.get("L3c")!.ambiguityMeaning, "content-class-size");
    assert.equal(byTier.get("L1")!.ambiguityMeaning, "unique-by-construction");
    assert.equal(byTier.get("L5")!.ambiguityMeaning, "tied-candidates");
  });

  it("**L1–L3b 的多候選數必定是 0**（不變量 4：雙端 bucket 唯一才接受）", () => {
    const view = ladderStats(open(fixtureDb()), 1);
    for (const tier of view.tiers) {
      if (tier.ambiguityMeaning !== "unique-by-construction") continue;
      assert.equal(
        tier.multiCandidate,
        0,
        tier.tier + " 有多候選的接受紀錄——那違反雙端 bucket 唯一性",
      );
    }
  });

  it("精確驗證數對 L1–L3c 是 null 而不是 0", () => {
    const view = ladderStats(open(fixtureDb()), 1);
    const byTier = new Map(view.tiers.map((t) => [t.tier, t]));
    // 填 0 會被讀成「一次都沒驗證」，但那幾層根本沒有「驗證」這回事。
    assert.equal(byTier.get("L1")!.verified, null);
    assert.equal(byTier.get("L3c")!.verified, null);
    assert.equal(byTier.get("L5")!.verified, 2);
  });

  it("**跨檔案搬移只收路徑真的變了的那些**", () => {
    const view = ladderStats(open(fixtureDb()), 1);
    // fixture 裡有兩條 L5：一條真的換了檔案，一條是同名重建（新血緣、同路徑）。
    // 後者配對成立但不是搬移——說「從 a.ts 搬到 a.ts」是胡說。
    assert.equal(view.crossFileTotal, 1);
    assert.equal(view.moves.length, 1);
    const move = view.moves[0]!;
    assert.equal(move.fromPath, "a.ts");
    assert.equal(move.toPath, "b.ts");
    assert.equal(move.exactJaccard, 0.875);
    // 主旨是第一行，不是整封訊息。
    assert.equal(move.subject, "refactor: move helper to utils");
  });

  it("總數是全 repo 的配對數，不隨清單上限裁切", () => {
    const view = ladderStats(open(fixtureDb()), 1, 0);
    assert.equal(view.moves.length, 0, "上限 0 應該不回任何一筆");
    assert.equal(view.crossFileTotal, 1, "但總數不受上限影響");
    assert.equal(view.totalAccepted, 4);
  });
});

describe("身份斷層的資料層", () => {
  it("**相似度的 NULL 與 0 不可混為一談**", () => {
    const view = discontinuitiesFor(open(fixtureDb()), 1);
    assert.equal(view.total, 2);
    // NULL = 舊內容無法解析，沒有可比較的 token 集合。
    // 0 = 確實比較過且完全無交集。前者是沒有證據，後者是最強的負證據。
    assert.equal(view.incomparable, 1);
    const similarities = view.rows.map((r) => r.similarity).sort();
    assert.deepEqual(similarities, [0, null]);
  });

  it("路徑取的是斷層發生當下那一版，不是現在的路徑", () => {
    const view = discontinuitiesFor(open(fixtureDb()), 1);
    const row = view.rows.find((r) => r.similarity === 0)!;
    assert.equal(row.path, "a.ts");
    assert.equal(row.symbol, "shared");
    assert.equal(row.subject, "feat: replace the body wholesale");
  });
});

describe("兩個新端點在伺服器與靜態匯出上是同一組 URL", () => {
  it("伺服器回得出來", async () => {
    const { url: base, server } = await startUiServer({ dbPath: fixtureDb(), port: 0 });
    try {
      for (const url of [LADDER_PATH, DISCONTINUITIES_PATH]) {
        const response = await fetch(base.replace(/\/$/, "") + url);
        assert.equal(response.status, 200, url);
        assert.ok(await response.json());
      }
    } finally {
      server.close();
    }
  });

  it("**靜態匯出寫出同名檔案**——頁面不需要知道自己跑在哪一種上面", () => {
    const out = mkdtempSync(path.join(tmpdir(), "ostracon-ladder-out-"));
    exportStaticSite(open(fixtureDb()), out, { label: "fixture" });
    for (const url of [LADDER_PATH, DISCONTINUITIES_PATH]) {
      const file = path.join(out, url.replace(/^\//, ""));
      const body = JSON.parse(readFileSync(file, "utf8"));
      assert.ok(body, url + " 沒有被匯出");
    }
  });
});
