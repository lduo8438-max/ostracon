import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SCHEMA_VERSION } from "../src/git/persist.ts";
import { exportStaticSite } from "../src/ui/export.ts";
import { APP_DIR, appBuilt, appFiles, contentTypeOf } from "../src/ui/app-assets.ts";
import { FIXED_ROUTES, evolutionRoute } from "../src/ui/routes.ts";
import { INSERT_CONTENT_FIXTURE, REVISION_COLUMNS, revisionValues } from "./db-fixture.ts";

const K = (n: number) => String(n).padStart(64, "0");

/** 最小可匯出的索引。這一組測試只在乎 URL 形狀，不在乎內容。 */
function fixtureDb(): DatabaseSync {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-subpath-")), "i.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.exec(`
    INSERT INTO schema_migration (version, applied_at) VALUES (${SCHEMA_VERSION}, '2026-01-01');
    INSERT INTO repo (id, root_path, created_at) VALUES (1, '/tmp/s', '2026-01-01');
    INSERT INTO git_commit (id, repo_id, sha, authored_at, committed_at, message, topo_order)
      VALUES (1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', '2026-01-01', '2026-01-01', 'feat: a', 1),
             (2, 1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2', '2026-01-05', '2026-01-05', 'refactor: b', 2);
    INSERT INTO path_lineage (id, repo_id) VALUES (1, 1);
    INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind) VALUES (1, 1, 1, 'shipped', 'function');
    INSERT INTO entity (id, repo_id, stable_key, birth_commit_id, death_commit_id)
      VALUES (1, 1, '${K(1)}', 1, NULL);
    ${INSERT_CONTENT_FIXTURE}
    INSERT INTO revision ${REVISION_COLUMNS} VALUES
      ${revisionValues({ id: 1, commitId: 1, path: "src/a.ts" })},
      ${revisionValues({ id: 2, commitId: 2, path: "src/a.ts" })};
    INSERT INTO revision_change (prev_revision, next_revision, commit_id, entity_id, change_level)
      VALUES (NULL, 1, 1, 1, 'birth'), (1, 2, 2, 1, 'shape');
  `);
  return db;
}

/**
 * 一台**只服務靜態檔**的伺服器，根目錄是「網域根」。
 *
 * 刻意不做 SPA fallback、也不替沒有尾斜線的目錄做 301——GitHub Pages 會導向
 * 帶尾斜線的形式，而測試要驗的正是那個形式底下的解析結果。少了這台伺服器，
 * 「掛在子目錄」就只能靠讀檔推論，而這次出事的正是推論。
 */
function serveRoot(root: string): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith("/")) file = path.join(file, "index.html");
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      response.writeHead(200, { "content-type": contentTypeOf(file) });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("404");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** 線上 demo 的實際形狀：專案站台 `/ostracon-demo/`，語料各一個子目錄。 */
const DEPLOY_DIR = "ostracon-demo/vuejs-core";

describe("匯出站台掛在非根路徑", () => {
  it("**頁面、資產與資料端點都必須落在語料子目錄之內**", async () => {
    if (!appBuilt()) return; // 沒跑過 build:ui（CI 一定會跑）
    const root = mkdtempSync(path.join(tmpdir(), "ostracon-pages-"));
    const out = path.join(root, DEPLOY_DIR);
    exportStaticSite(fixtureDb(), out, { label: "fixture" });
    const { base, close } = await serveRoot(root);
    try {
      const pageUrl = `${base}/${DEPLOY_DIR}/`;
      const page = await fetch(pageUrl);
      assert.equal(page.status, 200, "語料首頁本身就拿不到，後面的斷言沒有意義");
      const html = await page.text();

      // 一、HTML 引用的資產。`base: './'` 那條測試看的是字串，這裡看的是
      // 瀏覽器解析之後真正會發出的請求。
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
      assert.ok(refs.length > 0, "index.html 沒有任何資產引用，這條測試會空轉");
      for (const ref of refs) {
        const resolved = new URL(ref, pageUrl);
        assert.ok(
          resolved.pathname.startsWith(`/${DEPLOY_DIR}/`),
          `${ref} 解析成 ${resolved.pathname}，逃出了語料子目錄`,
        );
        assert.equal((await fetch(resolved)).status, 200, `${ref} 拿不到`);
      }

      // 二、資料端點。**這一段是這次線上事故的位置**：資產全對、頁面 200、
      // console 乾淨，而六個端點整批打到網域根上。
      for (const route of FIXED_ROUTES) {
        const resolved = new URL(route, pageUrl);
        assert.ok(
          resolved.pathname.startsWith(`/${DEPLOY_DIR}/`),
          `${route} 解析成 ${resolved.pathname}，逃出了語料子目錄`,
        );
        const response = await fetch(resolved);
        assert.equal(response.status, 200, `${route} → HTTP ${response.status}`);
        JSON.parse(await response.text()); // 拿到的必須真的是 JSON，不是 404 頁
      }

      // 三、以 stable_key 分片的那一條，模板字串走的是另一條路。
      const entities = JSON.parse(
        readFileSync(path.join(out, "api", "entities.json"), "utf8"),
      ) as Array<{ stableKey: string }>;
      assert.ok(entities.length > 0, "fixture 沒有任何 entity，時間軸那條會空轉");
      const timeline = new URL(evolutionRoute(entities[0]!.stableKey), pageUrl);
      assert.equal((await fetch(timeline)).status, 200, "時間軸拿不到");

      // 四、**咬檢**：把同一條路由寫成絕對形式，這台伺服器必須回 404。
      // 沒有這一條，前三段就無法證明自己抓得到那個 bug——它們可能只是在
      // 一台什麼都回 200 的伺服器上通過。
      const escaped = new URL(`/${FIXED_ROUTES[0]!}`, pageUrl);
      assert.equal(escaped.pathname, `/${FIXED_ROUTES[0]!}`);
      assert.equal(
        (await fetch(escaped)).status,
        404,
        "絕對路徑竟然拿得到——這台伺服器抓不出根目錄外逃，整組測試作廢",
      );
    } finally {
      await close();
    }
  });
});

describe("前端產物的請求路徑", () => {
  const bundles = () =>
    appFiles().filter((file) => file.endsWith(".js"))
      .map((file) => readFileSync(path.join(APP_DIR, file), "utf8"));

  it("**產物裡不得有根絕對的資料路徑**", () => {
    if (!appBuilt()) return;
    // 前端原本自己抄了一份 `/api/*.json`。它在 `ostracon ui`（服務於網域根）
    // 與 vite dev server 上都對，只有放進子目錄才錯——而那是唯一一種
    // 對外發布的形式。
    for (const [index, body] of bundles().entries()) {
      const hits = [...body.matchAll(/["'`]\/api\/[^"'`]*/g)].map((m) => m[0]);
      assert.deepEqual(hits, [], `bundle ${index} 裡有根絕對資料路徑：${hits.join(" ")}`);
    }
  });

  it("**六條固定路由都要真的出現在產物裡**", () => {
    if (!appBuilt()) return;
    // 上一條單獨存在時是可以空轉的：把所有 API 呼叫刪光、或掃錯檔案，
    // 它一樣會綠。這一條釘住「前端確實走 routes.ts 那一份」。
    const all = bundles().join("\n");
    for (const route of FIXED_ROUTES) {
      assert.ok(all.includes(route), `產物裡找不到 ${route}——前端沒有走共用路由`);
    }
    assert.ok(all.includes("api/evolution/"), "產物裡找不到時間軸路由");
  });

  it("**路由在子目錄下解析必須留在子目錄內**", () => {
    // 純函式，不需要建置。這一條在 routes.ts 被加回前導斜線時立刻紅。
    const pageUrl = "https://example.github.io/ostracon-demo/vuejs-core/";
    for (const route of [...FIXED_ROUTES, evolutionRoute(K(1))]) {
      assert.equal(
        new URL(route, pageUrl).toString(),
        `${pageUrl}${route}`,
        `${route} 不是相對於語料目錄解析的`,
      );
    }
  });
});
