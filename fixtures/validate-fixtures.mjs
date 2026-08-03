#!/usr/bin/env node
/**
 * validate-fixtures — 驗證黃金測試集本身
 *
 * 這不是跑測試，是檢查測試集有沒有爛掉。
 *
 * 黃金測試集最常見的死法是無聲腐爛：repo 被 force push、路徑寫錯一個字、
 * snippet_head 跟實際內容對不上，於是 runner 靜默跳過那條案例，
 * 指標看起來一切正常，實際上覆蓋率正在下降。
 *
 * 所以錨點解析失敗必須是硬錯誤，不是警告。
 *
 * 用法：
 *   node validate-fixtures.mjs <fixtures-dir> --repos <name>=<path> [...]
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const args = process.argv.slice(2);
const dir = args[0];
if (!dir) {
  console.error("用法: node validate-fixtures.mjs <fixtures-dir> --repos name=path [name=path ...]");
  process.exit(2);
}

const repos = new Map();
{
  const i = args.indexOf("--repos");
  if (i >= 0) {
    for (const kv of args.slice(i + 1)) {
      if (kv.startsWith("--")) break;
      const [n, ...p] = kv.split("=");
      repos.set(n, p.join("="));
    }
  }
}

const KINDS = new Set(["lineage", "discontinuity", "change_level", "construct", "excursion", "evidence"]);
const DIFFICULTY = new Set(["easy", "hard", "adversarial"]);
const CONFIDENCE = new Set(["certain", "probable", "ambiguous"]);
const CHANGE_LEVELS = new Set(["none", "raw", "token", "alpha", "shape", "birth", "death"]);
const TIERS = new Set(["L1", "L2", "L3", "L3b", "L3c", "L4", "L5"]);

let errors = 0;
let warnings = 0;
let anchorsChecked = 0;

const err = (where, msg) => { errors++; console.error(`  ✗ ${where}: ${msg}`); };
const warn = (where, msg) => { warnings++; console.warn(`  ! ${where}: ${msg}`); };

function loadFixture(file) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".json")) return JSON.parse(text);
  return parseYaml(text);
}

function git(repo, ...a) {
  return execFileSync("git", ["-C", repo, ...a], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * 錨點解析：確認 (commit, path) 存在，且 snippet_head 確實出現在該檔案中。
 *
 * snippet_head 不參與比對語意，它的唯一作用就是這個——當它對不上時，
 * 代表 fixture 或 repo 有一方漂移了，必須有人來看，不能靜默通過。
 */
function checkAnchor(repoPath, a, where) {
  if (!a || typeof a !== "object") return err(where, "anchor 缺失或格式錯誤");
  for (const f of ["commit", "path", "symbol"]) {
    if (!a[f]) return err(where, `anchor 缺少 ${f}`);
  }
  if (!/^[0-9a-f]{40}$/.test(a.commit)) {
    err(where, `commit 必須是完整 40 字元 SHA，收到 "${a.commit}"（短碼在 repo 成長後會產生歧義）`);
  }
  anchorsChecked++;

  let content;
  try {
    content = git(repoPath, "show", `${a.commit}:${a.path}`);
  } catch {
    return err(where, `在 ${a.commit.slice(0, 10)} 找不到路徑 ${a.path}`);
  }

  if (a.snippet_head) {
    if (!content.includes(a.snippet_head)) {
      return err(where, `snippet_head 在該版本檔案中不存在 → fixture 已漂移\n      期望: ${JSON.stringify(a.snippet_head)}`);
    }
    if (a.line_hint) {
      const lines = content.split("\n");
      const actual = lines[a.line_hint - 1];
      if (actual === undefined || !actual.includes(a.snippet_head.trim())) {
        const found = lines.findIndex((l) => l.includes(a.snippet_head.trim())) + 1;
        warn(where, `line_hint ${a.line_hint} 已過時（實際在第 ${found || "?"} 行）`);
      }
    }
  } else {
    warn(where, "anchor 沒有 snippet_head，漂移將無法被偵測");
  }
}

/**
 * entity 參照解析：change_level / discontinuity / construct / excursion 用的是
 * {path, symbol} + commit，不是 anchor。它們一樣會漂移，一樣必須驗。
 *
 * 這裡刻意不驗 symbol 是否存在於檔案中——那需要語法解析，而驗證器不該
 * 依賴 Ostracon 的解析器（否則解析器壞掉時驗證器會跟著一起錯）。
 * 只驗 (commit, path) 這組 git 原生座標，這是純 git 就能確定的部分。
 */
function checkEntityRef(repoPath, ref, commit, where, opts = {}) {
  if (!commit) return err(where, "缺少 commit");
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    err(where, `commit 必須是完整 40 字元 SHA，收到 "${commit}"`);
  }
  if (!ref?.path) return err(where, "缺少 path");
  anchorsChecked++;

  const exists = (sha) => {
    try { git(repoPath, "cat-file", "-e", `${sha}:${ref.path}`); return true; }
    catch { return false; }
  };

  const here = exists(commit);
  if (here) return;

  // death 是唯一合法的「此 commit 下路徑不存在」——但父版本必須存在，
  // 否則就只是路徑寫錯而已。
  if (opts.allowMissing) {
    let parent;
    try { parent = git(repoPath, "rev-parse", `${commit}^`).trim(); } catch { parent = null; }
    if (parent && exists(parent)) return;
    return err(where, `路徑 ${ref.path} 在 ${commit.slice(0, 10)} 與其父 commit 皆不存在`);
  }
  err(where, `在 ${commit.slice(0, 10)} 找不到路徑 ${ref.path}`);
}

function commitOrder(repoPath, shas, where) {
  const times = [];
  for (const s of shas) {
    try {
      times.push(Number(git(repoPath, "show", "-s", "--format=%ct", s).trim()));
    } catch {
      return err(where, `commit ${s.slice(0, 10)} 不存在於此 repo`);
    }
  }
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) {
      warn(where, `chain 第 ${i + 1} 項的時間早於前一項——順序可能寫反了`);
    }
  }
}

function validateCase(c, repoPath, file, idx) {
  const where = `${path.basename(file)}[${c.id ?? `#${idx}`}]`;
  if (!c.id) err(where, "缺少 id");
  if (!KINDS.has(c.kind)) return err(where, `未知的 kind: ${c.kind}`);
  if (!DIFFICULTY.has(c.difficulty)) err(where, `difficulty 必須是 easy|hard|adversarial`);
  if (c.label_confidence && !CONFIDENCE.has(c.label_confidence)) {
    err(where, "label_confidence 必須是 certain|probable|ambiguous");
  }
  if (!c.rationale || c.rationale.trim().length < 10) {
    err(where, "缺少 rationale。六週後你不會記得為什麼這樣標，而屆時系統若不同意，你需要重新裁決");
  }

  switch (c.kind) {
    case "lineage": {
      const lineageExpectation = c.expect ?? "present";
      if (!["present", "absent"].includes(lineageExpectation)) {
        err(where, "lineage.expect 必須是 present|absent");
      }
      const chains = c.label_confidence === "ambiguous"
        ? (c.accept_any_of ?? []).map((o) => o.chain)
        : [c.chain];
      if (!chains.length || chains.some((ch) => !Array.isArray(ch) || ch.length < 2)) {
        return err(where, "lineage 的 chain 至少要有兩個 anchor");
      }
      for (const ch of chains) {
        ch.forEach((step, i) => checkAnchor(repoPath, step.anchor, `${where}.chain[${i}]`));
        ch.forEach((step, i) => {
          if (i === 0) {
            if (step.transition) err(where, "chain 第一項不應有 transition");
            return;
          }
          if (!step.transition) return err(`${where}.chain[${i}]`, "缺少 transition");
          const t = step.transition.expect_tier_at_most;
          if (lineageExpectation === "absent") {
            if (step.transition.type !== "unrelated") {
              err(`${where}.chain[${i}]`, "expect=absent 的 transition.type 必須是 unrelated");
            }
            if (t !== undefined) {
              err(`${where}.chain[${i}]`, "expect=absent 不可設定 expect_tier_at_most");
            }
          } else if (!TIERS.has(t)) {
            err(`${where}.chain[${i}]`, `未知 tier: ${t}`);
          }
        });
        commitOrder(repoPath, ch.map((s) => s.anchor?.commit).filter(Boolean), where);
      }
      break;
    }
    case "discontinuity":
      if (!["present", "absent"].includes(c.expect)) err(where, "expect 必須是 present|absent");
      if (!c.slot?.symbol) err(where, "缺少 slot.symbol");
      checkEntityRef(repoPath, c.slot, c.at_commit, where);
      break;
    case "change_level":
      if (!CHANGE_LEVELS.has(c.expect)) err(where, `未知 change_level: ${c.expect}`);
      if (!c.entity?.symbol) err(where, "缺少 entity.symbol");
      checkEntityRef(repoPath, c.entity, c.at_commit, where,
                     { allowMissing: c.expect === "death" });
      break;
    case "construct":
      if (!c.expect?.born_at) err(where, "缺少 expect.born_at");
      checkEntityRef(repoPath, c.entity, c.expect?.born_at, `${where}.born_at`);
      if (c.expect?.died_at) {
        checkEntityRef(repoPath, c.entity, c.expect.died_at, `${where}.died_at`,
                       { allowMissing: true });
      }
      break;
    case "excursion":
      if (!["present", "absent"].includes(c.expect)) err(where, "expect 必須是 present|absent");
      if (c.expect === "present" && !c.introduce_at) err(where, "expect=present 時必須有 introduce_at");
      if (c.introduce_at) checkEntityRef(repoPath, c.entity, c.introduce_at, `${where}.introduce_at`);
      if (c.remove_at) {
        checkEntityRef(repoPath, c.entity, c.remove_at, `${where}.remove_at`, { allowMissing: true });
      }
      break;
    case "evidence":
      if (!Array.isArray(c.expect_spans) || !c.expect_spans.length) {
        err(where, "缺少 expect_spans");
      }
      break;
  }
}

// --- 主流程 -----------------------------------------------------------------
const files = readdirSync(dir).filter((f) => /\.(ya?ml|json)$/.test(f));
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

function countPolarity(c) {
  if (c.kind === "lineage") {
    if (c.expect === "absent") stats.negatives++;
    else stats.positives++;
  } else if (["discontinuity", "excursion"].includes(c.kind)) {
    if (c.expect === "absent") stats.negatives++;
    if (c.expect === "present") stats.positives++;
  } else if (c.kind === "construct") {
    stats.positives++;
  }
}

for (const f of files) {
  const file = path.join(dir, f);
  console.log(`\n${file}`);
  let fx;
  try { fx = loadFixture(file); } catch (e) { err(f, e.message); continue; }

  const repoName = fx.repo?.name;
  const repoPath = repos.get(repoName);
  if (!repoPath) {
    err(f, `未提供 repo "${repoName}" 的本地路徑（用 --repos ${repoName}=/path/to/repo）`);
    continue;
  }
  if (!fx.repo?.index_until) {
    err(f, "repo.index_until 未設定——沒有釘死索引邊界，上游一更新召回率就會無故變動");
  }

  for (const [i, c] of (fx.cases ?? []).entries()) {
    stats.total++;
    stats.byKind[c.kind] = (stats.byKind[c.kind] ?? 0) + 1;
    stats.byDifficulty[c.difficulty] = (stats.byDifficulty[c.difficulty] ?? 0) + 1;
    countPolarity(c);
    validateCase(c, repoPath, file, i);
  }
}

console.log(`\n${"-".repeat(60)}`);
console.log(`案例 ${stats.total} 條，錨點 ${anchorsChecked} 個`);
console.log(`  依類型: ${JSON.stringify(stats.byKind)}`);
console.log(`  依難度: ${JSON.stringify(stats.byDifficulty)}`);

console.log(`  負例 ${stats.negatives} / 正例 ${stats.positives}`);
if (stats.negatives < stats.positives * 0.5) {
  console.log(`  ! 負例偏少。只標正例會養出一個把什麼都連起來的匹配器，`);
  console.log(`    而且指標上看不出來——精確率的退步需要負例才測得到。`);
}

console.log(`\n錯誤 ${errors}，警告 ${warnings}`);
process.exit(errors ? 1 : 0);
