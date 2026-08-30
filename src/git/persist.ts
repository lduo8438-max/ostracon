import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
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

/**
 * 目前的 schema 版本。**改動 `db/schema.sql` 的結構就要加一。**
 *
 * 2 = `declaration_content`：內容與位置分離、雜湊改存 BLOB。
 * 3 = `idx_revision_path`：純索引，不動任何資料。
 */
export const SCHEMA_VERSION = 3;

/**
 * 可就地套用的遷移：**只有不改變任何產出的變更才准列在這裡。**
 *
 * v1→v2 改了資料的存法，舊資料庫真的不可續用，所以它不在這張表上——
 * 拒絕並要求重建才是對的。v2→v3 只加一條索引：查詢結果逐位元不變，
 * 而要求重建的代價是 angular 三小時。**判準是「產出會不會變」，
 * 不是「版本號有沒有變」**，所以這張表是白名單而不是通則。
 */
const MIGRATIONS: ReadonlyMap<number, (db: DatabaseSync) => void> = new Map([
  [3, (db: DatabaseSync) => {
    db.exec("CREATE INDEX IF NOT EXISTS idx_revision_path ON revision(repo_id, lineage_id, path)");
  }],
]);

/**
 * 把資料庫從 `from` 逐版推到 `SCHEMA_VERSION`，中途缺任何一步就放棄。
 *
 * 回傳 `false` 代表「這段落差沒有就地遷移的路徑」，由呼叫端沿用原本的拒絕訊息。
 * 每一步各自一個 transaction 並各記一列，中斷後續得下去。
 */
function migrate(db: DatabaseSync, from: number): boolean {
  const steps: Array<[number, (db: DatabaseSync) => void]> = [];
  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    const step = MIGRATIONS.get(v);
    if (step === undefined) return false;
    steps.push([v, step]);
  }
  for (const [version, step] of steps) {
    step(db);
    db.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
  }
  return true;
}

/**
 * 開一個索引資料庫：不存在就依 schema 建立，存在就確認版本相符。
 *
 * **原本這段邏輯在 `why.ts` / `ostracised.ts` / `materialize.ts` 各抄一份。**
 * 三份平行實作遲早分岔，而這次正好要在裡面加一道檢查——那正是不該有三份的時候。
 *
 * 版本檢查解決的是一個訊息品質問題：舊 schema 的資料庫拿來跑，失敗方式是
 * `no such column: content_id`，而那個訊息不會告訴任何人原因。與剖面版本守門
 * 同一種說法——說出「怎麼辦」，不只說「不行」。
 */
export function openIndexDatabase(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath)) {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const schema = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
    const init = openDb(dbPath);
    try {
      init.exec(schema);
      init.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
        .run(SCHEMA_VERSION, new Date().toISOString());
    } finally {
      init.close();
    }
  }
  const db = openDb(dbPath);
  try {
    assertSchemaVersion(db, dbPath);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * 版本不符就拒絕。
 *
 * 讀不到 `schema_migration` 的列不是「沒關係」——那正是**本次改動之前**建的
 * 資料庫的樣子（那張表從 v0.5 起就存在，但從來沒有任何程式寫過它）。
 */
export function assertSchemaVersion(db: DatabaseSync, dbPath: string): void {
  let found: number | undefined;
  try {
    found = (db.prepare("SELECT MAX(version) AS v FROM schema_migration").get() as
      { v: number | null } | undefined)?.v ?? undefined;
  } catch {
    found = undefined;
  }
  if (found === SCHEMA_VERSION) return;
  // 沒有記錄版本的資料庫是內容定址之前的產物，資料的存法就不同，不可就地遷移。
  if (found !== undefined && found < SCHEMA_VERSION && migrate(db, found)) return;
  throw new Error(
    `${dbPath} 的 schema 版本是 ${found ?? "更早（沒有記錄版本）"}，`
    + `目前是 ${SCHEMA_VERSION}。\n`
    + "schema 變更後既有的索引不可續用。請刪除該檔案後重跑，索引會自動重建。",
  );
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

export interface RepoConsolidation {
  /** 被改寫成正規路徑的舊列數（0 或 1）。 */
  migrated: number;
  /** 被合併掉的重複列的舊 root_path。非空代表這個資料庫先前被索引了不只一次。 */
  absorbed: string[];
}

/**
 * 把「同一個 repo 的其他拼法」收斂成一列。
 *
 * 光是改用正規路徑當身分還不夠：既有資料庫裡那些用舊拼法存的列**找不到就會
 * 再插一列**，於是這個修正自己製造出它要消滅的重複狀態。那正是
 * 「升版本但不作廢舊產出」的同型錯誤，只是換成由修正本身造成。
 *
 * 判準是「舊列的 `root_path` 正規化之後與這次相同」，所以只收斂真正的同一個
 * repo；目錄已經不存在的舊列一律不動——那可能是別台機器搬過來的資料庫，
 * 我們無從判斷它是不是同一個 repo。
 *
 * 保留 commit 數最多的那一列，其餘經由 `ON DELETE CASCADE` 整列移除。刪除是
 * 有代價的動作，但這些列**依定義是同一份語料的重複索引**，留著只會繼續產生
 * 假斷層；而且重跑索引就能完全重建。呼叫端必須把這件事說出來。
 */
export function consolidateRepoPaths(
  db: DatabaseSync,
  canonicalPath: string,
  canonicalise: (candidate: string) => string | undefined,
): RepoConsolidation {
  const rows = db.prepare(
    `SELECT r.id AS id, r.root_path AS rootPath,
            (SELECT COUNT(*) FROM git_commit c WHERE c.repo_id = r.id) AS commits
       FROM repo r ORDER BY r.id`,
  ).all() as unknown as { id: number; rootPath: string; commits: number }[];

  const same = rows.filter((row) =>
    row.rootPath === canonicalPath || canonicalise(row.rootPath) === canonicalPath);
  if (same.length === 0) return { migrated: 0, absorbed: [] };

  // 留 commit 最多的那一列；同數時留 id 最小的，讓結果與列的順序無關。
  const keep = same.reduce((best, row) =>
    row.commits > best.commits || (row.commits === best.commits && row.id < best.id)
      ? row
      : best);
  const absorbed = same.filter((row) => row.id !== keep.id);

  // 交易就地展開而不從 src/index/ 借 `inTransaction`——git 層不該反向依賴索引層。
  db.exec("BEGIN");
  try {
    for (const row of absorbed) {
      db.prepare("DELETE FROM repo WHERE id = ?").run(row.id);
    }
    if (keep.rootPath !== canonicalPath) {
      db.prepare("UPDATE repo SET root_path = ? WHERE id = ?").run(canonicalPath, keep.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    migrated: keep.rootPath === canonicalPath ? 0 : 1,
    absorbed: absorbed.map((row) => row.rootPath),
  };
}

export const repoConsolidationNotice = (c: RepoConsolidation): string =>
  `注意：這個資料庫裡有 ${c.absorbed.length + 1} 列指向同一個 repo`
  + `（${[...c.absorbed, "本次"].join("、")}），已合併成一列並重新索引。`
  + "repo 的身分先前是 --repo 的原字串，同一個 repo 的不同拼法會各建一列。";

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
