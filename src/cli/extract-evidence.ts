#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  extractFromCommitMessages,
  extractFromLinkedDocuments,
  ingestCommitMessages,
} from "../evidence/store.ts";

/**
 * 對既有索引跑證據層：收 commit message、規則式抽取、驗證後升格。
 * **零網路、零 LLM。**
 *
 * 覆蓋率是頭條數字：多數 commit message 只寫做了什麼，不寫為什麼。
 * 這個數字直接決定 stated 層在一個 repo 上有多少東西可說。
 */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function main(args: string[]): void {
  const dbPath = valueAfter(args, "--db");
  if (!dbPath) {
    console.error("用法：ostracon evidence extract --db <file> [--repo-id <n>]");
    process.exitCode = 2;
    return;
  }
  const repoId = Number(valueAfter(args, "--repo-id") ?? 1);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    console.log("ingest:", JSON.stringify(ingestCommitMessages(db, repoId)));
    const report = extractFromCommitMessages(db, repoId);
    console.log("extract:", JSON.stringify(report));
    const pct = report.documents === 0
      ? 0
      : (report.documentsWithRationale / report.documents) * 100;
    console.log(
      `理由覆蓋率 ${report.documentsWithRationale}/${report.documents} (${pct.toFixed(1)}%)`,
    );
    console.log("extract-linked:", JSON.stringify(extractFromLinkedDocuments(db, repoId)));
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
