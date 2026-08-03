import type { DatabaseSync } from "node:sqlite";
import {
  EXTRACTOR_VERSION,
  MARKDOWN_EXTRACTOR_VERSION,
  extractRationale,
  extractReferences,
} from "./extract.ts";
import { type ProposedSpan, sha256, verifySpan } from "./span.ts";

/**
 * 證據層的 persistence。**零 LLM、零網路。**
 *
 * commit message 已經在 `git_commit.message` 裡，所以 `stated` 層的來源文件
 * 完全不需要對外連線。這是刻意的順序：先把「驗證」這件事做對，再談誰來產生候選。
 */

export interface IngestReport {
  inserted: number;
  /** 上游文字與既有紀錄不同（commit message 不會變，出現就代表資料有問題） */
  conflicting: number;
}

/**
 * 把 commit message 收成 `source_doc`。
 *
 * `provenance_root` 是證據獨立性去重的依據：同一個 commit 的訊息永遠是一份證據，
 * 所以 root 就是 `commit:<sha>`。之後 PR 討論串會共用 `pr:<n>`，讓三個人說同一件事
 * 只算一份。
 */
export function ingestCommitMessages(
  db: DatabaseSync,
  repoId: number,
): IngestReport {
  const rows = db.prepare(
    "SELECT sha, message, author_name AS author, committed_at AS createdAt "
    + "FROM git_commit WHERE repo_id = ? ORDER BY topo_order",
  ).all(repoId) as unknown as Array<
    { sha: string; message: string; author: string | null; createdAt: string }
  >;

  const insert = db.prepare(
    `INSERT INTO source_doc
       (repo_id, doc_type, provenance_root, external_id, url, author, created_at,
        body, body_sha256)
     VALUES (?, 'commit_message', ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT (repo_id, doc_type, external_id) DO NOTHING`,
  );
  const existing = db.prepare(
    "SELECT body_sha256 AS sha FROM source_doc "
    + "WHERE repo_id = ? AND doc_type = 'commit_message' AND external_id = ?",
  );

  const report: IngestReport = { inserted: 0, conflicting: 0 };
  for (const row of rows) {
    // body 一字不改——證據 span 是對它算的，任何 trim 都會讓位移全部偏移。
    const bodySha = sha256(row.message);
    insert.run(
      repoId,
      `commit:${row.sha}`,
      row.sha,
      row.author,
      row.createdAt,
      row.message,
      bodySha,
    );
    const after = existing.get(repoId, row.sha) as { sha: string } | undefined;
    if (after === undefined) continue;
    if (after.sha !== bodySha) report.conflicting++;
    else report.inserted++;
  }
  return report;
}

export interface CandidateInput {
  sourceDocId: number;
  span: ProposedSpan;
  tier: "stated" | "linked";
  generatorKind: "rule" | "llm" | "import";
  generatorVersion: string;
  model?: string;
  promptVersion?: string;
}

export interface PromotionReport {
  promoted: number;
  rejected: number;
  byReason: Record<string, number>;
}

/**
 * 收下候選、驗證、只有通過的才寫進 `evidence`。
 *
 * **候選一律先進 staging**，包含失敗的。理由是失敗才是有用的訊號：
 * 產生端（規則或模型）壞在哪裡，只能從被拒絕的候選看出來。
 * 但被拒絕的候選永遠不會變成 evidence，也不得以任何形式降級使用。
 */
export function submitCandidates(
  db: DatabaseSync,
  repoId: number,
  candidates: CandidateInput[],
): PromotionReport {
  const report: PromotionReport = { promoted: 0, rejected: 0, byReason: {} };
  const now = new Date().toISOString();

  const docOf = db.prepare(
    "SELECT body, body_sha256 AS bodySha FROM source_doc WHERE id = ? AND repo_id = ?",
  );
  const insertCandidate = db.prepare(
    `INSERT INTO evidence_candidate
       (repo_id, source_doc_id, proposed_char_start, proposed_char_end,
        proposed_quoted_text, expected_doc_body_sha, proposed_tier,
        generator_kind, generator_version, model, prompt_version,
        status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT DO NOTHING`,
  );
  const findCandidate = db.prepare(
    `SELECT id FROM evidence_candidate
      WHERE repo_id = ? AND source_doc_id = ?
        AND proposed_char_start = ? AND proposed_char_end = ?
        AND proposed_quoted_text = ? AND proposed_tier = ?
        AND generator_kind = ? AND generator_version = ?`,
  );
  const insertEvidence = db.prepare(
    `INSERT INTO evidence
       (repo_id, source_doc_id, char_start, char_end, quoted_text, doc_body_sha, tier, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (source_doc_id, char_start, char_end, tier) DO NOTHING`,
  );
  const findEvidence = db.prepare(
    `SELECT id FROM evidence
      WHERE source_doc_id = ? AND char_start = ? AND char_end = ? AND tier = ?`,
  );
  const promote = db.prepare(
    `UPDATE evidence_candidate
        SET status = 'promoted', promoted_evidence_id = ?, rejection_reason = NULL,
            validated_at = ?
      WHERE id = ?`,
  );
  const reject = db.prepare(
    `UPDATE evidence_candidate
        SET status = 'rejected', promoted_evidence_id = NULL, rejection_reason = ?,
            validated_at = ?
      WHERE id = ?`,
  );

  for (const candidate of candidates) {
    const doc = docOf.get(candidate.sourceDocId, repoId) as
      | { body: string; bodySha: string }
      | undefined;
    if (doc === undefined) {
      throw new Error(`repo ${repoId} 沒有 source_doc ${candidate.sourceDocId}`);
    }

    insertCandidate.run(
      repoId,
      candidate.sourceDocId,
      candidate.span.charStart,
      candidate.span.charEnd,
      candidate.span.quotedText,
      candidate.span.expectedBodySha,
      candidate.tier,
      candidate.generatorKind,
      candidate.generatorVersion,
      candidate.model ?? null,
      candidate.promptVersion ?? null,
      now,
    );
    const staged = findCandidate.get(
      repoId,
      candidate.sourceDocId,
      candidate.span.charStart,
      candidate.span.charEnd,
      candidate.span.quotedText,
      candidate.tier,
      candidate.generatorKind,
      candidate.generatorVersion,
    ) as { id: number };

    const verdict = verifySpan(doc.body, doc.bodySha, candidate.span);
    if (!verdict.ok) {
      // 判定語意存在結構化的 reason；detail 只是給人看的補充。
      reject.run(verdict.reason, now, staged.id);
      report.rejected++;
      report.byReason[verdict.reason] = (report.byReason[verdict.reason] ?? 0) + 1;
      continue;
    }

    insertEvidence.run(
      repoId,
      candidate.sourceDocId,
      verdict.charStart,
      verdict.charEnd,
      verdict.quotedText,
      verdict.docBodySha,
      candidate.tier,
    );
    const evidence = findEvidence.get(
      candidate.sourceDocId,
      verdict.charStart,
      verdict.charEnd,
      candidate.tier,
    ) as { id: number };
    promote.run(evidence.id, now, staged.id);
    report.promoted++;
  }
  return report;
}

/**
 * 重新驗證既有的 evidence。
 *
 * `evidence.doc_body_sha` 是快照；上游文字被編輯過（PR 描述可以改）時，
 * 舊 span 的位移可能已經指向別的地方。這個函式回報失效的筆數，
 * **不自動刪除**——什麼時候該作廢是呼叫端的決定，不是驗證器的。
 */
export function revalidateEvidence(
  db: DatabaseSync,
  repoId: number,
): { checked: number; stale: number } {
  const rows = db.prepare(
    `SELECT e.id AS id, e.char_start AS charStart, e.char_end AS charEnd,
            e.quoted_text AS quotedText, e.doc_body_sha AS docBodySha,
            d.body AS body, d.body_sha256 AS bodySha
       FROM evidence e
       JOIN source_doc d ON d.id = e.source_doc_id
      WHERE e.repo_id = ?`,
  ).all(repoId) as unknown as Array<{
    id: number;
    charStart: number;
    charEnd: number;
    quotedText: string;
    docBodySha: string;
    body: string;
    bodySha: string;
  }>;

  let stale = 0;
  for (const row of rows) {
    const verdict = verifySpan(row.body, row.bodySha, {
      charStart: row.charStart,
      charEnd: row.charEnd,
      quotedText: row.quotedText,
      expectedBodySha: row.docBodySha,
    });
    if (!verdict.ok) stale++;
  }
  return { checked: rows.length, stale };
}


export interface ExtractionReport {
  documents: number;
  /** 至少產出一條候選的文件數。低不是 bug——多數 commit message 不解釋為什麼。 */
  documentsWithRationale: number;
  candidates: number;
  promoted: number;
  rejected: number;
  byReason: Record<string, number>;
  references: number;
}

export type LinkedExtractionReport = Omit<ExtractionReport, "references">;

/**
 * 對已收進 source_doc 的 PR / issue 文件做抽取。網路收取與證據升格刻意分開：
 * replay、live 或人工匯入的文件都走同一道 span 驗證，這個函式本身完全離線。
 */
export function extractFromLinkedDocuments(
  db: DatabaseSync,
  repoId: number,
): LinkedExtractionReport {
  const docs = db.prepare(
    `SELECT id, body, body_sha256 AS bodySha
       FROM source_doc
      WHERE repo_id = ?
        AND doc_type IN ('pr_body','pr_review','pr_comment','issue_body','issue_comment')
      ORDER BY id`,
  ).all(repoId) as unknown as Array<{
    id: number;
    body: string;
    bodySha: string;
  }>;

  const report: LinkedExtractionReport = {
    documents: docs.length,
    documentsWithRationale: 0,
    candidates: 0,
    promoted: 0,
    rejected: 0,
    byReason: {},
  };
  const candidates: CandidateInput[] = [];
  for (const doc of docs) {
    const spans = extractRationale(doc.body, { format: "markdown" });
    if (spans.length > 0) report.documentsWithRationale++;
    for (const span of spans) {
      candidates.push({
        sourceDocId: doc.id,
        span: {
          charStart: span.charStart,
          charEnd: span.charEnd,
          quotedText: span.quotedText,
          expectedBodySha: doc.bodySha,
        },
        tier: "linked",
        generatorKind: "rule",
        generatorVersion: `${MARKDOWN_EXTRACTOR_VERSION}/${span.rule}`,
      });
    }
  }

  report.candidates = candidates.length;
  const promotion = submitCandidates(db, repoId, candidates);
  report.promoted = promotion.promoted;
  report.rejected = promotion.rejected;
  report.byReason = promotion.byReason;
  return report;
}

/**
 * 對所有 commit message 跑規則式抽取，候選一律走同一道驗證。
 *
 * 覆蓋率低是**語料的性質**，不是抽取器壞掉：多數 commit message 只寫做了什麼。
 * 這個數字必須被回報而不是被掩蓋——它直接決定「stated 層在這個 repo 上有多少
 * 東西可說」，而那是題目層級的訊號。
 */
export function extractFromCommitMessages(
  db: DatabaseSync,
  repoId: number,
): ExtractionReport {
  const docs = db.prepare(
    "SELECT id, external_id AS sha, body, body_sha256 AS bodySha FROM source_doc "
    + "WHERE repo_id = ? AND doc_type = 'commit_message'",
  ).all(repoId) as unknown as Array<
    { id: number; sha: string; body: string; bodySha: string }
  >;

  const insertRef = db.prepare(
    `INSERT INTO reference_link
       (repo_id, from_kind, from_key, to_kind, to_key, method, confidence)
     VALUES (?, 'commit', ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  );

  const report: ExtractionReport = {
    documents: docs.length,
    documentsWithRationale: 0,
    candidates: 0,
    promoted: 0,
    rejected: 0,
    byReason: {},
    references: 0,
  };
  const candidates: CandidateInput[] = [];

  for (const doc of docs) {
    const spans = extractRationale(doc.body);
    if (spans.length > 0) report.documentsWithRationale++;
    for (const span of spans) {
      candidates.push({
        sourceDocId: doc.id,
        span: {
          charStart: span.charStart,
          charEnd: span.charEnd,
          quotedText: span.quotedText,
          expectedBodySha: doc.bodySha,
        },
        tier: "stated",
        generatorKind: "rule",
        generatorVersion: `${EXTRACTOR_VERSION}/${span.rule}`,
      });
    }
    for (const ref of extractReferences(doc.body)) {
      insertRef.run(repoId, doc.sha, ref.toKind, ref.toKey, ref.method, ref.confidence);
      report.references++;
    }
  }

  report.candidates = candidates.length;
  const promotion = submitCandidates(db, repoId, candidates);
  report.promoted = promotion.promoted;
  report.rejected = promotion.rejected;
  report.byReason = promotion.byReason;
  return report;
}
