import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluateFixtureCase } from "../src/golden/evaluate.ts";
import { sha256 } from "../src/evidence/span.ts";

/**
 * `kind: evidence` 的判定。
 *
 * 這一層先前只寫在 `docs/golden-fixtures-spec.md` 裡、沒有實作，所以任何
 * 證據層的退步都沒有黃金測試集在擋。中文標記的 bug 就是這樣溜過去的。
 */
const SHA = "a1450f05e05be7f927b052faa70a393848600669";
const BODY = "調整標籤正規化\n\n所以版本字串沒有理由改變。";

function dbWith(quotes: Array<{ tier: string; quote: string }>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.exec(
    `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/tmp/r', '2026-01-01');
     INSERT INTO source_doc
       (id, repo_id, doc_type, provenance_root, external_id, author, created_at,
        body, body_sha256)
     VALUES (1, 1, 'commit_message', 'commit:${SHA}', '${SHA}', 'x', '2026-01-01',
             '${BODY.replace(/\n/g, "' || char(10) || '")}', '${sha256(BODY)}');`,
  );
  const insert = db.prepare(
    `INSERT INTO evidence
       (repo_id, source_doc_id, char_start, char_end, quoted_text, doc_body_sha, tier, verified)
     VALUES (1, 1, ?, ?, ?, ?, ?, 1)`,
  );
  for (const [i, q] of quotes.entries()) {
    // 位移只要能通過 CHECK 就好；這組測試驗的是判定邏輯，不是 span 斷言。
    insert.run(i * 2, i * 2 + 1, q.quote, sha256(BODY), q.tier);
  }
  return db;
}

const negativeCase = {
  id: "evd-zh-negation",
  kind: "evidence",
  difficulty: "adversarial" as const,
  at_commit: SHA,
  expect_spans: [],
};

const positiveCase = {
  id: "evd-zh-colon",
  kind: "evidence",
  difficulty: "hard" as const,
  at_commit: SHA,
  expect_spans: [
    { source: { type: "commit_message" }, contains: "理由：邊界不穩定", tier: "stated" },
  ],
};

describe("golden 的 evidence 案例", () => {
  it("負例是窮舉的：這則訊息一條引文都不得產出", () => {
    const clean = dbWith([]);
    assert.equal(evaluateFixtureCase(clean, negativeCase).status, "pass");
    clean.close();

    const dirty = dbWith([{ tier: "stated", quote: "理由改變。" }]);
    const verdict = evaluateFixtureCase(dirty, negativeCase);
    assert.equal(verdict.status, "fail");
    // 判定語意必須在結構化的 binary 裡，不得靠讀 detail 反推。
    assert.deepEqual(verdict.binary, { expected: { spans: 0 }, actual: { spans: 1 } });
    assert.deepEqual(verdict.observed, { quotes: ["理由改變。"] });
    dirty.close();
  });

  it("**「文件沒被收進來」與「文件在但沒有引文」是兩件事**", () => {
    // 前者是覆蓋不足（missing），後者是一個真實的觀測值（pass）。
    // 混為一談會讓覆蓋率這個頭條數字失去意義。
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
    const verdict = evaluateFixtureCase(db, negativeCase);
    assert.equal(verdict.status, "missing");
    assert.equal(verdict.binary.actual, null, "missing 必須對應 actual = null");
    db.close();
  });

  it("正例只要求列出的 span 在，不禁止另有別的", () => {
    // span 的右邊界是抽取器的自由度；窮舉正例會讓 fixture 在無關的調整上碎掉。
    const db = dbWith([
      { tier: "stated", quote: "理由：邊界不穩定，改用 histogram。" },
      { tier: "stated", quote: "因為另一件事。" },
    ]);
    assert.equal(evaluateFixtureCase(db, positiveCase).status, "pass");
    db.close();
  });

  it("tier 不符不算命中", () => {
    const db = dbWith([{ tier: "linked", quote: "理由：邊界不穩定" }]);
    const verdict = evaluateFixtureCase(db, positiveCase);
    assert.equal(verdict.status, "fail");
    assert.deepEqual(verdict.binary.actual, ["absent"]);
    db.close();
  });

  it("負例的 polarity 是 negative，正例是 positive", () => {
    // 報告依 polarity 分層。負例被算成正例的話，「系統會不會亂報」這個
    // 面向的通過率就會被稀釋掉。
    const db = dbWith([]);
    assert.equal(evaluateFixtureCase(db, negativeCase).polarity, "negative");
    assert.equal(evaluateFixtureCase(db, positiveCase).polarity, "positive");
    db.close();
  });
});
