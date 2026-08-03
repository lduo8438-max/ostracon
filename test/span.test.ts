import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { sha256, verifySpan } from "../src/evidence/span.ts";
import { extractRationale, extractReferences } from "../src/evidence/extract.ts";
import {
  extractFromCommitMessages,
  ingestCommitMessages,
  revalidateEvidence,
  submitCandidates,
} from "../src/evidence/store.ts";

const BODY = "fix: 用 histogram 取代預設 diff 演算法\n\n因為 Myers 的 hunk 邊界不穩定。";
const SHA = sha256(BODY);

const span = (over: Partial<Parameters<typeof verifySpan>[2]> = {}) => ({
  charStart: 5,
  charEnd: 5 + "用 histogram 取代預設 diff 演算法".length,
  quotedText: "用 histogram 取代預設 diff 演算法",
  expectedBodySha: SHA,
  ...over,
});

describe("verifySpan（純函式）", () => {
  it("逐字對上就通過", () => {
    const verdict = verifySpan(BODY, SHA, span());
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.equal(verdict.quotedText, "用 histogram 取代預設 diff 演算法");
  });

  it("引文不在原文中就是幻覺，整條丟棄", () => {
    const verdict = verifySpan(BODY, SHA, span({ quotedText: "因為效能考量" }));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "text_not_found");
  });

  it("引文存在但位移錯了，與幻覺分開記", () => {
    // 兩者要調整的東西完全不同：一個是位移計算，一個是產生端在編故事。
    const verdict = verifySpan(BODY, SHA, span({ charStart: 0, charEnd: 3, quotedText: "Myers" }));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "offset_mismatch");
  });

  it("差一個字元就是不通過，不做任何修剪或容忍", () => {
    const base = span();
    for (const shift of [-1, 1]) {
      const verdict = verifySpan(BODY, SHA, { ...base, charStart: base.charStart + shift });
      assert.equal(verdict.ok, false, `位移 ${shift} 不得通過`);
    }
  });

  it("前後空白不得被吃掉——引文必須逐字，含空白", () => {
    const base = span();
    const verdict = verifySpan(BODY, SHA, {
      ...base,
      quotedText: ` ${base.quotedText} `,
    });
    assert.equal(verdict.ok, false);
  });

  it("上游文字被編輯過就作廢，即使內容碰巧仍對得上", () => {
    const verdict = verifySpan(BODY, SHA, span({ expectedBodySha: "0".repeat(64) }));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "stale_document");
  });

  it("超出範圍、負數與空區間都拒絕", () => {
    assert.equal(verifySpan(BODY, SHA, span({ charEnd: BODY.length + 1 })).ok, false);
    assert.equal(verifySpan(BODY, SHA, span({ charStart: -1 })).ok, false);
    assert.equal(verifySpan(BODY, SHA, span({ charStart: 5, charEnd: 5 })).ok, false);
  });

  it("空引文拒絕", () => {
    const verdict = verifySpan(BODY, SHA, span({ quotedText: "" }));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "empty_quote");
  });

  it("切在代理對中間必須拒絕，即使 slice 出來與引文相等", () => {
    // commit message 帶 emoji 非常常見。位移單位是 UTF-16 碼元，emoji 佔兩個，
    // 從中間切會產生半個字元——那樣的引文不是原文的任何一段。
    const body = "修好了 🤖 生成";
    const bodySha = sha256(body);
    const start = body.indexOf("🤖") + 1; // 切在代理對中間
    const verdict = verifySpan(body, bodySha, {
      charStart: start,
      charEnd: start + 1,
      quotedText: body.slice(start, start + 1),
      expectedBodySha: bodySha,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "splits_surrogate_pair");
  });

  it("完整涵蓋 emoji 的區間可以通過", () => {
    const body = "修好了 🤖 生成";
    const bodySha = sha256(body);
    const start = body.indexOf("🤖");
    const verdict = verifySpan(body, bodySha, {
      charStart: start,
      charEnd: start + 2,
      quotedText: "🤖",
      expectedBodySha: bodySha,
    });
    assert.equal(verdict.ok, true);
  });
});

describe("evidence store（真實 schema）", () => {
  const makeDb = () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
    db.exec(
      `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/tmp/r', '2026-01-01');
       INSERT INTO git_commit
         (id, repo_id, sha, author_name, authored_at, committed_at, message, is_merge, topo_order)
       VALUES (1, 1, 'abc123', 'someone', '2026-01-01', '2026-01-01', '${BODY.replace(/'/g, "''")}', 0, 0);`,
    );
    return db;
  };

  it("commit message 一字不改地收進 source_doc", () => {
    const db = makeDb();
    const report = ingestCommitMessages(db, 1);
    assert.equal(report.inserted, 1);
    const doc = db.prepare("SELECT body, body_sha256 AS sha, provenance_root AS root FROM source_doc")
      .get() as { body: string; sha: string; root: string };
    assert.equal(doc.body, BODY, "任何 trim 都會讓所有位移偏移");
    assert.equal(doc.sha, SHA);
    assert.equal(doc.root, "commit:abc123", "同一個 commit 的訊息永遠算一份證據");
    // 重跑不得重複收錄
    ingestCommitMessages(db, 1);
    const count = db.prepare("SELECT COUNT(*) AS n FROM source_doc").get() as { n: number };
    assert.equal(count.n, 1);
    db.close();
  });

  it("通過的候選寫進 evidence 並標成 promoted", () => {
    const db = makeDb();
    ingestCommitMessages(db, 1);
    const docId = (db.prepare("SELECT id FROM source_doc").get() as { id: number }).id;

    const report = submitCandidates(db, 1, [{
      sourceDocId: docId,
      span: span(),
      tier: "stated",
      generatorKind: "rule",
      generatorVersion: "test-1",
    }]);
    assert.deepEqual(report, { promoted: 1, rejected: 0, byReason: {} });

    const evidence = db.prepare(
      "SELECT quoted_text AS q, verified AS v FROM evidence",
    ).get() as { q: string; v: number };
    assert.equal(evidence.q, "用 histogram 取代預設 diff 演算法");
    assert.equal(evidence.v, 1);

    const staged = db.prepare(
      "SELECT status, promoted_evidence_id AS eid FROM evidence_candidate",
    ).get() as { status: string; eid: number | null };
    assert.equal(staged.status, "promoted");
    assert.ok(staged.eid);
    db.close();
  });

  it("被拒絕的候選留在 staging，絕不進 evidence", () => {
    const db = makeDb();
    ingestCommitMessages(db, 1);
    const docId = (db.prepare("SELECT id FROM source_doc").get() as { id: number }).id;

    const report = submitCandidates(db, 1, [
      {
        sourceDocId: docId,
        span: span({ quotedText: "完全是編出來的理由" }),
        tier: "stated",
        generatorKind: "llm",
        generatorVersion: "test-1",
        model: "some-model",
        promptVersion: "p1",
      },
      {
        sourceDocId: docId,
        span: span({ charStart: 0, charEnd: 3, quotedText: "Myers" }),
        tier: "stated",
        generatorKind: "llm",
        generatorVersion: "test-1",
      },
    ]);

    assert.equal(report.promoted, 0);
    assert.equal(report.rejected, 2);
    assert.deepEqual(report.byReason, { text_not_found: 1, offset_mismatch: 1 });

    const evidenceCount = db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number };
    assert.equal(evidenceCount.n, 0, "驗證失敗的候選不得以任何形式進入 evidence");

    const reasons = db.prepare(
      "SELECT rejection_reason AS r FROM evidence_candidate ORDER BY r",
    ).all() as Array<{ r: string }>;
    // 判定語意存在結構化欄位，不是從人類文字反推。
    assert.deepEqual(reasons.map((x) => x.r), ["offset_mismatch", "text_not_found"]);
    db.close();
  });

  it("上游文字被編輯後，既有 evidence 會被回報為失效", () => {
    const db = makeDb();
    ingestCommitMessages(db, 1);
    const docId = (db.prepare("SELECT id FROM source_doc").get() as { id: number }).id;
    submitCandidates(db, 1, [{
      sourceDocId: docId,
      span: span(),
      tier: "stated",
      generatorKind: "rule",
      generatorVersion: "test-1",
    }]);
    assert.deepEqual(revalidateEvidence(db, 1), { checked: 1, stale: 0 });

    // 模擬上游被編輯（PR 描述可以改）
    const edited = `${BODY} 補充說明`;
    db.prepare("UPDATE source_doc SET body = ?, body_sha256 = ? WHERE id = ?")
      .run(edited, sha256(edited), docId);

    const after = revalidateEvidence(db, 1);
    assert.deepEqual(after, { checked: 1, stale: 1 }, "快照對不上就必須被標出來");
    // 不自動刪除：什麼時候作廢是呼叫端的決定。
    const still = db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number };
    assert.equal(still.n, 1);
    db.close();
  });
});

describe("規則式抽取器", () => {
  it("命中因果標記的整行成為候選，位移精確", () => {
    const body = "fix: 改用 histogram\n\n因為 Myers 的 hunk 邊界不穩定。\n無關的一行。";
    const spans = extractRationale(body);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.quotedText, "因為 Myers 的 hunk 邊界不穩定。");
    assert.equal(body.slice(spans[0]!.charStart, spans[0]!.charEnd), spans[0]!.quotedText);
  });

  it("修剪清單符號與尾端空白，且修剪反映在位移上", () => {
    const body = "標題\n\n- to avoid a race condition   \n";
    const spans = extractRationale(body);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.quotedText, "to avoid a race condition");
    assert.equal(
      body.slice(spans[0]!.charStart, spans[0]!.charEnd),
      spans[0]!.quotedText,
      "修剪沒有反映在位移上就會產生對不上的 span",
    );
  });

  it("只說做了什麼的訊息不產出候選——那不是理由", () => {
    // 為了讓覆蓋率好看而把「做了什麼」當「為什麼」，會毀掉 stated 層唯一的價值。
    for (const body of [
      "fix: update scanner timeout",
      "feat: add maritime tracking",
      "chore: bump deps\n\n- update react to 19\n- update next to 15",
    ]) {
      assert.deepEqual(extractRationale(body), [], body);
    }
  });

  it("**抽取器不得產出自己的驗證器會拒絕的 span**", () => {
    // 這是這個模組的核心責任。任何修剪或位移的 bug 都會在這裡爆炸。
    const bodies = [
      "fix: x\n\n因為 A，所以 B。",
      "  * because the cache was unbounded  \n",
      "標題\n\n由於 emoji 🤖 的關係，避免切在中間\n",
      "to ensure correctness\nrather than speed",
      "無關內容",
      "",
    ];
    for (const body of bodies) {
      const bodySha = sha256(body);
      for (const span of extractRationale(body)) {
        const verdict = verifySpan(body, bodySha, {
          charStart: span.charStart,
          charEnd: span.charEnd,
          quotedText: span.quotedText,
          expectedBodySha: bodySha,
        });
        assert.equal(verdict.ok, true, `${span.rule} 在 ${JSON.stringify(body)} 產出無效 span`);
      }
    }
  });

  it("span 從因果標記開始，不從行首——否則只是把標題抄一遍", () => {
    // 實測看到的問題：整行當引文會與時間軸上方的 subject 一字不差地重複。
    const body = "fix: disable ISR to prevent quota burn";
    const spans = extractRationale(body);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.quotedText, "to prevent quota burn");
    assert.equal(body.slice(spans[0]!.charStart, spans[0]!.charEnd), spans[0]!.quotedText);
  });

  it("一行有多個標記時取最早出現的", () => {
    const body = "改用 A 以免 B，而不是 C";
    const spans = extractRationale(body);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.quotedText, "以免 B，而不是 C");
  });

  it("issue 參照分成關聯強度，且不是 evidence", () => {
    const refs = extractReferences("fix scanner (closes #108)\n\n相關：#42");
    assert.deepEqual(refs.map((r) => [r.toKey, r.confidence]), [["42", 0.4], ["108", 0.9]]);
  });
});

describe("extractFromCommitMessages（真實 schema）", () => {
  it("抽取結果走同一道驗證，且覆蓋率被誠實回報", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
    db.exec(
      `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/tmp/r', '2026-01-01');
       INSERT INTO git_commit
         (id, repo_id, sha, author_name, authored_at, committed_at, message, is_merge, topo_order)
       VALUES
         (1, 1, 'aaa', 'x', '2026-01-01', '2026-01-01',
          'fix: 換演算法' || char(10) || char(10) || '因為邊界不穩定 (closes #7)', 0, 0),
         (2, 1, 'bbb', 'x', '2026-01-01', '2026-01-01', 'chore: bump deps', 0, 1);`,
    );
    ingestCommitMessages(db, 1);
    const report = extractFromCommitMessages(db, 1);

    assert.equal(report.documents, 2);
    assert.equal(report.documentsWithRationale, 1, "只有一則寫了為什麼");
    assert.equal(report.rejected, 0, "規則式抽取器不該產出無效 span");
    assert.equal(report.promoted, 1);
    assert.equal(report.references, 1);

    const evidence = db.prepare("SELECT quoted_text AS q FROM evidence").get() as { q: string };
    assert.match(evidence.q, /因為邊界不穩定/);
    const ref = db.prepare(
      "SELECT to_key AS k, confidence AS c FROM reference_link",
    ).get() as { k: string; c: number };
    assert.deepEqual([ref.k, ref.c], ["7", 0.9]);
    db.close();
  });
});
