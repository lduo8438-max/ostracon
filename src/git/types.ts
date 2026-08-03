/** A=新增 M=修改 D=刪除 R=改名 C=複製 */
export type ChangeType = "A" | "M" | "D" | "R" | "C";

/**
 * 一個 unified diff hunk。
 *
 * **一列一個 hunk，不拆成 old/new 兩列**：約束的判準是「候選完全落在*純新增*
 * hunk 內」，而純新增（`oldCount === 0`）與修改（`oldCount > 0`）的 new-side
 * 範圍拆開後長得一模一樣。丟掉配對關係就再也分不出來，於是被修改的宣告會落在
 * 「新增範圍」內被誤判成 birth——正好是最不能犯的錯（誤報 birth ＝ 假斷層）。
 */
export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface FileChangeRecord {
  changeType: ChangeType;
  /** 此 commit 之後的路徑。D 的情況是被刪除的路徑。 */
  path: string;
  /** 僅 R / C 有值 */
  oldPath?: string;
  /** git 的相似度分數 0-100，僅 R / C 有值。只供候選排序，不決定 fixture difficulty。 */
  score?: number;
  /**
   * 僅非合併 commit 有值，且需開啟擷取。undefined 代表「沒去取」，
   * 空陣列代表「取了但沒有 hunk」（二進位、mode 變更、純改名）——兩者不可混同：
   * 前者不得套用 hunk 約束，後者代表內容確實沒動。
   */
  hunks?: DiffHunk[];
}

export interface CommitRecord {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** ISO8601 */
  authoredAt: string;
  committedAt: string;
  /** 完整訊息，含 body。證據層之後要對它做 span 引用，不可截斷。 */
  message: string;
  isMerge: boolean;
  /** 反向拓撲序中的索引。祖先必定小於後代。 */
  topoOrder: number;
  changes: FileChangeRecord[];
}

export interface WalkOptions {
  /** 改名偵測門檻，預設 30 */
  renameThreshold?: number;
  /** 複製偵測門檻，預設 40 */
  copyThreshold?: number;
  /**
   * 開啟後 git 會拿未修改的檔案一起比對來找複製來源，能抓到「檔案分割」，
   * 但成本從 O(改動檔案) 變成 O(全部檔案)，大 repo 上會慢一個數量級。
   * 預設關閉。
   */
  findCopiesHarder?: boolean;
}

export interface LineageSegment {
  lineageId: number;
  path: string;
  fromSha: string;
  /** null = 至今仍存在 */
  toSha: string | null;
  /** false = 這一段在資料庫裡已經存在，本次只是把它關閉（UPDATE 而非 INSERT） */
  isNew: boolean;
}

/**
 * 增量走訪的續跑狀態。
 *
 * 關鍵洞見：資料庫裡「尚未關閉的 segment」就是存活路徑集合本身
 * （to_commit_id IS NULL）。所以續跑不需要另外持久化任何狀態，
 * 一句 SELECT 就能重建，也不可能與實際資料不同步。
 */
export interface LineageState {
  active: Map<string, { lineageId: number; fromSha: string; isNew: boolean }>;
  nextLineageId: number;
}

export interface LineageResult {
  segments: LineageSegment[];
  /** key = `${sha}\0${path}`，值為該 file_change 所屬的 lineage */
  changeLineage: Map<string, number>;
  /** 走訪結束後的狀態，供下次增量續跑 */
  state: LineageState;
  /** 走訪過程中遇到的異常。不丟例外——但也絕不靜默。 */
  anomalies: Array<{ sha: string; path: string; reason: string }>;
}
