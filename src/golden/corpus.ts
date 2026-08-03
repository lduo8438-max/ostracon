#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * `corpus:fetch` — 把黃金測試集需要的語料抓到本機。
 *
 * **這支存在的理由是可驗證性。** README 宣稱 Osiris golden 33/33，而一個宣稱如果
 * 陌生人沒辦法自己重現，它就只是宣稱。有了這支，驗證是兩行指令。
 *
 * **座標的唯一真相是 fixture 本身**（`repo.clone_url` + `repo.index_until`），
 * 不是這支程式、不是 CI 設定、也不是文件。任何一處另外抄一份 SHA，遲早會與 fixture
 * 分岔而且不會有人發現——所以這裡一律從 fixture 讀，讀到什麼就用什麼。
 */

interface CorpusSpec {
  fixture: string;
  name: string;
  cloneUrl: string;
  indexUntil: string;
}

/** `generated:` 開頭代表語料是被程式產生的，不是 clone 來的。 */
const GENERATED = "generated:";

export function readCorpusSpecs(fixtureDir: string): CorpusSpec[] {
  return readdirSync(fixtureDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((file) => {
      const full = path.join(fixtureDir, file);
      const parsed = parseYaml(readFileSync(full, "utf8")) as {
        repo?: { name?: string; clone_url?: string; index_until?: string };
      };
      const repo = parsed.repo;
      if (!repo?.name || !repo.clone_url || !repo.index_until) {
        throw new Error(
          `${full} 缺少 repo.name / repo.clone_url / repo.index_until，無法定位語料`,
        );
      }
      return {
        fixture: full,
        name: repo.name,
        cloneUrl: repo.clone_url,
        indexUntil: repo.index_until,
      };
    });
}

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/**
 * 驗證取回的語料真的停在 fixture 指定的 commit。
 *
 * **這不是多餘的檢查。** 抓錯 commit 的話 golden 會以「案例 missing」的形式失敗，
 * 而那與「索引器壞掉」在報告上長得一模一樣——排查會從錯的地方開始。
 * 在這裡硬失敗，訊息才指得到真正的原因。
 */
function assertHead(dir: string, expected: string, source: string): void {
  const head = git(dir, ["rev-parse", "HEAD"]);
  if (head !== expected) {
    throw new Error(
      `${dir} 的 HEAD 是 ${head}，但 ${source} 要求 ${expected}。`,
    );
  }
}

function fetchCloned(spec: CorpusSpec, dir: string): "cloned" | "updated" | "up-to-date" {
  if (!existsSync(dir)) {
    mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", spec.cloneUrl, dir], { stdio: "inherit" });
    git(dir, ["checkout", "--quiet", spec.indexUntil]);
    return "cloned";
  }
  if (!existsSync(path.join(dir, ".git"))) {
    // 已經有東西但不是 git repo：**絕不覆寫**，讓使用者自己決定。
    throw new Error(`${dir} 已存在且不是 git repo。請自行移除或改用 --dir。`);
  }
  if (git(dir, ["rev-parse", "HEAD"]) === spec.indexUntil) return "up-to-date";
  // 釘死的 commit 可能還沒在本地：先 fetch 再 checkout。
  execFileSync("git", ["-C", dir, "fetch", "--quiet", "origin"], { stdio: "inherit" });
  git(dir, ["checkout", "--quiet", spec.indexUntil]);
  return "updated";
}

/**
 * 產生器是決定性的：同一支腳本必定產生同一個 SHA（實測兩次產生逐位元相同）。
 * 所以「HEAD 等於 `index_until`」就足以判定產物不過期，可以直接跳過。
 *
 * **HEAD 不符時不自動重建。** `build-controlled-repo.mjs` 自己就拒絕覆寫非空目錄，
 * 這裡沿用同樣的保守性：那是使用者的目錄，可能有他們自己放的東西。
 * 報告清楚的錯誤與該下的指令，由人決定要不要刪。
 */
function generate(spec: CorpusSpec, dir: string, repoRoot: string): "generated" | "up-to-date" {
  const script = path.resolve(repoRoot, spec.cloneUrl.slice(GENERATED.length));
  if (!existsSync(script)) {
    throw new Error(`${spec.fixture} 指向的產生器不存在：${script}`);
  }
  if (existsSync(dir)) {
    if (
      existsSync(path.join(dir, ".git"))
      && git(dir, ["rev-parse", "HEAD"]) === spec.indexUntil
    ) {
      return "up-to-date";
    }
    throw new Error(
      `${dir} 已存在但不是 ${spec.indexUntil} 的產物（產生器不覆寫非空目錄）。`
        + `\n確認裡面沒有你要留的東西之後：rm -rf ${dir} 再重跑。`,
    );
  }
  mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync(process.execPath, [script, dir], { stdio: "inherit" });
  return "generated";
}

export type FetchAction = "cloned" | "updated" | "up-to-date" | "generated";

export interface FetchResult {
  name: string;
  dir: string;
  action: FetchAction;
}

export function fetchCorpora(
  specs: CorpusSpec[],
  targetDir: string,
  repoRoot: string,
): FetchResult[] {
  return specs.map((spec) => {
    const dir = path.resolve(targetDir, spec.name);
    if (spec.cloneUrl.startsWith(GENERATED)) {
      const action = generate(spec, dir, repoRoot);
      assertHead(dir, spec.indexUntil, spec.fixture);
      return { name: spec.name, dir, action };
    }
    const action = fetchCloned(spec, dir);
    assertHead(dir, spec.indexUntil, spec.fixture);
    return { name: spec.name, dir, action };
  });
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const repoRoot = process.cwd();
  const fixtureDir = path.resolve(repoRoot, valueAfter(args, "--fixtures") ?? "fixtures");
  const targetDir = path.resolve(repoRoot, valueAfter(args, "--dir") ?? "corpora");

  const specs = readCorpusSpecs(fixtureDir);
  const results = fetchCorpora(specs, targetDir, repoRoot);

  console.log(`語料就緒（${targetDir}）：\n`);
  for (const r of results) {
    console.log(`  ${r.name.padEnd(22)} ${r.action.padEnd(11)} ${r.dir}`);
  }
  console.log("\n接下來：");
  for (const spec of specs) {
    const dir = path.resolve(targetDir, spec.name);
    console.log(
      `  pnpm golden:index -- --repo ${path.relative(repoRoot, dir)}`
        + ` --fixture ${path.relative(repoRoot, spec.fixture)} --db ${spec.name}.db`,
    );
    console.log(
      `  pnpm golden       -- --fixture ${path.relative(repoRoot, spec.fixture)}`
        + ` --db ${spec.name}.db --baseline fixtures/baselines/${spec.name}.json`,
    );
  }
}
