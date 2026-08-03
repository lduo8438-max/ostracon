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

await dispatch(process.argv.slice(2));
