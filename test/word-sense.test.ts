import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  EXTRACTOR_VERSION,
  MARKDOWN_EXTRACTOR_VERSION,
  extractRationale,
} from "../src/evidence/extract.ts";
import {
  discardStaleRuleEvidence,
  extractFromCommitMessages,
  extractFromLinkedDocuments,
  ingestCommitMessages,
} from "../src/evidence/store.ts";
import { sha256 } from "../src/evidence/span.ts";

const quotes = (body: string) =>
  extractRationale(body, { format: "markdown" }).map((s) => s.quotedText);

/**
 * 這一整組測試釘住的是一個裁決結果，不是一個直覺。
 *
 * demo 語料 103 條可疑引文全部人工裁決後：長度 < 30 的 68 條裡有 55 條是真理由，
 * 只有 8 條是空殼。**長度門檻要殺 55 條才換到 8 條**，所以它被否決。
 * 9 條空殼的實際成因是標記配到了另一個詞義——那是 bug，不是品質門檻問題。
 */
describe("因果標記的詞義", () => {
  it("since 的時間義不是理由", () => {
    // 裁決樣本 #18 / #211 / #430（同一則 commit message）、#47、#357、#364。
    assert.deepEqual(quotes("We've been using it since August."), []);
    assert.deepEqual(quotes("Has this been broken since version 7?"), []);
    assert.deepEqual(quotes("A few things landed since then which I'd like in."), []);
    assert.deepEqual(quotes("We've used T3 since launch. The founder is a fan."), []);
    assert.deepEqual(quotes("Nothing has changed since 2024."), []);
  });

  it("since 的因果義照常抽出", () => {
    // 這條是前一條的價格標籤：demo 語料 86 條 since 只有 5 條是時間義，
    // 詞義規則放寬一點點就會開始吃掉這 81 條。
    assert.deepEqual(
      quotes("Split it up since it was getting a bit long for one function."),
      ["since it was getting a bit long for one function."],
    );
    assert.deepEqual(
      quotes("Dropped it since doing these async caused some issues"),
      ["since doing these async caused some issues"],
    );
    // `maybe` 不是五月。詞界沒寫好的話這條會掉。
    assert.deepEqual(
      quotes("Kept it since maybe someone depends on the old shape"),
      ["since maybe someone depends on the old shape"],
    );
  });

  it("**被否決的標記不連累整行**", () => {
    // 舊版取最早出現的標記就定案，`since` 一被否決整行就沒有理由了。
    // 實際上理由在後面那個標記上。
    assert.deepEqual(
      quotes("Broken since August. Pinned the version to avoid the CI flake."),
      ["to avoid the CI flake."],
    );
  });

  it("標記後沒有實質內容就不是理由", () => {
    // 裁決樣本 #116 / #120 / #187 / #260。
    assert.deepEqual(quotes("I think this is the reason"), []);
    assert.deepEqual(quotes("Needs the flag, otherwise."), []);
  });

  it("**判準是有沒有內容，不是剩幾個字元**", () => {
    // 裁決樣本 #164：`4` 只有一個字元，但它就是內容——被拒絕的替代方案
    // 正是這個工具的題目。以「標記後不足 4 字元」為判準會殺掉它。
    assert.deepEqual(quotes("Pinned to 3 instead of 4."), ["instead of 4."]);
    assert.deepEqual(quotes("Use pnpm instead of npm"), ["instead of npm"]);
  });

  it("so that 接繫詞時理由在標記之前，左邊界往前拉到句首", () => {
    // 裁決樣本 #128 / #358 / #397：這一類全被判為「該拉長」。
    // `so that's` 是「所以，那個是」，不是表目的的 `so that`——理由在前半句。
    assert.deepEqual(
      quotes("I realised light mode looked trash so that's been fixed now too."),
      ["I realised light mode looked trash so that's been fixed now too."],
    );
    assert.deepEqual(
      quotes("That comment is updated each release so that is the latest"),
      ["That comment is updated each release so that is the latest"],
    );
    // 句首以句末標點為界，不是整行——前一句是另一件事。
    assert.deepEqual(
      quotes("Biome has three commands. I always use check, so that is what I added."),
      ["I always use check, so that is what I added."],
    );
  });

  it("表目的的 so that 不受影響", () => {
    assert.deepEqual(
      quotes("Cache it so that the CLI doesn't crash before the check."),
      ["so that the CLI doesn't crash before the check."],
    );
  });

  it("往前拉過的 span 仍與原文逐字對齊", () => {
    // 左邊界是新算的，位移算錯的話 span 斷言會整條丟棄——而且是靜默的。
    const body = "note\n\nI always use check, so that is what I added.\n";
    for (const span of extractRationale(body, { format: "markdown" })) {
      assert.equal(
        body.slice(span.charStart, span.charEnd),
        span.quotedText,
        "quotedText 必須等於 body 上同一段位移",
      );
    }
  });
});

const freshDb = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.exec(
    `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/tmp/r', '2026-01-01');
     INSERT INTO git_commit
       (id, repo_id, sha, author_name, authored_at, committed_at, message, is_merge, topo_order)
     VALUES (1, 1, 'aaa', 'x', '2026-01-01', '2026-01-01',
             'chore: bump' || char(10) || char(10) || 'Pinned it since August.', 0, 0);`,
  );
  return db;
};

/** 假裝資料庫是舊版抽取器建的：塞一條它會產出、而新版不會產出的引文。 */
function seedStaleEvidence(db: DatabaseSync): number {
  const body = "chore: bump\n\nPinned it since August.";
  const at = body.indexOf("since August.");
  ingestCommitMessages(db, 1);
  const docId = (db.prepare(
    "SELECT id FROM source_doc WHERE repo_id = 1 AND doc_type = 'commit_message'",
  ).get() as { id: number }).id;
  const ev = db.prepare(
    `INSERT INTO evidence
       (repo_id, source_doc_id, char_start, char_end, quoted_text, doc_body_sha, tier, verified)
     VALUES (1, ?, ?, ?, 'since August.', ?, 'stated', 1)`,
  ).run(docId, at, at + "since August.".length, sha256(body));
  db.prepare(
    `INSERT INTO evidence_candidate
       (repo_id, source_doc_id, proposed_char_start, proposed_char_end,
        proposed_quoted_text, expected_doc_body_sha, proposed_tier,
        generator_kind, generator_version, status, promoted_evidence_id, created_at)
     VALUES (1, ?, ?, ?, 'since August.', ?, 'stated', 'rule',
             'rule-rationale-0.1.0/causal:since', 'promoted', ?, '2026-01-01')`,
  ).run(docId, at, at + "since August.".length, sha256(body), Number(ev.lastInsertRowid));
  return Number(ev.lastInsertRowid);
}

describe("舊版抽取器的產出會被作廢", () => {
  it("**升版本但不作廢，等於這個修正在用過的資料庫上無效**", () => {
    const db = freshDb();
    seedStaleEvidence(db);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number }).n,
      1,
      "前提：舊版留下的空殼引文確實在資料庫裡",
    );

    const report = extractFromCommitMessages(db, 1);
    assert.equal(report.discarded.evidence, 1);
    assert.equal(report.discarded.candidates, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number }).n,
      0,
      "新版不會重新產出 since August.，所以重抽之後應該一條都不剩",
    );
    db.close();
  });

  it("當前版本的產出不會被自己刪掉", () => {
    const db = freshDb();
    ingestCommitMessages(db, 1);
    db.exec(
      `INSERT INTO source_doc
         (repo_id, doc_type, provenance_root, external_id, author, created_at, body, body_sha256)
       VALUES (1, 'pr_body', 'pr:1', 'pr:1:body', 'x', '2026-01-01',
               'Use pnpm instead of npm', '${sha256("Use pnpm instead of npm")}');`,
    );
    const linked = extractFromLinkedDocuments(db, 1);
    assert.equal(linked.promoted, 1);

    // stated 與 linked 是兩個版本字串。只把其中一個當成「當前」的話，
    // 後跑的那一支會把先跑的那一支剛寫好的列當成陳舊的刪掉。
    const again = extractFromCommitMessages(db, 1);
    assert.equal(again.discarded.evidence, 0);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number }).n,
      1,
      "linked 的引文必須還在",
    );
    db.close();
  });

  it("作廢不碰 source_doc——linked 文件是花網路取回來的", () => {
    const db = freshDb();
    seedStaleEvidence(db);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM source_doc").get() as
      { n: number }).n;
    discardStaleRuleEvidence(db, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM source_doc").get() as { n: number }).n,
      before,
    );
    db.close();
  });

  it("版本字串沒有互為前綴，否則作廢會漏掉一整類", () => {
    // `rule-rationale-markdown-x` 若以 `rule-rationale-x` 為前綴，
    // linked 的舊產出會被誤判成當前版本而留下來。
    assert.ok(!MARKDOWN_EXTRACTOR_VERSION.startsWith(`${EXTRACTOR_VERSION}/`));
    assert.ok(!EXTRACTOR_VERSION.startsWith(`${MARKDOWN_EXTRACTOR_VERSION}/`));
  });
});
