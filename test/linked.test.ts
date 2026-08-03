import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { ingestLinkedDocuments } from "../src/evidence/linked.ts";
import { extractRationale } from "../src/evidence/extract.ts";
import {
  extractFromLinkedDocuments,
  revalidateEvidence,
} from "../src/evidence/store.ts";
import { sha256, verifySpan } from "../src/evidence/span.ts";
import {
  createRecordingFetcher,
  createReplayFetcher,
  fixtureName,
} from "../src/http/fixtures.ts";
import type { HttpFetcher } from "../src/http/types.ts";
import { createGitHubFetcher } from "../src/http/github.ts";

const fixtureDir = path.resolve("fixtures/http");

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.exec(
    `INSERT INTO repo (id, root_path, origin_url, created_at)
       VALUES (1, '/tmp/demo', 'https://github.com/simplifaisoul/osiris.git', '2026-01-01');
     INSERT INTO git_commit
       (id, repo_id, sha, authored_at, committed_at, message, is_merge, topo_order)
       VALUES (1, 1, 'abc', '2026-01-01', '2026-01-01', 'fixes #162', 0, 0);
     INSERT INTO reference_link
       (repo_id, from_kind, from_key, to_kind, to_key, method, confidence)
       VALUES (1, 'commit', 'abc', 'issue', '162', 'message_ref', 0.9);`,
  );
  return db;
}

describe("linked 文件收取（全程 replay）", () => {
  it("離線修正 PR 種類，並保留 body、每則留言與 review", async () => {
    const db = makeDb();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("測試不得碰網路"))) as typeof fetch;
    try {
      const report = await ingestLinkedDocuments(db, 1, createReplayFetcher(fixtureDir));
      assert.deepEqual(report, {
        commitsScanned: 1,
        references: 1,
        correctedToPr: 1,
        documentsUpserted: 2,
        missing: 0,
        deduplicated: 0,
      });

      const reference = db.prepare(
        "SELECT to_kind AS kind FROM reference_link",
      ).get() as { kind: string };
      assert.equal(reference.kind, "pr", "issues endpoint 的 pull_request 欄位才是真相");

      const docs = db.prepare(
        `SELECT doc_type AS type, provenance_root AS root, external_id AS externalId,
                body, body_sha256 AS bodySha
           FROM source_doc ORDER BY doc_type, external_id`,
      ).all() as unknown as Array<{
        type: string;
        root: string;
        externalId: string;
        body: string;
        bodySha: string;
      }>;
      assert.equal(docs.length, 2, "公開 PR #162 的錄製快照含 body 與一則 comment");
      assert.deepEqual([...new Set(docs.map((doc) => doc.root))], ["pr:162"]);
      assert.equal(new Set(docs.map((doc) => doc.externalId)).size, 2);
      assert.ok(docs.some((doc) => doc.externalId === "pr:162:body"));
      assert.ok(docs.some((doc) => doc.externalId === "pr:162:comment:4522946314"));
      assert.ok(docs.every((doc) => doc.bodySha.length === 64));

      const extraction = extractFromLinkedDocuments(db, 1);
      assert.deepEqual(extraction, {
        documents: 2,
        documentsWithRationale: 1,
        candidates: 2,
        promoted: 2,
        rejected: 0,
        byReason: {},
      });
      const evidence = db.prepare(
        `SELECT d.external_id AS externalId, d.provenance_root AS root, e.tier
           FROM evidence e JOIN source_doc d ON d.id = e.source_doc_id
          ORDER BY d.external_id`,
      ).all() as unknown as Array<{ externalId: string; root: string; tier: string }>;
      assert.equal(evidence.length, 2);
      assert.ok(evidence.every((row) => row.root === "pr:162" && row.tier === "linked"));

      extractFromLinkedDocuments(db, 1);
      const afterRerun = db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number };
      assert.equal(afterRerun.n, 2, "離線重跑不得重複升格相同 span");

      const bodyDoc = docs.find((doc) => doc.externalId === "pr:162:body")!;
      const edited = `${bodyDoc.body}\nEdited upstream.`;
      db.prepare(
        "UPDATE source_doc SET body = ?, body_sha256 = ? WHERE external_id = 'pr:162:body'",
      ).run(edited, sha256(edited));
      assert.deepEqual(
        revalidateEvidence(db, 1),
        { checked: 2, stale: 2 },
        "PR body 被編輯後，舊 linked evidence 必須失效",
      );

      const second = await ingestLinkedDocuments(db, 1, createReplayFetcher(fixtureDir));
      assert.deepEqual(second, {
        commitsScanned: 0,
        references: 0,
        correctedToPr: 0,
        documentsUpserted: 0,
        missing: 0,
        deduplicated: 0,
      }, "linked 水位線讓重跑不再取同一個 commit");
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

  it("同一 PR 的多則留言使用不同 external_id，寫入時不按 root 去重", async () => {
    const db = makeDb();
    const fake: HttpFetcher = async (url) => {
      if (url.endsWith("/issues/162")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            number: 162,
            body: "because the shared cache needs a cap",
            html_url: "https://github.com/simplifaisoul/osiris/pull/162",
            user: { login: "author" },
            created_at: "2026-01-01",
            pull_request: {},
          }),
        };
      }
      if (url.includes("/issues/162/comments")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify([
            { id: 701, body: "to prevent one outage", html_url: "u1", created_at: "2026-01-02" },
            { id: 702, body: "because every worker shares it", html_url: "u2", created_at: "2026-01-03" },
          ]),
        };
      }
      return { status: 200, headers: {}, body: "[]" };
    };
    try {
      await ingestLinkedDocuments(db, 1, fake);
      const ids = db.prepare(
        "SELECT external_id AS id FROM source_doc ORDER BY external_id",
      ).all() as Array<{ id: string }>;
      assert.deepEqual(ids.map((row) => row.id), [
        "pr:162:body",
        "pr:162:comment:701",
        "pr:162:comment:702",
      ]);
      extractFromLinkedDocuments(db, 1);
      const rows = db.prepare(
        `SELECT COUNT(*) AS evidence, COUNT(DISTINCT d.id) AS documents,
                COUNT(DISTINCT d.provenance_root) AS roots
           FROM evidence e JOIN source_doc d ON d.id = e.source_doc_id`,
      ).get() as { evidence: number; documents: number; roots: number };
      assert.deepEqual({ ...rows }, { evidence: 3, documents: 3, roots: 1 });
    } finally {
      db.close();
    }
  });

  it("**同一目標被多個 commit 提到時只取一次**，但每一列都要修正 to_kind", async () => {
    // create-t3-app 有 1,310 條 reference 只指向 1,085 個相異目標，
    // 逐 row 取回等於 17% 的請求是重複的——那趟要跑近一小時，省下來的是實錢。
    const db = makeDb();
    // 再加兩個 commit 提到同一個 #162，以及一個提到別的目標當對照。
    db.exec(
      `INSERT INTO git_commit
         (id, repo_id, sha, authored_at, committed_at, message, is_merge, topo_order)
         VALUES (2, 1, 'def', '2026-01-02', '2026-01-02', 'also fixes #162', 0, 1),
                (3, 1, 'ghi', '2026-01-03', '2026-01-03', 'and #999', 0, 2);
       INSERT INTO reference_link
         (repo_id, from_kind, from_key, to_kind, to_key, method, confidence)
         VALUES (1, 'commit', 'def', 'issue', '162', 'message_ref', 0.9),
                (1, 'commit', 'ghi', 'issue', '999', 'message_ref', 0.9);`,
    );
    const urls: string[] = [];
    const fake: HttpFetcher = async (url) => {
      urls.push(url);
      const match = /\/issues\/(\d+)$/.exec(url);
      if (match) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            number: Number(match[1]),
            body: "because the cache needs a cap",
            html_url: `https://github.com/simplifaisoul/osiris/pull/${match[1]}`,
            user: { login: "author" },
            created_at: "2026-01-01",
            // 兩個都是 PR，這樣才驗得到快取命中時 to_kind 仍被修正
            pull_request: {},
          }),
        };
      }
      return { status: 200, headers: {}, body: "[]" };
    };
    try {
      const report = await ingestLinkedDocuments(db, 1, fake);
      assert.equal(report.references, 3, "三列 reference 都要走到");
      assert.equal(report.deduplicated, 1, "#162 的第二列必須命中快取");

      const issueCalls = urls.filter((u) => /\/issues\/\d+$/.test(u));
      assert.deepEqual(
        issueCalls.map((u) => u.slice(u.lastIndexOf("/") + 1)).sort(),
        ["162", "999"],
        "#162 只能被取一次",
      );

      // **這是這條測試真正守住的東西**：省請求不得省掉 to_kind 的修正，
      // 否則第二個 commit 的那一列會永遠留著錯的 'issue'，而查詢層靠它分辨 PR。
      const kinds = db.prepare(
        "SELECT from_key AS c, to_key AS k, to_kind AS kind FROM reference_link ORDER BY from_key",
      ).all() as Array<{ c: string; k: string; kind: string }>;
      assert.deepEqual(kinds.map((r) => ({ ...r })), [
        { c: "abc", k: "162", kind: "pr" },
        { c: "def", k: "162", kind: "pr" },
        { c: "ghi", k: "999", kind: "pr" },
      ]);
      assert.equal(report.correctedToPr, 3, "三列都是由 issue 修正成 pr");

      // 文件不得因為去重而漏寫或重複。
      const ids = db.prepare(
        "SELECT external_id AS id FROM source_doc ORDER BY external_id",
      ).all() as Array<{ id: string }>;
      assert.deepEqual(ids.map((r) => r.id), ["pr:162:body", "pr:999:body"]);
    } finally {
      db.close();
    }
  });

  it("rate limit 不推進水位線，並把 retry-after 留給呼叫端", async () => {
    const db = makeDb();
    const limited: HttpFetcher = async (url) => ({
      status: 429,
      headers: { "retry-after": "120", "x-ratelimit-reset": "1785505000" },
      body: '{"message":"secondary rate limit"}',
    });
    try {
      const report = await ingestLinkedDocuments(db, 1, limited);
      assert.deepEqual(report, {
        commitsScanned: 0,
        references: 1,
        correctedToPr: 0,
        documentsUpserted: 0,
        missing: 0,
        deduplicated: 0,
        stopped: {
          status: 429,
          url: "https://api.github.com/repos/simplifaisoul/osiris/issues/162",
          retryAfter: "120",
          rateLimitReset: "1785505000",
        },
      });
      const state = db.prepare(
        "SELECT 1 FROM pass_state WHERE repo_id = 1 AND pass_name = 'linked'",
      ).get();
      assert.equal(state, undefined, "失敗的 commit 不得被水位線越過");
    } finally {
      db.close();
    }
  });
});

describe("linked Markdown 抽取", () => {
  it("排除 fenced code 與引用行，保留正文理由且 span 全部可驗證", () => {
    const body = [
      "## Motivation",
      "Use a bound because workers share the same memory budget.",
      "",
      "> Quoted from elsewhere because the old cache was slow.",
      "",
      "```ts",
      "// because this is example code, not project rationale",
      "const reason = 'to prevent a demo failure';",
      "```",
      "",
      "- to prevent unbounded growth in production",
    ].join("\n");
    const spans = extractRationale(body, { format: "markdown" });
    assert.deepEqual(
      spans.map((span) => span.quotedText),
      [
        "because workers share the same memory budget.",
        "to prevent unbounded growth in production",
      ],
    );
    const bodySha = sha256(body);
    for (const extracted of spans) {
      assert.equal(verifySpan(body, bodySha, {
        charStart: extracted.charStart,
        charEnd: extracted.charEnd,
        quotedText: extracted.quotedText,
        expectedBodySha: bodySha,
      }).ok, true);
    }
  });
});

describe("HTTP 錄放 fixture", () => {
  it("live adapter 不會把 token 帶到 api.github.com 以外的 host", async () => {
    await assert.rejects(
      createGitHubFetcher({ token: "secret" })("https://example.com/steal"),
      /拒絕非 api\.github\.com URL/,
    );
  });

  it("錄檔會濾掉 Authorization 與 token-like header", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ostracon-http-"));
    const url = "https://api.github.com/repos/acme/demo/issues/9";
    const fake: HttpFetcher = async () => ({
      status: 200,
      headers: {
        Authorization: "Bearer github_pat_FAKESECRET",
        "x-debug-secret": "github_pat_ANOTHERSECRET",
        "content-type": "application/json",
      },
      body: "{}",
    });
    try {
      await createRecordingFetcher(fake, dir)(url);
      const recorded = readFileSync(path.join(dir, fixtureName(url)), "utf8");
      assert.doesNotMatch(recorded, /authorization/i);
      assert.doesNotMatch(recorded, /bearer\s+/i);
      assert.doesNotMatch(recorded, /github_pat_/i);
      assert.match(recorded, /content-type/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("版本庫內的 HTTP fixtures 不含 token", () => {
    const combined = readdirSync(fixtureDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readFileSync(path.join(fixtureDir, name), "utf8"))
      .join("\n");
    assert.doesNotMatch(combined, /authorization/i);
    assert.doesNotMatch(combined, /bearer\s+/i);
    assert.doesNotMatch(combined, /github_pat_|gh[pousr]_[A-Za-z0-9_]/i);
  });
});
