#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ingestLinkedDocuments } from "../evidence/linked.ts";
import { extractFromLinkedDocuments } from "../evidence/store.ts";
import { createRecordingFetcher, createReplayFetcher } from "../http/fixtures.ts";
import { createGitHubFetcher } from "../http/github.ts";
import { createRetryingFetcher, describeRetry } from "../http/retry.ts";

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(args: string[]): Promise<void> {
  const dbPath = valueAfter(args, "--db");
  const recordDir = valueAfter(args, "--record-dir");
  const replayDir = valueAfter(args, "--replay-dir");
  if (!dbPath || (recordDir && replayDir)) {
    console.error(
      "用法：ostracon evidence linked --db <file> [--repo-id <n>] "
        + "[--record-dir fixtures/http | --replay-dir fixtures/http]",
    );
    process.exitCode = 2;
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!replayDir && !token) {
    console.log("未設定 GITHUB_TOKEN；略過 linked 層（其餘索引不受影響）");
    return;
  }

  // 重試包在 live 外面、錄製裡面：錄下來的必須是成功的回應，不是中途的失敗。
  // replay 不包——離線重播不會有暫時性失敗，包了只會讓測試變慢且更難推理。
  const live = createRetryingFetcher(
    createGitHubFetcher({ token }),
    { onRetry: (event) => console.error(describeRetry(event)) },
  );
  const fetcher = replayDir
    ? createReplayFetcher(replayDir)
    : recordDir
      ? createRecordingFetcher(live, recordDir)
      : live;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    const sourceReport = await ingestLinkedDocuments(
      db,
      Number(valueAfter(args, "--repo-id") ?? 1),
      fetcher,
    );
    const extractionReport = extractFromLinkedDocuments(
      db,
      Number(valueAfter(args, "--repo-id") ?? 1),
    );
    console.log(JSON.stringify({ source: sourceReport, extraction: extractionReport }, null, 2));
    if (sourceReport.stopped) process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main(process.argv.slice(2));
}
