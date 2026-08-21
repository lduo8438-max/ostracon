#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verifyParserAdapters } from "../ast/parser.ts";
import {
  aggregateSuppressionNotice,
  deriveClaims,
  unboundExcursionNotice,
} from "../claim/derive.ts";
import { indexGit, INDEXER_VERSION } from "../git/index.ts";
import { repoConsolidationNotice } from "../git/persist.ts";
import { indexRepoStructure, REBUILD_NOTICE } from "../index/repo-pass.ts";
import { assertNoCrossRepoRows } from "../index/structural.ts";
import {
  assertExcursionScope,
  detectExcursions,
  type ExcursionMethod,
  type ExcursionStrength,
} from "../index/excursion.ts";

/**
 * `ostracised` — 列出這個 repo 裡試過又被推翻的做法。
 *
 * 這是專案的命名由來（ostraca 是被丟棄的陶片）。`why` 回答「這段程式碼怎麼變成
 * 現在這樣」，這支回答**「有哪些東西曾經在這裡、現在不在了」**——後者沒有入口的話
 * 使用者根本問不出前者：迂迴的定義就是已經消失，而消失的東西你不知道它叫什麼。
 *
 * **這支不讀 `--full` 開關，一律跑全 repo pass。** 搬移守門在單一血緣下看不到別的
 * 檔案，會把搬移通通判成迂迴（實測 41%）。給開關等於給使用者一個會產生假名單的選項。
 */

export interface OstracisedRow {
  /**
   * 對外身分。**不得用 rowid**——全量重建索引會讓 rowid 漂移，而漂移最壞的
   * 後果不是 404，是舊網址在重建後**成功回傳另一個 entity**（不變量 1）。
   */
  stableKey: string;
  strength: ExcursionStrength;
  method: ExcursionMethod;
  durationDays: number;
  path: string;
  symbol: string;
  bornAt: string;
  diedAt: string;
  diedSha: string;
  diedSubject: string;
}

/**
 * 依強度、再依存活天數排序。`idx_excursion_strength(repo_id, strength,
 * duration_days)` 直接吃得到，不需要新索引。
 *
 * `duration_days` 是**屬性不是門檻**（三週是試錯，三年是技術演進），所以它只影響
 * 排序，不影響誰進得了名單。
 *
 * **由短到長。** 原本是由長到短，於是第一眼看到的是活了 2,676 天才被重構掉的
 * 函式——那是技術演進，不是試錯，正好是這支指令**最沒有資訊量**的一端。
 * 由短到長之後三套語料的開頭都是真的實驗：vuejs/core 是 reactivity 裡試過又
 * 丟掉的位元旗標追蹤（`hasBit` / `setBit` / `setWasTracked`），Osiris 是三個
 * 城市專用的 camera fetcher（後來換成全球資料源）。
 *
 * 排序方向不是門檻：長命的仍在名單裡，只是不再佔據第一個畫面。
 */
export function listOstracised(
  db: DatabaseSync,
  repoId: number,
  filter?: { strength?: ExcursionStrength },
): OstracisedRow[] {
  return db.prepare(
    `SELECT e.stable_key AS stableKey, x.strength AS strength, x.method AS method,
            x.duration_days AS durationDays,
            last.path AS path, last.symbol AS symbol,
            bc.authored_at AS bornAt,
            dc.authored_at AS diedAt, dc.sha AS diedSha,
            CASE WHEN instr(dc.message, char(10)) > 0
                 THEN substr(dc.message, 1, instr(dc.message, char(10)) - 1)
                 ELSE dc.message END AS diedSubject
       FROM excursion x
       JOIN entity e ON e.id = x.entity_id
       JOIN git_commit bc ON bc.id = x.introduce_commit
       JOIN git_commit dc ON dc.id = x.remove_commit
       JOIN (SELECT r.entity_id AS entity_id, r.path AS path,
                    s.qualified_name AS symbol,
                    row_number() OVER (
                      PARTITION BY r.entity_id ORDER BY r.id DESC
                    ) AS rn
               FROM revision r JOIN slot s ON s.id = r.slot_id) last
            ON last.entity_id = x.entity_id AND last.rn = 1
      WHERE x.repo_id = ? AND x.entity_id IS NOT NULL
        AND (? IS NULL OR x.strength = ?)
      ORDER BY x.strength, x.duration_days ASC, last.path, last.symbol`,
  ).all(repoId, filter?.strength ?? null, filter?.strength ?? null) as unknown as
    OstracisedRow[];
}

/**
 * 測試檔的宣告不是「被推翻的做法」，是測試骨架。
 *
 * 實測 vuejs/core 的 A 級名單 710 條裡有 **173 條（24%）**是
 * `__tests__/*.spec.ts` 裡的 `App.render`、`testRender.makeApp` 這類——
 * 它們確實誕生又消亡，但沒有人「試過這個設計然後推翻它」。Osiris 與
 * create-t3-app 都是 0 條，所以這件事只有在有大型測試套件的語料上才看得見。
 *
 * 判準是路徑，抽樣驗過 40 條全部命中真正的測試檔。**預設排除但不靜默**：
 * 標頭會報出被排除的數量，`--include-tests` 可以看回來。整段藏起來的話，
 * 使用者會以為這個 repo 的試錯比實際少。
 */
export const TEST_PATH =
  /(^|\/)(__tests__|__mocks__|tests?|e2e|spec)\/|\.(spec|test|bench)\.[cm]?[jt]sx?$/;

export const isTestDeclaration = (row: OstracisedRow): boolean =>
  TEST_PATH.test(row.path);

const METHOD_LABEL: Record<ExcursionMethod, string> = {
  git_revert: "revert",
  inverse_diff: "移除的與加入的逐字相同",
  short_lifecycle: "只出現一次",
  trajectory: "改過幾次才移除",
};

/**
 * 純函式：把名單轉成可讀文字。不碰資料庫，方便測試。
 *
 * `filtered` 必須傳，否則標頭會把「這一趟沒查」印成「這個 repo 沒有」——
 * `--strength C` 時印出「A 確證 0」會讓使用者以為沒有 A 級的，而實際上有 71 條。
 */
export function renderOstracised(
  rows: OstracisedRow[],
  filter?: { strength?: ExcursionStrength; includeTests?: boolean },
): string {
  const only = filter?.strength;
  const hidden = filter?.includeTests === true
    ? []
    : rows.filter(isTestDeclaration);
  const shown = filter?.includeTests === true
    ? rows
    : rows.filter((row) => !isTestDeclaration(row));
  const testNote = hidden.length === 0
    ? []
    : [`（另有 ${hidden.length} 條在測試檔裡，那是測試骨架不是被推翻的做法；`
      + `要看的話加 --include-tests）`];
  rows = shown;
  if (rows.length === 0) {
    return [
      only === undefined
        ? "沒有找到被推翻的做法。\n"
          + "（這通常代表語料本身沒有這種痕跡，不是查詢失敗——"
          + "單人專案與長期維護的專案在這件事上差很多。）"
        : `沒有 ${only} 級的紀錄。拿掉 --strength 看完整名單。`,
      ...testNote,
    ].join("\n");
  }
  const out: string[] = [];
  if (only === undefined) {
    const a = rows.filter((r) => r.strength === "A").length;
    out.push(
      `${rows.length} 個曾經存在、後來被整段移除的宣告`
        + `（A 確證 ${a}｜C 疑似 ${rows.length - a}）`,
    );
  } else {
    // 只報這一段的數量，不對沒查的那一段做任何暗示。
    out.push(`${rows.length} 個 ${only} 級的紀錄（已用 --strength 過濾）`);
  }
  out.push(...testNote);
  // A 與 C 的證據強度差一個等級，混在同一份清單裡而不分段，等於把疑似
  // 當成確證呈現。分段之後 C 那一段可以整段標一次「疑似」。
  out.push("");
  for (const strength of ["A", "C"] as const) {
    const group = rows.filter((r) => r.strength === strength);
    if (group.length === 0) continue;
    out.push(
      strength === "A"
        ? `── A 確證（${group.length}）：結構上可獨立驗證`
        : `── C 疑似（${group.length}）：僅生命週期符合，未經證實，不得當成結論`,
    );
    for (const row of group) {
      out.push(
        `  ${row.durationDays.toFixed(0).padStart(5)} 天  `
          + `${row.path}:${row.symbol}`,
      );
      out.push(
        `          ${row.bornAt.slice(0, 10)} → ${row.diedAt.slice(0, 10)}`
          + `　${row.diedSha.slice(0, 10)}　${METHOD_LABEL[row.method]}`,
      );
      out.push(`          ${row.diedSubject}`);
    }
    out.push("");
  }
  out.push("用 `why <path>:<symbol> --full` 看任何一條的完整時間軸。");
  return out.join("\n");
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function ostracised(
  repo: string,
  dbPath: string,
  until: string,
  filter?: { strength?: ExcursionStrength; includeTests?: boolean },
): Promise<string> {
  if (!existsSync(dbPath)) {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const schema = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
    const init = new DatabaseSync(dbPath);
    init.exec(schema);
    init.close();
  }

  await verifyParserAdapters();
  const gitReport = indexGit(repo, { dbPath, until });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    // 這個資料庫如果是 `why` 的快路徑建的，全 repo pass 會先作廢重建。對這支
    // 指令而言那不只是「看得更完整」——搬移守門在單一血緣下是瞎的，沒重建的話
    // 名單裡會混進大量其實只是被搬走的東西（實測 41% 的候選）。
    const pass = await indexRepoStructure(db, repo, gitReport.repoId, INDEXER_VERSION);
    detectExcursions(db, gitReport.repoId, { scope: "repo" });
    // `abandoned_reason` 的主體是剛產生的 excursion，不是死亡 revision。
    // 先偵測再升格，UI 才能在移除那列呈現這段做法為何被放棄。
    const claims = deriveClaims(db, gitReport.repoId);
    // 索引就在上面兩行，理論上一定成立；斷言的意義是「將來有人改成可跳過索引時
    // 會在這裡爆炸」，而不是預期它現在會失敗。
    assertExcursionScope(db, gitReport.repoId);
    assertNoCrossRepoRows(db, gitReport.repoId);
    const list = renderOstracised(listOstracised(db, gitReport.repoId, filter), filter);
    const notes = [
      ...(gitReport.consolidation.absorbed.length > 0
        ? [repoConsolidationNotice(gitReport.consolidation)]
        : []),
      ...(pass.mode === "rebuilt" ? [REBUILD_NOTICE] : []),
      ...[aggregateSuppressionNotice(claims), unboundExcursionNotice(claims)]
        .filter((notice): notice is string => notice !== undefined),
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
  const includeTests = args.includes("--include-tests");
  const raw = valueAfter(args, "--strength");
  if (raw !== undefined && raw !== "A" && raw !== "C") {
    console.error("--strength 只接受 A 或 C（B 級需要文字證據，目前刻意不做）");
    process.exitCode = 2;
    return;
  }
  console.log(
    await ostracised(repo, dbPath, until, {
      ...(raw === undefined ? {} : { strength: raw }),
      ...(includeTests ? { includeTests } : {}),
    }),
  );
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main(process.argv.slice(2));
}
