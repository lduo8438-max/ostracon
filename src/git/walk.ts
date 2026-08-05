import { execFileSync } from "node:child_process";
import { COMMIT_MARKER, type FilePatch, parsePatchLog, unquotePath } from "./hunks.ts";
import type { ChangeType, CommitRecord, FileChangeRecord, WalkOptions } from "./types.ts";

/**
 * 記錄分隔符與欄位分隔符。
 *
 * commit message 可以包含任何字元——換行、tab、引號、甚至看起來像分隔線的東西。
 * 用 \x1e / \x1f 這兩個 ASCII 控制字元是唯一安全的做法：它們不可能出現在
 * 正常的 commit message 或路徑裡。用 "|" 或 "---" 這類分隔符的解析器，
 * 遲早會被某個包含該字元的 commit message 打爆，而且是靜默地錯。
 */
const REC = "\x1e";
const FIELD = "\x1f";

function git(repo: string, args: string[], input?: string): string {
  const argv = ["-C", repo, ...args];
  const base = { encoding: "utf8" as const, maxBuffer: 1 << 30 };
  // 給了 input 就不能同時指定 stdio[0]，兩種形式分開寫比條件展開清楚。
  return input === undefined
    ? execFileSync("git", argv, { ...base, stdio: ["ignore", "pipe", "pipe"] })
    : execFileSync("git", argv, { ...base, input });
}

function diffFlags(o: WalkOptions): string[] {
  const m = o.renameThreshold ?? 30;
  const c = o.copyThreshold ?? 40;
  const f = [`-M${m}%`, `-C${c}%`];
  if (o.findCopiesHarder) f.push("--find-copies-harder");
  return f;
}

/**
 * 解析 --name-status 的一行。回傳 null 代表這行不是變更記錄。
 *
 * **路徑一律去引號。** git 預設 `core.quotePath=true`，非 ASCII 檔名會輸出成
 * `"my \346\252\224\346\241\210.ts"`。先前這裡直接採用原字串，後果是路徑帶著
 * 引號與八進位逸出存進 `file_change` 與 `path_lineage_segment`，而 `grammarForPath`
 * 用 `/\.ts$/` 判副檔名——結尾是 `.ts"` 就永遠不匹配，**於是那些檔案完全不被解析**
 * （實測 revision 數為 0，不是「查不到」而是根本不存在）。
 *
 * 更糟的是它會製造假死亡：函式從 ASCII 檔名搬到非 ASCII 檔名時，搬移端看不見，
 * 於是被記成死亡，再餵給迂迴偵測就變成假的「被推翻」。
 *
 * diff parser（`hunks.ts`）本來就會去引號，所以先前兩邊的路徑對不起來，
 * 非 ASCII 檔案連 hunk 約束都是失效的。
 */
function parseNameStatus(line: string): FileChangeRecord | null {
  if (!line) return null;
  const parts = line.split("\t");
  const tag = parts[0];
  if (!tag) return null;

  const kind = tag[0] as ChangeType;
  if (kind === "R" || kind === "C") {
    const score = Number(tag.slice(1));
    const [, oldPath, newPath] = parts;
    if (!oldPath || !newPath) return null;
    return {
      changeType: kind,
      path: unquotePath(newPath),
      oldPath: unquotePath(oldPath),
      score: Number.isFinite(score) ? score : undefined,
    };
  }
  if (kind === "A" || kind === "M" || kind === "D") {
    const p = parts[1];
    return p ? { changeType: kind, path: unquotePath(p) } : null;
  }
  // T(型別變更) / U(未合併) 等；當作修改處理，不遺漏檔案。
  const p = parts[1];
  return p ? { changeType: "M", path: unquotePath(p) } : null;
}

/**
 * 合併 commit 的變更。
 *
 * `git log` 預設不對合併 commit 顯示 diff，這是對的——拿合併去比第一父會把
 * 被併入分支的所有改動重算一遍，而那些 commit 我們本來就會各自走訪，等於重複計算。
 *
 * 合併真正屬於自己的貢獻是「與所有父版本都不同」的部分，也就是衝突解決與 evil merge。
 * 那正是 combined diff (`-c`) 給出的東西。
 *
 * 代價：combined diff 不支援改名／複製偵測，所以不會產生 R / C。所有父版本都
 * 沒有／都有的路徑仍可可靠記為 A / D，其餘（包含 rename-like resolution）記為 M。
 * 這是 git 的限制，不是我們的選擇——必須寫下來，否則第四週會有人以為是 bug。
 */
function mergeChanges(repo: string, sha: string): FileChangeRecord[] {
  const out = git(repo, ["diff-tree", "-c", "-r", "--name-status", "--no-commit-id", sha]);
  const rows: FileChangeRecord[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [tags, path] = line.split("\t");
    if (!path || !tags) continue;
    const kind: ChangeType = tags.split("").every((c) => c === "A")
      ? "A"
      : tags.split("").every((c) => c === "D")
        ? "D"
        : "M";
    rows.push({ changeType: kind, path: unquotePath(path) });
  }
  return rows;
}

/**
 * diff 演算法。Myers / histogram / patience 的 hunk 邊界不同，而 hunk 現在會
 * 影響匹配結果，所以不能吃 git 的預設值（使用者的 diff.algorithm 設定會改變
 * 索引產出）。這個值必須併入 INDEXER_VERSION。
 */
export const DIFF_ALGORITHM = "histogram";

/**
 * 第二趟走訪，只為了取 hunk。
 *
 * 為什麼不能和 --name-status 同一趟：實測 `git log --name-status --patch`
 * 中 --name-status 恆勝（兩種順序都試過），patch 根本不輸出。
 *
 * 為什麼合併 commit 沒有：`git log --patch` 預設不對合併輸出 diff，而 hunk
 * 約束本來就只在非合併 commit 上套用（combined diff 沒有可靠的單一父 hunk），
 * 兩者正好一致，不需要特別處理。
 */
export function collectHunks(
  repo: string,
  range = "HEAD",
  opts: WalkOptions = {},
): Map<string, FilePatch[]> {
  const raw = git(repo, [
    "log",
    "--topo-order",
    "--reverse",
    "--patch",
    "--unified=0",
    `--diff-algorithm=${DIFF_ALGORITHM}`,
    ...diffFlags(opts),
    `--format=${COMMIT_MARKER}%H`,
    range,
  ]);
  return parsePatchLog(raw);
}

/**
 * 一批取幾個 commit 的 patch。
 *
 * 實測 Osiris（99 commit）：解析後的 Map 只留 263 KB，成本幾乎全在單次 git 呼叫
 * 的原始字串——2.5 MB，約 26 KB/commit。外推一萬 commit 是 260 MB 的 JS 字串，
 * 加上 execFileSync 解碼前的 Buffer，峰值約 0.5 GB。分批把峰值壓成常數，
 * 而累積的解析結果本來就便宜（一萬 commit 約 27 MB）。
 *
 * 500 × 26 KB ≈ 13 MB／批。
 */
export const HUNK_BATCH_SIZE = 500;

/**
 * 依明確的 sha 清單分批取 hunk，回傳與 `collectHunks` 相同形狀的 Map。
 *
 * 用 `--no-walk --stdin` 而不是把範圍切成 `A..B` 區間：拓撲序的一段切片並不等於
 * 任何一個 `A..B` 範圍（分支與合併會讓兩者分歧），而 `--no-walk` 是「就這幾個
 * commit，各自對自己的第一父做 diff」，正好是我們要的語意，也讓分批不可能改變
 * 任何一個 commit 的結果——改名偵測是逐 commit 的，不跨批次。
 *
 * 合併 commit 在 `--no-walk` 下同樣只輸出標記行、不輸出 diff，與 `collectHunks`
 * 一致，不需要另外過濾。
 */
export function collectHunksForCommits(
  repo: string,
  shas: string[],
  opts: WalkOptions = {},
  batchSize = HUNK_BATCH_SIZE,
): Map<string, FilePatch[]> {
  const out = new Map<string, FilePatch[]>();
  for (let i = 0; i < shas.length; i += batchSize) {
    const batch = shas.slice(i, i + batchSize);
    const raw = git(
      repo,
      [
        "log",
        "--no-walk",
        "--stdin",
        "--patch",
        "--unified=0",
        `--diff-algorithm=${DIFF_ALGORITHM}`,
        ...diffFlags(opts),
        `--format=${COMMIT_MARKER}%H`,
      ],
      `${batch.join("\n")}\n`,
    );
    for (const [sha, files] of parsePatchLog(raw)) out.set(sha, files);
  }
  return out;
}

/**
 * 走訪 until 可及的全部歷史，回傳反向拓撲序（祖先在前）的 commit 記錄。
 *
 * 效能：非合併 commit 的 metadata 與 diff 用「一次」git log 取得，
 * 只有合併 commit 需要各自再呼叫一次。一萬個 commit 的 repo 通常有數百個合併，
 * 所以總 spawn 數是數百而非上萬——這是能達到 <10 分鐘預算的關鍵。
 */
export function walkCommits(
  repo: string,
  until = "HEAD",
  opts: WalkOptions = {},
): CommitRecord[] {
  const format =
    REC +
    ["%H", "%P", "%an", "%ae", "%aI", "%cI", "%B"].join(FIELD) +
    FIELD;

  const raw = git(repo, [
    "log",
    "--topo-order",
    "--reverse",
    "--name-status",
    ...diffFlags(opts),
    `--format=${format}`,
    until,
  ]);

  const commits: CommitRecord[] = [];
  const merges: CommitRecord[] = [];

  for (const chunk of raw.split(REC)) {
    if (!chunk.trim()) continue;
    const f = chunk.split(FIELD);
    if (f.length < 8) continue;

    const [sha, parentsRaw, authorName, authorEmail, authoredAt, committedAt, message] = f;
    const diffBlock = f.slice(7).join(FIELD);

    const parents = parentsRaw!.trim() ? parentsRaw!.trim().split(" ") : [];
    const changes: FileChangeRecord[] = [];
    for (const line of diffBlock.split("\n")) {
      const c = parseNameStatus(line.trim() ? line : "");
      if (c) changes.push(c);
    }

    const rec: CommitRecord = {
      sha: sha!,
      parents,
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authoredAt: authoredAt ?? "",
      committedAt: committedAt ?? "",
      message: message ?? "",
      isMerge: parents.length > 1,
      topoOrder: commits.length,
      changes,
    };
    commits.push(rec);
    if (rec.isMerge) merges.push(rec);
  }

  for (const m of merges) m.changes = mergeChanges(repo, m.sha);

  return commits;
}
