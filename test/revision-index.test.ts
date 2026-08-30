import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openIndexDatabase, SCHEMA_VERSION } from "../src/git/persist.ts";
import { PREVIOUS_PATH_ENTITY_SQL } from "../src/index/structural.ts";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "ostracon-revidx-"));
}

function planOf(db: DatabaseSync, sql: string): string[] {
  return (db.prepare("EXPLAIN QUERY PLAN " + sql).all() as Array<{ detail: string }>)
    .map((r) => r.detail);
}

describe("revision 的路徑索引", () => {
  it("**`previousPathEntity` 不得全表掃描 revision**", () => {
    const dir = scratch();
    try {
      const db = openIndexDatabase(path.join(dir, "fresh.db"));
      const plan = planOf(db, PREVIOUS_PATH_ENTITY_SQL);
      db.close();
      // 這條查詢是「每一次誕生呼叫一次」。沒有索引時它掃 revision 全表——
      // angular 實測 290 萬列、1,316 ms/次，兩顆大規模 revert 各因此花掉數十分鐘。
      //
      // 斷言「計畫裡沒有 revision 的 SCAN」而不是「索引存在」：查詢被改成吃不到
      // 索引時，前者會咬，後者不會。**查詢本身是從 structural.ts 匯入的**，
      // 所以這裡驗的一定是真的會跑的那一段。
      assert.deepEqual(
        plan.filter((d) => /^SCAN r\b/.test(d)),
        [],
        `revision 被全表掃描了：\n${plan.join("\n")}`,
      );
      assert.ok(
        plan.some((d) => d.includes("idx_revision_path")),
        `沒有用到 idx_revision_path：\n${plan.join("\n")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v2 的資料庫就地遷移，不要求重建", () => {
    const dir = scratch();
    try {
      const file = path.join(dir, "v2.db");
      // 先建一個現行版本的庫，再把它倒退成 v2 的樣子：拿掉索引與版本列。
      openIndexDatabase(file).close();
      const seed = new DatabaseSync(file);
      seed.exec("DROP INDEX idx_revision_path");
      seed.exec("DELETE FROM schema_migration");
      seed.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (2, ?)")
        .run(new Date().toISOString());
      seed.close();

      // v1→v2 改了資料的存法所以拒絕；v2→v3 只加索引，**產出逐位元不變，而要求
      // 重建的代價是 angular 三小時**——所以這一段必須是遷移，不是拒絕。
      const db = openIndexDatabase(file);
      const version = (db.prepare("SELECT MAX(version) AS v FROM schema_migration")
        .get() as { v: number }).v;
      const plan = planOf(db, PREVIOUS_PATH_ENTITY_SQL);
      db.close();
      assert.equal(version, SCHEMA_VERSION);
      assert.ok(plan.some((d) => d.includes("idx_revision_path")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("沒有記錄版本的舊資料庫仍然被拒絕（資料存法不同，遷移不了）", () => {
    const dir = scratch();
    try {
      const file = path.join(dir, "v0.db");
      openIndexDatabase(file).close();
      const seed = new DatabaseSync(file);
      seed.exec("DELETE FROM schema_migration");
      seed.close();
      assert.throws(() => openIndexDatabase(file), /schema 版本/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
