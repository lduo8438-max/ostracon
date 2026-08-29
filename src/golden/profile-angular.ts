#!/usr/bin/env node

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verifyParserAdapters } from "../ast/parser.ts";
import { indexGit, INDEXER_VERSION } from "../git/index.ts";
import { openIndexDatabase } from "../git/persist.ts";
import {
  indexRepoStructure,
  type RepoPassProgress,
} from "../index/repo-pass.ts";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], flag: string): string {
  const value = valueAfter(args, flag);
  if (value === undefined) throw new Error(`缺少 ${flag}`);
  return path.resolve(value);
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`需要正整數，實際是 ${raw ?? "undefined"}`);
  }
  return value;
}

function fileBytes(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

interface EventBase {
  at: string;
  pid: number;
  event: string;
}

function logger(logPath: string): (event: EventBase & Record<string, unknown>) => void {
  mkdirSync(path.dirname(logPath), { recursive: true });
  return (event) => {
    const line = JSON.stringify(event);
    appendFileSync(logPath, `${line}\n`);
    process.stdout.write(`${line}\n`);
  };
}

export async function main(args: string[]): Promise<void> {
  const repo = required(args, "--repo");
  const dbPath = required(args, "--db");
  const logPath = required(args, "--log");
  const until = valueAfter(args, "--until") ?? "HEAD";
  const progressEvery = positiveInteger(valueAfter(args, "--progress-every"), 5_000);
  const abortAfter = valueAfter(args, "--abort-after") === undefined
    ? undefined
    : positiveInteger(valueAfter(args, "--abort-after"), progressEvery);
  const log = logger(logPath);
  const started = Date.now();

  log({
    at: new Date().toISOString(),
    pid: process.pid,
    event: "started",
    repo,
    dbPath,
    until,
    progressEvery,
    abortAfter,
    indexerVersion: INDEXER_VERSION,
  });

  try {
    openIndexDatabase(dbPath).close();
    await verifyParserAdapters();
    const gitReport = indexGit(repo, { dbPath, until });
    log({
      at: new Date().toISOString(),
      pid: process.pid,
      event: "git-complete",
      ...gitReport,
      dbBytes: fileBytes(dbPath),
      walBytes: fileBytes(`${dbPath}-wal`),
      rssBytes: process.memoryUsage().rss,
      maxRssKiB: process.resourceUsage().maxRSS,
    });

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    let previous: RepoPassProgress | undefined;
    try {
      const pass = await indexRepoStructure(db, repo, gitReport.repoId, INDEXER_VERSION, {
        progressEvery,
        onProgress(progress) {
          log({
            at: new Date().toISOString(),
            pid: process.pid,
            event: "progress",
            ...progress,
            intervalCommits: progress.commitsScanned - (previous?.commitsScanned ?? 0),
            intervalRevisions: progress.revisions - (previous?.revisions ?? 0),
            intervalElapsedMs: progress.elapsedMs - (previous?.elapsedMs ?? 0),
            dbBytes: fileBytes(dbPath),
            walBytes: fileBytes(`${dbPath}-wal`),
          });
          previous = progress;
          if (abortAfter !== undefined && progress.commitsScanned >= abortAfter) {
            throw new Error(`PROFILE_INTENTIONAL_ABORT:${progress.commitsScanned}`);
          }
        },
      });
      log({
        at: new Date().toISOString(),
        pid: process.pid,
        event: "pass-complete",
        ...pass,
        dbBytes: fileBytes(dbPath),
        walBytes: fileBytes(`${dbPath}-wal`),
        rssBytes: process.memoryUsage().rss,
        maxRssKiB: process.resourceUsage().maxRSS,
      });
    } finally {
      db.close();
    }

    log({
      at: new Date().toISOString(),
      pid: process.pid,
      event: "completed",
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({
      at: new Date().toISOString(),
      pid: process.pid,
      event: message.startsWith("PROFILE_INTENTIONAL_ABORT:")
        ? "intentional-abort"
        : "failed",
      message,
      elapsedMs: Date.now() - started,
      dbBytes: fileBytes(dbPath),
      walBytes: fileBytes(`${dbPath}-wal`),
      rssBytes: process.memoryUsage().rss,
      maxRssKiB: process.resourceUsage().maxRSS,
    });
    if (message.startsWith("PROFILE_INTENTIONAL_ABORT:")) {
      process.exitCode = 75;
      return;
    }
    throw error;
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main(process.argv.slice(2));
}
