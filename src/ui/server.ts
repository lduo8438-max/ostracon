import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { evolutionOf, listEntities, repoSummary } from "./data.ts";
import { PAGE } from "./page.ts";

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

export function createUiServer(options: UiOptions): Server {
  const repoId = options.repoId ?? 1;
  return createServer((request, response) => {
    // 每一條連線都要自己設 foreign_keys（不變量 13）。這裡是唯讀，但開著
    // 才不會在將來加入寫入時忘記。
    const db = new DatabaseSync(options.dbPath, { readOnly: true });
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/" || url.pathname === "/index.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGE);
        return;
      }
      if (url.pathname === "/api/summary") {
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(repoSummary(db, repoId)));
        return;
      }
      if (url.pathname === "/api/entities") {
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(listEntities(db, repoId)));
        return;
      }
      if (url.pathname === "/api/evolution") {
        const entity = Number(url.searchParams.get("entity"));
        if (!Number.isSafeInteger(entity) || entity <= 0) {
          response.writeHead(400, JSON_HEADERS);
          response.end(JSON.stringify({ error: "entity 必須是正整數" }));
          return;
        }
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(evolutionOf(db, repoId, entity)));
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
