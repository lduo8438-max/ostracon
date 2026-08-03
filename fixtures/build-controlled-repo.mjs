#!/usr/bin/env node
/**
 * 建立可重現的微型 Git repo，專門控制真實歷史裡很難孤立的單一變因。
 *
 * commit identity、時間與檔案內容全部固定，所以 SHA 在任何機器上都相同。
 * 輸出目錄必須不存在或為空，避免覆蓋使用者資料。
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const target = process.argv.slice(2).find((arg) => arg !== "--");
if (!target) {
  console.error("用法：node fixtures/build-controlled-repo.mjs <output-directory>");
  process.exit(2);
}

const absolute = path.resolve(target);
if (existsSync(absolute) && readdirSync(absolute).length > 0) {
  console.error(`拒絕覆蓋非空目錄：${absolute}`);
  process.exit(2);
}
mkdirSync(absolute, { recursive: true });

const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Ostracon Fixtures",
  GIT_AUTHOR_EMAIL: "fixtures@ostracon.dev",
  GIT_COMMITTER_NAME: "Ostracon Fixtures",
  GIT_COMMITTER_EMAIL: "fixtures@ostracon.dev",
};

const git = (args, date) =>
  execFileSync("git", ["-C", absolute, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: date
      ? {
          ...identity,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        }
      : identity,
  }).trim();

const source = (name) => `export function ${name}(input: string): string {
  const trimmed = input.trim();
  const segments = trimmed.split(":");
  const normalized = segments
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length > 0);
  const unique = [...new Set(normalized)];
  const joined = unique.join("-");
  return joined.length > 0 ? joined : "unknown";
}
`;

const identicalClosures = (scopeLabels) => `"use client";

declare function useEffect(
  callback: () => void,
  dependencies: readonly string[],
): void;

export function Dashboard(): null {
${scopeLabels.map((label) => `  useEffect(() => {
    const poll = () => {
      const response = "ok";
      return response;
    };
    poll();
  }, ["${label}"]);
`).join("\n")}
  return null;
}
`;

const indistinguishableClosures = (count) =>
  identicalClosures(Array.from({ length: count }, () => "same"));

git(["init", "-q", "--initial-branch=main"]);
mkdirSync(path.join(absolute, "src"), { recursive: true });
writeFileSync(path.join(absolute, "src/account.ts"), source("formatAccount"));
git(["add", "-A"]);
git(["commit", "-q", "-m", "add account formatter"], "2026-01-01T00:00:00Z");
const before = git(["rev-parse", "HEAD"]);

writeFileSync(path.join(absolute, "src/account.ts"), source("serializeAccount"));
git(["add", "-A"]);
git(["commit", "-q", "-m", "rename formatter without changing body"], "2026-01-02T00:00:00Z");
const after = git(["rev-parse", "HEAD"]);

writeFileSync(
  path.join(absolute, "src/identical-closures.ts"),
  identicalClosures(["alpha", "beta", "gamma"]),
);
git(["add", "-A"]);
git(
  ["commit", "-q", "-m", "add three identical poll closures"],
  "2026-01-03T00:00:00Z",
);
const collisionBefore = git(["rev-parse", "HEAD"]);

writeFileSync(
  path.join(absolute, "src/identical-closures.ts"),
  identicalClosures(["inserted", "alpha", "beta", "gamma"]),
);
git(["add", "-A"]);
git(
  ["commit", "-q", "-m", "prepend an identical poll closure"],
  "2026-01-04T00:00:00Z",
);
const collisionAfter = git(["rev-parse", "HEAD"]);

writeFileSync(
  path.join(absolute, "src/ambiguous-closures.ts"),
  indistinguishableClosures(3),
);
git(["add", "-A"]);
git(
  ["commit", "-q", "-m", "add three indistinguishable poll scopes"],
  "2026-01-05T00:00:00Z",
);
const ambiguousBefore = git(["rev-parse", "HEAD"]);

writeFileSync(
  path.join(absolute, "src/ambiguous-closures.ts"),
  indistinguishableClosures(4),
);
git(["add", "-A"]);
git(
  ["commit", "-q", "-m", "add a fourth indistinguishable poll scope"],
  "2026-01-06T00:00:00Z",
);
const ambiguousAfter = git(["rev-parse", "HEAD"]);

console.log(
  JSON.stringify(
    {
      repo: absolute,
      before,
      after,
      collisionBefore,
      collisionAfter,
      ambiguousBefore,
      ambiguousAfter,
    },
    null,
    2,
  ),
);
