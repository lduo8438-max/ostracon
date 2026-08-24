#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifyParserAdapters } from "../ast/parser.ts";
import { indexGit, INDEXER_VERSION } from "../git/index.ts";
import { openIndexDatabase, repoConsolidationNotice } from "../git/persist.ts";
import { indexRepoStructure, REBUILD_NOTICE } from "../index/repo-pass.ts";
import { assertNoCrossRepoRows } from "../index/structural.ts";
import { isTestPath } from "./ostracised.ts";

/**
 * `hotspots` — 這個 repo 裡被重構最多次的宣告。
 *
 * ## 為什麼這支值得存在（先量過才寫的）
 *
 * 「攪動熱點」在一般工具裡是**檔案**層級的 commit 次數，那是 `git log` 直接給得出
 * 的東西，重做一次沒有意義。實測 vuejs/core：依「全部 revision_change 列」排檔案
 * 與依「只算結構改動」排檔案，**top-10 重疊 8/10**——檔案層級上這兩件事幾乎是
 * 同一個答案，所以檔案級的熱點視圖確實不該做。
 *
 * **entity 層級是另一回事，而那是 git 給不出來的。** 同樣的語料，攪動最高的
 * 15 個宣告分佈在 12 個檔案，而且 `renderer.ts` 一個檔案裡有**三個獨立熱點**
 * （`baseCreateRenderer` 212 次、`createRenderer` 193 次、
 * `baseCreateRenderer.mountComponent` 66 次）——檔案級視圖會把它們併成一列，
 * 於是「這個兩千行的檔案裡到底是哪一段一直在變」這個問題永遠答不出來。
 *
 * ## 三個判準都是量出來的，不是猜的
 *
 * **一、只算真的動到結構的改動。** vuejs/core 的 `revision_change` 有 88.5% 是
 * `none`（同一個宣告在別處改動的 commit 裡被重新觀察，內容一個位元組都沒變）。
 * 把那些算進攪動，等於用一個虛胖九倍的分子排名。`createRenderer` 有 480 列
 * `revision_change`，其中只有 193 次真的動到結構——**那個比值本身就是資訊**，
 * 所以兩個數字都印出來。
 *
 * **二、排序用絕對次數，不用速率。** 「結構改動／存活天數」看起來更公平，實測
 * 卻是小分母的陷阱：`createRenderer.processSuspense` 9 次改動除以 52 天等於
 * 每年 63 次，會排在 `compileScript` 217 次之上。**存活天數是屬性不是門檻**——
 * 印出來讓人自己判斷，與 `ostracised` 對 `duration_days` 的處理一致。
 *
 * **三、排名不是「最老的程式碼」。** 這件事會讓整支指令變成廢話，所以量過：
 * 依結構改動次數排的前 20 名，與依存活天數排的前 20 名**只重疊 3 個**。
 *
 * ## 測試檔沿用 `ostracised` 那一份判準
 *
 * 不另寫一份。斷層密度與迂迴密度在 vuejs/core 上都被 `.spec.ts` 主導
 * （`Suspense.spec.ts:setup` 被置換 4 次，那只是每個 `it()` 各寫一個同名
 * `setup`），攪動也會有同樣的問題。**預設排除但不靜默**：標頭報數量，
 * `--include-tests` 看得回來。
 */

export interface HotspotRow {
  /** 對外身分。不得用 rowid——全量重建索引會讓它漂移（不變量 1）。 */
  stableKey: string;
  path: string;
  symbol: string;
  /** 真的動到結構的次數。這是排序依據。 */
  structural: number;
  /** 這個 entity 出現在幾次改動裡（含 `none`）。與上一欄的比值是雜訊比。 */
  observed: number;
  /** 第一次到最後一次改動的間隔。**屬性不是門檻**，只印不篩。 */
  days: number;
  firstAt: string;
  lastAt: string;
  /** 已消亡的要標出來——「它一直在變」與「它變到最後被刪掉」不是同一件事。 */
  dead: boolean;
}

/**
 * 依結構改動次數排序。
 *
 * `shape` 是唯一算進分子的層級：`raw`（只改註解或排版）與 `token`（只改局部
 * 變數名）照定義不是重構，`alpha`（字面值或呼叫目標變更）是灰區——它不改控制流，
 * 算進「被重構幾次」會高估。寧可低估：這支指令的用途是**挑一個地方去問 `why`**，
 * 漏掉一個候選的代價遠低於把一整排格式化 commit 排到第一頁。
 */
export function listHotspots(
  db: DatabaseSync,
  repoId: number,
): HotspotRow[] {
  return db.prepare(
    `SELECT e.stable_key AS stableKey,
            last.path AS path, last.symbol AS symbol,
            SUM(CASE WHEN rc.change_level = 'shape' THEN 1 ELSE 0 END) AS structural,
            COUNT(*) AS observed,
            julianday(MAX(c.authored_at)) - julianday(MIN(c.authored_at)) AS days,
            MIN(c.authored_at) AS firstAt,
            MAX(c.authored_at) AS lastAt,
            CASE WHEN e.death_commit_id IS NULL THEN 0 ELSE 1 END AS dead
       FROM revision_change rc
       JOIN git_commit c ON c.id = rc.commit_id
       JOIN entity e ON e.id = rc.entity_id
       JOIN (SELECT r.entity_id AS entity_id, r.path AS path,
                    s.qualified_name AS symbol,
                    row_number() OVER (
                      PARTITION BY r.entity_id ORDER BY r.id DESC
                    ) AS rn
               FROM revision r JOIN slot s ON s.id = r.slot_id) last
            ON last.entity_id = e.id AND last.rn = 1
      WHERE e.repo_id = ?
      GROUP BY e.id
     HAVING structural > 0
      ORDER BY structural DESC, observed DESC, last.path, last.symbol`,
    // **一次取完，不在 SQL 裡 LIMIT。**
    //
    // 測試檔的判準是路徑字串加語言註冊表（`isTestPath`），搬進 SQL 會變成第二份
    // 實作；留在 SQL 外面就必須先取回足夠的列。而「取一個視窗再過濾」會讓標頭
    // 的抑制數量只是**視窗內**的數量——那正是這個專案被咬過的那種「標頭與清單
    // 各說各話」。母數與清單來自同一個陣列，就不可能分岔。
    //
    // 代價可以忽略：vuejs/core 有結構改動的宣告是 2,416 個，而分組本身要掃的
    // 233,665 列 `revision_change` 不論取幾列都要掃。
  ).all(repoId) as unknown as HotspotRow[];
}

const thousands = (n: number): string => n.toLocaleString("en-US");

/**
 * 純函式：把名單轉成可讀文字。不碰資料庫，方便測試。
 *
 * **`rows` 是完整名單，截斷發生在這裡。** 母數、抑制數量與清單因此來自同一個
 * 陣列，不可能分岔——先截斷再算母數的話，「這個 repo 有 2,416 個宣告動過結構」
 * 會被印成「有 20 個」，而測試檔的抑制數量會變成只是視窗內的數量。
 */
export function renderHotspots(
  rows: HotspotRow[],
  options: { limit: number; includeTests?: boolean },
): string {
  const hidden = options.includeTests === true
    ? []
    : rows.filter((row) => isTestPath(row.path));
  const eligible = options.includeTests === true
    ? rows
    : rows.filter((row) => !isTestPath(row.path));
  const shown = eligible.slice(0, options.limit);

  if (shown.length === 0) {
    return "沒有任何宣告動過結構。\n"
      + "（若這個 repo 明明有歷史，先確認索引跑完了——這支指令會自己建索引。）";
  }

  const out: string[] = [
    `${thousands(eligible.length)} 個宣告動過結構；以下是攪動最高的 ${shown.length} 個`,
  ];
  if (hidden.length > 0) {
    out.push(
      `（另有 ${hidden.length} 條在測試檔裡，那是測試骨架不是被重構的設計；`
      + "要看的話加 --include-tests）",
    );
  }
  out.push(
    "",
    "「結構」是真的動到控制流或形狀的次數；「碰過」含完全沒變的那些"
    + "（同一次 commit 動到同檔別處時也會重新觀察一遍）。",
    "",
  );
  for (const [index, row] of shown.entries()) {
    const noise = row.observed === 0
      ? ""
      : `　碰過 ${thousands(row.observed)} 次`;
    out.push(
      `  ${String(index + 1).padStart(2)}. `
      + `${thousands(row.structural).padStart(4)} 次結構改動${noise}`
      + `　${row.days.toFixed(0)} 天${row.dead ? "　已消亡" : ""}`,
    );
    out.push(`      ${row.path}:${row.symbol}`);
    out.push(`      ${row.firstAt.slice(0, 10)} → ${row.lastAt.slice(0, 10)}`);
  }
  out.push("");
  out.push("用 `why <path>:<symbol> --full` 看任何一條的完整時間軸。");
  return out.join("\n");
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function hotspots(
  repo: string,
  dbPath: string,
  until: string,
  options?: { limit?: number; includeTests?: boolean },
): Promise<string> {
  const limit = options?.limit ?? 20;
  openIndexDatabase(dbPath).close();

  await verifyParserAdapters();
  const gitReport = indexGit(repo, { dbPath, until });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    // **一律跑全 repo pass，與 `ostracised` 同樣的理由。** 快路徑建的索引在
    // 跨檔案搬移上會把同一段程式碼算成兩個 entity，攪動次數因此被腰斬——
    // 而那正好發生在最值得看的那些宣告上（會被搬移的通常就是一直在重構的）。
    const pass = await indexRepoStructure(db, repo, gitReport.repoId, INDEXER_VERSION);
    assertNoCrossRepoRows(db, gitReport.repoId);
    const list = renderHotspots(
      listHotspots(db, gitReport.repoId),
      {
        limit,
        ...(options?.includeTests ? { includeTests: true } : {}),
      },
    );
    const notes = [
      ...(gitReport.consolidation.absorbed.length > 0
        ? [repoConsolidationNotice(gitReport.consolidation)]
        : []),
      ...(pass.mode === "rebuilt" ? [REBUILD_NOTICE] : []),
    ];
    return notes.length > 0 ? `${notes.join("\n")}\n\n${list}` : list;
  } finally {
    db.close();
  }
}

export async function main(args: string[]): Promise<void> {
  const repo = valueAfter(args, "--repo") ?? process.cwd();
  const dbPath = valueAfter(args, "--db") ?? ".ostracon/index.db";
  const until = valueAfter(args, "--until") ?? "HEAD";
  const rawLimit = valueAfter(args, "--limit");
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error("--limit 需要正整數");
    process.exitCode = 2;
    return;
  }
  console.log(
    await hotspots(repo, dbPath, until, {
      limit,
      ...(args.includes("--include-tests") ? { includeTests: true } : {}),
    }),
  );
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main(process.argv.slice(2));
}
