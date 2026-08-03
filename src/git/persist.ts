import { DatabaseSync } from "node:sqlite";
import type { CommitRecord, LineageResult, LineageState } from "./types.ts";

/**
 * 用 node:sqlite（Node 內建）而非 better-sqlite3。
 *
 * better-sqlite3 需要原生編譯，在沒有 build toolchain 的機器上 `npm i` 會直接失敗——
 * 而安裝摩擦是開源專案的頭號死因。node:sqlite 零相依、零編譯。
 *
 * 代價是它在 Node 22 仍標記為 experimental，API 可能變動。
 * 所以所有 SQLite 呼叫都收在這個檔案裡，換掉只需要動這一個模組。
 */

export interface PersistResult {
  repoId: number;
  commitIds: Map<string, number>;
  /** 實際寫入的 file_hunk 列數 */
  hunkRows: number;
}

/**
 * 完整 schema 需要 FTS5；部分第三方 Node build 沒有把它編進內建 SQLite。
 * 用實際建表探測，不猜 Node 版本或發行來源。
 */
export function assertFts5(db: DatabaseSync): void {
  try {
    db.exec(
      "CREATE VIRTUAL TABLE temp.__ostracon_fts5_probe USING fts5(content); " +
      "DROP TABLE temp.__ostracon_fts5_probe;",
    );
  } catch (error) {
    throw new Error(
      "此 Node 內建的 SQLite 未編入 FTS5，Ostracon 的完整 schema 無法初始化。\n" +
      "請改用包含 FTS5 的 Node build，或替換 SQLite driver；driver 邊界只在 persist.ts。\n" +
      `原始錯誤：${(error as Error).message}`,
    );
  }
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    assertFts5(db);
  } catch (error) {
    db.close();
    throw error;
  }
  // foreign_keys 是「每連線」設定，不會被 schema 記住。
  // 每一條新連線都必須重設，否則外鍵形同虛設。
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/** 取得某 repo 已索引到的最後一個 commit 的 sha。沒有就回 undefined。 */
export function getWatermark(db: DatabaseSync, repoId: number): string | undefined {
  const row = db
    .prepare(
      `SELECT c.sha AS sha FROM pass_state p
       JOIN git_commit c ON c.id = p.last_commit_id
       WHERE p.repo_id = ? AND p.pass_name = 'structural'`,
    )
    .get(repoId) as { sha: string } | undefined;
  return row?.sha;
}

export function getIndexerVersion(db: DatabaseSync, repoId: number): string | undefined {
  const row = db
    .prepare(
      `SELECT indexer_version AS version
       FROM pass_state
       WHERE repo_id = ? AND pass_name = 'structural'`,
    )
    .get(repoId) as { version: string } | undefined;
  return row?.version;
}

/** path_lineage.id 是全資料庫主鍵；新 repo 也必須從全域最大值之後開始。 */
export function getNextLineageId(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM path_lineage").get() as
    { m: number };
  return row.m + 1;
}

/** topo_order 對同 repo 的全部批次單調遞增，不可每次續跑都從 0 開始。 */
export function getNextTopoOrder(db: DatabaseSync, repoId: number): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(topo_order), -1) AS m FROM git_commit WHERE repo_id = ?")
    .get(repoId) as { m: number };
  return row.m + 1;
}

export function findRepo(db: DatabaseSync, rootPath: string): number | undefined {
  const r = db.prepare("SELECT id FROM repo WHERE root_path = ?").get(rootPath) as
    | { id: number }
    | undefined;
  return r?.id;
}

/**
 * 從資料庫重建血緣續跑狀態。
 *
 * 尚未關閉的 segment（to_commit_id IS NULL）就是存活路徑集合本身，
 * 所以續跑狀態不需要另外持久化——它不可能與實際資料不同步，
 * 因為它「就是」實際資料。
 */
export function loadLineageState(db: DatabaseSync, repoId: number): LineageState {
  const rows = db
    .prepare(
      `SELECT s.lineage_id AS lineageId, s.path AS path, c.sha AS fromSha
       FROM path_lineage_segment s
       JOIN path_lineage l ON l.id = s.lineage_id
       JOIN git_commit c ON c.id = s.from_commit_id
       WHERE l.repo_id = ? AND s.to_commit_id IS NULL`,
    )
    .all(repoId) as Array<{ lineageId: number; path: string; fromSha: string }>;

  const active = new Map<string, { lineageId: number; fromSha: string; isNew: boolean }>();
  for (const r of rows) {
    active.set(r.path, { lineageId: r.lineageId, fromSha: r.fromSha, isNew: false });
  }
  return { active, nextLineageId: getNextLineageId(db) };
}

export function persistWalk(
  db: DatabaseSync,
  rootPath: string,
  commits: CommitRecord[],
  lineage: LineageResult,
  opts: {
    originUrl?: string;
    defaultBranch?: string;
    structuralWatermark?: { sha: string; indexerVersion: string };
  } = {},
): PersistResult {
  db.exec("BEGIN");
  try {
    const repoId = upsertRepo(db, rootPath, opts);
    const commitIds = insertCommits(db, repoId, commits);
    insertParents(db, repoId, commits, commitIds);
    resolveCommitIds(db, repoId, lineage, commitIds);
    applyLineages(db, repoId, lineage, commitIds);
    const fileChangeIds = insertFileChanges(db, commits, commitIds, lineage);
    const hunkRows = insertHunks(db, commits, fileChangeIds);
    if (opts.structuralWatermark) {
      updateStructuralWatermark(db, repoId, opts.structuralWatermark, commitIds);
    }
    db.exec("COMMIT");
    return { repoId, commitIds, hunkRows };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * segment 的端點可能落在「先前批次已索引」的 commit 上（例如續跑時關閉一段舊血緣），
 * 那些 sha 不在本次的 commitIds 裡，必須回資料庫補查。
 */
function resolveCommitIds(
  db: DatabaseSync,
  repoId: number,
  lineage: LineageResult,
  commitIds: Map<string, number>,
): void {
  const sel = db.prepare("SELECT id FROM git_commit WHERE repo_id = ? AND sha = ?");
  const need = new Set<string>();
  for (const s of lineage.segments) {
    if (!commitIds.has(s.fromSha)) need.add(s.fromSha);
    if (s.toSha && !commitIds.has(s.toSha)) need.add(s.toSha);
  }
  for (const sha of need) {
    const row = sel.get(repoId, sha) as { id: number } | undefined;
    if (row) commitIds.set(sha, row.id);
  }
}

function upsertRepo(
  db: DatabaseSync,
  rootPath: string,
  opts: { originUrl?: string; defaultBranch?: string },
): number {
  const existing = db
    .prepare("SELECT id FROM repo WHERE root_path = ?")
    .get(rootPath) as { id: number } | undefined;
  if (existing) return existing.id;

  const info = db
    .prepare(
      `INSERT INTO repo (root_path, origin_url, default_branch, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(rootPath, opts.originUrl ?? null, opts.defaultBranch ?? null, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

function insertCommits(
  db: DatabaseSync,
  repoId: number,
  commits: CommitRecord[],
): Map<string, number> {
  const ins = db.prepare(
    `INSERT INTO git_commit
       (repo_id, sha, author_name, author_email, authored_at, committed_at,
        message, is_merge, topo_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, sha) DO UPDATE SET topo_order = excluded.topo_order`,
  );
  const sel = db.prepare("SELECT id FROM git_commit WHERE repo_id = ? AND sha = ?");
  const ids = new Map<string, number>();
  for (const c of commits) {
    ins.run(
      repoId, c.sha, c.authorName, c.authorEmail, c.authoredAt, c.committedAt,
      c.message, c.isMerge ? 1 : 0, c.topoOrder,
    );
    ids.set(c.sha, (sel.get(repoId, c.sha) as { id: number }).id);
  }
  return ids;
}

function insertParents(
  db: DatabaseSync,
  repoId: number,
  commits: CommitRecord[],
  ids: Map<string, number>,
): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO git_commit_parent (child_id, parent_id, ordinal)
     VALUES (?, ?, ?)`,
  );
  const findExisting = db.prepare("SELECT id FROM git_commit WHERE repo_id = ? AND sha = ?");
  for (const c of commits) {
    const childId = ids.get(c.sha)!;
    c.parents.forEach((p, i) => {
      const parentId = ids.get(p)
        ?? (findExisting.get(repoId, p) as { id: number } | undefined)?.id;
      // 父 commit 不在走訪範圍內（--until 截斷、或淺層 clone）時跳過。
      // 這不是錯誤，是邊界。
      if (parentId !== undefined) ins.run(childId, parentId, i);
    });
  }
}

/**
 * lineageId 就是 path_lineage 的主鍵，不做二次映射。
 * isNew=true 的 segment 走 INSERT，isNew=false 的走 UPDATE——
 * 後者代表「上一批次留下的開放段落，這次被關閉了」。
 */
function applyLineages(
  db: DatabaseSync,
  repoId: number,
  lineage: LineageResult,
  commitIds: Map<string, number>,
): void {
  const insLineage = db.prepare(
    "INSERT INTO path_lineage (id, repo_id) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
  );
  const lineageOwner = db.prepare("SELECT repo_id AS repoId FROM path_lineage WHERE id = ?");
  const insSeg = db.prepare(
    `INSERT INTO path_lineage_segment (lineage_id, path, from_commit_id, to_commit_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (lineage_id, from_commit_id) DO UPDATE SET
       path = excluded.path, to_commit_id = excluded.to_commit_id`,
  );
  const closeSeg = db.prepare(
    `UPDATE path_lineage_segment SET to_commit_id = ?
     WHERE lineage_id = ? AND from_commit_id = ?`,
  );

  for (const seg of lineage.segments) {
    const from = commitIds.get(seg.fromSha);
    if (from === undefined) {
      throw new Error(`找不到 segment 起點 commit ${seg.fromSha}`);
    }
    let to: number | null = null;
    if (seg.toSha) {
      const resolved = commitIds.get(seg.toSha);
      if (resolved === undefined) {
        throw new Error(`找不到 segment 終點 commit ${seg.toSha}`);
      }
      to = resolved;
    }
    if (seg.isNew) {
      insLineage.run(seg.lineageId, repoId);
      const owner = lineageOwner.get(seg.lineageId) as { repoId: number };
      if (owner.repoId !== repoId) {
        throw new Error(
          `lineage id ${seg.lineageId} 已屬於 repo ${owner.repoId}，不可指派給 repo ${repoId}`,
        );
      }
      insSeg.run(seg.lineageId, seg.path, from, to);
    } else {
      const result = closeSeg.run(to, seg.lineageId, from);
      if (result.changes !== 1) {
        throw new Error(
          `無法關閉 lineage ${seg.lineageId} 的 segment ${seg.path}@${seg.fromSha}`,
        );
      }
    }
  }
}

function updateStructuralWatermark(
  db: DatabaseSync,
  repoId: number,
  watermark: { sha: string; indexerVersion: string },
  commitIds: Map<string, number>,
): void {
  const commitId = commitIds.get(watermark.sha)
    ?? (db
      .prepare("SELECT id FROM git_commit WHERE repo_id = ? AND sha = ?")
      .get(repoId, watermark.sha) as { id: number } | undefined)?.id;
  if (commitId === undefined) {
    throw new Error(`無法把 structural 水位線設到未索引的 commit ${watermark.sha}`);
  }

  db.prepare(
    `INSERT INTO pass_state (repo_id, pass_name, last_commit_id, indexer_version, updated_at)
     VALUES (?, 'structural', ?, ?, ?)
     ON CONFLICT (repo_id, pass_name) DO UPDATE SET
       last_commit_id = excluded.last_commit_id,
       indexer_version = excluded.indexer_version,
       updated_at = excluded.updated_at`,
  ).run(repoId, commitId, watermark.indexerVersion, new Date().toISOString());
}

/**
 * 用 INSERT ... ON CONFLICT DO NOTHING 而非裸 INSERT。
 * 增量走訪理論上不會重複送同一個 commit，但「理論上」不該是資料完整性的唯一防線——
 * schema 的 UNIQUE (commit_id, path) 是防線，這裡只是讓重跑不會炸掉。
 *
 * 回傳 `${sha}\0${path}` → file_change.id：hunk 是 file_change 的子表，需要這個
 * 對照。DO NOTHING 在衝突時不回傳 lastInsertRowid，所以一律回頭 SELECT，
 * 與 insertCommits 同樣的做法。
 */
function insertFileChanges(
  db: DatabaseSync,
  commits: CommitRecord[],
  commitIds: Map<string, number>,
  lineage: LineageResult,
): Map<string, number> {
  const ins = db.prepare(
    `INSERT INTO file_change
       (commit_id, lineage_id, path, old_path, change_type, rename_score, blob_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (commit_id, path) DO NOTHING`,
  );
  const sel = db.prepare("SELECT id FROM file_change WHERE commit_id = ? AND path = ?");
  const ids = new Map<string, number>();
  for (const c of commits) {
    const commitId = commitIds.get(c.sha)!;
    for (const ch of c.changes) {
      const localId = lineage.changeLineage.get(`${c.sha}\0${ch.path}`);
      if (localId === undefined) continue;
      ins.run(
        commitId,
        localId,
        ch.path,
        ch.oldPath ?? null,
        ch.changeType,
        ch.score ?? null,
        null, // blob_sha 由解析層填入，走訪層不讀檔案內容
      );
      ids.set(`${c.sha}\0${ch.path}`, (sel.get(commitId, ch.path) as { id: number }).id);
    }
  }
  return ids;
}

/**
 * 寫入 hunk。
 *
 * `hunks === undefined` 是「沒去取」（合併、二進位、mode 變更），**不是**「零個
 * hunk」——一列都不寫，讓消費端從零列判斷「不得套用 hunk 約束」。這個區分是
 * types.ts 明講不可混同的那一個，在這裡就是「跳過」與「寫零列」的差別，
 * 而兩者在資料庫裡的結果相同，所以只能靠不寫入來維持保守側。
 *
 * hunk_index 用陣列順序，而陣列順序來自 git 的輸出順序（依 new_start 遞增），
 * 是確定性的，重跑會得到同一組編號。
 */
function insertHunks(
  db: DatabaseSync,
  commits: CommitRecord[],
  fileChangeIds: Map<string, number>,
): number {
  const ins = db.prepare(
    `INSERT INTO file_hunk
       (file_change_id, hunk_index, old_start, old_count, new_start, new_count)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (file_change_id, hunk_index) DO NOTHING`,
  );
  let written = 0;
  for (const c of commits) {
    for (const ch of c.changes) {
      if (ch.hunks === undefined) continue;
      const fileChangeId = fileChangeIds.get(`${c.sha}\0${ch.path}`);
      if (fileChangeId === undefined) continue; // 血緣缺漏而未寫入 file_change
      ch.hunks.forEach((h, i) => {
        ins.run(fileChangeId, i, h.oldStart, h.oldCount, h.newStart, h.newCount);
        written++;
      });
    }
  }
  return written;
}
