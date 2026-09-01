import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  discontinuitiesFor,
  entityIdForStableKey,
  evolutionOf,
  ladderStats,
  listEntities,
  ostracisedFor,
  repoSummary,
} from "./data.ts";
import { APP_DIR, appBuilt, appFiles } from "./app-assets.ts";
import { hotspotsView } from "./hotspots-view.ts";
import {
  DISCONTINUITIES_PATH,
  ENTITIES_PATH,
  HOTSPOTS_PATH,
  LADDER_PATH,
  OSTRACISED_PATH,
  SUMMARY_PATH,
  evolutionPath,
} from "./server.ts";

/**
 * 把一個索引匯出成**純靜態檔**，不需要 node、不需要 SQLite。
 *
 * 線上 demo 的散布方式。實測過的替代方案是託管一台伺服器，但那要搬 284 MB 的
 * SQLite、要 Node 24 加 FTS5、還多一個會壞掉的執行期——而 API 只有三個端點，
 * 其中兩個是單例、一個以 entity 分片，本來就對得上靜態檔。
 *
 * **頁面與 `src/ui/server.ts` 共用同一份實作**：兩邊的 URL 都是
 * `/api/<name>.json`，所以匯出只是把同名檔案寫到磁碟。頁面裡沒有任何
 * 「靜態版 / 伺服器版」的分支。
 *
 * 實測產出（gzip 後訪客實際下載）：Osiris 1.7 MB（頁面 5 KB＋清單 17 KB＋
 * 每條時間軸約 5 KB）、create-t3-app 1.9 MB、vuejs/core 23 MB。
 */

export interface ExportOptions {
  /**
   * 畫面上顯示的語料名稱，**取代 `summary.rootPath`**。
   *
   * 不換的話 demo 會把匯出者的檔案系統路徑公開出去
   * （實測：`/Users/…/reports/corpora/vue-core`）。這不是美觀問題。
   */
  label: string;
  repoId?: number;
  /** 匯出幾個宣告。畫面本來就只列這麼多。 */
  limit?: number;
  /**
   * 語料的路徑。給了才會把斷層的前後程式碼片段嵌進匯出。
   *
   * **索引不存原始碼**（只有 blob hash 與 byte 位移），所以片段一定要回讀
   * git。不給不是錯誤——匯出可能在沒有語料的機器上跑——但 payload 會記下
   * 是哪一種情況，畫面因此說得出為什麼沒有片段。
   *
   * **給了就會把那些程式碼公開出去。** 對 MIT 語料沒問題，對私有 repo 是
   * 一次不可逆的外洩，所以這是明示的旗標而不是預設行為。
   */
  repoRoot?: string;
}

export interface ExportReport {
  /** 前端資產有沒有一起寫出去。`missing` = 還沒 `pnpm run build:ui`。 */
  app: "included" | "missing";
  entities: number;
  /** 被推翻的做法（已排除測試骨架）。**與 CLI 同一個查詢與同一個 predicate。** */
  ostracised: number;
  files: number;
  bytes: number;
}

export function exportStaticSite(
  db: DatabaseSync,
  outDir: string,
  options: ExportOptions,
): ExportReport {
  const repoId = options.repoId ?? 1;
  const root = path.resolve(outDir);
  mkdirSync(path.join(root, "api", "evolution"), { recursive: true });

  let files = 0;
  let bytes = 0;
  const write = (relative: string, body: string) => {
    // 路徑一律由 SUMMARY_PATH 那組常數導出，手寫字串就是分岔的開始。
    const target = path.join(root, relative.replace(/^\//, ""));
    writeFileSync(target, body);
    files++;
    bytes += Buffer.byteLength(body);
  };

  write(SUMMARY_PATH, JSON.stringify({
    ...repoSummary(db, repoId),
    rootPath: options.label,
  }));

  // **有意圖的一律收，再用改動量補滿。** 只取「改動最多的前 N 筆」的話，
  // demo 會被一個與內容無關的排序決定內容——實測 vuejs/core 那樣會把訊噪比
  // 最好的 `generateCodeFrame` 擠掉（它只有 10 次改動，門檻是 11）。
  const withIntent = listEntities(db, repoId, Number.MAX_SAFE_INTEGER, {
    onlyWithIntent: true,
  });
  const byChurn = listEntities(db, repoId, options.limit);
  const seen = new Set(withIntent.map((e) => e.stableKey));
  const entities = [...withIntent, ...byChurn.filter((e) => !seen.has(e.stableKey))]
    .sort((a, b) => b.revisions - a.revisions
      || a.path.localeCompare(b.path)
      || a.symbol.localeCompare(b.symbol));

  // 被推翻的做法整份收，**而且它們的時間軸一定要一起匯出**。清單看得到、
  // 點進去沒有資料，就是把一個落差換成另一個落差。
  const ostracised = ostracisedFor(db, repoId);
  write(OSTRACISED_PATH, JSON.stringify(ostracised));
  write(ENTITIES_PATH, JSON.stringify(entities));

  // 這兩份是**全 repo 的彙總**，不隨 `--limit` 裁切：階梯的分母就是整個 repo
  // 的配對數，裁掉之後那個比例會說謊。實測 vuejs/core 兩份合計 100 KB 出頭。
  write(LADDER_PATH, JSON.stringify(ladderStats(db, repoId)));
  write(
    DISCONTINUITIES_PATH,
    JSON.stringify(discontinuitiesFor(db, repoId, 500, options.repoRoot)),
  );
  const hotspots = hotspotsView(db, repoId);
  write(HOTSPOTS_PATH, JSON.stringify(hotspots));

  // **三份名單的聯集才是「訪客點得到的一切」。**
  //
  // 熱點原本不在這個聯集裡。真實語料看不出來——前 50 名熱點的改動數本來就高，
  // 一定落在 `byChurn` 的窗口內——但那是 `--limit` 的運氣不是保證：把 limit 調小，
  // 熱點清單上的項目就會指向不存在的時間軸。畫面上每一列都帶「開啟時間軸」的
  // 入口，而入口指向錯誤頁比沒有入口更糟：使用者會以為資料壞了。
  // 集合不變量測試抓到的。
  //
  // **檔名用 `stable_key`**：rowid 會隨全量重建漂移，而漂移最壞的後果不是 404，
  // 是舊網址在重建後成功回傳另一個 entity。
  const needed = new Set<string>([
    ...entities.map((e) => e.stableKey),
    ...ostracised.rows.map((r) => r.stableKey),
    ...hotspots.rows.map((r) => r.stableKey),
  ]);
  for (const key of needed) {
    const entityId = entityIdForStableKey(db, repoId, key);
    if (entityId === undefined) continue;
    write(evolutionPath(key), JSON.stringify(evolutionOf(db, repoId, entityId)));
  }
  // **與伺服器同一份產物。** 先前這裡寫的是一個字串常數，而伺服器回的是同一個
  // 字串；現在兩邊都指向 dist/ui/app，所以「本機看到的」與「發佈出去的」是同
  // 一份程式碼，不是兩份剛好一樣的東西。
  // **政策在 CLI，不在這裡。** 「沒有前端就拒絕匯出」是 `ostracon export` 的
  // 決定（與「拒絕匯出降級過的索引」同一層），這支函式只回報事實。
  // 先前寫成在這裡丟例外，結果 CI 的單元測試全紅——那些測試只驗 JSON 那一半，
  // 不該被前端有沒有建置綁住。
  for (const file of appFiles()) {
    const body = readFileSync(path.join(APP_DIR, file));
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
    files++;
    bytes += body.byteLength;
  }

  return {
    app: appBuilt() ? "included" : "missing",
    entities: needed.size,
    ostracised: ostracised.rows.length,
    files,
    bytes,
  };
}

/**
 * 靜態版不能用 `file://` 開——Chrome 會擋掉同源 `fetch`。這句話要印出來，
 * 否則第一個試的人會以為匯出壞了。
 */
export const SERVE_HINT =
  "靜態檔不能直接用 file:// 開啟（瀏覽器會擋 fetch）。"
  + "本機預覽：`python3 -m http.server --directory <目錄>`。";
