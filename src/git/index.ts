import { execFileSync } from "node:child_process";
import { collectHunksForCommits, DIFF_ALGORITHM, walkCommits } from "./walk.ts";
import { attachHunks } from "./hunks.ts";
import { buildLineages } from "./lineage.ts";
import {
  findRepo,
  getIndexerVersion,
  getNextLineageId,
  getNextTopoOrder,
  getWatermark,
  loadLineageState,
  openDb,
  persistWalk,
} from "./persist.ts";
import type { WalkOptions } from "./types.ts";

export {
  collectHunks,
  collectHunksForCommits,
  DIFF_ALGORITHM,
  HUNK_BATCH_SIZE,
  walkCommits,
} from "./walk.ts";
export { attachHunks, parseHunkHeader, parsePatchLog, unquotePath } from "./hunks.ts";
export type { AttachResult, FilePatch } from "./hunks.ts";
export { buildLineages } from "./lineage.ts";
export {
  assertFts5,
  findRepo,
  getIndexerVersion,
  getNextLineageId,
  getNextTopoOrder,
  getWatermark,
  loadLineageState,
  openDb,
  persistWalk,
} from "./persist.ts";
export type * from "./types.ts";

export interface IndexGitOptions extends WalkOptions {
  until?: string;
  dbPath: string;
}

export interface IndexGitReport {
  repoId: number;
  /** 本次是從頭建索引還是接續既有水位 */
  mode: "full" | "incremental";
  commits: number;
  merges: number;
  fileChanges: number;
  lineages: number;
  segments: number;
  anomalies: number;
  /** 取到 hunk 的 file_change 數。未取到的是合併、二進位與純 mode 變更。 */
  filesWithHunks: number;
  /** 寫入的 file_hunk 列數 */
  hunkRows: number;
  /**
   * patch 有、但同一 commit 的 name-status 沒有的路徑數。
   * 兩趟走訪用同一組 diff 設定，理應恆為 0；非 0 代表路徑解析出錯（多半是引號），
   * 不丟例外——一個罕見路徑不該讓整個索引停擺——但必須報出來。
   */
  hunkOrphans: number;
  elapsedMs: number;
}

/**
 * pass 1 的走訪部分：commit 串、路徑血緣、file_change。
 * 完全不讀檔案內容，也不呼叫任何模型。解析與雜湊是下一個模組的事。
 */
export function indexGit(repoPath: string, opts: IndexGitOptions): IndexGitReport {
  const t0 = Date.now();
  const until = opts.until ?? "HEAD";
  // 版本由本次實際使用的選項算出，不是寫死的常數。
  const version = indexerVersion(opts);
  const db = openDb(opts.dbPath);

  try {
    // 增量：只走水位線之後的 commit，並從資料庫載回血緣續跑狀態。
    const existingRepo = findRepo(db, repoPath);
    const watermark = existingRepo !== undefined ? getWatermark(db, existingRepo) : undefined;
    const storedVersion = existingRepo !== undefined
      ? getIndexerVersion(db, existingRepo)
      : undefined;

    let range = until;
    let initial = {
      active: new Map(),
      nextLineageId: getNextLineageId(db),
    };
    let mode: "full" | "incremental" = "full";
    if (watermark) {
      if (storedVersion !== version) {
        throw new Error(
          `資料庫的 structural indexer_version 是 ${storedVersion ?? "未知"}，` +
          `目前版本是 ${version}。請重建此 repo 的索引。`,
        );
      }
      // 歷史被改寫（force push、rebase）時水位線不再是祖先，接續下去會產生
      // 一個混合了兩份歷史的資料庫。這種情況必須停下來，不能猜。
      if (!isAncestor(repoPath, watermark, until)) {
        throw new Error(
          `水位線 ${watermark.slice(0, 10)} 不是 ${until} 的祖先——歷史可能已被改寫。\n` +
            `接續索引會混入兩份不一致的歷史。請重建此 repo 的索引。`,
        );
      }
      range = `${watermark}..${until}`;
      initial = loadLineageState(db, existingRepo!);
      mode = "incremental";
    } else if (existingRepo !== undefined && getNextTopoOrder(db, existingRepo) > 0) {
      // 舊版若在資料交易完成後、寫水位線之前中斷，會留下有 commit 卻無水位的 repo。
      // 不能從頭硬接，否則會把血緣與 topo_order 再建立一份。
      throw new Error("此 repo 已有 commit 資料但沒有 structural 水位線；請重建索引。");
    }

    const commits = walkCommits(repoPath, range, opts);

    // hunk 必須是第二趟：實測 `git log --name-status --patch` 中 --name-status
    // 恆勝，patch 根本不輸出（兩種順序都試過）。依走訪結果的 sha 清單分批取，
    // 讓峰值記憶體與歷史長度無關。
    const hunkTargets = commits.filter((c) => !c.isMerge).map((c) => c.sha);
    const attached = attachHunks(commits, collectHunksForCommits(repoPath, hunkTargets, opts));

    const topoOffset = existingRepo !== undefined ? getNextTopoOrder(db, existingRepo) : 0;
    for (const commit of commits) commit.topoOrder += topoOffset;
    const lineage = buildLineages(commits, initial);
    const untilSha = tryGit(repoPath, ["rev-parse", `${until}^{commit}`]);
    if (!untilSha) throw new Error(`無法解析索引終點 ${until}`);

    const { repoId, hunkRows } = persistWalk(db, repoPath, commits, lineage, {
      originUrl: tryGit(repoPath, ["remote", "get-url", "origin"]),
      defaultBranch: tryGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
      structuralWatermark: { sha: untilSha, indexerVersion: version },
    });

    return {
      repoId,
      mode,
      commits: commits.length,
      merges: commits.filter((c) => c.isMerge).length,
      fileChanges: commits.reduce((n, c) => n + c.changes.length, 0),
      lineages: new Set(lineage.segments.map((s) => s.lineageId)).size,
      segments: lineage.segments.length,
      anomalies: lineage.anomalies.length,
      filesWithHunks: attached.filesWithHunks,
      hunkRows,
      hunkOrphans: attached.orphans.length,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    db.close();
  }
}

/**
 * 走訪層演算法本身的版本。改動走訪、血緣或 hunk 的**產出方式**時提升它。
 *
 * 這不是完整的版本字串——完整版本還要帶上會改變產出的**設定**，見
 * `indexerVersion()`。
 */
export const WALK_ALGORITHM_VERSION = "walk-0.2.0";

/**
 * 完整的 structural indexer 版本。
 *
 * **必須由實際使用的選項算出，不能手寫。** 改名／複製門檻與 `findCopiesHarder`
 * 都會改變 `file_change` 與 `path_lineage` 的產出，diff 演算法會改變 `file_hunk`
 * 的產出。先前這裡是寫死的 `walk-0.2.0+M30C40+histogram`，只要呼叫端覆寫任何
 * 一個門檻，新舊結果就會用同一個版本字串混進同一個資料庫而不報錯——那正是
 * 不變量 7 要防的事。
 */
export function indexerVersion(opts: WalkOptions = {}): string {
  const m = opts.renameThreshold ?? 30;
  const c = opts.copyThreshold ?? 40;
  const harder = opts.findCopiesHarder ? "+CH" : "";
  return `${WALK_ALGORITHM_VERSION}+M${m}C${c}${harder}+${DIFF_ALGORITHM}`;
}

/** 預設選項下的版本。既有呼叫端與測試沿用這個常數。 */
export const INDEXER_VERSION = indexerVersion();

function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function tryGit(repo: string, args: string[]): string | undefined {
  try {
    const v = execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}
