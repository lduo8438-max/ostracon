#!/usr/bin/env node
/**
 * mine-candidates — 為黃金測試集尋找候選案例
 *
 * 這個腳本只回答「該去哪裡找」，不回答「答案是什麼」。
 * 它不產生任何標註，也不判斷兩段程式碼是否為同一個實體——那是你的工作。
 *
 * 刻意保持粗糙：它只用 git 內建的啟發式，不讀 Ostracon 的任何索引結果。
 * Git 與索引器的啟發式仍可能同源，所以它絕不能提出候選答案；否則標註者
 * 很容易變成替工具蓋章，讓黃金測試集繼承同一套盲點並形成循環論證。
 *
 * 用法：
 *   node mine-candidates.mjs <repo-path> [--until <sha>] [--limit 20]
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const repo = args[0];
if (!repo || repo.startsWith("--")) {
  console.error("用法: node mine-candidates.mjs <repo-path> [--until <sha>] [--limit N]");
  process.exit(1);
}
const until = argVal("--until") ?? "HEAD";
const limit = Number(argVal("--limit") ?? 15);
const minLines = Number(argVal("--min-lines") ?? 20);

function argVal(flag) {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith("--")) {
    console.error(`${flag} 缺少值`);
    process.exit(1);
  }
  return args[i + 1];
}

function git(...a) {
  try {
    return execFileSync("git", ["-C", repo, ...a], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 256,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (process.env.DEBUG) {
      console.error(e.stderr?.trim() || e.message);
    }
    return "";
  }
}

function die(message) {
  console.error(`錯誤: ${message}`);
  process.exit(1);
}

if (!existsSync(repo)) die(`repo 路徑不存在：${repo}`);
if (git("rev-parse", "--is-inside-work-tree").trim() !== "true") {
  die(`不是有效的 Git worktree：${repo}`);
}
if (!Number.isInteger(limit) || limit <= 0) die("--limit 必須是正整數");
if (!Number.isInteger(minLines) || minLines < 0) die("--min-lines 必須是非負整數");

const untilSha = git("rev-parse", "--verify", `${until}^{commit}`).trim();
if (!/^[0-9a-f]{40}$/.test(untilSha)) die(`找不到 commit：${until}`);

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".py", ".go", ".rs"]);
const isCode = (p) => CODE_EXT.has(path.extname(p));

function section(n, title, note) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`情境 ${n} — ${title}`);
  if (note) console.log(`  ${note}`);
  console.log("=".repeat(72));
}

// ---------------------------------------------------------------------------
// 情境 2/3/4/5 — 改名與搬檔，依相似度分數排序
//
// git 的 -M 會輸出 R<score>，score 是 0-100 的相似度。
// score 越低 = 改名的同時內容也大幅變動 = 你的 L2/L3 會失效、只剩相似度匹配。
// 這些低分項就是情境 5，最容易斷掉的一種，優先標它們。
// ---------------------------------------------------------------------------
function renames() {
  const out = git("log", "-M20%", "--diff-filter=R", "--name-status",
                  "--format=@@%H|%ad|%s", "--date=short", untilSha);
  const rows = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) {
      const [h, d, ...s] = line.slice(2).split("|");
      cur = { sha: h, date: d, subject: s.join("|") };
    } else if (/^R(\d+)\t/.test(line) && cur) {
      const [tag, from, to] = line.split("\t");
      const score = Number(tag.slice(1));
      if (isCode(from) || isCode(to)) rows.push({ ...cur, score, from, to });
    }
  }
  rows.sort((a, b) => a.score - b.score);

  section("2/3/4/5", "改名與搬檔（依相似度由低到高）",
    "分數越低越難：R100 是純改名(情境2/3)，R50-R80 是改名+大幅編輯(情境5)");
  if (!rows.length) return console.log("  （無）");
  for (const r of rows.slice(0, limit)) {
    const tag = r.score >= 95 ? "低難度候選" : r.score >= 80 ? "中難度候選" : "高難度候選 ★";
    console.log(`  R${String(r.score).padStart(3)} [${tag}] ${r.sha.slice(0, 10)} ${r.date}`);
    console.log(`        ${r.from}  →  ${r.to}`);
    console.log(`        ${r.subject}`);
  }
}

// ---------------------------------------------------------------------------
// 情境 15/17 — 純格式變更
//
// 判準：把 --numstat 與 -w --numstat（忽略空白）相比。
// 忽略空白後變動量塌縮到接近零，就是格式化 commit。
// 這是精確測試，不是靠 commit message 猜的。
// ---------------------------------------------------------------------------
function formatOnly() {
  const shas = git("log", "--format=%H|%ad|%s", "--date=short", untilSha)
    .split("\n").filter(Boolean);
  const rows = [];
  for (const line of shas) {
    const [sha, date, ...s] = line.split("|");
    const raw = numstat(git("show", "--numstat", "--format=", sha));
    if (raw.files === 0 || raw.lines < minLines) continue;
    const ws = numstat(git("show", "-w", "--numstat", "--format=", sha));
    const collapse = 1 - ws.lines / raw.lines;
    if (collapse > 0.8) {
      rows.push({ sha, date, subject: s.join("|"), ...raw, wsLines: ws.lines, collapse });
    }
  }
  rows.sort((a, b) => b.files - a.files);

  section("15/17", "純格式／空白變更",
    "忽略空白後變動量塌縮 >80%。所有實體都應落在 raw 層，一個都不該送 LLM");
  if (!rows.length) return console.log("  （無）");
  for (const r of rows.slice(0, limit)) {
    console.log(`  ${r.sha.slice(0, 10)} ${r.date}  ${r.files} 檔 / ${r.lines} 行 ` +
                `→ 忽略空白後剩 ${r.wsLines} 行 (塌縮 ${(r.collapse * 100).toFixed(0)}%)`);
    console.log(`        ${r.subject}`);
  }
}

function numstat(text) {
  let files = 0, lines = 0;
  for (const l of text.split("\n")) {
    const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    if (!isCode(m[3])) continue;
    files++;
    lines += (Number(m[1]) || 0) + (Number(m[2]) || 0);
  }
  return { files, lines };
}

// ---------------------------------------------------------------------------
// 情境 24/25 — 回退
//
// 兩種來源：git revert 產生的 commit（A 級素材），
// 以及 message 提到 revert/rollback/back out 但不是 git revert 的（情境 25）。
// ---------------------------------------------------------------------------
function reverts() {
  const rows = git("log", "--format=%H|%ad|%s|%b<<<", "--date=short", untilSha)
    .split("<<<").map((x) => x.trim()).filter(Boolean)
    .map((chunk) => {
      const [sha, date, subject, ...body] = chunk.split("|");
      return { sha, date, subject, body: body.join("|") };
    })
    .filter((r) => /revert|rollback|roll back|back out|undo/i.test(r.subject + r.body));

  section("24/25", "回退");
  if (!rows.length) return console.log("  （無）");
  for (const r of rows.slice(0, limit)) {
    const isGitRevert = /^Revert "/.test(r.subject) || /This reverts commit/i.test(r.body);
    console.log(`  ${isGitRevert ? "[情境24 git revert → A級]" : "[情境25 手動回退]"} ` +
                `${r.sha.slice(0, 10)} ${r.date}`);
    console.log(`        ${r.subject}`);
  }
}

// ---------------------------------------------------------------------------
// 情境 10 — 檔案消失後同路徑再出現
//
// 同一路徑被刪除、之後又新增。這是「刪除後重建同名」的檔案層版本，
// 你的斷層偵測應該在這裡報 discontinuity 而不是把血緣接起來。
// ---------------------------------------------------------------------------
function resurrections() {
  const out = git("log", "--diff-filter=AD", "--name-status",
                  "--format=@@%H|%ad", "--date=short", "--reverse", untilSha);
  const hist = new Map();
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) {
      const [h, d] = line.slice(2).split("|");
      cur = { sha: h, date: d };
    } else if (/^[AD]\t/.test(line) && cur) {
      const [st, p] = line.split("\t");
      if (!isCode(p)) continue;
      if (!hist.has(p)) hist.set(p, []);
      hist.get(p).push({ st, ...cur });
    }
  }
  const rows = [];
  for (const [p, evs] of hist) {
    for (let i = 1; i < evs.length; i++) {
      if (evs[i - 1].st === "D" && evs[i].st === "A") {
        rows.push({ path: p, died: evs[i - 1], reborn: evs[i] });
      }
    }
  }

  section(10, "檔案刪除後同路徑再出現",
    "應報斷層，不應接起血緣。這類案例是斷層偵測最好的正例");
  if (!rows.length) return console.log("  （無）");
  for (const r of rows.slice(0, limit)) {
    console.log(`  ${r.path}`);
    console.log(`        刪除 ${r.died.sha.slice(0, 10)} ${r.died.date}  →  ` +
                `重現 ${r.reborn.sha.slice(0, 10)} ${r.reborn.date}`);
  }
}

// ---------------------------------------------------------------------------
// 高攪動檔案 — 情境 1/9/26 的獵場
//
// 被反覆重寫的檔案是設計還沒收斂的地方，也是迂迴與斷層最可能出現的地方。
// 標註時從這些檔案挑函式，命中率遠高於隨機挑。
// ---------------------------------------------------------------------------
function churn() {
  const counts = new Map();
  for (const p of git("log", "--name-only", "--format=", untilSha).split("\n")) {
    if (!p || !isCode(p)) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit);

  section("1/9/26", "高攪動檔案（獵場）",
    "從這些檔案裡挑函式標註，比隨機挑的命中率高得多");
  for (const [p, n] of rows) {
    console.log(`  ${String(n).padStart(4)} 次  ${p}`);
    console.log(`         git log -L :<函式名>:${p}`);
  }
}

// ---------------------------------------------------------------------------
console.log(`repo: ${path.resolve(repo)}\nuntil: ${untilSha}`);
console.log(`\n本腳本只提供「該去哪裡找」，不提供任何標註建議。每一條都必須由你親自判斷。`);
renames();
formatOnly();
reverts();
resurrections();
churn();
console.log(`\n${"-".repeat(72)}`);
console.log(`下一步：對挑中的檔案跑 git log -L :<函式名>:<路徑> 逐一檢視，`);
console.log(`把判斷結果寫進 fixtures/<repo>.yaml。斷點記進 rationale；difficulty 只看待測系統需要的匹配層級。`);
