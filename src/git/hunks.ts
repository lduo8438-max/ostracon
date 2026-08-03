import type { CommitRecord, DiffHunk } from "./types.ts";

/**
 * unified diff 的解析。純函式：不碰 git、不碰資料庫。
 *
 * 為什麼要 hunk：內容完全相同的候選之間，匹配器已經沒有資訊可用（完整 Osiris
 * 歷史有 51 條 L4/Jaccard=1 的任意配對）。git 已經算好了「新增的是哪幾行」，
 * 這是目前唯一沒被用上、而且比 AST 位置穩定得多的訊號。
 */

/** commit 邊界標記。commit message 可含任何字元，只有控制字元是安全的。 */
export const COMMIT_MARKER = "\x1e";

export interface FilePatch {
  /** 後像路徑；純刪除時為被刪除的路徑。與 `file_change.path` 對齊。 */
  path: string;
  hunks: DiffHunk[];
}

/**
 * 解析 `@@ -a,b +c,d @@` 標頭。省略計數等同 1。
 *
 * 計數為 0 時 start 的語意不同：`-10,0` 代表「插入在舊檔第 10 行之後」，
 * 而不是「舊檔第 10 行」。消費端只有在對應計數 > 0 時才能把它當區間用。
 */
export function parseHunkHeader(line: string): DiffHunk | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/**
 * 還原 git 的 C-style 引號路徑（`"src/\303\251.ts"`）。
 *
 * 八進位逸出是位元組不是字元，所以必須先組回 byte 陣列再用 UTF-8 解碼；
 * 逐字元 String.fromCharCode 會把非 ASCII 路徑解成亂碼。
 */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const body = raw.slice(1, raw.endsWith('"') ? -1 : undefined);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      // 未逸出的字元必定是 ASCII（git 只在 ASCII 可列印範圍外才不逸出的情況不存在）
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    const octal = /^[0-7]$/.test(next) ? body.slice(i, i + 3) : undefined;
    if (octal && /^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 2;
      continue;
    }
    const simple: Record<string, number> = {
      n: 10, t: 9, r: 13, f: 12, b: 8, v: 11, a: 7,
      '"': 34, "\\": 92,
    };
    bytes.push(simple[next] ?? next.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** 從 `+++ b/path` 或 `--- a/path` 取出路徑；`/dev/null` 回傳 null。 */
function headerPath(line: string): string | null {
  const raw = line.slice(4);
  if (raw === "/dev/null") return null;
  // git 一定加恰好一個 a/ 或 b/ 前綴，所以固定砍兩個字元是安全的；
  // 引號路徑的前綴在引號內部（`"b/…"`），要先去引號再砍。
  if (raw.startsWith('"')) return unquotePath(`"${raw.slice(3)}`);
  return raw.slice(2);
}

interface ScanState {
  sha: string | null;
  files: FilePatch[];
  current: FilePatch | null;
  /** 尚未讀完的 hunk 內容行數。> 0 時任何一行都只是內容，不得當語法解析。 */
  pending: number;
  oldPath: string | null;
}

/**
 * 解析 `git log --patch --unified=0` 的輸出，回傳 sha → 該 commit 的檔案 hunk。
 *
 * **必須是嚴格狀態機**：`-U0` 的內容行只加一個 `+`/`-` 前綴，所以一行內容
 * `++ b/foo` 會輸出成 `+++ b/foo`，與檔案標頭完全同形。唯一可靠的做法是讀到
 * hunk 標頭後，照它宣告的行數把內容原封不動吃掉，不在其中做任何語法判斷。
 */
export function parsePatchLog(raw: string): Map<string, FilePatch[]> {
  const out = new Map<string, FilePatch[]>();
  const st: ScanState = { sha: null, files: [], current: null, pending: 0, oldPath: null };

  const flushFile = () => {
    if (st.current && st.current.hunks.length > 0) st.files.push(st.current);
    st.current = null;
    st.oldPath = null;
  };
  const flushCommit = () => {
    flushFile();
    if (st.sha !== null) out.set(st.sha, st.files);
    st.files = [];
  };

  for (const line of raw.split("\n")) {
    if (st.pending > 0) {
      // "\ No newline at end of file" 不是內容行，不計入 hunk 宣告的行數。
      if (!line.startsWith("\\")) st.pending--;
      continue;
    }

    if (line.startsWith(COMMIT_MARKER)) {
      flushCommit();
      st.sha = line.slice(1).trim();
      continue;
    }
    if (line.startsWith("diff --git ")) {
      // 路徑一律從 ---/+++ 取。`diff --git a/x b/y` 這行在路徑含空白時無法切分。
      flushFile();
      continue;
    }
    if (line.startsWith("--- ")) {
      st.oldPath = headerPath(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = headerPath(line) ?? st.oldPath;
      // 純刪除的後像是 /dev/null，此時用前像路徑——與 file_change.path 對齊。
      if (p !== null) st.current = { path: p, hunks: [] };
      continue;
    }
    const h = parseHunkHeader(line);
    if (h && st.current) {
      st.current.hunks.push(h);
      st.pending = h.oldCount + h.newCount;
    }
    // 其餘（index/mode/similarity/rename/Binary files…）不影響 hunk，忽略。
  }
  flushCommit();
  return out;
}

export interface AttachResult {
  /** patch 有、但該 commit 的 name-status 沒有的路徑。理論上應為空。 */
  orphans: Array<{ sha: string; path: string }>;
  filesWithHunks: number;
}

/**
 * 把 hunk 掛回 `CommitRecord`。純函式。
 *
 * 兩趟走訪用同一組 diff 設定，檔案集合理應完全一致，所以 orphan 代表解析出錯
 * （多半是路徑引號）。不丟例外——一個罕見路徑不該讓整個索引停擺——但也絕不靜默：
 * 交給編排層一併報告。
 */
export function attachHunks(
  commits: CommitRecord[],
  byCommit: Map<string, FilePatch[]>,
): AttachResult {
  const orphans: AttachResult["orphans"] = [];
  let filesWithHunks = 0;

  for (const commit of commits) {
    const patches = byCommit.get(commit.sha);
    if (!patches) continue;
    const byPath = new Map(commit.changes.map((c) => [c.path, c]));
    for (const patch of patches) {
      const change = byPath.get(patch.path);
      if (!change) {
        orphans.push({ sha: commit.sha, path: patch.path });
        continue;
      }
      change.hunks = patch.hunks;
      filesWithHunks++;
    }
  }
  return { orphans, filesWithHunks };
}
