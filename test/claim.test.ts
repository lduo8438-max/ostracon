import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  aggregateSuppressionNotice,
  CLAIM_DERIVATION_VERSION,
  unboundExcursionNotice,
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

  it("迂迴的放棄理由綁 excursion_id，不冒充單次改動的 claim", () => {
    const db = fixture();
    addEvidence(db, "to avoid the CI flake.", "to avoid");
    db.exec(
      `INSERT INTO git_commit
         (id, repo_id, sha, authored_at, committed_at, message, topo_order)
       VALUES (2, 1, 'bbb', '2026-01-02', '2026-01-02', ${lit(BODY)}, 1);
       UPDATE source_doc
          SET external_id = 'bbb', provenance_root = 'commit:bbb'
        WHERE id = 1;
       INSERT INTO excursion
         (id, repo_id, entity_id, introduce_commit, remove_commit, duration_days,
          strength, method)
       VALUES (1, 1, 1, 1, 2, 1, 'A', 'inverse_diff')`,
    );

    // 同一個 commit 有理由還不夠；它必須真的是這個 entity 的死亡改動。
    deriveClaims(db, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM claim WHERE excursion_id = 1")
        .get() as { n: number }).n,
      0,
    );

    db.exec(
      `INSERT INTO revision_change
         (id, prev_revision, next_revision, commit_id, entity_id, change_level)
       VALUES (3, 1, NULL, 2, 1, 'death');
       UPDATE entity SET death_commit_id = 2 WHERE id = 1`,
    );
    deriveClaims(db, 1);
    const abandoned = db.prepare(
      `SELECT revision_change_id AS revisionChangeId, excursion_id AS excursionId,
              claim_type AS claimType, text
         FROM v_presentable_claim WHERE excursion_id = 1`,
    ).get() as {
      revisionChangeId: number | null;
      excursionId: number;
      claimType: string;
      text: string;
    };
    assert.deepEqual({ ...abandoned }, {
      revisionChangeId: null,
      excursionId: 1,
      claimType: "abandoned_reason",
      text: "to avoid the CI flake.",
    });
    assert.equal(
      presentableClaimsFor(db, 1, 1).some((c) => c.excursionId === 1),
      true,
      "entity 的意圖查詢必須沿 excursion 主體接得到這條 claim",
    );
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

/**
 * squash merge：一顆 commit 的訊息裡裝著好幾份變更紀錄。
 *
 * 這一組釘住的不是召回率，是**歸屬的正確性**。實測 create-t3-app 有 253 條
 * claim 是這樣長出來的——甲 PR 的理由掛到乙 entity 上，產生錯誤的歷史。
 */
const SQUASH = [
  "chore: next-merge (#494), ship edge instead of lambda",
  "",
  "* fix: use auth instead of question while merging the router (#330)",
  "",
  "* refactor: using path instead of passing prop (#395)",
].join("\r\n");

function squashFixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.exec(
    `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/r', '2026-01-01');
     INSERT INTO path_lineage (id, repo_id) VALUES (1, 1);
     INSERT INTO git_commit
       (id, repo_id, sha, authored_at, committed_at, message, topo_order) VALUES
       (1, 1, 'aaa', '2026-01-01', '2026-01-01', 'feat: born', 0),
       (2, 1, 'bbb', '2026-01-02', '2026-01-02', ${lit(SQUASH)}, 1);
     INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind)
       VALUES (1, 1, 1, 'alpha', 'function');
     INSERT INTO entity (id, repo_id, stable_key, birth_commit_id)
       VALUES (1, 1, 'k1', 1);
     INSERT INTO revision
       (id, repo_id, commit_id, slot_id, entity_id, lineage_id, path, blob_sha,
        byte_start, byte_end, line_start, line_end, hash_raw, hash_token,
        hash_alpha, hash_alpha_self, hash_shape, shape_profile,
        node_count, token_count, similarity_recall_mode, exact_ngram_hashes)
     VALUES (1, 1, 1, 1, 1, 1, 'src/a.ts', 'b', 0, 1, 1, 2,
             'r','t','a','as','sh','p', 30, 10, 'exact', x'00');
     -- death 必然沒有後繼（schema 的 CHECK），所以掛在 prev_revision 上。
     INSERT INTO revision_change (id, prev_revision, commit_id, entity_id, change_level)
       VALUES (1, 1, 2, 1, 'death');
     INSERT INTO excursion
       (id, repo_id, entity_id, introduce_commit, remove_commit, duration_days,
        strength, method)
       VALUES (1, 1, 1, 1, 2, 1.0, 'C', 'short_lifecycle');
     INSERT INTO source_doc
       (id, repo_id, doc_type, provenance_root, external_id, author, created_at,
        body, body_sha256)
     VALUES (1, 1, 'commit_message', 'commit:bbb', 'bbb', 'x', '2026-01-02',
             ${lit(SQUASH)}, '${sha256(SQUASH)}');`,
  );
  return db;
}

function addSquashEvidence(db: DatabaseSync, quote: string): void {
  const at = SQUASH.indexOf(quote);
  assert.ok(at >= 0, `squash fixture 裡沒有 ${quote}`);
  const ev = db.prepare(
    `INSERT INTO evidence
       (repo_id, source_doc_id, char_start, char_end, quoted_text, doc_body_sha,
        tier, verified)
     VALUES (1, 1, ?, ?, ?, ?, 'stated', 1)`,
  ).run(at, at + quote.length, quote, sha256(SQUASH));
  db.prepare(
    `INSERT INTO evidence_candidate
       (repo_id, source_doc_id, proposed_char_start, proposed_char_end,
        proposed_quoted_text, expected_doc_body_sha, proposed_tier, generator_kind,
        generator_version, status, promoted_evidence_id, created_at)
     VALUES (1, 1, ?, ?, ?, ?, 'stated', 'rule',
             'rule-rationale-0.3.0/causal:instead of', 'promoted', ?, '2026-01-02')`,
  ).run(at, at + quote.length, quote, sha256(SQUASH), Number(ev.lastInsertRowid));
}

describe("意圖層：聚合訊息不得歸因", () => {
  it("**body 深處的引文不升格，主旨行的照升**", () => {
    const db = squashFixture();
    addSquashEvidence(db, "instead of lambda");
    addSquashEvidence(db, "instead of question while merging the router (#330)");
    const report = deriveClaims(db, 1);

    const rows = claimRows(db);
    assert.deepEqual(rows.map((r) => r.text),
      ["instead of lambda", "instead of lambda"],
      "只有主旨行那條可以歸因；它同時是這次改動的 tradeoff 與這段迂迴的放棄理由");
    const types = db.prepare("SELECT claim_type AS t FROM claim ORDER BY id")
      .all() as unknown as { t: string }[];
    assert.deepEqual(types.map((x) => x.t), ["tradeoff", "abandoned_reason"]);
    // 一條 body 引文會同時撞到 revision_change 與 excursion 兩個主體，
    // 所以被擋下的是 2 個候選而不是 2 條證據。
    assert.deepEqual(report.unattributable,
      { candidates: 2, quotes: 1, commits: 1 },
      "一條引文扇出成兩個候選：主體分別是 revision_change 與 excursion");
    db.close();
  });

  it("**證據沒有被刪——壞掉的只是歸屬**", () => {
    // 「這句話存在於這則訊息」仍然為真，而且是可驗證的事實。刪掉它等於
    // 讓系統忘記自己曾經看過什麼。
    const db = squashFixture();
    addSquashEvidence(db, "instead of question while merging the router (#330)");
    deriveClaims(db, 1);
    const kept = db.prepare(
      "SELECT COUNT(*) AS n FROM evidence WHERE verified = 1",
    ).get() as { n: number };
    assert.equal(kept.n, 1, "verified evidence 數量不得改變");
    assert.deepEqual(claimRows(db), []);
    db.close();
  });

  it("**abandoned_reason 在聚合 commit 上必須歸零**", () => {
    // 這是最危險的一種：它宣稱「這個做法為什麼被放棄」，而依據是一條
    // 跟該 entity 毫無關係的 PR 標題。
    const db = squashFixture();
    addSquashEvidence(db, "instead of question while merging the router (#330)");
    deriveClaims(db, 1);
    const abandoned = db.prepare(
      "SELECT COUNT(*) AS n FROM claim WHERE claim_type = 'abandoned_reason'",
    ).get() as { n: number };
    assert.equal(abandoned.n, 0);
    db.close();
  });

  it("抑制不得靜默", () => {
    const db = squashFixture();
    addSquashEvidence(db, "instead of question while merging the router (#330)");
    const notice = aggregateSuppressionNotice(deriveClaims(db, 1));
    assert.match(notice ?? "", /1 條引文（2 個候選）/);
    assert.match(notice ?? "", /1 顆聚合 commit/);
    assert.match(notice ?? "", /證據本身仍保留/);
    db.close();
  });

  it("沒有聚合訊息時不報這件事", () => {
    const db = fixture();
    addEvidence(db, "to avoid the CI flake.", "to avoid");
    const report = deriveClaims(db, 1);
    assert.deepEqual(report.unattributable, { candidates: 0, quotes: 0, commits: 0 });
    assert.equal(aggregateSuppressionNotice(report), undefined);
    db.close();
  });
});

describe("意圖層：綁不到單一 entity 的放棄理由要留白", () => {
  /**
   * 一顆 commit 移除 `n` 個 entity，其中第一個是迂迴，並在訊息裡放一條理由。
   *
   * 這是實測形狀的縮影：vuejs/core 的 104 條 `abandoned_reason` 只來自 18 條
   * 引文，最嚴重的一條被掛到 36 個 entity。
   */
  function removalFixture(n: number): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
    const slots: string[] = [];
    const entities: string[] = [];
    const revs: string[] = [];
    const changes: string[] = [];
    for (let i = 1; i <= n; i++) {
      slots.push(`(${i}, 1, 1, 'sym${i}', 'function')`);
      entities.push(`(${i}, 1, 'k${i}', 1)`);
      revs.push(
        `(${i}, 1, 1, ${i}, ${i}, 1, 'src/a.ts', 'b', 0, 1, 1, 2,
          'r','t','a','as','sh','p', 30, 10, 'exact', x'00')`,
      );
      changes.push(`(${i}, ${i}, 2, ${i}, 'death')`);
    }
    db.exec(
      `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/r', '2026-01-01');
       INSERT INTO path_lineage (id, repo_id) VALUES (1, 1);
       INSERT INTO git_commit
         (id, repo_id, sha, authored_at, committed_at, message, topo_order) VALUES
         (1, 1, 'aaa', '2026-01-01', '2026-01-01', 'feat: born', 0),
         (2, 1, 'bbb', '2026-01-02', '2026-01-02', ${lit(BODY)}, 1);
       INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind)
         VALUES ${slots.join(",")};
       INSERT INTO entity (id, repo_id, stable_key, birth_commit_id)
         VALUES ${entities.join(",")};
       INSERT INTO revision
         (id, repo_id, commit_id, slot_id, entity_id, lineage_id, path, blob_sha,
          byte_start, byte_end, line_start, line_end, hash_raw, hash_token,
          hash_alpha, hash_alpha_self, hash_shape, shape_profile,
          node_count, token_count, similarity_recall_mode, exact_ngram_hashes)
       VALUES ${revs.join(",")};
       INSERT INTO revision_change
         (id, prev_revision, commit_id, entity_id, change_level)
         VALUES ${changes.join(",")};
       INSERT INTO excursion
         (id, repo_id, entity_id, introduce_commit, remove_commit, duration_days,
          strength, method)
         VALUES (1, 1, 1, 1, 2, 1, 'A', 'inverse_diff');
       INSERT INTO source_doc
         (id, repo_id, doc_type, provenance_root, external_id, author, created_at,
          body, body_sha256)
       VALUES (1, 1, 'commit_message', 'commit:bbb', 'bbb', 'x', '2026-01-02',
               ${lit(BODY)}, '${sha256(BODY)}');`,
    );
    addEvidence(db, "to avoid the CI flake.", "to avoid");
    return db;
  }

  const abandoned = (db: DatabaseSync) =>
    (db.prepare("SELECT COUNT(*) AS n FROM claim WHERE claim_type='abandoned_reason'")
      .get() as { n: number }).n;

  it("commit 只移除一樣東西時，引文指得到它", () => {
    const db = removalFixture(1);
    const report = deriveClaims(db, 1);
    assert.equal(abandoned(db), 1);
    assert.deepEqual(report.unboundExcursion, { candidates: 0, quotes: 0, commits: 0 });
    db.close();
  });

  it("**移除了不只一樣東西就留白**", () => {
    // 那句話指的是哪一個？沒有任何結構資訊回答得了。判準與匹配階梯的雙端
    // bucket 唯一性同一個原則：候選不只一個就不接受，而不是挑一個。
    const db = removalFixture(3);
    const report = deriveClaims(db, 1);
    assert.equal(abandoned(db), 0);
    assert.deepEqual(report.unboundExcursion, { candidates: 1, quotes: 1, commits: 1 });
    db.close();
  });

  it("**只收回放棄理由，一般改動的意圖與證據都還在**", () => {
    // 收回的是「這個做法被放棄」那句強宣稱，不是把證據刪掉。
    const db = removalFixture(3);
    deriveClaims(db, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE verified=1")
        .get() as { n: number }).n,
      1,
      "verified evidence 不得改變",
    );
    assert.equal(
      claimRows(db).filter((r) => r.t === "constraint").length,
      3,
      "三次死亡改動各自仍有一般的意圖",
    );
    db.close();
  });

  it("抑制不得靜默", () => {
    const notice = unboundExcursionNotice(deriveClaims(removalFixture(3), 1));
    assert.match(notice ?? "", /1 條引文（1 個候選）/);
    assert.match(notice ?? "", /1 顆一次移除多樣東西的 commit/);
    assert.match(notice ?? "", /證據與一般改動的意圖都仍保留/);
  });
});
