import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { deriveClaims } from "../src/claim/derive.ts";
import {
  evolutionOf,
  listEntities,
  ostracisedFor,
  repoSummary,
} from "../src/ui/data.ts";
import {
  ENTITIES_PATH,
  OSTRACISED_PATH,
  SUMMARY_PATH,
  evolutionPath,
  startUiServer,
} from "../src/ui/server.ts";
import { exportStaticSite } from "../src/ui/export.ts";
import { entityCoverage, rationaleGroups } from "../src/ui/data.ts";
import { affectedEntityCounts } from "../src/claim/scope.ts";
import { declarationScopeOf } from "../src/index/repo-pass.ts";
import { APP_DIR, appBuilt, appFiles } from "../src/ui/app-assets.ts";
import { sha256 } from "../src/evidence/span.ts";
import { INSERT_CONTENT_FIXTURE, REVISION_COLUMNS, revisionValues } from "./db-fixture.ts";

/** SQLite 的字串字面量是單引號；雙引號會被當成識別子。 */
const lit = (text: string) => `'${text.replaceAll("'", "''")}'`;

const WITH_REASON = "fix: cap the fetch\n\nCapped it to avoid the quota burn.";

/** `stable_key` 是 64 位十六進位；路由會驗格式，fixture 也要用真實形狀。 */
const K1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const K2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
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
    revisionValues({ id, commitId: commit });
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
       VALUES (1, 1, '${K1}', 1);
     ${INSERT_CONTENT_FIXTURE}
     INSERT INTO revision ${REVISION_COLUMNS}
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
    assert.equal(entity.untouched, 0);
    assert.equal(entity.withEntityIntent, 1);
    assert.equal(entity.withBatchIntent, 0);
    db.close();
  });

  it("稀疏度是頭條數字", () => {
    const db = open(fixtureDb());
    const summary = repoSummary(db, 1);
    assert.equal(summary.changes, 2);
    assert.equal(summary.untouched, 0);
    assert.equal(summary.changesWithEntityIntent, 1);
    assert.equal(summary.changesWithBatchIntent, 0);
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
    assert.equal(listEntities(db, 1)[0]!.withEntityIntent, 2);
    assert.equal(repoSummary(db, 1).changesWithEntityIntent, 2);
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

      const entities = await (await fetch(`${url}api/entities.json`)).json() as
        Array<{ stableKey: string }>;
      assert.equal(entities.length, 1);
      const rows = await (await fetch(
        `${url}api/evolution/${entities[0]!.stableKey}.json`,
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
      // 壞 id 與「沒這條路由」必須分開：把壞參數當成 404 會讓使用者
      // 去找一個其實存在的端點。
      assert.equal((await fetch(`${url}api/evolution/abc.json`)).status, 400);
      assert.equal((await fetch(`${url}api/evolution/-1.json`)).status, 400);
      // **格式對但不存在要回 404，不是 400。** 那是「沒有這個東西」，不是參數錯。
      assert.equal(
        (await fetch(`${url}api/evolution/${"f".repeat(64)}.json`)).status,
        404,
      );
      assert.equal((await fetch(`${url}api/evolution`)).status, 404);
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

  // 「頁面沒有任何外部資源」搬到 ladder-view.test.ts 的
  // 「**前端成品不得載入任何外部資源**」——那一條掃的是真正出貨的
  // `dist/ui/app`，而不是一段永遠不會送到瀏覽器的樣板字串。
  //
  // 「逐列高度保留子像素，而且從任一欄捲動都同步」**沒有搬，因為機制沒有了**：
  // 舊頁面是兩個各自捲動的欄，要靠 JS 逐列量測高度才對得齊；新前端一列就是
  // 一個 grid row（`.timeline-row` 裡三個 div），對齊由版面保證，沒有第二個
  // 捲動容器可以拆開。契約消失是因為造成它的東西消失了，不是因為不再在意。
});

describe("整批理由要標示而不是收回", () => {
  /**
   * 一顆 commit 同時改到 `n` 個宣告，訊息裡只有一句理由。
   *
   * 實測形狀：vuejs/core 的 722 條一般 claim 只來自 123 條引文，最大一條同時
   * 歸給 72 個宣告；Osiris 被當成健康基準的 74 條其實只是 3 條引文，其中一條
   * 掛在 70 個宣告上。
   */
  function batchDb(n: number, unclaimed = 0): string {
    const body = "refactor: split the module\n\nMoved them to avoid the cycle.";
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-batch-")), "i.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
    const slots: string[] = [];
    const entities: string[] = [];
    const revs: string[] = [];
    const changes: string[] = [];
    for (let i = 1; i <= n; i++) {
      slots.push(`(${i}, 1, 1, 'sym${i}', 'function')`);
      entities.push(`(${i}, 1, 'k${i}', 1)`);
      revs.push(revisionValues({ id: i, commitId: 1, slotId: i, entityId: i }));
      changes.push(`(${i}, ${i}, 1, ${i}, 'shape')`);
    }
    db.exec(
      `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/r', '2026-01-01');
       INSERT INTO path_lineage (id, repo_id) VALUES (1, 1);
       INSERT INTO git_commit
         (id, repo_id, sha, authored_at, committed_at, message, topo_order)
       VALUES (1, 1, 'aaaaaaaaaaaa', '2026-01-01', '2026-01-01', ${lit(body)}, 0);
       INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind)
         VALUES ${slots.join(",")};
       INSERT INTO entity (id, repo_id, stable_key, birth_commit_id)
         VALUES ${entities.join(",")};
       ${INSERT_CONTENT_FIXTURE}
       INSERT INTO revision ${REVISION_COLUMNS}
       VALUES ${revs.join(",")};
       INSERT INTO revision_change (id, next_revision, commit_id, entity_id, change_level)
         VALUES ${changes.join(",")};
       INSERT INTO source_doc
         (id, repo_id, doc_type, provenance_root, external_id, author, created_at,
          body, body_sha256)
       VALUES (1, 1, 'commit_message', 'commit:aaaaaaaaaaaa', 'aaaaaaaaaaaa', 'x',
               '2026-01-01', ${lit(body)}, '${sha256(body)}');`,
    );
    const quote = "to avoid the cycle.";
    const at = body.indexOf(quote);
    const ev = db.prepare(
      `INSERT INTO evidence
         (repo_id, source_doc_id, char_start, char_end, quoted_text, doc_body_sha,
          tier, verified)
       VALUES (1, 1, ?, ?, ?, ?, 'stated', 1)`,
    ).run(at, at + quote.length, quote, sha256(body));
    db.prepare(
      `INSERT INTO evidence_candidate
         (repo_id, source_doc_id, proposed_char_start, proposed_char_end,
          proposed_quoted_text, expected_doc_body_sha, proposed_tier, generator_kind,
          generator_version, status, promoted_evidence_id, created_at)
       VALUES (1, 1, ?, ?, ?, ?, 'stated', 'rule',
               'rule-rationale-0.5.0/causal:to avoid', 'promoted', ?, '2026-01-01')`,
    ).run(at, at + quote.length, quote, sha256(body), Number(ev.lastInsertRowid));
    deriveClaims(db, 1);
    // **同一顆 commit 動到、但沒有被理由涵蓋的宣告。** 在 `deriveClaims` 之後才
    // 插入，所以 `affectedEntityCounts` 會數到它們而理由不會——沒有這一段，
    // 「reach 從 entities 導出」那條測試咬不動（兩個數字剛好相等，改成另算
    // 一份也照樣通過，實測過）。
    for (let i = n + 1; i <= n + unclaimed; i++) {
      db.exec(
        `INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind)
           VALUES (${i}, 1, 1, 'extra${i}', 'function');
         INSERT INTO entity (id, repo_id, stable_key, birth_commit_id)
           VALUES (${i}, 1, 'k${i}', 1);
         INSERT INTO revision ${REVISION_COLUMNS}
         VALUES ${revisionValues({ id: i, commitId: 1, slotId: i, entityId: i })};
         INSERT INTO revision_change (id, next_revision, commit_id, entity_id, change_level)
           VALUES (${i}, ${i}, 1, ${i}, 'shape');`,
      );
    }
    db.close();
    return dbPath;
  }

  it("只改到一個宣告時，理由是那個宣告專屬的", () => {
    const db = open(batchDb(1));
    const [intent] = evolutionOf(db, 1, 1)[0]!.intent;
    assert.equal(intent!.scope, "entity");
    assert.equal(intent!.affectedEntities, 1);
    db.close();
  });

  it("**同時改到多個宣告時標為整批，而且不收回**", () => {
    // 收回的代價量過：以「扇出必須為 1」當門檻，Osiris 的意圖層會整個歸零。
    // 該收回的是宣稱的**強度**，不是這條資訊本身。
    const db = open(batchDb(5));
    const [intent] = evolutionOf(db, 1, 1)[0]!.intent;
    assert.ok(intent, "理由不得消失");
    assert.equal(intent.scope, "batch");
    assert.equal(intent.affectedEntities, 5);
    assert.equal(intent.text, "to avoid the cycle.", "引文逐字不變");
    db.close();
  });

  it("**稀疏度標頭把專屬與整批分開數**", () => {
    // 合起來會誇大一個數量級：實測 vuejs/core 是 34 對 508。
    const db = open(batchDb(5));
    const summary = repoSummary(db, 1);
    assert.equal(summary.changes, 5);
    assert.equal(summary.changesWithEntityIntent, 0, "沒有一次是專屬的");
    assert.equal(summary.changesWithBatchIntent, 5);
    db.close();
  });

  it("結構欄也分開數", () => {
    const db = open(batchDb(5));
    const rows = listEntities(db, 1);
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.withEntityIntent === 0 && r.withBatchIntent === 1));
    db.close();
  });

  it("**分子與分母必須數同一種東西**", () => {
    // claim 的相關性判準是 `change_level <> 'none'`。分母把 `none` 也算進來的話，
    // 那個比例是在比較兩個不同的母體——實測 vuejs/core 有 88.5% 的列是 `none`，
    // 分母因此虛胖九倍。
    const dbPath = batchDb(3);
    const db = open(dbPath);
    db.exec(
      `INSERT INTO git_commit
         (id, repo_id, sha, authored_at, committed_at, message, topo_order)
       VALUES (2, 1, 'bbbbbbbbbbbb', '2026-01-02', '2026-01-02', 'chore: touch', 1);
       INSERT INTO revision_change
         (id, prev_revision, commit_id, entity_id, change_level)
       VALUES (91, 1, 2, 1, 'none'), (92, 2, 2, 2, 'none')`,
    );
    const summary = repoSummary(db, 1);
    assert.equal(summary.changes, 3, "只數真的改到的");
    assert.equal(summary.untouched, 2, "「檔案動了但這裡沒動」單獨數，不混進分母");

    const first = listEntities(db, 1).find((e) => e.symbol === "sym1");
    assert.ok(first);
    assert.equal(first.revisions, 1);
    assert.equal(first.untouched, 1);
    db.close();
  });

  // 「整批的引文不給暖色」搬到 workspace/src/contract.test.tsx 的
  // 「**整批理由不進逐列的暖色格**」：那一條真的把元件掛起來，斷言整批列
  // 拿到的是 `.honest-blank` 而不是 `.literal-evidence`——比釘一條 CSS 選擇器
  // 接近契約本身。

  /**
   * 扇出是 scope，不是品質。規格見 `docs/plan-rationale-scope.md`。
   */
  describe("理由以引文分組", () => {
    it("**扇出增加，理由數不得增加**", () => {
      // 這是整條線的核心驗收。先前畫面逐列顯示，於是同一句話被印 N 次——
      // 實測 pypa/pip 6,859 列只來自 814 個群組（9 倍），
      // microsoft/playwright 6,975 列只來自 531 個（14 倍）。
      const three = open(batchDb(3));
      const thirty = open(batchDb(30));
      assert.equal(rationaleGroups(three, 1).length, 1);
      assert.equal(rationaleGroups(thirty, 1).length, 1, "扇出變大讓理由看起來變多了");
      assert.equal(rationaleGroups(three, 1)[0]!.reach, 3);
      assert.equal(rationaleGroups(thirty, 1)[0]!.reach, 30);
      three.close();
      thirty.close();
    });

    it("**`reach` 與 `entities` 是同一個陣列導出的**", () => {
      // 兩邊各算一次的話，標頭會說 20 而清單只展得開 12——這個專案已經被
      // 同型的分岔咬過（CLI 說 5 顆聚合 commit、UI 說 6 顆）。
      //
      // **這顆 commit 動到 20 個宣告，理由只涵蓋 12 個。** 兩個數字必須不同，
      // 否則「改成用 affectedEntityCounts 算 reach」這個錯誤照樣會通過。
      const db = open(batchDb(12, 8));
      assert.equal(affectedEntityCounts(db, 1).get("aaaaaaaaaaaa"), 20);
      const groups = rationaleGroups(db, 1);
      assert.equal(groups.length, 1);
      for (const group of groups) {
        assert.equal(group.reach, group.entities.length);
        assert.equal(group.reach, 12, "理由涵蓋的不是被 commit 動到的全部");
        assert.equal(new Set(group.entities).size, group.entities.length, "entities 有重複");
      }
      db.close();
    });

    it("scope 由涵蓋數決定，不由別處算", () => {
      const single = open(batchDb(1));
      const many = open(batchDb(5));
      assert.equal(rationaleGroups(single, 1)[0]!.scope, "entity");
      assert.equal(rationaleGroups(many, 1)[0]!.scope, "batch");
      single.close();
      many.close();
    });

    it("quoteId 穩定且唯一", () => {
      // 它會進網址。同一份索引重算兩次必須相同。
      const db = open(batchDb(4));
      const first = rationaleGroups(db, 1);
      const second = rationaleGroups(db, 1);
      assert.deepEqual(first.map((g) => g.quoteId), second.map((g) => g.quoteId));
      assert.equal(new Set(first.map((g) => g.quoteId)).size, first.length);
      db.close();
    });
  });

  describe("可達性的三個契約", () => {
    it("indexed 由資料庫算，discoverable 與 inspectable 由呼叫端報", () => {
      const db = open(batchDb(7));
      const coverage = entityCoverage(db, 1, {
        discoverable: 4,
        inspectable: 7,
        rule: "test",
        absentReason: "test",
      });
      assert.equal(coverage.indexed, 7);
      assert.equal(coverage.discoverable, 4);
      db.close();
    });

    it("**報出比索引總數還大的可達數要吵**", () => {
      // 一個看起來合理的錯數字比一個錯誤訊息危險得多——「任何一個宣告都
      // 查得到」那句假宣稱就是這樣上線的。
      const db = open(batchDb(2));
      assert.throws(
        () => entityCoverage(db, 1, {
          discoverable: 99,
          inspectable: 2,
          rule: "test",
          absentReason: null,
        }),
        /可達性數字大於索引總數/,
      );
      db.close();
    });
  });
});

describe("靜態匯出", () => {
  const outDir = () => mkdtempSync(path.join(tmpdir(), "ostracon-export-"));

  it("**匯出的路徑與伺服器的完全相同**", () => {
    // 這是「頁面只有一份實作」的物理保證：兩邊的 URL 一樣，頁面裡就不會
    // 長出「靜態版 / 伺服器版」的分支。
    const db = open(fixtureDb());
    const out = outDir();
    const report = exportStaticSite(db, out, { label: "demo repo" });
    assert.equal(report.entities, 1);
    for (const relative of [
      SUMMARY_PATH, ENTITIES_PATH, evolutionPath(K1), "/index.html",
    ]) {
      assert.ok(
        existsSync(path.join(out, relative.replace(/^\//, ""))),
        `${relative} 應該被寫出來`,
      );
    }
    db.close();
  });

  it("**有意圖的宣告一定會被匯出，不受改動量排序影響**", () => {
    // 實測 vuejs/core 取前 400 筆時門檻是 11 次改動，而訊噪比最好的
    // `generateCodeFrame`（10 次改動、一條具體約束）剛好被擠掉。
    // demo 的內容不能被一個與內容無關的排序決定。
    const db = open(fixtureDb());
    const out = outDir();
    // limit 1 之下，只靠改動量排序仍會取到那一筆；把它降到 0 才看得出差別，
    // 所以改用「只要有意圖就一定在」這個性質來釘。
    const report = exportStaticSite(db, out, { label: "x", limit: 0 });
    assert.equal(report.entities, 1, "有意圖的那一筆不得因為 limit 被丟掉");
    assert.ok(existsSync(path.join(out, evolutionPath(K1).replace(/^\//, ""))));
    db.close();
  });

  it("**`--label` 取代本機路徑**", () => {
    // 不換的話 demo 會把匯出者的檔案系統路徑公開出去。這不是美觀問題。
    const db = open(fixtureDb());
    const out = outDir();
    exportStaticSite(db, out, { label: "vuejs/core" });
    const summary = JSON.parse(
      readFileSync(path.join(out, SUMMARY_PATH.replace(/^\//, "")), "utf8"),
    ) as { rootPath: string };
    assert.equal(summary.rootPath, "vuejs/core");
    // 真正該驗的是「來源路徑沒有外洩」——fixture 的 root_path 是 `/r`。
    assert.equal(
      JSON.stringify(summary).includes(repoSummary(db, 1).rootPath),
      false,
      "匯出的 JSON 裡不得殘留資料庫記的本機路徑",
    );
    db.close();
  });

  it("匯出的內容與伺服器回的一字不差", async () => {
    // 兩條路徑各算一次的話，線上 demo 與本機看到的會是兩份資料。
    const dbPath = fixtureDb();
    const out = outDir();
    const db = open(dbPath);
    exportStaticSite(db, out, { label: "x" });
    db.close();

    const { url, server } = await startUiServer({ dbPath, port: 0 });
    try {
      const live = await (await fetch(`${url}api/evolution/${K1}.json`)).text();
      const stat = readFileSync(
        path.join(out, evolutionPath(K1).replace(/^\//, "")), "utf8",
      );
      assert.equal(stat, live);
    } finally {
      server.close();
    }
  });

  it("匯出的頁面沒有任何外部資源，也沒有殘留的查詢字串端點", () => {
    const db = open(fixtureDb());
    const out = outDir();
    exportStaticSite(db, out, { label: "x" });
    const html = readFileSync(path.join(out, "index.html"), "utf8");
    assert.equal(/(?:src|href)="(?:https?:)?\/\//.test(html), false);
    assert.doesNotMatch(html, /api\/evolution\?/, "查詢字串沒辦法變成靜態檔");
    db.close();
  });
});

describe("被推翻的做法：清單、數字、時間軸必須一致", () => {
  /** 一個已消亡且被判為迂迴的宣告，外加一個測試檔裡的。 */
  function goneDb(): string {
    const dbPath = fixtureDb();
    const db = open(dbPath);
    db.exec(
      `UPDATE revision_change
          SET change_level = 'death', prev_revision = 2, next_revision = NULL
        WHERE id = 2;
       INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind)
         VALUES (2, 1, 1, 'App.render', 'function');
       INSERT INTO entity (id, repo_id, stable_key, birth_commit_id)
         VALUES (2, 1, '${K2}', 1);
       INSERT INTO revision ${REVISION_COLUMNS}
       VALUES ${revisionValues({ id: 3, commitId: 1, slotId: 2, entityId: 2,
                                 path: "src/__tests__/a.spec.ts" })};
       INSERT INTO revision_change
         (id, prev_revision, commit_id, entity_id, change_level)
         VALUES (3, 3, 2, 2, 'death');
       INSERT INTO excursion
         (id, repo_id, entity_id, introduce_commit, remove_commit, duration_days,
          strength, method) VALUES
         (1, 1, 1, 1, 2, 1, 'A', 'inverse_diff'),
         (2, 1, 2, 1, 2, 1, 'A', 'inverse_diff');`,
    );
    db.close();
    return dbPath;
  }

  it("**標頭數字與清單來自同一個查詢與同一個 predicate**", () => {
    // landing 寫 710、CLI 顯示 537 那次，就是兩邊各數一次的結果。
    const db = open(goneDb());
    const view = ostracisedFor(db, 1);
    const summary = repoSummary(db, 1);
    assert.equal(summary.ostracised.shown, view.rows.length);
    assert.equal(summary.ostracised.hiddenTests, view.hiddenTests);
    assert.equal(view.rows.length, 1, "測試檔的那條不在清單裡");
    assert.equal(view.hiddenTests, 1);
    assert.equal(view.suspected, 0);
    assert.equal(view.rows[0]!.symbol, "cappedFetch");
    db.close();
  });

  it("**清單上的每一條都匯出得到時間軸**", async () => {
    // 清單看得到、點進去沒有資料，就是把一個落差換成另一個落差。
    const dbPath = goneDb();
    const out = mkdtempSync(path.join(tmpdir(), "ostracon-gone-"));
    const db = open(dbPath);
    // limit 0：靠改動量排序一筆都不收，只剩被推翻的做法與有意圖的那一筆。
    const report = exportStaticSite(db, out, { label: "x", limit: 0 });
    const view = ostracisedFor(db, 1);
    db.close();

    assert.equal(report.ostracised, view.rows.length);
    for (const row of view.rows) {
      assert.ok(
        existsSync(path.join(out, evolutionPath(row.stableKey).replace(/^\//, ""))),
        `${row.symbol} 的時間軸應該被匯出`,
      );
    }
    const listed = JSON.parse(
      readFileSync(path.join(out, OSTRACISED_PATH.replace(/^\//, "")), "utf8"),
    ) as { rows: Array<{ stableKey: string }>; hiddenTests: number };
    assert.deepEqual(
      listed.rows.map((r) => r.stableKey),
      view.rows.map((r) => r.stableKey),
    );
    assert.equal(listed.hiddenTests, view.hiddenTests);
  });

  it("**C 級疑似不進清單也不進頭條**", () => {
    // C 是「僅生命週期符合、未經證實」，放進頭條就是把疑似當成確證呈現。
    const dbPath = goneDb();
    const db = open(dbPath);
    db.exec("UPDATE excursion SET strength = 'C' WHERE id = 1");
    const view = ostracisedFor(db, 1);
    assert.equal(view.rows.length, 0);
    assert.equal(view.suspected, 1);
    assert.equal(repoSummary(db, 1).ostracised.suspected, 1);
    db.close();
  });

  it("端點回得出被推翻的做法", async () => {
    const { url, server } = await startUiServer({ dbPath: goneDb(), port: 0 });
    try {
      const body = await (await fetch(`${url}api/ostracised.json`)).json() as
        { rows: unknown[]; hiddenTests: number };
      assert.equal(body.rows.length, 1);
      assert.equal(body.hiddenTests, 1);
    } finally {
      server.close();
    }
  });
});

describe("對外身分是 stable_key，不是 rowid", () => {
  it("**rowid 漂移最壞的後果不是 404，是回傳另一個 entity**", () => {
    // 全量重建索引會讓 rowid 改變。用 rowid 當網址的話，舊連結在重建後
    // 可能安靜地指到別的宣告——那比 404 難發現得多（不變量 1）。
    assert.equal(evolutionPath(K1), `/api/evolution/${K1}.json`);
    assert.doesNotMatch(evolutionPath(K1), /\/1\.json$/);
  });

  it("匯出的檔名就是 stable_key", () => {
    const db = open(fixtureDb());
    const out = mkdtempSync(path.join(tmpdir(), "ostracon-key-"));
    exportStaticSite(db, out, { label: "x" });
    assert.ok(existsSync(path.join(out, "api", "evolution", `${K1}.json`)));
    db.close();
  });

  it("**格式不合法回 400，格式合法但不存在回 404**", async () => {
    // 兩者混為一談會讓使用者去找一個其實存在的端點，或反過來以為參數寫錯。
    const { url, server } = await startUiServer({ dbPath: fixtureDb(), port: 0 });
    try {
      assert.equal((await fetch(`${url}api/evolution/1.json`)).status, 400);
      assert.equal((await fetch(`${url}api/evolution/..%2F..%2Fetc.json`)).status, 400);
      assert.equal(
        (await fetch(`${url}api/evolution/${"0".repeat(64)}.json`)).status, 404,
      );
      assert.equal((await fetch(`${url}api/evolution/${K1}.json`)).status, 200);
    } finally {
      server.close();
    }
  });

  // 「**切換名單要清掉選取**」**沒有搬，因為機制沒有了**：舊頁面有 all／gone
  // 兩個 tab 共用同一個右欄，切 tab 不清選取就會留下上一條時間軸。新前端沒有
  // 那組 tab——picker 選完直接換整條時間軸，右欄不存在「來源消失」的狀態。
  //
  // 「**深連結用 stable_key，而且兩個入口共用同一段切換**」搬到
  // workspace/src/contract.test.tsx 的「深連結解析（真的發請求）」。舊的那一條
  // 自己寫著「**這一組是原始碼層級的釘樁，不是行為驗證**」——它只能 regex 比對
  // `switchTab("gone")` 有沒有出現在字串裡。現在是真的發請求：只在
  // ostracised.json 裡的 key 打得開、在 entities.json 裡的不去付第二份的成本、
  // 兩份都沒有時出現明確錯誤而不是靜默退回精選。
  //
  // 「**選取會更新網址，但不得堆積上一頁**」也搬過去了，而且從「原始碼裡有沒有
  // 出現 pushState」變成「點一下之後 `history.length` 有沒有變」。
});

describe("清單的名稱要符合資料", () => {
  it("**已消亡的宣告仍在清單裡，並且逐列標示**", () => {
    // 這份清單不是「現存的宣告」——只留存活者會讓實測 vuejs/core 的 916 筆
    // 兩個名單都到不了（C 級疑似或在測試檔裡），而它們是 parseChildren、
    // parseTag 這種實在的歷史。所以不過濾，改成逐列標示。
    const db = open(fixtureDb());
    assert.equal(listEntities(db, 1)[0]!.dead, false);

    db.exec("UPDATE entity SET death_commit_id = 2 WHERE id = 1");
    const after = listEntities(db, 1);
    assert.equal(after.length, 1, "已消亡的不得從清單消失");
    assert.equal(after[0]!.dead, true);
    db.close();
  });

  it("`dead` 是布林，不是 SQLite 的 0／1", () => {
    // `0` 是 falsy 但 `"0"` 不是——這種東西流到樣板裡會安靜地永遠為真。
    const db = open(fixtureDb());
    assert.strictEqual(listEntities(db, 1)[0]!.dead, false);
    db.close();
  });

  // 「tab 名稱不宣稱「現存」」搬到 workspace/src/contract.test.tsx 的
  // 「**已消亡的宣告仍看得到，並且逐列標示**」——picker 現在承擔同一件事，
  // 而那一條連「有沒有真的標出 removed」一起驗。
});

describe("公開 demo 的介面文字是英文", () => {
  it("**出貨的產物裡不得有任何中日韓字元**", () => {
    if (!appBuilt()) return;
    // 舊版是逐條列出九個英文字串——那是「這幾句翻過了」，不是「介面是英文的」，
    // 加一個新畫面就繞過去了。改成掃成品：這個 repo 的註解、commit 訊息與
    // 測試名稱都是中文，但**壓縮之後留在 bundle 裡的中文只可能是介面文字**。
    const cjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
    for (const file of appFiles()) {
      if (!/\.(html|js|css)$/.test(file)) continue;
      const body = readFileSync(path.join(APP_DIR, file), "utf8");
      const hit = cjk.exec(body);
      assert.equal(
        hit,
        null,
        hit === null ? "" : `${file} 含中日韓字元：${body.slice(Math.max(0, hit.index - 40), hit.index + 40)}`,
      );
    }
    assert.match(readFileSync(path.join(APP_DIR, "index.html"), "utf8"), /<html lang="en">/);
  });
});

describe("反白不得改變版面", () => {
  it("**沒有任何 .selected 規則會改到盒模型**", () => {
    // 舊頁面釘的是 `.rev.hit, .slot.hit { box-shadow: inset`——理由是意圖欄與
    // 演化欄逐列量測對齊，選中列一長高理由就印到別人的改動底下。新前端不靠
    // 量測對齊了，但同一條規則仍然成立：選取只換顏色，不換尺寸，否則點一下
    // 整張表就會抖一下。
    //
    // **`border-color` 是允許的**（寬度沒變），`border:` 簡寫與 `border-width`
    // 不允許——那正是最容易不小心寫成的形式。
    const css = readFileSync(
      new URL("../workspace/src/index.css", import.meta.url),
      "utf8",
    );
    const rules = [...css.matchAll(/^([^\n{]*\.selected[^\n{]*)\{([^}]*)\}/gm)];
    assert.ok(rules.length >= 5, `只找到 ${rules.length} 條 .selected 規則——選擇器改了，這條會空轉`);
    for (const [, selector, body] of rules) {
      assert.doesNotMatch(
        body!,
        /(^|;)\s*(padding|margin|border-width|border-style|border|font-size|line-height)\s*:/,
        `${selector!.trim()} 改到了盒模型——選取會讓那一列的高度變動`,
      );
    }
  });
});

describe("降級過的索引不得靜默地被讀出去", () => {
  const scopedDb = (scope: "repo" | "lineage") => {
    const dbPath = fixtureDb();
    const db = open(dbPath);
    db.prepare(
      `INSERT INTO pass_state
         (repo_id, pass_name, last_commit_id, indexer_version, updated_at)
       VALUES (1, 'declarations', NULL, ?, '2026-01-01')
       ON CONFLICT (repo_id, pass_name) DO UPDATE SET
         indexer_version = excluded.indexer_version`,
    ).run(`walk-0.0.0+whatever+scope:${scope}`);
    return { dbPath, db };
  };

  it("**認得出索引是快路徑建的**", () => {
    // `why` 的快路徑只走單一血緣：搬移守門在那個範圍下是瞎的，配不到的宣告
    // 會被算成誕生。實測對一個已跑過全 repo pass 的資料庫再跑一次 why，
    // vuejs/core 多出 3 個假 entity 與約 155 列改動。
    const lineage = scopedDb("lineage");
    assert.equal(declarationScopeOf(lineage.db, 1), "lineage");
    lineage.db.close();

    const repo = scopedDb("repo");
    assert.equal(declarationScopeOf(repo.db, 1), "repo");
    repo.db.close();
  });

  it("沒有宣告層水位線時回 undefined，而不是猜一個", () => {
    const db = open(fixtureDb());
    assert.equal(declarationScopeOf(db, 1), undefined);
    db.close();
  });
});
