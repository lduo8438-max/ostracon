#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml } from "yaml";
import { evaluateFixtureCases } from "./evaluate.ts";
import {
  buildGoldenReport,
  exitCodeForReport,
  formatGoldenReport,
  type BaselineReport,
} from "./report.ts";

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const fixturePath = valueAfter(args, "--fixture") ?? "fixtures/osiris.yaml";
const dbPath = valueAfter(args, "--db") ?? ".ostracon/index.db";
const baselinePath = valueAfter(args, "--baseline");
const reportPath = valueAfter(args, "--report");

if (!existsSync(dbPath)) {
  console.error(`找不到資料庫：${dbPath}`);
  process.exit(2);
}

const fixture = parseYaml(readFileSync(fixturePath, "utf8")) as {
  cases?: Parameters<typeof evaluateFixtureCases>[1];
};
if (!Array.isArray(fixture.cases)) {
  console.error(`fixture 沒有 cases：${fixturePath}`);
  process.exit(2);
}

let baseline: BaselineReport | undefined;
if (baselinePath) {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineReport;
}

const db = new DatabaseSync(dbPath, { readOnly: true });
let report;
try {
  report = buildGoldenReport(evaluateFixtureCases(db, fixture.cases), baseline);
} finally {
  db.close();
}

console.log(formatGoldenReport(report));
if (reportPath) {
  writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
}
process.exitCode = exitCodeForReport(report);
