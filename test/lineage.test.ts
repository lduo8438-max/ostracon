import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLineages } from "../src/git/lineage.ts";
import type { CommitRecord, FileChangeRecord } from "../src/git/types.ts";

let n = 0;
function c(changes: FileChangeRecord[], sha = `sha${++n}`): CommitRecord {
  return {
    sha, parents: [], authorName: "t", authorEmail: "t",
    authoredAt: "2026-01-01T00:00:00Z", committedAt: "2026-01-01T00:00:00Z",
    message: "m", isMerge: false, topoOrder: 0, changes,
  };
}
const A = (path: string): FileChangeRecord => ({ changeType: "A", path });
const M = (path: string): FileChangeRecord => ({ changeType: "M", path });
const D = (path: string): FileChangeRecord => ({ changeType: "D", path });
const R = (oldPath: string, path: string, score = 100): FileChangeRecord =>
  ({ changeType: "R", path, oldPath, score });
const C = (oldPath: string, path: string, score = 80): FileChangeRecord =>
  ({ changeType: "C", path, oldPath, score });

const lineageOf = (r: ReturnType<typeof buildLineages>, sha: string, path: string) =>
  r.changeLineage.get(`${sha}\0${path}`);

test("改名鏈維持同一血緣", () => {
  n = 0;
  const r = buildLineages([
    c([A("a.ts")], "s1"),
    c([R("a.ts", "b.ts")], "s2"),
    c([R("b.ts", "c.ts")], "s3"),
  ]);
  const id = lineageOf(r, "s1", "a.ts");
  assert.equal(lineageOf(r, "s2", "b.ts"), id);
  assert.equal(lineageOf(r, "s3", "c.ts"), id);
  assert.equal(r.segments.filter((s) => s.lineageId === id).length, 3);
  assert.equal(r.anomalies.length, 0);
});

test("刪除後同路徑重現是新血緣，不是同一個", () => {
  // 情境 10。血緣接起來的話，斷層偵測就永遠沒有機會報這個案例。
  n = 0;
  const r = buildLineages([
    c([A("x.ts")], "s1"),
    c([D("x.ts")], "s2"),
    c([A("x.ts")], "s3"),
  ]);
  const first = lineageOf(r, "s1", "x.ts");
  const second = lineageOf(r, "s3", "x.ts");
  assert.notEqual(first, second);
  const closed = r.segments.find((s) => s.lineageId === first)!;
  assert.equal(closed.toSha, "s2", "舊血緣必須在刪除的 commit 關閉");
  assert.equal(r.segments.find((s) => s.lineageId === second)!.toSha, null);
});

test("複製開新血緣，來源血緣不受影響", () => {
  n = 0;
  const r = buildLineages([
    c([A("src.ts")], "s1"),
    c([C("src.ts", "copy.ts")], "s2"),
    c([M("src.ts")], "s3"),
  ]);
  const src = lineageOf(r, "s1", "src.ts");
  assert.notEqual(lineageOf(r, "s2", "copy.ts"), src);
  assert.equal(lineageOf(r, "s3", "src.ts"), src, "來源必須延續原血緣");
});

test("同一 commit 內改名後又新增同名檔案，血緣不會被搶走", () => {
  // 這是分階段處理的理由。若先處理新增，a.ts 的血緣會被新檔案覆蓋，
  // 改名的那一端就找不到來源，整條血緣靜默斷掉。
  n = 0;
  const r = buildLineages([
    c([A("a.ts")], "s1"),
    c([R("a.ts", "b.ts"), A("a.ts")], "s2"),
  ]);
  const original = lineageOf(r, "s1", "a.ts");
  assert.equal(lineageOf(r, "s2", "b.ts"), original, "改名端應繼承原血緣");
  assert.notEqual(lineageOf(r, "s2", "a.ts"), original, "新的同名檔案必須是新血緣");
});

test("同一 commit 內的鏈式改名不會互相踩到", () => {
  n = 0;
  const r = buildLineages([
    c([A("a.ts"), A("b.ts")], "s1"),
    c([R("a.ts", "b.ts"), R("b.ts", "c.ts")], "s2"),
  ]);
  const la = lineageOf(r, "s1", "a.ts");
  const lb = lineageOf(r, "s1", "b.ts");
  assert.equal(lineageOf(r, "s2", "b.ts"), la);
  assert.equal(lineageOf(r, "s2", "c.ts"), lb);
  assert.equal(r.anomalies.length, 0);
});

test("來源不存在的改名會開新血緣並留下 anomaly", () => {
  n = 0;
  const r = buildLineages([c([R("ghost.ts", "real.ts")], "s1")]);
  assert.ok(lineageOf(r, "s1", "real.ts"));
  assert.equal(r.anomalies.length, 1);
  assert.match(r.anomalies[0]!.reason, /改名來源/);
});

test("修改不存在的路徑會開新血緣並留下 anomaly", () => {
  // 合併的 combined diff 不做改名偵測，rename-like resolution 會報成 M。
  n = 0;
  const r = buildLineages([c([M("merged.ts")], "s1")]);
  assert.ok(lineageOf(r, "s1", "merged.ts"));
  assert.equal(r.anomalies.length, 1);
});

test("純修改不製造額外 segment", () => {
  n = 0;
  const r = buildLineages([
    c([A("a.ts")], "s1"),
    c([M("a.ts")], "s2"),
    c([M("a.ts")], "s3"),
  ]);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0]!.toSha, null);
});

// ── 增量續跑 ────────────────────────────────────────────────────────────────

test("分批走訪的結果與一次走完完全相同", () => {
  n = 0;
  const all = [
    c([A("a.ts"), A("keep.ts")], "s1"),
    c([R("a.ts", "b.ts")], "s2"),
    c([M("b.ts"), D("keep.ts")], "s3"),
    c([A("keep.ts")], "s4"),
  ];
  const once = buildLineages(all);
  const first = buildLineages(all.slice(0, 2));
  const second = buildLineages(all.slice(2), first.state);

  for (const [k, v] of once.changeLineage) {
    const got = first.changeLineage.get(k) ?? second.changeLineage.get(k);
    assert.equal(got, v, `${k} 的血緣歸屬在分批與一次走完之間不一致`);
  }
  assert.equal(first.state.nextLineageId <= second.state.nextLineageId, true);
});

test("跨批次關閉前一批留下的開放段落，標記為需要 UPDATE 而非 INSERT", () => {
  n = 0;
  const first = buildLineages([c([A("a.ts")], "s1")]);
  const second = buildLineages([c([D("a.ts")], "s2")], first.state);

  const closed = second.segments.find((s) => s.path === "a.ts")!;
  assert.equal(closed.isNew, false, "上一批已寫入資料庫的段落必須走 UPDATE");
  assert.equal(closed.toSha, "s2");
  assert.equal(closed.fromSha, "s1", "必須帶著原本的 fromSha 才定位得到那一列");
});

test("續跑時新血緣的 id 不會與既有的相撞", () => {
  n = 0;
  const first = buildLineages([c([A("a.ts"), A("b.ts")], "s1")]);
  const second = buildLineages([c([A("c.ts")], "s2")], first.state);
  const firstIds = new Set(first.segments.map((s) => s.lineageId));
  const newId = second.segments.find((s) => s.path === "c.ts")!.lineageId;
  assert.equal(firstIds.has(newId), false);
});
