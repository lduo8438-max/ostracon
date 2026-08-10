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

// ── 非 ASCII 檔名 ──────────────────────────────────────────────────────────
//
// git 預設 core.quotePath=true，所以 --name-status 會把這個路徑輸出成
// "src/\347\245\250\345\210\270\350\247\243\346\236\220.ts"。走訪層若不去引號，
// 路徑會帶著引號存進資料庫，而副檔名判定看到的是 `.ts"`——於是**檔案完全不被解析**。
//
// 這裡刻意做成「ASCII 路徑改名到非 ASCII 路徑」，一個案例同時守住三件事：
//   1. 非 ASCII 檔案有沒有被解析（沒去引號的話這一版根本沒有宣告）
//   2. R 記錄的新舊路徑是否都去引號（只去一邊會讓血緣接不起來）
//   3. 血緣有沒有跨過改名——接不起來就會產生一個**假死亡**，
//      而假死亡再餵給迂迴偵測就變成假的「被推翻」
//
// 新的 commit 一律追加在尾端，既有案例的 SHA 才不會變動。
writeFileSync(path.join(absolute, "src/legacy.ts"), source("resolveTicket"));
git(["add", "-A"]);
git(["commit", "-q", "-m", "add ticket resolver"], "2026-01-07T00:00:00Z");
const asciiPath = git(["rev-parse", "HEAD"]);

git(["mv", "src/legacy.ts", "src/票券解析.ts"]);
git(["commit", "-q", "-m", "rename onto a non-ASCII path"], "2026-01-08T00:00:00Z");
const nonAsciiPath = git(["rev-parse", "HEAD"]);

// ── 中文 commit message ────────────────────────────────────────────────────
//
// 兩套黃金語料（Osiris、create-t3-app）都是英文，所以抽取器宣稱的中英並列
// 只有英文那一半被驗過。中文沒有詞界而標記是用 indexOf 配的，裸的「理由」
// 會命中「真理由」「判斷理由」「沒有理由」——引文從詞中間開始。
//
// 最嚴重的一種是把否定詞留在 span 外面：「沒有理由改變」抽出「理由改變。」，
// **逐字為真、span 斷言通過、意思相反**。span 斷言擋不住這一類，所以它必須
// 由 fixture 擋。每則訊息只測一件事，判定才不會互相汙染。
const zhCommit = (file, fn, message, date) => {
  writeFileSync(path.join(absolute, `src/${file}`), source(fn));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message], date);
  return git(["rev-parse", "HEAD"]);
};

// 負例：否定詞在標記之前。抽出「理由改變。」就是把原意講反了。
const zhNegation = zhCommit(
  "zh-negation.ts",
  "normalizeLabel",
  "調整標籤正規化\n\n量過之後 5 個 entity 一個不差，所以版本字串沒有理由改變。",
  "2026-01-09T00:00:00Z",
);

// 負例：「真理由」「判斷理由」——標記是別的詞的後半段。
const zhMidWord = zhCommit(
  "zh-mid-word.ts",
  "collectSummary",
  "整理裁決樣本\n\n103 條可疑引文全部人工裁決：真理由 87、空殼 9。\n相交就能判斷理由是不是在講這段程式碼。",
  "2026-01-10T00:00:00Z",
);

// 正例：名詞標記帶冒號，與英文的 reason: / why: 同一個形狀。
const zhColon = zhCommit(
  "zh-colon.ts",
  "parseWindow",
  "改用 histogram 切 diff\n\n理由：Myers 的 hunk 邊界不穩定。",
  "2026-01-11T00:00:00Z",
);

// 正例：連接詞類。接在漢字後面（「這是因為」）是合法中文，不得被詞界規則誤殺。
const zhConjunction = zhCommit(
  "zh-conjunction.ts",
  "resolveScope",
  "改走全 repo 候選池\n\n這是因為偵測器看不到內容搬去的那個檔案。",
  "2026-01-12T00:00:00Z",
);

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
      asciiPath,
      nonAsciiPath,
      zhNegation,
      zhMidWord,
      zhColon,
      zhConjunction,
    },
    null,
    2,
  ),
);
