import type { DatabaseSync } from "node:sqlite";
import type { HttpFetcher, HttpResponse } from "../http/types.ts";
import { sha256 } from "./span.ts";

export const LINKED_PASS_VERSION = "linked-source-0.1.0";

interface ReferenceRow {
  id: number;
  toKind: string;
  toKey: string;
}

interface GitHubUser {
  login?: string;
}

interface GitHubIssue {
  number: number;
  body: string | null;
  html_url: string;
  user?: GitHubUser | null;
  created_at: string;
  pull_request?: unknown;
}

interface GitHubComment {
  id: number;
  body: string | null;
  html_url: string;
  user?: GitHubUser | null;
  created_at: string;
}

interface GitHubReview {
  id: number;
  body: string | null;
  html_url: string;
  user?: GitHubUser | null;
  submitted_at: string | null;
}

interface LinkedDocument {
  docType: "pr_body" | "pr_comment" | "pr_review" | "issue_body" | "issue_comment";
  provenanceRoot: string;
  externalId: string;
  url: string;
  author: string | null;
  createdAt: string | null;
  body: string;
}

export interface LinkedIngestReport {
  commitsScanned: number;
  references: number;
  correctedToPr: number;
  documentsUpserted: number;
  missing: number;
  /**
   * 本趟因為同一個目標已經取過而**省下的 reference row 數**。
   *
   * 同一個 PR 被多個 commit 提到是常態：create-t3-app 有 1,310 條 reference
   * 但只指向 1,085 個相異目標，逐 row 取回等於 17% 的請求是重複的。
   * 這個數字讓省下多少可以被看見，而不是只能推測。
   */
  deduplicated: number;
  stopped?: {
    status: number;
    url: string;
    retryAfter?: string;
    rateLimitReset?: string;
  };
}

export function parseGitHubOrigin(origin: string): { owner: string; repo: string } | undefined {
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(origin);
  if (https) return { owner: https[1]!, repo: https[2]! };
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(origin);
  return ssh ? { owner: ssh[1]!, repo: ssh[2]! } : undefined;
}

function parseJson<T>(response: HttpResponse, url: string): T {
  try {
    return JSON.parse(response.body) as T;
  } catch (error) {
    throw new Error(`GitHub 回應不是 JSON：${url}`, { cause: error });
  }
}

function nextPage(response: HttpResponse): string | undefined {
  const link = response.headers.link ?? response.headers.Link;
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
    if (match?.[2]?.split(/\s+/).includes("next")) return match[1];
  }
  return undefined;
}

async function getPages<T>(fetcher: HttpFetcher, firstUrl: string): Promise<{
  values?: T[];
  failure?: NonNullable<LinkedIngestReport["stopped"]>;
}> {
  const values: T[] = [];
  let url: string | undefined = firstUrl;
  while (url) {
    const response = await fetcher(url);
    if (response.status !== 200) {
      return {
        failure: {
          status: response.status,
          url,
          ...(response.headers["retry-after"]
            ? { retryAfter: response.headers["retry-after"] }
            : {}),
          ...(response.headers["x-ratelimit-reset"]
            ? { rateLimitReset: response.headers["x-ratelimit-reset"] }
            : {}),
        },
      };
    }
    values.push(...parseJson<T[]>(response, url));
    url = nextPage(response);
  }
  return { values };
}

function documentsFor(
  issue: GitHubIssue,
  comments: GitHubComment[],
  reviews: GitHubReview[],
): LinkedDocument[] {
  const kind = issue.pull_request === undefined ? "issue" : "pr";
  const root = `${kind}:${issue.number}`;
  const documents: LinkedDocument[] = [{
    docType: `${kind}_body`,
    provenanceRoot: root,
    externalId: `${root}:body`,
    url: issue.html_url,
    author: issue.user?.login ?? null,
    createdAt: issue.created_at,
    body: issue.body ?? "",
  }];
  for (const comment of comments) {
    documents.push({
      docType: `${kind}_comment`,
      provenanceRoot: root,
      externalId: `${root}:comment:${comment.id}`,
      url: comment.html_url,
      author: comment.user?.login ?? null,
      createdAt: comment.created_at,
      body: comment.body ?? "",
    });
  }
  for (const review of reviews) {
    documents.push({
      docType: "pr_review",
      provenanceRoot: root,
      externalId: `${root}:review:${review.id}`,
      url: review.html_url,
      author: review.user?.login ?? null,
      createdAt: review.submitted_at,
      body: review.body ?? "",
    });
  }
  return documents;
}

function inTransaction(db: DatabaseSync, run: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 取回 reference_link 指向的 GitHub 文件。只有注入的 fetcher 能碰網路；本函式
 * 對 replay 與 live 完全無感。每個 commit 成功寫完才推進 linked 水位線。
 */
export async function ingestLinkedDocuments(
  db: DatabaseSync,
  repoId: number,
  fetcher: HttpFetcher,
): Promise<LinkedIngestReport> {
  const repoRow = db.prepare(
    "SELECT origin_url AS origin FROM repo WHERE id = ?",
  ).get(repoId) as { origin: string | null } | undefined;
  if (!repoRow?.origin) throw new Error(`repo ${repoId} 沒有 origin_url`);
  const slug = parseGitHubOrigin(repoRow.origin);
  if (!slug) throw new Error(`目前只支援 github.com origin：${repoRow.origin}`);

  const state = db.prepare(
    "SELECT last_commit_id AS lastCommitId, indexer_version AS version "
      + "FROM pass_state WHERE repo_id = ? AND pass_name = 'linked'",
  ).get(repoId) as { lastCommitId: number | null; version: string } | undefined;
  const afterTopo = state?.version === LINKED_PASS_VERSION && state.lastCommitId !== null
    ? (db.prepare("SELECT topo_order AS n FROM git_commit WHERE id = ?")
      .get(state.lastCommitId) as { n: number } | undefined)?.n ?? -1
    : -1;

  const commits = db.prepare(
    `SELECT id, sha, topo_order AS topoOrder
       FROM git_commit
      WHERE repo_id = ? AND topo_order > ?
      ORDER BY topo_order`,
  ).all(repoId, afterTopo) as unknown as Array<{
    id: number;
    sha: string;
    topoOrder: number;
  }>;
  const referencesOf = db.prepare(
    `SELECT r.id, r.to_kind AS toKind, r.to_key AS toKey
       FROM reference_link r
       JOIN git_commit c ON c.repo_id = r.repo_id
                        AND c.sha = r.from_key
      WHERE r.repo_id = ? AND r.from_kind = 'commit' AND c.id = ?
      ORDER BY CAST(r.to_key AS INTEGER), r.id`,
  );
  const insertDoc = db.prepare(
    `INSERT INTO source_doc
       (repo_id, doc_type, provenance_root, external_id, url, author, created_at,
        body, body_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, doc_type, external_id) DO UPDATE SET
       provenance_root = excluded.provenance_root,
       url = excluded.url,
       author = excluded.author,
       created_at = excluded.created_at,
       body = excluded.body,
       body_sha256 = excluded.body_sha256`,
  );
  const correctKind = db.prepare(
    "UPDATE reference_link SET to_kind = ? WHERE id = ?",
  );
  const writeState = db.prepare(
    `INSERT INTO pass_state
       (repo_id, pass_name, last_commit_id, indexer_version, updated_at)
     VALUES (?, 'linked', ?, ?, ?)
     ON CONFLICT (repo_id, pass_name) DO UPDATE SET
       last_commit_id = excluded.last_commit_id,
       indexer_version = excluded.indexer_version,
       updated_at = excluded.updated_at`,
  );

  const report: LinkedIngestReport = {
    commitsScanned: 0,
    references: 0,
    correctedToPr: 0,
    documentsUpserted: 0,
    missing: 0,
    deduplicated: 0,
  };
  const base = `https://api.github.com/repos/${slug.owner}/${slug.repo}`;

  /**
   * 本趟已經取回過的目標。鍵是 `to_key`——**GitHub 的 issue 與 PR 共用同一組編號**，
   * 所以號碼本身就唯一標定一個討論串，不需要（也不能）把 `to_kind` 放進鍵：
   * `to_kind` 在取回之前一律是 `issue`，要取回之後才知道真相。
   *
   * 只快取 `kind`，不快取文件內容：命中時該目標的 `source_doc` 早就寫進去了，
   * 重寫一次是完全相同的內容。少存文件也讓記憶體與相異目標數無關。
   *
   * **只活在單趟之內。** 續跑時是冷的，但水位線已經跳過做完的 commit，
   * 而所有寫入都是 ON CONFLICT 冪等的，所以不影響可恢復性。
   */
  const fetchedTargets = new Map<string, "issue" | "pr">();

  for (const commit of commits) {
    const refs = referencesOf.all(repoId, commit.id) as unknown as ReferenceRow[];
    const fetched: Array<{
      reference: ReferenceRow;
      kind: "issue" | "pr";
      documents: LinkedDocument[];
    }> = [];

    for (const reference of refs) {
      report.references++;
      // 已經取過這個目標：仍要修正這一列的 to_kind，但不必再發任何請求，
      // 也不必重寫一模一樣的 source_doc。
      const already = fetchedTargets.get(reference.toKey);
      if (already !== undefined) {
        report.deduplicated++;
        fetched.push({ reference, kind: already, documents: [] });
        continue;
      }
      const issueUrl = `${base}/issues/${reference.toKey}`;
      const issueResponse = await fetcher(issueUrl);
      if (issueResponse.status === 404) {
        report.missing++;
        continue;
      }
      if (issueResponse.status !== 200) {
        report.stopped = {
          status: issueResponse.status,
          url: issueUrl,
          ...(issueResponse.headers["retry-after"]
            ? { retryAfter: issueResponse.headers["retry-after"] }
            : {}),
          ...(issueResponse.headers["x-ratelimit-reset"]
            ? { rateLimitReset: issueResponse.headers["x-ratelimit-reset"] }
            : {}),
        };
        return report;
      }
      const issue = parseJson<GitHubIssue>(issueResponse, issueUrl);
      const kind = issue.pull_request === undefined ? "issue" : "pr";
      const commentsResult = await getPages<GitHubComment>(
        fetcher,
        `${base}/issues/${reference.toKey}/comments?per_page=100`,
      );
      if (commentsResult.failure) {
        report.stopped = commentsResult.failure;
        return report;
      }
      let reviews: GitHubReview[] = [];
      if (kind === "pr") {
        const reviewsResult = await getPages<GitHubReview>(
          fetcher,
          `${base}/pulls/${reference.toKey}/reviews?per_page=100`,
        );
        if (reviewsResult.failure) {
          report.stopped = reviewsResult.failure;
          return report;
        }
        reviews = reviewsResult.values!;
      }
      fetchedTargets.set(reference.toKey, kind);
      fetched.push({
        reference,
        kind,
        documents: documentsFor(issue, commentsResult.values!, reviews),
      });
    }

    inTransaction(db, () => {
      for (const item of fetched) {
        correctKind.run(item.kind, item.reference.id);
        if (item.kind === "pr" && item.reference.toKind !== "pr") {
          report.correctedToPr++;
        }
        for (const doc of item.documents) {
          insertDoc.run(
            repoId,
            doc.docType,
            doc.provenanceRoot,
            doc.externalId,
            doc.url,
            doc.author,
            doc.createdAt,
            doc.body,
            sha256(doc.body),
          );
          report.documentsUpserted++;
        }
      }
      writeState.run(
        repoId,
        commit.id,
        LINKED_PASS_VERSION,
        new Date().toISOString(),
      );
    });
    report.commitsScanned++;
  }
  return report;
}
