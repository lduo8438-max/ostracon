import type { DatabaseSync } from "node:sqlite";
import { type HotspotRow, listHotspots } from "../cli/hotspots.ts";
import { isTestPath } from "../cli/ostracised.ts";

export interface HotspotsView {
  /** 動過結構的宣告總數（未截斷、未排除測試檔）。母數與清單同源。 */
  total: number;
  /** 被排除的測試檔宣告數。**排除不得靜默。** */
  hiddenTests: number;
  rows: HotspotRow[];
}

/**
 * 攪動熱點的畫面資料。
 *
 * **查詢與測試檔判準都與 CLI 共用**（`listHotspots` 與 `isTestPath`）。
 * 這個專案被同型的分岔咬過一次——CLI 說 5 顆聚合 commit、UI 說 6 顆，因為
 * 畫面另外寫了一份 SQL 而漏掉 `change_level <> 'none'` 的前置過濾。
 *
 * 截斷發生在這裡而不是 SQL 裡，理由與 `renderHotspots` 相同：母數、抑制數量
 * 與清單來自同一個陣列，不可能分岔。
 */
export function hotspotsView(
  db: DatabaseSync,
  repoId: number,
  limit = 50,
): HotspotsView {
  const all = listHotspots(db, repoId);
  const eligible = all.filter((row) => !isTestPath(row.path));
  return {
    total: all.length,
    hiddenTests: all.length - eligible.length,
    rows: eligible.slice(0, limit),
  };
}
