import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { deriveClaims } from "../src/claim/derive.ts";
import { evolutionOf, listEntities, repoSummary } from "../src/ui/data.ts";
import { startUiServer } from "../src/ui/server.ts";
import { PAGE } from "../src/ui/page.ts";
import { sha256 } from "../src/evidence/span.ts";

/** SQLite 的字串字面量是單引號；雙引號會被當成識別子。 */
const lit = (text: string) => `'${text.replaceAll("'", "''")}'`;

const WITH_REASON = "fix: cap the fetch\n\nCapped it to avoid the quota burn.";
const WITHOUT = "chore: reformat";

/**
 * 兩次改動、同一個 entity：第一次說得出為什麼，第二次沒有。
 *
 * 這正是三欄 UI 要呈現的形狀——實測 Osiris 只有 4.0% 的 commit 說得出為什麼，
 * 所以「空白」是常態而不是例外。
 */
function fixtureDb(): string {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-ui-")), "i.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const rev = (id: number, commit: number) =>
    `(${id}, 1, ${commit}, 1, 1, 1, 'src/a.ts', 'b', 0, 1, 1, 2,
      'r','t','a','as','sh','p', 30, 10, 'exact', x'00')`;
  db.exec(
    `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/r', '2026-01-01');
     INSERT INTO path_lineage (id, repo_id) VALUES (1, 1);
     INSERT INTO git_commit
       (id, repo_id, sha, authored_at, committed_at, message, topo_order) VALUES
       (1, 1, 'aaaaaaaaaaaa', '2026-01-01', '2026-01-01', ${lit(WITH_REASON)}, 0),
       (2, 1, 'bbbbbbbbbbbb', '2026-01-02', '2026-01-02', ${lit(WITHOUT)}, 1);
     INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind)
       VALUES (1, 1, 1, 'cappedFetch', 'function');
     INSERT INTO entity (id, repo_id, stable_key, birth_commit_id)
       VALUES (1, 1, 'k1', 1);
     INSERT INTO revision
       (id, repo_id, commit_id, slot_id, entity_id, lineage_id, path, blob_sha,
        byte_start, byte_end, line_start, line_end, hash_raw, hash_token,
        hash_alpha, hash_alpha_self, hash_shape, shape_profile,
        node_count, token_count, similarity_recall_mode, exact_ngram_hashes)
     VALUES ${rev(1, 1)}, ${rev(2, 2)};
     INSERT INTO revision_change (id, next_revision, commit_id, entity_id, change_level)
       VALUES (1, 1, 1, 1, 'shape'), (2, 2, 2, 1, 'raw');
     INSERT INTO source_doc
       (id, repo_id, doc_type, provenance_root, external_id, author, created_at,
        body, body_sha256) VALUES
       (1, 1, 'commit_message', 'commit:aaaaaaaaaaaa', 'aaaaaaaaaaaa', 'x',
        '2026-01-01', ${lit(WITH_REASON)}, '${sha256(WITH_REASON)}'),
       (2, 1, 'commit_message', 'commit:bbbbbbbbbbbb', 'bbbbbbbbbbbb', 'x',
        '2026-01-02', ${lit(WITHOUT)}, '${sha256(WITHOUT)}');`,
  );

  const quote = "to avoid the quota burn.";
  const at = WITH_REASON.indexOf(quote);
  const ev = db.prepare(
    `INSERT INTO evidence
       (repo_id, source_doc_id, char_start, char_end, quoted_text, doc_body_sha,
        tier, verified)
     VALUES (1, 1, ?, ?, ?, ?, 'stated', 1)`,
  ).run(at, at + quote.length, quote, sha256(WITH_REASON));
  db.prepare(
    `INSERT INTO evidence_candidate
       (repo_id, source_doc_id, proposed_char_start, proposed_char_end,
        proposed_quoted_text, expected_doc_body_sha, proposed_tier, generator_kind,
        generator_version, status, promoted_evidence_id, created_at)
     VALUES (1, 1, ?, ?, ?, ?, 'stated', 'rule',
             'rule-rationale-0.3.0/causal:to avoid', 'promoted', ?, '2026-01-01')`,
  ).run(
    at, at + quote.length, quote, sha256(WITH_REASON), Number(ev.lastInsertRowid),
  );
  deriveClaims(db, 1);
  db.close();
  return dbPath;
}

const open = (dbPath: string) => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
};

describe("三欄 UI 的資料層", () => {
  it("**意圖逐列對齊改動，沒有的那一列是空陣列**", () => {
    // 對齊錯了就是把 A 改動的理由印在 B 底下——這個工具最不能犯的錯。
    // 而空陣列是**真實的觀測值**（那次改動沒人說為什麼），不是還沒載入。
    const db = open(fixtureDb());
    const rows = evolutionOf(db, 1, 1);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.shortSha), ["aaaaaaaaaa", "bbbbbbbbbb"]);
    assert.deepEqual(
      rows.map((r) => r.intent.map((i) => i.claimType)),
      [["constraint"], []],
      "理由屬於第一次改動，第二次必須是空的",
    );
    assert.equal(rows[0]!.intent[0]!.text, "to avoid the quota burn.");
    db.close();
  });

  it("結構欄同時給出改動次數與其中幾次有理由", () => {
    // 「有幾次有理由」要在挑選之前就看得到，否則使用者只能一個一個點開才知道
    // 哪些東西講得出故事。
    const db = open(fixtureDb());
    const [entity] = listEntities(db, 1);
    assert.ok(entity);
    assert.equal(entity.symbol, "cappedFetch");
    assert.equal(entity.revisions, 2);
    assert.equal(entity.withIntent, 1);
    db.close();
  });

  it("稀疏度是頭條數字", () => {
    const db = open(fixtureDb());
    const summary = repoSummary(db, 1);
    assert.equal(summary.changes, 2);
    assert.equal(summary.changesWithIntent, 1);
    db.close();
  });

  it("**無法歸因的聚合證據要出現在標頭上**", () => {
    // 沒有這個數字，使用者會把大片空白讀成「這個團隊不寫理由」，
    // 而實情是理由寫了、squash 把它跟改動的對應關係銷毀了。
    const db = open(fixtureDb());
    assert.deepEqual(repoSummary(db, 1).aggregate,
      { candidates: 0, quotes: 0, commits: 0 });

    const squash = [
      "chore: next-merge (#494)",
      "",
      "* fix: use auth instead of question (#330)",
      "",
      "* refactor: use path instead of passing prop (#395)",
    ].join("\r\n");
    const quote = "instead of question (#330)";
    const at = squash.indexOf(quote);
    db.exec(
      `INSERT INTO git_commit
         (id, repo_id, sha, authored_at, committed_at, message, topo_order)
       VALUES (3, 1, 'cccccccccccc', '2026-01-03', '2026-01-03', ${lit(squash)}, 2);
       INSERT INTO source_doc
         (id, repo_id, doc_type, provenance_root, external_id, author, created_at,
          body, body_sha256)
       VALUES (3, 1, 'commit_message', 'commit:cccccccccccc', 'cccccccccccc', 'x',
               '2026-01-03', ${lit(squash)}, '${sha256(squash)}');`,
    );
    db.prepare(
      `INSERT INTO evidence
         (repo_id, source_doc_id, char_start, char_end, quoted_text, doc_body_sha,
          tier, verified)
       VALUES (1, 3, ?, ?, ?, ?, 'stated', 1)`,
    ).run(at, at + quote.length, quote, sha256(squash));

    // **光有引文還不夠。** 這顆 commit 得真的改到了什麼，這條引文才會是
    // 「本來會變成意圖、被聚合守門擋下」的那種。少了這一步就會把相關性抑制
    // 造成的空白也算到 squash 頭上——CLI 與標頭因此各說 5 顆與 6 顆。
    assert.deepEqual(repoSummary(db, 1).aggregate,
      { candidates: 0, quotes: 0, commits: 0 },
      "沒有相關改動的引文不算在聚合抑制裡");

    db.exec(
      `INSERT INTO revision_change
         (id, prev_revision, commit_id, entity_id, change_level)
       VALUES (3, 2, 3, 1, 'raw')`,
    );
    assert.deepEqual(repoSummary(db, 1).aggregate,
      { candidates: 1, quotes: 1, commits: 1 });
    db.close();
  });

  it("excursion 主體的 abandoned_reason 對回移除那一列", () => {
    const db = open(fixtureDb());
    db.exec(
      `UPDATE revision_change
          SET change_level = 'death', prev_revision = 2, next_revision = NULL
        WHERE id = 2;
       INSERT INTO excursion
         (id, repo_id, entity_id, introduce_commit, remove_commit, duration_days,
          strength, method)
       VALUES (1, 1, 1, 1, 2, 1, 'C', 'trajectory');
       INSERT INTO claim
         (repo_id, excursion_id, claim_type, text, tier, confidence, created_at)
       VALUES (1, 1, 'abandoned_reason', 'to avoid the quota burn.',
               'stated', 1.0, '2026-01-02');
       INSERT INTO claim_evidence (claim_id, evidence_id, role)
       VALUES (last_insert_rowid(), 1, 'supports');`,
    );

    const rows = evolutionOf(db, 1, 1);
    assert.deepEqual(
      rows.map((r) => r.intent.map((i) => i.claimType)),
      [["constraint"], ["abandoned_reason"]],
      "放棄理由屬於 excursion 的 remove_commit，不是 introduce_commit",
    );
    assert.equal(listEntities(db, 1)[0]!.withIntent, 2);
    assert.equal(repoSummary(db, 1).changesWithIntent, 2);
    db.close();
  });

  it("**inferred 不會經由這一層外洩到畫面上**", () => {
    // 資料層一律走 `v_presentable_claim`。這條測試釘住不變量 9 在 UI 這一側。
    const dbPath = fixtureDb();
    const db = open(dbPath);
    db.prepare(
      `INSERT INTO claim
         (repo_id, revision_change_id, claim_type, text, tier, confidence,
          model, created_at)
       VALUES (1, 2, 'why', '模型推測的理由', 'inferred', 0.99, 'm', '2026-01-01')`,
    ).run();
    const rows = evolutionOf(db, 1, 1);
    assert.deepEqual(rows[1]!.intent, [], "推測不得出現在意圖欄");
    db.close();
  });
});

describe("三欄 UI 的伺服器", () => {
  it("端點回得出結構、演化與意圖", async () => {
    const { url, server } = await startUiServer({ dbPath: fixtureDb(), port: 0 });
    try {
      const page = await fetch(url);
      assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
      assert.match(await page.text(), /Ostracon/);

      const entities = await (await fetch(`${url}api/entities`)).json() as
        Array<{ entityId: number }>;
      assert.equal(entities.length, 1);
      const rows = await (await fetch(
        `${url}api/evolution?entity=${entities[0]!.entityId}`,
      )).json() as Array<{ intent: unknown[] }>;
      assert.deepEqual(rows.map((r) => r.intent.length), [1, 0]);
    } finally {
      server.close();
    }
  });

  it("壞的 entity 參數回 400，未知路徑回 404——不是空陣列", async () => {
    // 空陣列在這個畫面上的意思是「查過了，真的沒有」。拿它當失敗值就是
    // 讓畫面說謊。
    const { url, server } = await startUiServer({ dbPath: fixtureDb(), port: 0 });
    try {
      assert.equal((await fetch(`${url}api/evolution?entity=abc`)).status, 400);
      assert.equal((await fetch(`${url}api/evolution`)).status, 400);
      assert.equal((await fetch(`${url}nope`)).status, 404);
    } finally {
      server.close();
    }
  });

  it("**只綁 127.0.0.1**", async () => {
    // 資料庫裡是整個 repo 的歷史，包括私有程式碼的路徑與 commit 訊息。
    const { server } = await startUiServer({ dbPath: fixtureDb(), port: 0 });
    try {
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      assert.equal(address.address, "127.0.0.1");
    } finally {
      server.close();
    }
  });

  it("頁面沒有任何外部資源", () => {
    // 零相依、可離線是這個專案的賣點之一；一個 CDN 連結就足以毀掉它。
    assert.equal(/(?:src|href)="(?:https?:)?\/\//.test(PAGE), false);
    assert.match(PAGE, /system-ui/, "字體用系統堆疊，不下載字體檔");
  });

  it("逐列高度保留子像素，而且從任一欄捲動都同步", () => {
    // Chrome 目視驗證抓到第一版只同步「演化 → 意圖」；從意圖欄捲就會拆開。
    assert.match(PAGE, /getBoundingClientRect\(\)\.height/);
    assert.doesNotMatch(PAGE, /\.offsetHeight/);
    assert.match(PAGE, /evolutionPane\.addEventListener\("scroll"/);
    assert.match(PAGE, /intentPane\.addEventListener\("scroll"/);
  });
});
