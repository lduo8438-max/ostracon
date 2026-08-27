#!/usr/bin/env node

import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], flag: string): string {
  const value = valueAfter(args, flag);
  if (value === undefined) throw new Error(`缺少 ${flag}`);
  return value;
}

function absolute(args: string[], flag: string): string {
  return path.resolve(required(args, flag));
}

function appendJson(file: string, event: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function events(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8").trim().split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<void> {
  while (alive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

async function runProfile(
  args: string[],
  outputPath: string,
  statePath: string,
  phase: string,
): Promise<RunResult> {
  const output = createWriteStream(outputPath, { flags: "a" });
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    path.resolve("src/golden/profile-angular.ts"),
    ...args,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  appendJson(statePath, { event: "phase-started", phase, pid: child.pid });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  const result = await new Promise<RunResult>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  output.end();
  appendJson(statePath, { event: "phase-exited", phase, ...result });
  return result;
}

function launchDetached(args: string[], statePath: string, outputPath: string): void {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const output = openSync(outputPath, "a");
  const script = path.resolve("src/golden/profile-angular-supervisor.ts");
  const child = spawn("/usr/bin/caffeinate", [
    "-dimsu",
    process.execPath,
    "--experimental-strip-types",
    script,
    ...args.filter((arg) => arg !== "--detach"),
  ], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", output, output],
  });
  child.unref();
  appendJson(statePath, { event: "detached-launched", pid: child.pid });
}

function checkpoint(dbPath: string): Record<string, unknown> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const mark = db.prepare(
      `SELECT p.last_commit_id AS lastCommitId, c.sha AS sha, c.topo_order AS topoOrder,
              p.indexer_version AS indexerVersion
         FROM pass_state p
         LEFT JOIN git_commit c ON c.id = p.last_commit_id
        WHERE p.pass_name = 'declarations'`,
    ).get() as Record<string, unknown> | undefined;
    if (mark === undefined) throw new Error("刻意中斷後沒有 declarations 水位線");
    return mark;
  } finally {
    db.close();
  }
}

export async function main(args: string[]): Promise<void> {
  const statePath = absolute(args, "--state");
  if (args.includes("--detach")) {
    launchDetached(args, statePath, absolute(args, "--launcher-output"));
    return;
  }

  if (args.includes("--resume-main-only")) {
    const repo = absolute(args, "--repo");
    const mainDb = absolute(args, "--main-db");
    const mainLog = absolute(args, "--main-log");
    const mainOutput = absolute(args, "--main-output");
    appendJson(statePath, { event: "resume-supervisor-started", pid: process.pid });
    try {
      const mainResult = await runProfile([
        "--repo", repo,
        "--db", mainDb,
        "--log", mainLog,
        "--until", "HEAD",
        "--progress-every", "5000",
      ], mainOutput, statePath, "main-resume");
      if (mainResult.code !== 0) {
        throw new Error(`正式長跑續跑失敗：code=${mainResult.code} signal=${mainResult.signal}`);
      }
      appendJson(statePath, { event: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendJson(statePath, { event: "failed", phase: "main-resume", message });
      process.exitCode = 1;
    }
    return;
  }

  const waitPid = Number(required(args, "--wait-pid"));
  const repo = absolute(args, "--repo");
  const gateDb = absolute(args, "--gate-db");
  const gateLog = absolute(args, "--gate-log");
  const gateOutput = absolute(args, "--gate-output");
  const gateUntil = required(args, "--gate-until");
  const mainDb = absolute(args, "--main-db");
  const mainLog = absolute(args, "--main-log");
  const mainOutput = absolute(args, "--main-output");
  appendJson(statePath, { event: "supervisor-started", pid: process.pid, waitPid });

  try {
    await waitForExit(waitPid);
    const gateEvents = events(gateLog);
    const lastGate = gateEvents[gateEvents.length - 1];
    if (lastGate?.event !== "intentional-abort") {
      throw new Error(`第一段不是預期中斷，最後事件是 ${String(lastGate?.event)}`);
    }
    appendJson(statePath, {
      event: "intentional-abort-verified",
      checkpoint: checkpoint(gateDb),
    });

    const gateResult = await runProfile([
      "--repo", repo,
      "--db", gateDb,
      "--log", gateLog,
      "--until", gateUntil,
      "--progress-every", "5000",
    ], gateOutput, statePath, "gate-resume");
    if (gateResult.code !== 0) {
      throw new Error(`閘門續跑失敗：code=${gateResult.code} signal=${gateResult.signal}`);
    }
    const resumePass = events(gateLog)
      .filter((event) => event.event === "pass-complete")
      .at(-1);
    if (resumePass?.mode !== "incremental") {
      throw new Error(`閘門沒有走增量續跑：mode=${String(resumePass?.mode)}`);
    }
    appendJson(statePath, {
      event: "gate-passed",
      checkpoint: checkpoint(gateDb),
      commitsScanned: resumePass.commitsScanned,
      revisions: resumePass.revisions,
    });

    const mainResult = await runProfile([
      "--repo", repo,
      "--db", mainDb,
      "--log", mainLog,
      "--until", "HEAD",
      "--progress-every", "5000",
    ], mainOutput, statePath, "main");
    if (mainResult.code !== 0) {
      throw new Error(`正式長跑失敗：code=${mainResult.code} signal=${mainResult.signal}`);
    }
    appendJson(statePath, { event: "completed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendJson(statePath, { event: "failed", message });
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main(process.argv.slice(2));
}
