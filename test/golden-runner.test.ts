import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { evaluateFixtureCase } from "../src/golden/evaluate.ts";
import {
  buildGoldenReport,
  exitCodeForReport,
  formatGoldenReport,
  type CaseEvaluation,
} from "../src/golden/report.ts";

const c = (
  id: string,
  status: "pass" | "fail" | "missing",
  difficulty: "easy" | "hard" | "adversarial" = "hard",
): CaseEvaluation => ({
  id,
  kind: "change_level",
  difficulty,
  polarity: "neutral",
  status,
  binary: {
    expected: "shape",
    actual: status === "missing" ? null : status === "pass" ? "shape" : "alpha",
  },
});

test("pass / fail / missing 三態分開，覆蓋率是頭條數字", () => {
  const report = buildGoldenReport([c("p", "pass"), c("f", "fail"), c("m", "missing")]);
  assert.deepEqual(report.summary, {
    total: 3,
    evaluated: 2,
    pass: 1,
    fail: 1,
    missing: 1,
    coverage: 2 / 3,
    passRate: 1 / 2,
  });
  assert.match(formatGoldenReport(report), /^覆蓋率 2\/3/);
});

test("空資料庫語意：0 條被評估不是測試失敗，退出碼為 0", () => {
  const report = buildGoldenReport([c("a", "missing"), c("b", "missing")]);
  assert.equal(report.summary.evaluated, 0);
  assert.equal(report.summary.passRate, null);
  assert.equal(exitCodeForReport(report), 0);
});

test("missing 超過兩成時所有比率標成不可解讀", () => {
  const report = buildGoldenReport([
    c("a", "pass"), c("b", "pass"), c("c", "pass"), c("d", "missing"),
  ]);
  assert.equal(report.interpretable, false);
  assert.match(report.warnings[0]!, /不可解讀/);
});

test("新增覆蓋帶進 fail 不算迴歸，不比較彙總率", () => {
  const baseline = { cases: [c("old", "pass"), c("new", "missing")] };
  const report = buildGoldenReport([c("old", "pass"), c("new", "fail")], baseline);
  assert.equal(report.summary.passRate, 0.5);
  assert.deepEqual(report.regressions, []);
  assert.equal(exitCodeForReport(report), 0);
});

test("只有基準 pass 變成 fail 或 missing 才算逐案例迴歸", () => {
  const baseline = { cases: [c("failed", "pass"), c("lost", "pass")] };
  const report = buildGoldenReport(
    [c("failed", "fail"), c("lost", "missing")],
    baseline,
  );
  assert.deepEqual(
    report.regressions.map((r) => [r.id, r.current]),
    [["failed", "fail"], ["lost", "missing"]],
  );
  assert.equal(exitCodeForReport(report), 1);
});

test("easy 層不進迴歸閘門", () => {
  const baseline = { cases: [c("easy", "pass", "easy")] };
  const report = buildGoldenReport([c("easy", "fail", "easy")], baseline);
  assert.deepEqual(report.regressions, []);
});

test("binary.expected/actual 是結構化欄位，missing 不可偷偷帶 actual", () => {
  const invalid = c("bad", "missing");
  invalid.binary.actual = "從訊息解析出來的值";
  assert.throws(() => buildGoldenReport([invalid]), /actual 必須是 null/);
});

test("discontinuity 以 commit + path + symbol 精確對到新 slot", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE git_commit (id INTEGER PRIMARY KEY, sha TEXT);
    CREATE TABLE slot (id INTEGER PRIMARY KEY, qualified_name TEXT);
    CREATE TABLE revision (
      id INTEGER PRIMARY KEY,
      commit_id INTEGER,
      slot_id INTEGER,
      entity_id INTEGER,
      path TEXT
    );
    CREATE TABLE slot_discontinuity (
      slot_id INTEGER,
      commit_id INTEGER,
      next_entity INTEGER
    );
    INSERT INTO git_commit VALUES (1, 'recreated');
    INSERT INTO slot VALUES (10, 'checkRate');
    INSERT INTO revision VALUES (20, 1, 10, 200, 'scanner/server.js');
    INSERT INTO slot_discontinuity VALUES (10, 1, 200);
  `);
  const fixture = (symbol: string, expect: "present" | "absent") => ({
    id: `dis-${symbol}`,
    kind: "discontinuity",
    difficulty: "easy" as const,
    expect,
    slot: { path: "scanner/server.js", symbol },
    at_commit: "recreated",
  });
  assert.equal(evaluateFixtureCase(db, fixture("checkRate", "present")).status, "pass");
  assert.equal(evaluateFixtureCase(db, fixture("server", "absent")).status, "pass");
  db.close();
});

test("lineage expect=absent 直接檢查結構化 match，不從訊息猜 precision", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE git_commit (id INTEGER PRIMARY KEY, sha TEXT);
    CREATE TABLE slot (
      id INTEGER PRIMARY KEY,
      qualified_name TEXT,
      disambiguator TEXT
    );
    CREATE TABLE revision (
      id INTEGER PRIMARY KEY,
      commit_id INTEGER,
      slot_id INTEGER,
      path TEXT,
      byte_start INTEGER
    );
    CREATE TABLE revision_match (
      prev_revision INTEGER,
      next_revision INTEGER,
      tier TEXT,
      accepted INTEGER
    );
    INSERT INTO git_commit VALUES (1, 'prev'), (2, 'next');
    INSERT INTO slot VALUES
      (1, 'Dashboard.fetchEndpoint', '2'),
      (2, 'Dashboard.fetchEndpoint', '0');
    INSERT INTO revision VALUES
      (10, 1, 1, 'src/app/page.tsx', 100),
      (20, 2, 2, 'src/app/page.tsx', 200);
    INSERT INTO revision_match VALUES (10, 20, 'L4', 1);
  `);
  const fixture = {
    id: "negative",
    kind: "lineage",
    difficulty: "adversarial" as const,
    expect: "absent",
    chain: [
      {
        anchor: {
          commit: "prev",
          path: "src/app/page.tsx",
          symbol: "Dashboard.fetchEndpoint",
          occurrence: 2,
        },
      },
      {
        anchor: {
          commit: "next",
          path: "src/app/page.tsx",
          symbol: "Dashboard.fetchEndpoint",
          occurrence: 0,
        },
        transition: { type: "unrelated" },
      },
    ],
  };
  assert.deepEqual(evaluateFixtureCase(db, fixture).binary, {
    expected: ["unmatched"],
    actual: ["L4"],
  });
  assert.equal(evaluateFixtureCase(db, fixture).status, "fail");
  db.exec("DELETE FROM revision_match");
  assert.equal(evaluateFixtureCase(db, fixture).status, "pass");
  db.close();
});

test("ambiguous lineage 不把任選一個可接受配對誤報成已驗證信心", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE git_commit (id INTEGER PRIMARY KEY, sha TEXT);
    CREATE TABLE slot (
      id INTEGER PRIMARY KEY,
      qualified_name TEXT,
      disambiguator TEXT
    );
    CREATE TABLE revision (
      id INTEGER PRIMARY KEY,
      commit_id INTEGER,
      slot_id INTEGER,
      path TEXT,
      byte_start INTEGER
    );
    CREATE TABLE revision_match (
      prev_revision INTEGER,
      next_revision INTEGER,
      tier TEXT,
      accepted INTEGER,
      ambiguity_size INTEGER
    );
    INSERT INTO git_commit VALUES (1, 'prev'), (2, 'next');
    INSERT INTO slot VALUES
      (1, 'Dashboard.poll', '0'),
      (2, 'Dashboard.poll', '0'),
      (3, 'Dashboard.poll', '1');
    INSERT INTO revision VALUES
      (10, 1, 1, 'src/ambiguous.ts', 100),
      (20, 2, 2, 'src/ambiguous.ts', 200),
      (21, 2, 3, 'src/ambiguous.ts', 300);
    -- 先擺「宣稱唯一」的版本：選中的配對本身可接受，但 ambiguity_size = 1。
    INSERT INTO revision_match VALUES (10, 20, 'L4', 1, 1);
  `);
  const anchor = (commit: string, occurrence: number) => ({
    commit,
    path: "src/ambiguous.ts",
    symbol: "Dashboard.poll",
    occurrence,
  });
  const fixture = {
    id: "ambiguous",
    kind: "lineage",
    difficulty: "adversarial" as const,
    label_confidence: "ambiguous" as const,
    accept_any_of: [0, 1].map((occurrence) => ({
      chain: [
        { anchor: anchor("prev", 0) },
        {
          anchor: anchor("next", occurrence),
          transition: { expect_tier_at_most: "L4" },
        },
      ],
    })),
  };

  // 選中的配對落在可接受集合內，但系統宣稱只有一個候選 → 必須 fail。
  // 少了這個方向，一個「永遠宣稱唯一」的匹配器只要碰巧選到可接受的那一個就過關。
  const overclaimed = evaluateFixtureCase(db, fixture);
  assert.equal(overclaimed.status, "fail");
  assert.deepEqual(
    (overclaimed.observed as { selectedAlternatives: number[] }).selectedAlternatives,
    [0],
  );
  assert.equal(
    (overclaimed.observed as { reportedConfidence: number | null }).reportedConfidence,
    1,
  );

  // 同一個配對，誠實回報「三個等價候選裡挑了一個」→ pass。
  db.exec("UPDATE revision_match SET ambiguity_size = 3");
  const honest = evaluateFixtureCase(db, fixture);
  assert.equal(honest.status, "pass");
  assert.equal(
    (honest.binary.actual as { claimedUnique: boolean }).claimedUnique,
    false,
  );

  // ambiguous 不計入比率（分母仍是 0），但**必須**進迴歸閘門——
  // 兩者都排除的話，這條案例永遠擋不下任何東西。
  const report = buildGoldenReport([honest]);
  assert.equal(report.summary.total, 0);
  assert.equal(report.ambiguousCases.length, 1);
  const regressed = buildGoldenReport([overclaimed], {
    cases: [{ id: "ambiguous", status: "pass", difficulty: "adversarial" }],
  });
  assert.equal(regressed.regressions.length, 1, "pass 變 fail 必須被閘門擋下");
  db.close();
});
