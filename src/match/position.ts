import type { DiffHunk } from "../git/types.ts";

/**
 * 由 diff hunk 導出的位置證據。純函式：不碰 git、不碰資料庫。
 *
 * 動機（實測，見 `docs/plan-diff-hunk.md` §5）：內容完全相同的候選之間，雜湊與
 * 相似度都已用盡資訊。但 git 告訴我們哪幾行沒被碰過，而**沒被碰過的宣告，它在
 * 前像的行號可以精確回推**——內容用盡的地方，位置仍然是確定的。
 *
 * 這裡刻意不做任何「近似」或「容忍」：回推是整數算術，命中就是命中。
 * 一旦引入模糊比對，這一層就從證據退化成另一個猜測，失去存在的理由。
 */

/**
 * hunk 在新側佔用的最後一行。
 *
 * `newCount = 0` 的純刪除在新側不佔任何行，git 給的 `newStart` 語意是
 * 「刪除發生在新檔第 newStart 行之後」，所以拿它當分界點而不是當佔用範圍。
 */
function lastNewLine(h: DiffHunk): number {
  return h.newCount > 0 ? h.newStart + h.newCount - 1 : h.newStart;
}

/**
 * hunk 是否碰到新側的 [startLine, endLine]。
 *
 * **匯出是為了讓畫面用同一個判準。** 時間軸要標「這次改動有沒有真的碰到這個
 * 宣告」，而那與 L3c 成立的前提是同一件事。另寫一份的話會出現「畫面說沒碰到、
 * matcher 當時認為碰到了」——那是最難發現的那種錯，因為兩邊各自看起來都對。
 *
 * 只比對端點是不夠的：一個「兩行換兩行」的 hunk 落在宣告正中間時，位移為零，
 * 端點回推得到完全正確的舊行號，但宣告的內容其實改了——那會產生一個假的位置
 * 證明。所以必須檢查整個區間不與任何 hunk 相交。
 */
export function touches(h: DiffHunk, startLine: number, endLine: number): boolean {
  if (h.newCount > 0) {
    return startLine <= lastNewLine(h) && endLine >= h.newStart;
  }
  // 純刪除在新側沒有範圍可相交，但刪除點若落在宣告之內，代表宣告掉了幾行。
  // 邊界（正好等於首行或末行）算「碰到」——寧可少給一次證據。
  return h.newStart >= startLine && h.newStart <= endLine;
}

export interface LineRange {
  startLine: number;
  endLine: number;
}

/**
 * 把新側的行範圍回推成舊側的行範圍。
 *
 * 回傳 null 代表「這個範圍被改過」，沒有位置證據可用。呼叫端必須把 null 當成
 * 「不知道」而不是「不相等」——兩者的差別就是保守與武斷的差別。
 *
 * `hunks` 允許任意順序：git 的輸出本來就依 newStart 遞增，但這一層不該依賴
 * 呼叫端維持那個順序，排錯了會安靜地算出錯誤的位移。
 */
export function reconstructOldRange(
  startLine: number,
  endLine: number,
  hunks: readonly DiffHunk[],
): LineRange | null {
  const ordered = [...hunks].sort((a, b) => a.newStart - b.newStart);
  let delta = 0;
  for (const h of ordered) {
    if (touches(h, startLine, endLine)) return null;
    // 完全位於宣告之前的 hunk 才貢獻位移；之後的不影響。
    if (lastNewLine(h) < startLine) delta += h.newCount - h.oldCount;
  }
  return { startLine: startLine - delta, endLine: endLine - delta };
}

/**
 * 新側的行範圍是否完全落在某個**純新增** hunk 內。
 *
 * `oldCount = 0` 才是純新增。這是 birth 判定的依據，也是為什麼 `file_hunk`
 * 一列一個 hunk：拆成 old/new 兩列之後，純新增與修改的 new-side 範圍同形，
 * 被修改的宣告會被誤判成 birth——誤報 birth ＝ 假斷層。
 */
export function insidePureAddHunk(
  startLine: number,
  endLine: number,
  hunks: readonly DiffHunk[],
): boolean {
  return hunks.some((h) =>
    h.oldCount === 0
    && h.newCount > 0
    && startLine >= h.newStart
    && endLine <= lastNewLine(h));
}
