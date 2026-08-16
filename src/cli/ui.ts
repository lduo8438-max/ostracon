#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startUiServer } from "../ui/server.ts";

/**
 * `ostracon ui` — 三欄畫面：結構 → 演化 → 意圖。
 *
 * **只讀，不索引。** `why` 與 `ostracised` 會自己建索引，這支刻意不會：
 * 一個網頁在背景默默跑全 repo pass，使用者只會看到它卡住。要先有索引，
 * 訊息直接說該跑哪一行。
 */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(args: string[]): Promise<void> {
  const dbPath = valueAfter(args, "--db") ?? ".ostracon/index.db";
  if (!existsSync(dbPath)) {
    console.error(
      `找不到索引：${dbPath}\n`
      + "這支指令只讀不建。先跑一次索引，例如：\n"
      + "  ostracon why '<path>:<symbol>' --repo <repo> --full\n"
      + "  ostracon evidence extract --db " + dbPath,
    );
    process.exitCode = 2;
    return;
  }
  const port = Number(valueAfter(args, "--port") ?? 4319);
  const repoId = Number(valueAfter(args, "--repo-id") ?? 1);
  const { url } = await startUiServer({ dbPath, repoId, port });
  console.log(`ostracon ui：${url}`);
  console.log("只綁 127.0.0.1——資料庫裡是整個 repo 的歷史。Ctrl-C 結束。");
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main(process.argv.slice(2));
}
