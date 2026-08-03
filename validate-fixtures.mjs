#!/usr/bin/env node
/**
 * validate-fixtures — 驗證黃金測試集本身
 *
 * 這不是跑索引器，而是確保 fixture 仍能由原生 Git 座標解析。
 * commit、path 或 snippet_head 失效都是硬錯誤，避免 runner 靜默跳過
 * 已漂移的案例，讓覆蓋率在沒人察覺時下降。
 *
 * 用法：
 *   node validate-fixtures.mjs <fixtures-dir> --repos name=path [name=path ...]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const args = process.argv.slice(2);
const dir = args[0];
if (!dir || dir.startsWith("--")) {
  console.error("用法: node validate-fixtures.mjs <fixtures-dir> --repos name=path [name=path ...]");
  process.exit(2);
}

const repos = new Map();
const reposFlag = args.indexOf("--repos");
if (reposFlag >= 0) {
  for (const kv of args.slice(reposFlag + 1)) {
    if (kv.startsWith("--")) break;
    const separator = kv.indexOf("=");
    if (separator <= 0 || separator === kv.length - 1) {
      console.error(`無效的 repo 對應：${kv}（格式應為 name=/path/to/repo）`);
      process.exit(2);
    }
    repos.set(kv.slice(0, separator), kv.slice(separator + 1));
  }
}

const KINDS = new Set([
  "lineage",
  "discontinuity",
  "change_level",
  "construct",
  "excursion",
  "evidence",
]);
const DIFFICULTY = new Set(["easy", "hard", "adversarial"]);
const CONFIDENCE = new Set(["certain", "probable", "ambiguous"]);
const CHANGE_LEVELS = new Set(["none", "raw", "token", "alpha", "shape", "birth", "death"]);
const TIERS = new Set(["L1", "L2", "L3", "L3b", "L3c", "L4", "L5"]);
const TRANSITIONS = new Set([
  "edit",
  "rename",
  "move",
  "move_rename",
  "move_rename_rewrite",
  "extract",
  "inline",
  "unrelated",
]);
const EVIDENCE_TIERS = new Set(["stated", "linked"]);
const FULL_SHA = /^[0-9a-f]{40}$/;

let errors = 0;
let warnings = 0;
let anchorsChecked = 0;
let entityRefsChecked = 0;
const commitCache = new Map();
const pathCache = new Map();

const err = (where, message) => {
  errors++;
  console.error(`  ✗ ${where}: ${message}`);
};
const warn = (where, message) => {
  warnings++;
  console.warn(`  ! ${where}: ${message}`);
};

function loadFixture(file) {
  const text = readFileSync(file, "utf8");
  return file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
}

function git(repoPath, ...gitArgs) {
  return execFileSync("git", ["-C", repoPath, ...gitArgs], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitSucceeds(repoPath, ...gitArgs) {
  return spawnSync("git", ["-C", repoPath, ...gitArgs], {
    stdio: "ignore",
  }).status === 0;
}

function verifyRepo(repoPath, where) {
  try {
    if (!statSync(repoPath).isDirectory()) {
      err(where, `repo 路徑不是目錄：${repoPath}`);
      return false;
    }
  } catch {
    err(where, `repo 路徑不存在：${repoPath}`);
    return false;
  }
  if (!gitSucceeds(repoPath, "rev-parse", "--git-dir")) {
    err(where, `不是有效的 Git repository：${repoPath}`);
    return false;
  }
  return true;
}

function checkCommit(repoPath, sha, where, field = "commit") {
  if (!FULL_SHA.test(sha ?? "")) {
    err(
      where,
      `${field} 必須是完整 40 字元 SHA，收到 ${JSON.stringify(sha)}（短碼在 repo 成長後會產生歧義）`,
    );
    return false;
  }

  const key = `${repoPath}\0${sha}`;
  if (!commitCache.has(key)) {
    commitCache.set(key, gitSucceeds(repoPath, "cat-file", "-e", `${sha}^{commit}`));
  }
  if (!commitCache.get(key)) {
    err(where, `${field} ${sha.slice(0, 10)} 不存在於此 repo（可能已被 force push）`);
    return false;
  }
  return true;
}

function checkWithinBoundary(repoPath, sha, indexUntil, where) {
  if (!FULL_SHA.test(sha ?? "") || !FULL_SHA.test(indexUntil ?? "")) return;
  if (!gitSucceeds(repoPath, "merge-base", "--is-ancestor", sha, indexUntil)) {
    err(where, `${sha.slice(0, 10)} 不在 repo.index_until ${indexUntil.slice(0, 10)} 的歷史範圍內`);
  }
}

function readPath(repoPath, sha, filePath) {
  const key = `${repoPath}\0${sha}\0${filePath}`;
  if (pathCache.has(key)) return pathCache.get(key);
  try {
    const content = git(repoPath, "show", `${sha}:${filePath}`);
    pathCache.set(key, content);
    return content;
  } catch {
    pathCache.set(key, null);
    return null;
  }
}

function checkPath(repoPath, sha, filePath, where) {
  if (!filePath || typeof filePath !== "string") {
    err(where, "缺少 path");
    return null;
  }
  if (!FULL_SHA.test(sha ?? "")) return null;
  const content = readPath(repoPath, sha, filePath);
  if (content === null) {
    err(where, `在 ${sha.slice(0, 10)} 找不到路徑 ${filePath}`);
  }
  return content;
}

function firstParent(repoPath, sha, where) {
  try {
    const parents = git(repoPath, "show", "-s", "--format=%P", sha).trim().split(/\s+/).filter(Boolean);
    if (!parents.length) {
      err(where, `${sha.slice(0, 10)} 沒有 parent，無法驗證 death 事件的前一版本`);
      return null;
    }
    return parents[0];
  } catch {
    return null;
  }
}

function checkEntity(entity, where) {
  if (!entity || typeof entity !== "object") {
    err(where, "entity 缺失或格式錯誤");
    return false;
  }
  if (!entity.path) err(where, "entity 缺少 path");
  if (!entity.symbol) err(where, "entity 缺少 symbol");
  return Boolean(entity.path && entity.symbol);
}

/**
 * 確認 (commit, path) 存在，且 snippet_head 仍出現在該版本檔案中。
 * snippet_head 不參與標註語意；它只負責偵測 fixture 漂移。
 */
function checkAnchor(repoPath, anchor, where, indexUntil) {
  if (!anchor || typeof anchor !== "object") {
    err(where, "anchor 缺失或格式錯誤");
    return;
  }
  for (const field of ["commit", "path", "symbol"]) {
    if (!anchor[field]) err(where, `anchor 缺少 ${field}`);
  }
  if (
    anchor.occurrence !== undefined
    && (!Number.isInteger(anchor.occurrence) || anchor.occurrence < 0)
  ) {
    err(where, "occurrence 必須是非負整數");
  }
  if (
    anchor.line_hint !== undefined
    && (!Number.isInteger(anchor.line_hint) || anchor.line_hint <= 0)
  ) {
    err(where, "line_hint 必須是正整數");
  }

  anchorsChecked++;
  if (!checkCommit(repoPath, anchor.commit, where)) return;
  checkWithinBoundary(repoPath, anchor.commit, indexUntil, where);
  const content = checkPath(repoPath, anchor.commit, anchor.path, where);
  if (content === null) return;

  if (!anchor.snippet_head) {
    warn(where, "anchor 沒有 snippet_head，內容漂移將無法被偵測");
    return;
  }
  if (!content.includes(anchor.snippet_head)) {
    err(
      where,
      `snippet_head 在該版本檔案中不存在 → fixture 已漂移\n      期望: ${JSON.stringify(anchor.snippet_head)}`,
    );
    return;
  }
  if (anchor.line_hint !== undefined) {
    const lines = content.split("\n");
    const expectedLine = lines[anchor.line_hint - 1];
    if (expectedLine === undefined || !expectedLine.includes(anchor.snippet_head.trim())) {
      const actualLine = lines.findIndex((line) => line.includes(anchor.snippet_head.trim())) + 1;
      warn(where, `line_hint ${anchor.line_hint} 已過時（實際在第 ${actualLine || "?"} 行）`);
    }
  }
}

function checkChainOrder(repoPath, chain, where) {
  for (let i = 1; i < chain.length; i++) {
    const previous = chain[i - 1]?.anchor?.commit;
    const current = chain[i]?.anchor?.commit;
    if (!FULL_SHA.test(previous ?? "") || !FULL_SHA.test(current ?? "")) continue;
    if (!gitSucceeds(repoPath, "merge-base", "--is-ancestor", previous, current)) {
      err(
        `${where}.chain[${i}]`,
        `${previous.slice(0, 10)} 不是 ${current.slice(0, 10)} 的祖先，chain 順序或分支可能寫錯`,
      );
    }
  }
}

function checkCommitField(repoPath, value, where, field, indexUntil) {
  if (checkCommit(repoPath, value, where, field)) {
    checkWithinBoundary(repoPath, value, indexUntil, where);
    return true;
  }
  return false;
}

/**
 * 驗證非 lineage 案例使用的純 Git 座標 (commit, path)。
 *
 * 刻意不驗 symbol 是否真的存在於檔案中：那需要語法解析，會讓 fixture
 * 驗證器與待測的 Ostracon parser 共用失敗模式。symbol 只驗欄位存在。
 *
 * death / remove 允許路徑在事件 commit 消失，但它必須存在於 first parent；
 * 若兩邊都沒有，便是拼錯路徑或偽造的 death，不可靜默放行。
 */
function checkEntityRef(
  repoPath,
  ref,
  commit,
  where,
  indexUntil,
  { allowMissing = false, commitField = "commit" } = {},
) {
  if (!ref || typeof ref !== "object") {
    err(where, "entity 參照缺失或格式錯誤");
    return;
  }
  if (!ref.path) {
    err(where, "缺少 path");
    return;
  }
  if (!ref.symbol) err(where, "缺少 symbol");

  entityRefsChecked++;
  if (!checkCommitField(repoPath, commit, where, commitField, indexUntil)) return;
  if (readPath(repoPath, commit, ref.path) !== null) return;

  if (!allowMissing) {
    err(where, `在 ${commit.slice(0, 10)} 找不到路徑 ${ref.path}`);
    return;
  }

  const parent = firstParent(repoPath, commit, where);
  if (!parent) return;
  if (readPath(repoPath, parent, ref.path) !== null) return;
  err(
    where,
    `路徑 ${ref.path} 在 ${commit.slice(0, 10)} 與其父 commit ${parent.slice(0, 10)} 皆不存在`,
  );
}

function checkEntityAt(repoPath, entity, sha, where) {
  if (!checkEntity(entity, where)) return;
  checkPath(repoPath, sha, entity.path, where);
}

function validateCase(c, context) {
  const { repoPath, file, index, indexUntil } = context;
  const where = `${path.basename(file)}[${c?.id ?? `#${index}`}]`;
  if (!c || typeof c !== "object") {
    err(where, "case 必須是 object");
    return;
  }
  if (!c.id || typeof c.id !== "string") err(where, "缺少 id");
  if (!KINDS.has(c.kind)) {
    err(where, `未知的 kind: ${c.kind}`);
    return;
  }
  if (!DIFFICULTY.has(c.difficulty)) {
    err(where, "difficulty 必須是 easy|hard|adversarial");
  }
  if (c.label_confidence && !CONFIDENCE.has(c.label_confidence)) {
    err(where, "label_confidence 必須是 certain|probable|ambiguous");
  }
  if (typeof c.rationale !== "string" || c.rationale.trim().length < 10) {
    err(where, "缺少 rationale。六週後需要靠它重新裁決標註");
  }

  switch (c.kind) {
    case "lineage": {
      const lineageExpectation = c.expect ?? "present";
      if (!["present", "absent"].includes(lineageExpectation)) {
        err(where, "lineage.expect 必須是 present|absent");
      }
      const chains = c.label_confidence === "ambiguous"
        ? (c.accept_any_of ?? []).map((option) => option?.chain)
        : [c.chain];
      if (!chains.length || chains.some((chain) => !Array.isArray(chain) || chain.length < 2)) {
        err(where, "lineage 的 chain 至少要有兩個 anchor");
        return;
      }
      for (const chain of chains) {
        chain.forEach((step, i) => {
          checkAnchor(repoPath, step?.anchor, `${where}.chain[${i}]`, indexUntil);
          if (i === 0) {
            if (step?.transition) err(`${where}.chain[${i}]`, "chain 第一項不應有 transition");
            return;
          }
          if (!step?.transition) {
            err(`${where}.chain[${i}]`, "缺少 transition");
            return;
          }
          if (!TRANSITIONS.has(step.transition.type)) {
            err(`${where}.chain[${i}]`, `未知 transition.type: ${step.transition.type}`);
          }
          if (lineageExpectation === "absent") {
            if (step.transition.type !== "unrelated") {
              err(`${where}.chain[${i}]`, "expect=absent 的 transition.type 必須是 unrelated");
            }
            if (step.transition.expect_tier_at_most !== undefined) {
              err(`${where}.chain[${i}]`, "expect=absent 不可設定 expect_tier_at_most");
            }
          } else if (step.transition.type === "unrelated") {
            err(`${where}.chain[${i}]`, "expect=present 不可使用 unrelated transition");
          } else if (!TIERS.has(step.transition.expect_tier_at_most)) {
            err(
              `${where}.chain[${i}]`,
              `expect_tier_at_most 必須是 L1|L2|L3|L3b|L3c|L4|L5，收到 ${step.transition.expect_tier_at_most}`,
            );
          }
        });
        checkChainOrder(repoPath, chain, where);
      }
      break;
    }

    case "discontinuity": {
      if (!["present", "absent"].includes(c.expect)) {
        err(where, "expect 必須是 present|absent");
      }
      checkEntityRef(repoPath, c.slot, c.at_commit, where, indexUntil, {
        commitField: "at_commit",
      });
      break;
    }

    case "change_level": {
      if (!CHANGE_LEVELS.has(c.expect)) err(where, `未知 change_level: ${c.expect}`);
      checkEntityRef(repoPath, c.entity, c.at_commit, where, indexUntil, {
        allowMissing: c.expect === "death",
        commitField: "at_commit",
      });
      break;
    }

    case "construct": {
      if (!c.expect?.born_at) {
        err(where, "缺少 expect.born_at");
        break;
      }
      checkEntityRef(repoPath, c.entity, c.expect.born_at, `${where}.born_at`, indexUntil, {
        commitField: "expect.born_at",
      });
      if (c.expect.died_at) {
        checkEntityRef(repoPath, c.entity, c.expect.died_at, `${where}.died_at`, indexUntil, {
          allowMissing: true,
          commitField: "expect.died_at",
        });
      }
      break;
    }

    case "excursion": {
      if (!["present", "absent"].includes(c.expect)) {
        err(where, "expect 必須是 present|absent");
      }
      if (c.expect === "present") {
        if (!c.introduce_at || !c.remove_at) {
          err(where, "expect=present 時必須有 introduce_at 與 remove_at");
          break;
        }
        checkEntityRef(
          repoPath,
          c.entity,
          c.introduce_at,
          `${where}.introduce_at`,
          indexUntil,
          { commitField: "introduce_at" },
        );
        checkEntityRef(
          repoPath,
          c.entity,
          c.remove_at,
          `${where}.remove_at`,
          indexUntil,
          { allowMissing: true, commitField: "remove_at" },
        );
        if (!["A", "B", "C"].includes(c.expect_strength_at_least)) {
          err(where, "expect_strength_at_least 必須是 A|B|C");
        }
      } else {
        checkEntity(c.entity, where);
      }
      break;
    }

    case "evidence": {
      const commitOk = checkCommitField(repoPath, c.at_commit, where, "at_commit", indexUntil);
      if (commitOk) checkEntityAt(repoPath, c.entity, c.at_commit, where);
      if (!Array.isArray(c.expect_spans) || !c.expect_spans.length) {
        err(where, "缺少 expect_spans");
        break;
      }
      c.expect_spans.forEach((span, i) => {
        const spanWhere = `${where}.expect_spans[${i}]`;
        if (!span?.source?.type || !span?.source?.external_id) {
          err(spanWhere, "缺少 source.type / source.external_id");
        }
        if (!span?.contains || typeof span.contains !== "string") {
          err(spanWhere, "缺少 contains");
        }
        if (!EVIDENCE_TIERS.has(span?.tier)) {
          err(spanWhere, "tier 必須是 stated|linked");
        }
      });
      break;
    }
  }
}

function countPolarity(c, stats) {
  if (c.kind === "lineage") {
    if (c.expect === "absent") stats.negatives++;
    else stats.positives++;
    return;
  }
  if (["discontinuity", "excursion"].includes(c.kind)) {
    if (c.expect === "absent") stats.negatives++;
    if (c.expect === "present") stats.positives++;
    return;
  }
  if (c.kind === "construct") stats.positives++;
}

let files;
try {
  files = readdirSync(dir).filter((file) => /\.(ya?ml|json)$/.test(file)).sort();
} catch (error) {
  console.error(`無法讀取 fixtures 目錄 ${dir}: ${error.message}`);
  process.exit(2);
}
if (!files.length) {
  console.error(`${dir} 底下沒有 fixture 檔`);
  process.exit(2);
}

const stats = {
  total: 0,
  byKind: {},
  byDifficulty: {},
  negatives: 0,
  positives: 0,
};

for (const fixtureName of files) {
  const file = path.join(dir, fixtureName);
  console.log(`\n${file}`);
  let fixture;
  try {
    fixture = loadFixture(file);
  } catch (error) {
    err(fixtureName, `無法解析：${error.message}`);
    continue;
  }
  if (!fixture || typeof fixture !== "object") {
    err(fixtureName, "fixture 頂層必須是 object");
    continue;
  }
  if (fixture.fixture_version !== 1) {
    err(fixtureName, `fixture_version 必須是 1，收到 ${fixture.fixture_version}`);
  }

  const repoName = fixture.repo?.name;
  const repoPath = repos.get(repoName);
  if (!repoPath) {
    err(
      fixtureName,
      `未提供 repo ${JSON.stringify(repoName)} 的本地路徑（用 --repos ${repoName}=/path/to/repo）`,
    );
    continue;
  }
  if (!verifyRepo(repoPath, fixtureName)) continue;

  const indexUntil = fixture.repo?.index_until;
  checkCommit(repoPath, indexUntil, fixtureName, "repo.index_until");
  if (!Array.isArray(fixture.cases) || !fixture.cases.length) {
    err(fixtureName, "cases 必須是非空陣列");
    continue;
  }

  const ids = new Set();
  fixture.cases.forEach((c, index) => {
    stats.total++;
    stats.byKind[c?.kind] = (stats.byKind[c?.kind] ?? 0) + 1;
    stats.byDifficulty[c?.difficulty] = (stats.byDifficulty[c?.difficulty] ?? 0) + 1;
    countPolarity(c ?? {}, stats);
    if (c?.id && ids.has(c.id)) err(`${fixtureName}[${c.id}]`, "id 重複");
    if (c?.id) ids.add(c.id);
    validateCase(c, { repoPath, file, index, indexUntil });
  });
}

console.log(`\n${"-".repeat(60)}`);
console.log(`案例 ${stats.total} 條，錨點 ${anchorsChecked} 個`);
console.log(`  已驗證 entity 參照: ${entityRefsChecked}`);
console.log(`  依類型: ${JSON.stringify(stats.byKind)}`);
console.log(`  依難度: ${JSON.stringify(stats.byDifficulty)}`);
console.log(`  負例 ${stats.negatives} / 正例 ${stats.positives}`);

if (stats.negatives < stats.positives * 0.5) {
  warn(
    "coverage",
    `負例少於正例的一半。只標「應連起來」會養出過度連線的匹配器；精確率退步只能由負例測出`,
  );
}

console.log(`\n錯誤 ${errors}，警告 ${warnings}`);
process.exit(errors ? 1 : 0);
