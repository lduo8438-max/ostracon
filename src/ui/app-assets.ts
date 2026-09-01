import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 建置後的前端資產在哪裡。
 *
 * **這個相對路徑在開發與安裝後必須解析到同一個地方**，而那不是自動成立的：
 *
 * - 開發（strip-types）：`src/ui/app-assets.ts` → `src/ui/../../dist/ui/app`
 * - 安裝後：`dist/ui/app-assets.js` → `dist/ui/../../dist/ui/app`
 *
 * 兩者都落在 `<套件根>/dist/ui/app`。這與 `db/schema.sql` 是同一個技巧，而
 * 那次的教訓寫在 CI 裡：**深度剛好相同是巧合不是保證**，所以封裝冒煙測試
 * 必須在安裝之後真的抓一次這些檔案。
 */
export const APP_DIR = fileURLToPath(new URL("../../dist/ui/app/", import.meta.url));

/** 前端建置過了嗎。沒有的話 `ostracon ui` 要說怎麼辦，不是回 404。 */
export function appBuilt(): boolean {
  return existsSync(path.join(APP_DIR, "index.html"));
}

export const APP_MISSING_NOTICE =
  "找不到建置後的前端（dist/ui/app）。\n"
  + "從原始碼跑的話先執行 `pnpm run build:ui`；"
  + "裝了 npm 套件卻看到這則訊息，代表封裝漏了資產，請回報。";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export const contentTypeOf = (file: string): string =>
  MIME[path.extname(file)] ?? "application/octet-stream";

/**
 * 讀一個資產。**路徑一律先正規化再確認仍在 APP_DIR 之內**——這是唯一一處
 * 把使用者給的字串接到檔案系統上的地方，而伺服器雖然只綁 127.0.0.1，
 * 「只綁本機」不是路徑穿越的理由。
 */
export function readAsset(relative: string): Buffer | undefined {
  const target = path.resolve(APP_DIR, "." + relative);
  if (!target.startsWith(path.resolve(APP_DIR))) return undefined;
  return existsSync(target) && !target.endsWith(path.sep)
    ? readFileSync(target)
    : undefined;
}

/** 匯出時要複製的全部檔案，相對於 `APP_DIR`。 */
export function appFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(path.join(APP_DIR, dir), { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel + "/");
      else out.push(rel);
    }
  };
  if (appBuilt()) walk(".", "");
  return out;
}
