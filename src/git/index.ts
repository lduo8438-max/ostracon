import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { collectHunksForCommits, DIFF_ALGORITHM, walkCommits } from "./walk.ts";
import { attachHunks } from "./hunks.ts";
import { buildLineages } from "./lineage.ts";
import {
  consolidateRepoPaths,
  findRepo,
  getIndexerVersion,
  getNextLineageId,
  getNextTopoOrder,
  getWatermark,
  loadLineageState,
  openDb,
  persistWalk,
  type RepoConsolidation,
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
  /** 舊拼法留下的重複 repo 列的收斂結果。`absorbed` 非空時呼叫端必須說出來。 */
  consolidation: RepoConsolidation;
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
export function indexGit(inputPath: string, opts: IndexGitOptions): IndexGitReport {
  const t0 = Date.now();
  // 在開啟資料庫之前檢查：與其產生一個會說謊的索引再叫人重建，不如一開始就不要寫。
  assertNotShallow(inputPath);
  // 身分一律用正規路徑。整個函式往下都用它，包含餵給 git 的 -C——
  // 留一個未正規化的變數在作用域裡，遲早有人接錯。
  const repoPath = canonicalRepoPath(inputPath);
  const until = opts.until ?? "HEAD";
  // 版本由本次實際使用的選項算出，不是寫死的常數。
  const version = indexerVersion(opts);
  const db = openDb(opts.dbPath);

  try {
    // 舊資料庫可能用別的拼法存過同一個 repo。不先收斂的話，改用正規路徑當身分
    // 反而會再插一列，親手製造出這個修正要消滅的重複狀態。
    const consolidation = consolidateRepoPaths(db, repoPath, (candidate) =>
      existsSync(candidate) ? canonicalRepoPath(candidate) : undefined);

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
      consolidation,
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
/**
 * `0.2.0` → `0.3.0`：`--name-status` 的路徑改為一律去引號。
 *
 * 非 ASCII 檔名先前帶著引號與八進位逸出存進 `file_change` 與
 * `path_lineage_segment`，那些路徑值現在不同了——而 `stable_key` 雜湊誕生路徑，
 * 所以產出確實改變（不變量 7）。ASCII-only 的 repo 產出完全相同，但版本仍必須
 * 提升：舊資料庫裡那些路徑是壞的，續跑會讓兩種形態混在同一個水位線之後。
 */
export const WALK_ALGORITHM_VERSION = "walk-0.3.0";

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

/**
 * 淺層 clone 會讓這個工具**斷言一個沒有發生的誕生**。
 *
 * `git clone --depth N` 之後，歷史在第 N 個 commit 處被截斷，而截斷點看起來
 * 與真正的初始 commit 一模一樣。實測：對 `--depth 5` 的本 repo 查
 * `src/match/signature.ts:minhash`，工具說它誕生於 `2a065be`（截斷邊界），
 * 而它實際誕生於 `fd402bd`。輸出裡沒有任何跡象顯示這是假的。
 *
 * **這比誤報斷層更糟。** 斷層有門檻、有 `similarity` 可供檢視、UI 會標示；
 * 假誕生沒有任何標記，與真誕生的呈現完全相同。而「這段程式碼何時誕生」
 * 是這個工具的第一個賣點。
 *
 * 影響不只誕生：`ostracised` 會把「歷史被截斷」讀成「這段程式碼被移除」，
 * 迂迴的搬移守門也看不到截斷線以外的內容。
 *
 * **`actions/checkout` 預設 `fetch-depth: 1`**，所以任何人把它放進 CI，
 * 預設就是錯的。
 *
 * 所以是拒絕執行而不是印警告：警告會捲過去，而時間軸照樣說謊，使用者分不出
 * 哪一條「誕生」是真的。這與「scope 不符就拒印迂迴清單」是同一個模式。
 *
 * **partial clone（`--filter=blob:none`）不在此列**：它的 commit 歷史是完整的，
 * 只有 blob 是延遲取得，所以歷史正確、只是比較慢。這裡只擋 shallow。
 */
export function assertNotShallow(repo: string): void {
  if (tryGit(repo, ["rev-parse", "--is-shallow-repository"]) !== "true") return;
  throw new Error(
    `${repo} 是淺層 clone（shallow），歷史在截斷點被切斷。\n`
      + "截斷點會被當成「誕生」，而輸出裡看不出那是假的——這個工具的第一個賣點\n"
      + "正是「這段程式碼何時誕生」，所以這裡拒絕產生會說謊的索引。\n"
      + "請先取回完整歷史：git fetch --unshallow",
  );
}

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

/**
 * repo 的正規身分。
 *
 * 先前直接拿 `--repo` 的原字串當身分，所以同一個 repo 的不同拼法會在同一個
 * 資料庫裡各建一列。那不只是浪費：`lineageIdAt` 的快路徑不綁 repo，同一個 sha
 * 出現多次時會挑到別列的血緣，`why` 於是印出「slot 延續但內容血緣斷開」——
 * **假斷層，不變量 2 指名的最嚴重失效模式**。實測 `ostracon why X` 之後再
 * `ostracon why X --repo .` 就會發生，不需要任何特殊參數。
 *
 * 用 `git rev-parse --show-toplevel` 而不是 `path.resolve`，因為三種拼法都要
 * 收斂而後者只收斂第一種（實測）：相對路徑、**repo 內的子目錄**、
 * 以及 **symlink**（macOS 的 `/tmp` 就是）。
 */
export function canonicalRepoPath(repoPath: string): string {
  // 不是 git repo 時退回 resolve；該報的錯由後面的走訪自己報，這裡不搶著失敗。
  return tryGit(repoPath, ["rev-parse", "--show-toplevel"]) ?? path.resolve(repoPath);
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
