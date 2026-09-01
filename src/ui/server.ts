import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { hotspotsView } from "./hotspots-view.ts";
import {
  discontinuitiesFor,
  entityIdForStableKey,
  evolutionOf,
  ladderStats,
  listEntities,
  ostracisedFor,
  repoSummary,
} from "./data.ts";
import {
  APP_MISSING_NOTICE,
  appBuilt,
  contentTypeOf,
  readAsset,
} from "./app-assets.ts";

/**
 * 三欄 UI 的伺服器。**`node:http`，零新相依。**
 *
 * 「不增加執行期相依」是禁令，而 roadmap 把這一版叫「最醜的 UI」——它的工作
 * 是把端到端跑通，不是展示前端工程。一個框架加一套建置流程換到的東西，
 * 這裡沒有一項用得上。
 *
 * **只綁 127.0.0.1。** 資料庫裡是使用者整個 repo 的歷史，包括私有程式碼的
 * 路徑與 commit 訊息。預設對外開放等於預設外洩；要對外的人自己去做通道。
 * 這也是這個專案唯一一處 `node:http` 的**伺服端**用法——出站網路仍然只准
 * 出現在 `src/http/github.ts`。
 */

export interface UiOptions {
  dbPath: string;
  repoId?: number;
  port?: number;
  host?: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/**
 * 端點以**路徑**定位，而且帶 `.json` 副檔名。
 *
 * 這是為了讓靜態匯出與這台伺服器**共用同一個頁面**。查詢字串
 * （原本的 `?entity=7`）沒有辦法變成靜態檔，一旦保留就得替頁面寫第二套取數
 * 邏輯——而「同一個東西兩份實作」在這個專案已經出過好幾次事。改成路徑之後，
 * `ostracon export` 直接把檔案寫在同名位置，頁面一個字都不用改。
 */
export const SUMMARY_PATH = "/api/summary.json";
export const ENTITIES_PATH = "/api/entities.json";
export const OSTRACISED_PATH = "/api/ostracised.json";
/** 匹配階梯的分佈與跨檔案搬移清單。 */
export const LADDER_PATH = "/api/ladder.json";
/** 身份斷層：slot 延續、entity 血緣斷開的那些位置。 */
export const DISCONTINUITIES_PATH = "/api/discontinuities.json";
/** 攪動熱點。**與 CLI 共用 `listHotspots`**，不另寫一份查詢。 */
export const HOTSPOTS_PATH = "/api/hotspots.json";
export const evolutionPath = (stableKey: string) =>
  `/api/evolution/${stableKey}.json`;

/** `stable_key` 是 64 位十六進位。放進路徑之前一定要驗——它會變成檔名。 */
export const STABLE_KEY = /^[0-9a-f]{64}$/;

/**
 * 從路徑取回 `stable_key`。
 *
 * `undefined` = 不是這條路由；`null` = 是這條路由但鍵不合法。**兩者不可合併**：
 * 前者要回 404，後者要回 400，而把壞參數當成「沒這個路徑」會讓使用者去找一個
 * 根本存在的端點。
 */
function stableKeyFromPath(pathname: string): string | null | undefined {
  const match = /^\/api\/evolution\/(.*)\.json$/.exec(pathname);
  if (match === null) return undefined;
  return STABLE_KEY.test(match[1]!) ? match[1]! : null;
}

/** 這個 repo 索引時的根路徑。讀片段要回本地 git，所以需要它。 */
function repoRootOf(db: DatabaseSync, repoId: number): string | undefined {
  return (db.prepare("SELECT root_path AS root FROM repo WHERE id = ?")
    .get(repoId) as { root: string } | undefined)?.root;
}

export function createUiServer(options: UiOptions): Server {
  const repoId = options.repoId ?? 1;
  return createServer((request, response) => {
    // 每一條連線都要自己設 foreign_keys（不變量 13）。這裡是唯讀，但開著
    // 才不會在將來加入寫入時忘記。
    const db = new DatabaseSync(options.dbPath, { readOnly: true });
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      // 頁面與資產都來自建置後的前端。**伺服器與靜態匯出共用同一份產物**，
      // 所以「本機看到的」與「發佈出去的」不可能是兩個版本。
      if (!url.pathname.startsWith("/api/")) {
        if (!appBuilt()) {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end(APP_MISSING_NOTICE);
          return;
        }
        // **不做 SPA fallback。** 這個前端用的是 hash 片段（`#<stable_key>`），
        // 不是路徑路由——把未知路徑一律回 index.html 只會把打錯的網址偽裝成
        // 正常頁面，而 `/nope` 回 200 是在說謊。既有測試釘住這一點。
        const file = url.pathname === "/" || url.pathname === "/index.html"
          ? "/index.html"
          : url.pathname;
        const asset = readAsset(file);
        if (asset === undefined) {
          response.writeHead(404, JSON_HEADERS);
          response.end(JSON.stringify({ error: "找不到" }));
          return;
        }
        response.writeHead(200, { "content-type": contentTypeOf(file) });
        response.end(asset);
        return;
      }
      if (url.pathname === SUMMARY_PATH) {
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(repoSummary(db, repoId)));
        return;
      }
      if (url.pathname === ENTITIES_PATH) {
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(listEntities(db, repoId)));
        return;
      }
      if (url.pathname === OSTRACISED_PATH) {
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(ostracisedFor(db, repoId)));
        return;
      }
      if (url.pathname === LADDER_PATH) {
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(ladderStats(db, repoId)));
        return;
      }
      if (url.pathname === DISCONTINUITIES_PATH) {
        // 本機伺服器旁邊就是語料，所以片段直接讀。讀不到時 payload 會說
        // `repo-unavailable`，不是靜默留白。
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(
          discontinuitiesFor(db, repoId, 500, repoRootOf(db, repoId)),
        ));
        return;
      }
      if (url.pathname === HOTSPOTS_PATH) {
        // 測試檔的排除與 CLI 用同一個 predicate，而且**排除不得靜默**——
        // 兩邊各數一次的話，畫面與 CLI 遲早會給出不同的數字。
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(hotspotsView(db, repoId)));
        return;
      }
      const key = stableKeyFromPath(url.pathname);
      if (key !== undefined) {
        if (key === null) {
          response.writeHead(400, JSON_HEADERS);
          response.end(JSON.stringify({ error: "entity 必須是 64 位十六進位的 stable_key" }));
          return;
        }
        const id = entityIdForStableKey(db, repoId, key);
        if (id === undefined) {
          // 格式對但這個 repo 沒有——那是「沒有這個東西」，不是參數錯。
          response.writeHead(404, JSON_HEADERS);
          response.end(JSON.stringify({ error: "這個 repo 沒有這個 stable_key" }));
          return;
        }
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(evolutionOf(db, repoId, id)));
        return;
      }
      response.writeHead(404, JSON_HEADERS);
      response.end(JSON.stringify({ error: "沒有這個路徑" }));
    } catch (error) {
      // 錯誤要說出來而不是回空陣列——空陣列在這個 UI 裡的意思是
      // 「查過了，真的沒有」，拿它當失敗值就是讓畫面說謊。
      response.writeHead(500, JSON_HEADERS);
      response.end(JSON.stringify({ error: String(error) }));
    } finally {
      db.close();
    }
  });
}

export function startUiServer(options: UiOptions): Promise<{ url: string; server: Server }> {
  const server = createUiServer(options);
  const host = options.host ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4319, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null
        ? address.port
        : options.port;
      resolve({ url: `http://${host}:${port}/`, server });
    });
  });
}
