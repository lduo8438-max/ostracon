#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  declarationScopeOf,
  PARTIAL_INDEX_NOTICE,
} from "../index/repo-pass.ts";
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
  // **明示才嵌片段。** 索引不存原始碼，所以片段一定要回讀 git；而回讀到的
  // 東西會被發佈出去。對 MIT 語料沒問題，對私有 repo 是一次不可逆的外洩，
  // 所以不做「有 root_path 就自動讀」那種貼心。
  const repoRoot = valueAfter(args, "--repo");
  const rawLimit = valueAfter(args, "--limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    console.error("--limit 必須是正整數");
    process.exitCode = 2;
    return;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // **匯出會被發佈出去，收不回來。** 讀到降級過的索引就停下來，而不是印個
    // 警告然後照樣產生一份數字偏高的站台——我自己踩過一次。
    if (declarationScopeOf(db, 1) === "lineage") {
      console.error(`拒絕匯出：${PARTIAL_INDEX_NOTICE}`);
      process.exitCode = 2;
      return;
    }
    if (repoRoot !== undefined && !existsSync(repoRoot)) {
      // 給了卻讀不到就停下來。靜默省略片段的話，畫面會有時有、有時沒有，
      // 而使用者不知道為什麼——那比一律沒有更糟。
      console.error(
        `--repo 指向的路徑不存在：${repoRoot}\n`
        + "斷層的前後片段要回讀該語料的 git blob。"
        + "確認路徑，或拿掉 --repo 匯出成不含片段的版本。",
      );
      process.exitCode = 2;
      return;
    }
    const report = exportStaticSite(db, outDir, {
      label,
      ...(limit === undefined ? {} : { limit }),
      ...(repoRoot === undefined ? {} : { repoRoot }),
    });
    console.log(
      `匯出 ${report.entities} 個宣告（含 ${report.ostracised} 個被推翻的做法）、`
      + `${report.files} 個檔案、`
      + `${(report.bytes / 1024 / 1024).toFixed(1)} MB → ${outDir}`,
    );
    if (repoRoot === undefined) {
      // **說出怎麼辦，不只說沒有。** 資料庫本來就記著索引時的語料路徑，
      // 使用者不必自己去翻。
      const recorded = (db.prepare("SELECT root_path AS root FROM repo WHERE id = 1")
        .get() as { root: string } | undefined)?.root;
      console.log(
        "未嵌入斷層的程式碼片段（沒有給 --repo）。畫面會說明原因。"
        + (recorded !== undefined && existsSync(recorded)
          ? `\n要嵌入的話：--repo ${recorded}（那些程式碼會隨站台公開）。`
          : ""),
      );
    } else {
      console.log(
        `已嵌入斷層的程式碼片段，來源 ${repoRoot}——**那些程式碼會隨站台公開**。`,
      );
    }
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
