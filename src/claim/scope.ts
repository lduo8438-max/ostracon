import type { DatabaseSync } from "node:sqlite";

/**
 * 一條理由的**尺度**：它是在講這一個宣告，還是在講整批改動。
 *
 * 證據掛在 commit 上，claim 掛在改動上。一顆改動了 72 個宣告的 commit，它訊息裡
 * 那句話會被歸給 72 次改動——**在 commit 尺度上那是真的**（這次改動確實發生在
 * 這顆 commit 裡，作者確實說了那句話），但把它印在單一函式底下，讀起來就變成
 * 「**這個函式**因為 X 而改」。那一步沒有任何結構資訊支持。
 *
 * 實測（fresh DB）：
 *
 * | 語料 | 一般 claim | 背後引文 | 扇出 >1 的 claim | 最大扇出 |
 * |---|---|---|---|---|
 * | vuejs/core | 722 | 123 | 684（95%） | 72 |
 * | remix | 2,626 | 171 | 2,589（99%） | 113 |
 * | Osiris | 74 | **3** | 74（100%） | 70 |
 *
 * **所以做法是標示而不是收回。** 收回的代價量過：以「扇出必須為 1」當門檻，
 * Osiris 的意圖層會整個歸零、vuejs/core 只剩 34 個 entity 有意圖（0.5%）。
 * 那條判準對 `abandoned_reason` 成立，是因為那句宣稱本身就是 entity 級的
 * （「**這個**做法被放棄」）；一般 claim 的宣稱較弱，該做的是把尺度說清楚。
 *
 * 也刻意不設扇出上限：實測分布沒有自然斷點（72, 45, 44, 43, 40, 36, 33, 15,
 * 14, 13, 13, 13, 13, 11 …），任何門檻都是憑空畫的。
 */
export type ClaimScope = "entity" | "batch";

export const scopeOf = (affectedEntities: number): ClaimScope =>
  affectedEntities <= 1 ? "entity" : "batch";

/**
 * 每顆 commit 有幾次**相關**改動——也就是它的引文會被歸給幾個 entity。
 *
 * 判準是 `change_level <> 'none'`，與 `suppressUnrelatedRationale` 及 claim
 * 升格用的是同一條。**一份實作、多個呼叫端**：CLI 與畫面各算一次的話，同一條
 * 引文會在兩個介面上被標成不同的尺度，而這個專案已經因為「兩份實作分岔」
 * 踩過好幾次。
 *
 * 回傳以 sha 為鍵，因為兩個呼叫端手上都是 sha 而不是 rowid。
 */
export function affectedEntityCounts(
  db: DatabaseSync,
  repoId: number,
): Map<string, number> {
  const rows = db.prepare(
    `SELECT c.sha AS sha, COUNT(*) AS n
       FROM revision_change rc
       JOIN git_commit c ON c.id = rc.commit_id
      WHERE c.repo_id = ? AND rc.change_level <> 'none'
      GROUP BY c.sha`,
  ).all(repoId) as unknown as Array<{ sha: string; n: number }>;
  return new Map(rows.map((row) => [row.sha, row.n]));
}
