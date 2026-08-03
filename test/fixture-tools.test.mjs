import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as toYaml } from "yaml";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const miner = path.join(projectRoot, "mine-candidates.mjs");
const validator = path.join(projectRoot, "validate-fixtures.mjs");
const temporaryRoots = [];

function command(cwd, executable, args) {
  return execFileSync(executable, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(repo, ...args) {
  return command(repo, "git", args);
}

function write(repo, relativePath, content) {
  const target = path.join(repo, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commitAll(repo, message) {
  git(repo, "add", "-A");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-fixture-tools-"));
  temporaryRoots.push(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Ostracon Tests");
  git(repo, "config", "user.email", "tests@ostracon.org");
  return repo;
}

function validate(fixtures, repo) {
  return spawnSync(
    process.execPath,
    [validator, fixtures, "--repos", `testrepo=${repo}`],
    { encoding: "utf8" },
  );
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("TEMPLATE.yaml contains all six case types and three negative slots", () => {
  const template = readFileSync(path.join(projectRoot, "TEMPLATE.yaml"), "utf8");
  const parsed = parseYaml(template);
  const kinds = parsed.cases.map((fixtureCase) => fixtureCase.kind);
  assert.deepEqual(
    new Set(kinds),
    new Set(["lineage", "discontinuity", "change_level", "construct", "excursion", "evidence"]),
  );
  assert.equal(parsed.cases.filter((fixtureCase) => fixtureCase.expect === "absent").length, 3);
});

test("mine-candidates ranks renames and detects whitespace collapse", () => {
  const repo = makeRepo();
  const original = Array.from(
    { length: 35 },
    (_, i) => `export const value${i} = ${i};`,
  ).join("\n");
  const pureRenameSource = Array.from(
    { length: 35 },
    (_, i) => `export function pure${i}() { return ${i}; }`,
  ).join("\n");
  write(repo, "src/old-name.ts", `${original}\n`);
  write(repo, "src/pure-old.ts", `${pureRenameSource}\n`);
  write(repo, "src/format-me.ts", `${original}\n`);
  commitAll(repo, "initial source");

  git(repo, "mv", "src/old-name.ts", "src/new-name.ts");
  git(repo, "mv", "src/pure-old.ts", "src/pure-new.ts");
  const rewritten = Array.from(
    { length: 35 },
    (_, i) => i < 9 ? `export const changed${i} = ${i * 2};` : `export const value${i} = ${i};`,
  ).join("\n");
  write(repo, "src/new-name.ts", `${rewritten}\n`);
  commitAll(repo, "move and rewrite source");

  const formatted = original
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  write(repo, "src/format-me.ts", `${formatted}\n`);
  write(repo, "src/new-name.ts", `${rewritten.split("\n").map((line) => `    ${line}`).join("\n")}\n`);
  commitAll(repo, "indent source");

  const result = spawnSync(
    process.execPath,
    [miner, repo, "--limit", "20", "--min-lines", "20"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /改名與搬檔（依相似度由低到高）/);
  assert.match(result.stdout, /R\s*\d+ .*候選/);
  assert.match(result.stdout, /old-name\.ts\s+→\s+src\/new-name\.ts/);
  assert.match(result.stdout, /pure-old\.ts\s+→\s+src\/pure-new\.ts/);
  const renameScores = [...result.stdout.matchAll(/^\s+R\s*(\d+)\s+\[/gm)]
    .map((match) => Number(match[1]));
  assert.ok(renameScores.length >= 2);
  assert.ok(renameScores.some((score) => score < 100));
  assert.equal(renameScores.at(-1), 100);
  assert.deepEqual(renameScores, [...renameScores].sort((a, b) => a - b));
  assert.match(result.stdout, /塌縮 100%/);
  assert.match(result.stdout, /只提供「該去哪裡找」，不提供任何標註建議/);
});

test("mine-candidates fails clearly for a non-repository", () => {
  const notRepo = mkdtempSync(path.join(tmpdir(), "ostracon-not-repo-"));
  temporaryRoots.push(notRepo);
  const result = spawnSync(process.execPath, [miner, notRepo], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不是有效的 Git worktree/);
});

test("validate-fixtures accepts valid YAML and rejects a drifting snippet", () => {
  const repo = makeRepo();
  write(
    repo,
    "src/example.ts",
    "export function alpha(value: number) {\n  return value + 1;\n}\n",
  );
  const first = commitAll(repo, "add alpha");
  write(
    repo,
    "src/example.ts",
    "export function beta(value: number) {\n  return value + 2;\n}\n",
  );
  const second = commitAll(repo, "rename alpha to beta");

  const fixtures = mkdtempSync(path.join(tmpdir(), "ostracon-fixtures-"));
  temporaryRoots.push(fixtures);
  const fixturePath = path.join(fixtures, "testrepo.yaml");
  const fixture = {
    fixture_version: 1,
    repo: {
      name: "testrepo",
      clone_url: "https://github.com/<org>/<repo>.git",
      index_until: second,
      language: "typescript",
    },
    labeled_by: "test",
    labeled_at: "2026-07-26",
    cases: [
      {
        id: "lin-001",
        kind: "lineage",
        difficulty: "hard",
        label_confidence: "certain",
        rationale: "The function keeps the same responsibility across a direct rename.",
        chain: [
          {
            anchor: {
              commit: first,
              path: "src/example.ts",
              symbol: "alpha",
              occurrence: 0,
              line_hint: 1,
              snippet_head: "export function alpha(value: number) {",
            },
          },
          {
            anchor: {
              commit: second,
              path: "src/example.ts",
              symbol: "beta",
              occurrence: 0,
              line_hint: 1,
              snippet_head: "export function beta(value: number) {",
            },
            transition: {
              type: "rename",
              expect_tier_at_most: "L4",
            },
          },
        ],
      },
      {
        id: "dis-001",
        kind: "discontinuity",
        difficulty: "adversarial",
        expect: "absent",
        slot: { path: "src/example.ts", symbol: "beta" },
        at_commit: second,
        rationale: "This is a large edit but remains a continuous implementation.",
      },
    ],
  };
  writeFileSync(fixturePath, toYaml(fixture));

  const valid = validate(fixtures, repo);
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
  assert.match(valid.stdout, /案例 2 條，錨點 2 個/);
  assert.match(valid.stdout, /負例 1 \/ 正例 1/);
  assert.match(valid.stdout, /錯誤 0，警告 0/);

  const drifted = readFileSync(fixturePath, "utf8").replace(
    "export function beta(value: number) {",
    "export function missing(value: number) {",
  );
  writeFileSync(fixturePath, drifted);
  const invalid = validate(fixtures, repo);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /testrepo\.yaml\[lin-001\]\.chain\[1\]: snippet_head/);
  assert.match(invalid.stderr, /fixture 已漂移/);

  const badPath = structuredClone(fixture);
  badPath.cases[0].chain[1].anchor.path = "src/typo.ts";
  writeFileSync(fixturePath, toYaml(badPath));
  const missingPath = validate(fixtures, repo);
  assert.equal(missingPath.status, 1);
  assert.match(missingPath.stderr, /找不到路徑 src\/typo\.ts/);

  const missingCommitFixture = structuredClone(fixture);
  missingCommitFixture.cases[0].chain[0].anchor.commit = "0".repeat(40);
  writeFileSync(fixturePath, toYaml(missingCommitFixture));
  const missingCommit = validate(fixtures, repo);
  assert.equal(missingCommit.status, 1);
  assert.match(missingCommit.stderr, /不存在於此 repo（可能已被 force push）/);
});

test("validate-fixtures protects entity refs and distinguishes real from fake death", () => {
  const repo = makeRepo();
  write(repo, "src/lifecycle.ts", "export function lifecycle() { return 1; }\n");
  const born = commitAll(repo, "add lifecycle");
  write(repo, "src/lifecycle.ts", "export function lifecycle() { return 2; }\n");
  const alive = commitAll(repo, "edit lifecycle");
  rmSync(path.join(repo, "src/lifecycle.ts"));
  const died = commitAll(repo, "remove lifecycle");

  const fixtures = mkdtempSync(path.join(tmpdir(), "ostracon-entity-refs-"));
  temporaryRoots.push(fixtures);
  const fixturePath = path.join(fixtures, "testrepo.yaml");
  const fixture = {
    fixture_version: 1,
    repo: {
      name: "testrepo",
      clone_url: "https://github.com/<org>/<repo>.git",
      index_until: died,
      language: "typescript",
    },
    labeled_by: "test",
    labeled_at: "2026-07-26",
    cases: [
      {
        id: "dis-entity-ref",
        kind: "discontinuity",
        difficulty: "easy",
        slot: { path: "src/lifecycle.ts", symbol: "lifecycle" },
        at_commit: alive,
        expect: "present",
        rationale: "The slot exists at the commit used to evaluate the discontinuity.",
      },
      {
        id: "chg-real-death",
        kind: "change_level",
        difficulty: "easy",
        entity: { path: "src/lifecycle.ts", symbol: "lifecycle" },
        at_commit: died,
        expect: "death",
        rationale: "The file is absent at this commit but exists in its first parent.",
      },
      {
        id: "con-lifecycle",
        kind: "construct",
        difficulty: "easy",
        entity: { path: "src/lifecycle.ts", symbol: "lifecycle" },
        expect: { born_at: born, died_at: died },
        rationale: "The construct is introduced with the file and removed with the file.",
      },
      {
        id: "exc-lifecycle",
        kind: "excursion",
        difficulty: "easy",
        entity: { path: "src/lifecycle.ts", symbol: "lifecycle" },
        expect: "present",
        introduce_at: born,
        remove_at: died,
        expect_strength_at_least: "A",
        rationale: "The implementation is introduced and then explicitly removed.",
      },
    ],
  };
  writeFileSync(fixturePath, toYaml(fixture));

  const valid = validate(fixtures, repo);
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
  assert.match(valid.stdout, /已驗證 entity 參照: 6/);

  for (const caseId of [
    "dis-entity-ref",
    "chg-real-death",
    "con-lifecycle",
    "exc-lifecycle",
  ]) {
    const typo = structuredClone(fixture);
    const fixtureCase = typo.cases.find((candidate) => candidate.id === caseId);
    const ref = fixtureCase.slot ?? fixtureCase.entity;
    ref.path = "src/typo.ts";
    writeFileSync(fixturePath, toYaml(typo));

    const invalid = validate(fixtures, repo);
    assert.equal(invalid.status, 1, `${caseId}\n${invalid.stdout}\n${invalid.stderr}`);
    assert.match(invalid.stderr, /src\/typo\.ts/);
    if (caseId === "chg-real-death") {
      assert.match(invalid.stderr, /與其父 commit .*皆不存在/);
    }
  }
});

test("validate-fixtures warns when negatives are less than half of positives", () => {
  const repo = makeRepo();
  write(repo, "src/example.ts", "export function alpha() { return 1; }\n");
  const first = commitAll(repo, "add alpha");
  write(repo, "src/example.ts", "export function beta() { return 1; }\n");
  const second = commitAll(repo, "rename alpha");

  const fixtures = mkdtempSync(path.join(tmpdir(), "ostracon-fixtures-"));
  temporaryRoots.push(fixtures);
  const fixture = {
    fixture_version: 1,
    repo: {
      name: "testrepo",
      clone_url: "https://github.com/<org>/<repo>.git",
      index_until: second,
      language: "typescript",
    },
    labeled_by: "test",
    labeled_at: "2026-07-26",
    cases: [
      {
        id: "lin-001",
        kind: "lineage",
        difficulty: "easy",
        label_confidence: "certain",
        rationale: "The implementation is unchanged while the symbol is renamed.",
        chain: [
          {
            anchor: {
              commit: first,
              path: "src/example.ts",
              symbol: "alpha",
              snippet_head: "export function alpha()",
            },
          },
          {
            anchor: {
              commit: second,
              path: "src/example.ts",
              symbol: "beta",
              snippet_head: "export function beta()",
            },
            transition: { type: "rename", expect_tier_at_most: "L2" },
          },
        ],
      },
    ],
  };
  writeFileSync(path.join(fixtures, "testrepo.yaml"), toYaml(fixture));
  const result = validate(fixtures, repo);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /負例 0 \/ 正例 1/);
  assert.match(result.stderr, /coverage: 負例少於正例的一半/);
  assert.match(result.stdout, /錯誤 0，警告 1/);
});
