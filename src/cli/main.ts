#!/usr/bin/env node

/**
 * `ostracon` 的單一進入點。
 *
 * 子指令**只做分派，不做參數解析**——每一支自己解析自己的旗標，這裡只決定
 * 把 `argv` 交給誰。理由是每支指令的旗標本來就不一樣（`why` 要 target、
 * `evidence linked` 要 record/replay 目錄），硬做一套共用解析器會變成
 * 一個誰都不合身的抽象。
 *
 * 每支子指令同時保留自己的直接執行守衛，所以 `pnpm why:cli` 之類的開發捷徑
 * 仍然可用，與這裡走的是同一個 `main(args)`。
 */

const USAGE = `ostracon — 從 git history 重建程式碼的決策演化史

用法：
  ostracon why <path>:<symbol> [--repo <path>] [--db <file>] [--until <sha>] [--full]
        印出一段程式碼的演化史。--full 索引整個 repo，跨檔案搬移才看得見（慢很多）。
        路徑在 --until 已被刪除也查得到。

  ostracon ostracised [--repo <path>] [--db <file>] [--until <sha>] [--strength A|C]
        列出試過又被推翻的做法。一律跑全 repo pass——搬移守門在單一血緣下是瞎的。

  ostracon ui [--db <file>] [--port <n>] [--repo-id <n>]
        三欄畫面：結構 → 演化 → 意圖。只讀不建索引，只綁 127.0.0.1。

  ostracon export --db <file> --out <dir> --label <名稱> [--limit <n>]
        匯出成純靜態站台（線上 demo 用）。--label 是必填：不給的話畫面會
        顯示匯出者的本機路徑。

  ostracon evidence extract --db <file> [--repo-id <n>]
        從 commit message 抽取理由並驗證 span。零網路、零 LLM。

  ostracon evidence linked --db <file> [--repo-id <n>]
                           [--record-dir <dir> | --replay-dir <dir>]
        取回被參照的 GitHub PR / issue 討論串。需要 GITHUB_TOKEN；沒有就安全略過。

環境需求：Node 24 以上，且內建 SQLite 必須含 FTS5。詳見 README。`;

async function dispatch(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case "why":
      return (await import("./why.ts")).main(rest);

    case "ostracised":
      return (await import("./ostracised.ts")).main(rest);

    case "ui":
      return (await import("./ui.ts")).main(rest);

    case "export":
      return (await import("./export-site.ts")).main(rest);

    case "evidence": {
      const [sub, ...args] = rest;
      if (sub === "extract") return (await import("./extract-evidence.ts")).main(args);
      if (sub === "linked") return (await import("./linked-evidence.ts")).main(args);
      console.error(
        sub === undefined
          ? "evidence 需要子指令：extract 或 linked"
          : `未知的 evidence 子指令：${sub}`,
      );
      process.exitCode = 2;
      return;
    }

    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return;

    case "-v":
    case "--version": {
      // 版本讀自封裝的 package.json，不在原始碼裡另抄一份——抄了就會與
      // 實際發布的版本分岔。
      const { readFileSync } = await import("node:fs");
      const pkg = JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      console.log(pkg.version);
      return;
    }

    default:
      console.error(`未知的指令：${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

/**
 * 把已知的失敗印成一行人看得懂的訊息，而不是 Node 的 stack trace。
 *
 * 掃描首次使用者路徑時，**每一種錯誤的第一行都是 `node:internal/errors:985`**：
 * 空 repo、`--until` 指向不存在的 ref、repo 路徑打錯、目錄不是 git repo、
 * `--db` 指向不可寫的位置——全都是最常見的「打錯字」情境。有些訊息本身其實不錯
 * （「無法解析目標 a.ts；格式應為 …」），但都被埋在 stack trace 底下。
 *
 * **非預期的錯誤仍然保留完整 stack。** 把所有東西都壓成一行會讓真正的 bug
 * 變得無法排查——這裡要分辨的是「使用者做錯了」與「我們寫錯了」。
 */
function explain(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : String(error);

  // git 自己的訊息夠清楚，但被包在 execFileSync 的 "Command failed: …" 裡，
  // 前面還有一整行 git 指令。抽出 fatal: 那一行就好。
  const fatal = /^fatal: .*$/m.exec(raw);
  if (fatal) {
    const line = fatal[0];
    if (line.includes("unknown revision or path not in the working tree")) {
      return `${line}\n這通常是 --until 指向了不存在的 ref，或這個 repo 還沒有任何 commit。`;
    }
    if (line.includes("not a git repository")) {
      return `${line}\n--repo 要指向一個 git repo 的根目錄。`;
    }
    if (line.includes("cannot change to")) {
      return `${line}\n--repo 指向的路徑不存在。`;
    }
    return line;
  }

  if (raw.startsWith("ENOENT: no such file or directory, mkdir")) {
    return `${raw}\n--db 的上層目錄不存在，而且無法建立。`;
  }

  // 我們自己丟出來的訊息本來就是給人看的（淺層 clone、目標格式、版本不符…）。
  // 判準是「有沒有換行或中文」——那是我們寫的，不是 runtime 的。
  if (/[一-鿿]/.test(raw)) return raw;

  return undefined;
}

try {
  await dispatch(process.argv.slice(2));
} catch (error) {
  const message = explain(error);
  if (message === undefined) throw error;
  console.error(message);
  process.exitCode = 1;
}
