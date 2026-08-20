#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { exportStaticSite, SERVE_HINT } from "../ui/export.ts";

/** `ostracon export` — 把索引匯出成可直接託管的靜態站台。 */

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function main(args: string[]): void {
  const dbPath = valueAfter(args, "--db");
  const outDir = valueAfter(args, "--out");
  const label = valueAfter(args, "--label");
  if (dbPath === undefined || outDir === undefined || label === undefined) {
    console.error(
      "用法：ostracon export --db <db> --out <目錄> --label <語料名稱> [--limit <n>]\n"
      + "--label 是必填：不給的話畫面會顯示匯出者的本機路徑。",
    );
    process.exitCode = 2;
    return;
  }
  const rawLimit = valueAfter(args, "--limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    console.error("--limit 必須是正整數");
    process.exitCode = 2;
    return;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const report = exportStaticSite(db, outDir, {
      label,
      ...(limit === undefined ? {} : { limit }),
    });
    console.log(
      `匯出 ${report.entities} 個宣告、${report.files} 個檔案、`
      + `${(report.bytes / 1024 / 1024).toFixed(1)} MB → ${outDir}`,
    );
    console.log(SERVE_HINT);
  } finally {
    db.close();
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2));
}
