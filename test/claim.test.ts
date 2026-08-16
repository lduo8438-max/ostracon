import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CLAIM_DERIVATION_VERSION,
  deriveClaims,
  markerOf,
  presentableClaimsFor,
} from "../src/claim/derive.ts";
import { sha256 } from "../src/evidence/span.ts";

/**
 * 意圖層。**這一整組測試的前提是零 LLM**：型別由抽取器命中的標記確定式導出，
 * 文字是逐字引文。模型日後只能加 `inferred`，而那一層永遠不進
 * `v_presentable_claim`（不變量 9）。
 */

/** SQLite 的字串字面量是單引號；雙引號會被當成識別子。 */
const lit = (text: string) => `'${text.replaceAll("'", "''")}'`;

const BODY = "chore: bump\n\nPinned it to avoid the CI flake.";

/**
 * 一個最小但**走真實 schema** 的資料庫：一個 commit 改動兩個 entity，
 * 其中一個 `change_level = 'none'`。
 */
function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const rev = (id: number, entity: number) =>
    `(${id}, 1, 1, ${id}, ${entity}, 1, 'src/a.ts', 'b', 0, 1, 1, 2,
      'r','t','a','as','sh','p', 30, 10, 'exact', x'00')`;
  db.exec(
    `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/r', '2026-01-01');
     INSERT INTO path_lineage (id, repo_id) VALUES (1, 1);
     INSERT INTO git_commit
       (id, repo_id, sha, authored_at, committed_at, message, topo_order)
     VALUES (1, 1, 'aaa', '2026-01-01', '2026-01-01', ${lit(BODY)}, 0);
     INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind) VALUES
       (1, 1, 1, 'alpha', 'function'), (2, 1, 1, 'beta', 'function');
     INSERT INTO entity (id, repo_id, stable_key, birth_commit_id) VALUES
       (1, 1, 'k1', 1), (2, 1, 'k2', 1);
     INSERT INTO revision
       (id, repo_id, commit_id, slot_id, entity_id, lineage_id, path, blob_sha,
        byte_start, byte_end, line_start, line_end, hash_raw, hash_token,
        hash_alpha, hash_alpha_self, hash_shape, shape_profile,
        node_count, token_count, similarity_recall_mode, exact_ngram_hashes)
     VALUES ${rev(1, 1)}, ${rev(2, 2)};
     INSERT INTO revision_change (id, next_revision, commit_id, entity_id, change_level)
     VALUES (1, 1, 1, 1, 'shape'), (2, 2, 1, 2, 'none');
     INSERT INTO source_doc
       (id, repo_id, doc_type, provenance_root, external_id, author, created_at,
        body, body_sha256)
     VALUES (1, 1, 'commit_message', 'commit:aaa', 'aaa', 'x', '2026-01-01',
             ${lit(BODY)}, '${sha256(BODY)}');`,
  );
  return db;
}

/** 加一條已驗證的 stated 證據，並記下它命中的標記。 */
function addEvidence(db: DatabaseSync, quote: string, marker: string): number {
  const at = BODY.indexOf(quote);
  assert.ok(at >= 0, `fixture 的 body 裡沒有 ${quote}`);
  const ev = db.prepare(
    `INSERT INTO evidence
       (repo_id, source_doc_id, char_start, char_end, quoted_text, doc_body_sha, tier, verified)
     VALUES (1, 1, ?, ?, ?, ?, 'stated', 1)`,
  ).run(at, at + quote.length, quote, sha256(BODY));
  db.prepare(
    `INSERT INTO evidence_candidate
       (repo_id, source_doc_id, proposed_char_start, proposed_char_end,
        proposed_quoted_text, expected_doc_body_sha, proposed_tier, generator_kind,
        generator_version, status, promoted_evidence_id, created_at)
     VALUES (1, 1, ?, ?, ?, ?, 'stated', 'rule', ?, 'promoted', ?, '2026-01-01')`,
  ).run(
    at,
    at + quote.length,
    quote,
    sha256(BODY),
    `rule-rationale-0.3.0/causal:${marker}`,
    Number(ev.lastInsertRowid),
  );
  return Number(ev.lastInsertRowid);
}

const claimRows = (db: DatabaseSync) =>
  db.prepare(
    "SELECT claim_type AS t, text, tier, confidence AS c, revision_change_id AS rc "
    + "FROM claim ORDER BY id",
  ).all() as unknown as
    { t: string; text: string; tier: string; c: number; rc: number }[];

describe("意圖層：證據升格為 claim", () => {
  it("標記決定型別，而且是確定式的", () => {
    assert.equal(markerOf("rule-rationale-0.3.0/causal:instead of"), "instead of");
    assert.equal(markerOf("rule-rationale-markdown-0.3.0/causal:to avoid"), "to avoid");
    assert.equal(markerOf(null), undefined);

    const db = fixture();
    addEvidence(db, "to avoid the CI flake.", "to avoid");
    deriveClaims(db, 1);
    const rows = claimRows(db);
    assert.equal(rows.length, 1);
    // 「不這樣做會怎樣」是約束，不是理由。
    assert.equal(rows[0]!.t, "constraint");
    assert.equal(rows[0]!.text, "to avoid the CI flake.", "文字必須逐字，不得改寫");
    db.close();
  });

  it("**對照表沒收的標記不產出 claim，不是預設歸 why**", () => {
    // 猜一個型別比沉默糟：使用者看到 `why` 就會當成作者說的理由。
    const db = fixture();
    addEvidence(db, "to avoid the CI flake.", "however");
    const report = deriveClaims(db, 1);
    assert.equal(report.unmapped, 1);
    assert.equal(report.written, 0);
    assert.deepEqual(claimRows(db), []);
    db.close();
  });

  it("**相關性用既有那條規則，不另訂一套**", () => {
    // `change_level = 'none'` 的改動不掛理由——與 `suppressUnrelatedRationale`
    // 同一條判準。各寫一份的話，畫面上會出現時間軸不承認的理由。
    const db = fixture();
    addEvidence(db, "to avoid the CI flake.", "to avoid");
    deriveClaims(db, 1);
    const rows = claimRows(db);
    assert.deepEqual(rows.map((r) => r.rc), [1], "只有改動過的那個 entity 有 claim");
    db.close();
  });

  it("寫進去的每一條都進得了 v_presentable_claim", () => {
    // 支持關係與 claim 必須同一輪寫入，否則會留下永遠看不見的列。
    const db = fixture();
    addEvidence(db, "to avoid the CI flake.", "to avoid");
    const report = deriveClaims(db, 1);
    const visible = (db.prepare("SELECT COUNT(*) AS n FROM v_presentable_claim")
      .get() as { n: number }).n;
    assert.equal(visible, report.written);
    assert.equal(
      presentableClaimsFor(db, 1, 1).map((c) => c.text)[0],
      "to avoid the CI flake.",
    );
    db.close();
  });

  it("**inferred 永遠不進 v_presentable_claim**", () => {
    // 不變量 9。schema 的 view 已經擋著，這條測試釘住它不被改掉。
    const db = fixture();
    db.prepare(
      `INSERT INTO claim
         (repo_id, revision_change_id, claim_type, text, tier, confidence,
          model, created_at)
       VALUES (1, 1, 'why', '推測的理由', 'inferred', 0.9, 'some-model', '2026-01-01')`,
    ).run();
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM v_presentable_claim").get() as
        { n: number }).n,
      0,
    );
    assert.deepEqual(presentableClaimsFor(db, 1, 1), []);
    db.close();
  });

  it("重跑是冪等的，而且不碰模型產生的 claim", () => {
    const db = fixture();
    addEvidence(db, "to avoid the CI flake.", "to avoid");
    db.prepare(
      `INSERT INTO claim
         (repo_id, revision_change_id, claim_type, text, tier, confidence,
          model, created_at)
       VALUES (1, 1, 'why', '模型寫的', 'inferred', 0.9, 'some-model', '2026-01-01')`,
    ).run();

    const first = deriveClaims(db, 1);
    const second = deriveClaims(db, 1);
    assert.equal(first.written, second.written, "同樣的輸入必須產生同樣的輸出");
    assert.equal(second.rebuilt, false, "第二次不是跨版本重建");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM claim WHERE model IS NOT NULL")
        .get() as { n: number }).n,
      1,
      "規則層的重算不得清掉模型層的產出",
    );
    assert.equal(
      (db.prepare(
        "SELECT indexer_version AS v FROM pass_state WHERE pass_name = 'claim'",
      ).get() as { v: string }).v,
      CLAIM_DERIVATION_VERSION,
    );
    db.close();
  });

  it("linked 的 confidence 繼承參照連結，不另外發明數字", () => {
    // claim 的可信度不可能高於「這個 commit 真的跟那個討論串有關」。
    const db = fixture();
    const prBody = "We cache it to prevent a stampede.";
    db.exec(
      `INSERT INTO source_doc
         (id, repo_id, doc_type, provenance_root, external_id, author, created_at,
          body, body_sha256)
       VALUES (2, 1, 'pr_body', 'pr:7', 'pr:7:body', 'x', '2026-01-01',
               ${lit(prBody)}, '${sha256(prBody)}');
       INSERT INTO reference_link
         (repo_id, from_kind, from_key, to_kind, to_key, method, confidence)
       VALUES (1, 'commit', 'aaa', 'pr', '7', 'message_ref', 0.4);`,
    );
    const quote = "to prevent a stampede.";
    const at = prBody.indexOf(quote);
    const ev = db.prepare(
      `INSERT INTO evidence
         (repo_id, source_doc_id, char_start, char_end, quoted_text, doc_body_sha,
          tier, verified)
       VALUES (1, 2, ?, ?, ?, ?, 'linked', 1)`,
    ).run(at, at + quote.length, quote, sha256(prBody));
    db.prepare(
      `INSERT INTO evidence_candidate
         (repo_id, source_doc_id, proposed_char_start, proposed_char_end,
          proposed_quoted_text, expected_doc_body_sha, proposed_tier, generator_kind,
          generator_version, status, promoted_evidence_id, created_at)
       VALUES (1, 2, ?, ?, ?, ?, 'linked', 'rule',
               'rule-rationale-markdown-0.3.0/causal:to prevent', 'promoted', ?,
               '2026-01-01')`,
    ).run(
      at, at + quote.length, quote, sha256(prBody), Number(ev.lastInsertRowid),
    );

    deriveClaims(db, 1);
    const linked = claimRows(db).find((r) => r.tier === "linked");
    assert.ok(linked, "linked 證據要產出 claim");
    assert.equal(linked.c, 0.4, "裸的 #N 是 0.4，不得升成 1.0");
    assert.equal(linked.t, "constraint");
    db.close();
  });
});
