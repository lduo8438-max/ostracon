import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./structural.ts";

/**
 * 迂迴偵測（entity 層級）。**零 LLM、零網路。**
 *
 * 「哪些做法試過又被推翻」是這個專案的命名由來（ostracised approaches）。
 * 一個 entity 在觀測範圍內誕生又死亡，就是候選；證據強度決定它能不能被當成
 * 結論陳述。
 *
 * **不需要 `construct_span`。** schema 的 `excursion` 是 `entity_id` XOR
 * `construct_id`，entity 層級用現有的 `entity` / `revision` 就夠。
 * construct 層級（整個模組或方案被推翻）是另一個切片。
 */

/** `architecture.md` §5 的強度分級。A > B > C。 */
export type ExcursionStrength = "A" | "B" | "C";
export type ExcursionMethod =
  | "git_revert"
  | "inverse_diff"
  | "short_lifecycle"
  | "trajectory";

/**
 * 搬移守門能看到多遠。**這決定了結果的意義，所以它必須進版本字串。**
 *
 * - `repo`：整個 repo 都已索引（`indexRepoStructure`），守門看得到所有檔案。
 * - `lineage`：只索引了部分血緣（`indexLineage`），守門**是瞎的**——搬到未索引
 *   檔案的內容查不到，會被誤判成迂迴。
 *
 * 同一個 entity 在兩種 scope 下可以得到不同答案，所以它們不是同一份產出，
 * 不得混進同一個資料庫而不重算（不變量 7）。scope 從 `lineage` 升級到 `repo`
 * 時版本字串改變，水位線檢查會自動要求重算。
 */
export type MoveGuardScope = "repo" | "lineage";

const EXCURSION_ALGORITHM = "excursion-1.0.0+inverse-raw+move-guard";

export const excursionVersion = (scope: MoveGuardScope): string =>
  `${EXCURSION_ALGORITHM}+scope:${scope}`;

const PASS_NAME = "excursion";

export interface ExcursionReport {
  /**
   * `up-to-date` 代表水位線已在 repo 頂端且版本相同，**這一趟完全沒有掃描**：
   * `candidates` 與 `excludedAsMoved` 會是 0，而 `byStrength` / `byMethod`
   * 讀自資料庫既有的列。把「沒掃描」與「掃了但沒東西」分開，理由與 golden runner
   * 分開 `pass` / `missing` 相同——混為一談會讓 0 同時代表兩件相反的事。
   */
  status: "detected" | "up-to-date";
  scope: MoveGuardScope;
  /** 本趟掃描的候選數。`up-to-date` 時為 0。 */
  candidates: number;
  /** 內容在死亡當下或之後仍存在於別處——是搬移不是迂迴，直接排除 */
  excludedAsMoved: number;
  byStrength: Record<ExcursionStrength, number>;
  byMethod: Record<string, number>;
}

interface EntityRow {
  id: number;
  birthSha: string;
  deathSha: string;
  birthAt: string;
  deathAt: string;
  deathTopo: number;
  deathSubject: string;
  firstRaw: string;
  lastRaw: string;
  lastAlpha: string;
  revisions: number;
}

/**
 * 候選：誕生與死亡都落在觀測範圍內的 entity。
 *
 * 只取尚存活（`death_commit_id IS NULL`）以外的——還活著的東西不可能是迂迴。
 */
function candidates(db: DatabaseSync, repoId: number): EntityRow[] {
  return db.prepare(
    `SELECT e.id AS id,
            bc.sha AS birthSha, dc.sha AS deathSha,
            bc.authored_at AS birthAt, dc.authored_at AS deathAt,
            dc.topo_order AS deathTopo,
            CASE WHEN instr(dc.message, char(10)) > 0
                 THEN substr(dc.message, 1, instr(dc.message, char(10)) - 1)
                 ELSE dc.message END AS deathSubject,
            (SELECT r.hash_raw FROM revision r
              WHERE r.entity_id = e.id ORDER BY r.id LIMIT 1) AS firstRaw,
            (SELECT r.hash_raw FROM revision r
              WHERE r.entity_id = e.id ORDER BY r.id DESC LIMIT 1) AS lastRaw,
            (SELECT r.hash_alpha FROM revision r
              WHERE r.entity_id = e.id ORDER BY r.id DESC LIMIT 1) AS lastAlpha,
            (SELECT COUNT(*) FROM revision r WHERE r.entity_id = e.id) AS revisions
       FROM entity e
       JOIN git_commit bc ON bc.id = e.birth_commit_id
       JOIN git_commit dc ON dc.id = e.death_commit_id
      WHERE e.repo_id = ?
      ORDER BY e.id`,
  ).all(repoId) as unknown as EntityRow[];
}

/**
 * 這段內容是否在死亡當下或之後仍存在於**別的 entity** 上。
 *
 * **這道守門非做不可。** 實測 create-t3-app：117 個「內容逐字未變即被移除」的
 * 候選裡有 15 個（13%）其實是 matcher 漏接的搬移——例如 `MyApp` 從
 * `template-prisma/src/pages/_app.tsx` 被搬到
 * `cli/template/extras/src/pages/_app/base.tsx`，模板目錄大規模重構讓 L5 的
 * bucket 唯一性失敗。少了這道守門，13% 的迂迴會是假的。
 *
 * 而「這個做法被推翻了」講錯的代價與誤報斷層同級：它讓使用者相信一段
 * 從未發生的歷史。
 *
 * 先比 `hash_raw`（逐字），再比 `hash_alpha`（僅局部改名後搬走）。
 *
 * **判準是「另一個 entity 在我們死亡時仍活著」，不是「有 revision 落在死亡之後」。**
 * `revision` 只在檔案被觸及時才寫入，所以搬過去的副本如果之後再也沒被改動，
 * 用 revision 的 topo_order 去查會完全漏掉它——測試就是這樣抓到的，
 * 而先前在 create-t3-app 上量到的 13% 因此是低估。
 */
function stillExistsElsewhere(
  db: DatabaseSync,
  entity: EntityRow,
): boolean {
  const query = (column: "hash_raw" | "hash_alpha", value: string) =>
    db.prepare(
      `SELECT 1 AS ok
         FROM entity o
         JOIN revision r ON r.entity_id = o.id
         LEFT JOIN git_commit dc ON dc.id = o.death_commit_id
        WHERE r.${column} = ?
          AND o.id <> ?
          AND (o.death_commit_id IS NULL OR dc.topo_order >= ?)
        LIMIT 1`,
    ).get(value, entity.id, entity.deathTopo) !== undefined;

  return query("hash_raw", entity.lastRaw) || query("hash_alpha", entity.lastAlpha);
}

/** git 的 revert commit 標題。`Revert "…"` 與 `Revert '…'` 都算。 */
const REVERT_SUBJECT = /^revert[\s:"']/i;

/**
 * 判定強度與方法。
 *
 * A 級只有兩條路，都是純結構、可獨立驗證：
 *   - `git_revert`：死亡 commit 本身就是 revert。
 *   - `inverse_diff`：移除掉的正是當初加入的——`hash_raw` 從首到末未變，
 *     所以移除的 diff 就是引入的 diff 的反向。
 *
 * **B 級這一片不做。** 它需要文字證據與 entity 的關聯，而現有的 evidence
 * 掛在 commit 上而不是 entity 上（眼檢已發現「理由引文 span-correct 但未必
 * entity-relevant」）。硬接會產生看似有據實則無關的宣稱。
 *
 * 其餘一律 C 級，UI 必須標「疑似」，不得作為結論陳述。
 */
function classify(entity: EntityRow): {
  strength: ExcursionStrength;
  method: ExcursionMethod;
} {
  if (REVERT_SUBJECT.test(entity.deathSubject)) {
    return { strength: "A", method: "git_revert" };
  }
  if (entity.firstRaw === entity.lastRaw) {
    return { strength: "A", method: "inverse_diff" };
  }
  // 只被觀測到一次就消失：生命週期符合，但沒有任何反向證據。
  return {
    strength: "C",
    method: entity.revisions <= 1 ? "short_lifecycle" : "trajectory",
  };
}

/**
 * `duration_days` 是**屬性不是門檻**：三週後撤掉是試錯，三年後撤掉是技術演進，
 * 兩者都有價值但意義不同，讓使用者自己過濾。
 *
 * **用 `authored_at` 而不是 `committed_at`。** committer 時間會被 rebase、
 * cherry-pick 與 amend 重寫：Osiris 的 99 個 commit 只有 88 個相異的 committer
 * 時間，而引入與移除這個 fixture 案例的兩個 commit 的 committer 時間**完全相同**，
 * 算出來的存活時間會是 0 天。author 時間是程式碼實際被寫下的時刻，
 * 那才是「這個做法活了多久」的誠實答案。
 */
function durationDays(birthAt: string, deathAt: string): number {
  const ms = Date.parse(deathAt) - Date.parse(birthAt);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, ms / 86_400_000);
}

/**
 * 斷言這個資料庫的迂迴資料是**全 repo scope 且掃到頂端**的。
 *
 * 清單查詢的呼叫端非用不可：一份「被推翻的做法」名單如果建立在瞎掉的搬移守門上，
 * 裡面會混進大量其實只是被搬走的東西（實測 41%）。**寧可拒絕輸出也不給半套名單**
 * ——使用者無從分辨名單是完整的還是殘缺的，而錯誤的那一半看起來與正確的一模一樣。
 */
export function assertExcursionScope(db: DatabaseSync, repoId: number): void {
  const tip = db.prepare(
    "SELECT id FROM git_commit WHERE repo_id = ? ORDER BY topo_order DESC LIMIT 1",
  ).get(repoId) as { id: number } | undefined;
  if (tip === undefined) throw new Error("這個 repo 還沒有任何 commit 被索引。");

  const state = db.prepare(
    `SELECT last_commit_id AS lastCommitId, indexer_version AS version
       FROM pass_state WHERE repo_id = ? AND pass_name = ?`,
  ).get(repoId, PASS_NAME) as
    { lastCommitId: number | null; version: string } | undefined;

  const expected = excursionVersion("repo");
  if (state === undefined) {
    throw new Error("這個資料庫還沒跑過迂迴偵測。");
  }
  if (state.version !== expected) {
    throw new Error(
      `迂迴資料的版本是 ${state.version}，需要 ${expected}。`
      + "搬移守門必須看得到整個 repo，否則名單會混進只是被搬走的東西。",
    );
  }
  if (state.lastCommitId !== tip.id) {
    throw new Error("迂迴水位線落後於索引終點，請重跑後再查詢。");
  }
}

/** 從資料庫既有的列彙總，供 `up-to-date` 時回報。 */
function summarize(db: DatabaseSync, repoId: number): Pick<
  ExcursionReport,
  "byStrength" | "byMethod"
> {
  const byStrength: Record<ExcursionStrength, number> = { A: 0, B: 0, C: 0 };
  const byMethod: Record<string, number> = {};
  const rows = db.prepare(
    `SELECT strength, method, COUNT(*) AS n
       FROM excursion WHERE repo_id = ? AND entity_id IS NOT NULL
      GROUP BY strength, method`,
  ).all(repoId) as unknown as Array<
    { strength: ExcursionStrength; method: string; n: number }
  >;
  for (const row of rows) {
    byStrength[row.strength] += row.n;
    byMethod[row.method] = (byMethod[row.method] ?? 0) + row.n;
  }
  return { byStrength, byMethod };
}

export function detectExcursions(
  db: DatabaseSync,
  repoId: number,
  options: { scope: MoveGuardScope },
): ExcursionReport {
  const version = excursionVersion(options.scope);
  const report: ExcursionReport = {
    status: "detected",
    scope: options.scope,
    candidates: 0,
    excludedAsMoved: 0,
    byStrength: { A: 0, B: 0, C: 0 },
    byMethod: {},
  };

  const tip = db.prepare(
    "SELECT id FROM git_commit WHERE repo_id = ? ORDER BY topo_order DESC LIMIT 1",
  ).get(repoId) as { id: number } | undefined;
  // repo 裡一個 commit 都沒有：沒有東西可判，也不該動水位線。
  if (tip === undefined) return report;

  const state = db.prepare(
    `SELECT last_commit_id AS lastCommitId, indexer_version AS version
       FROM pass_state WHERE repo_id = ? AND pass_name = ?`,
  ).get(repoId, PASS_NAME) as
    { lastCommitId: number | null; version: string } | undefined;
  // 水位線已在頂端且版本相同：整趟跳過。這是全表掃描，重跑代價不是零。
  // 版本不同就必須重算——scope 從 lineage 升級到 repo 時答案會變。
  if (state && state.version === version && state.lastCommitId === tip.id) {
    return { ...report, status: "up-to-date", ...summarize(db, repoId) };
  }

  const commitId = db.prepare(
    "SELECT id FROM git_commit WHERE repo_id = ? AND sha = ?",
  );
  const insert = db.prepare(
    `INSERT INTO excursion
       (repo_id, entity_id, construct_id, introduce_commit, remove_commit,
        duration_days, strength, method, score)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entity_id, introduce_commit, remove_commit)
       WHERE entity_id IS NOT NULL
     DO UPDATE SET
       duration_days = excluded.duration_days,
       strength = excluded.strength,
       method = excluded.method,
       score = excluded.score`,
  );

  // 重跑時的過期列必須清掉，但**不能整表刪**：`claim.excursion_id` 是
  // ON DELETE CASCADE，整表刪會連帶清掉掛在上面的 claim。所以只刪「這一趟判定
  // 不再成立」的那些——例如上一趟判成迂迴、這一趟才發現內容其實搬到別處。
  db.exec(
    "CREATE TEMP TABLE IF NOT EXISTS excursion_keep (entity_id INTEGER PRIMARY KEY)",
  );
  db.exec("DELETE FROM excursion_keep");
  const keep = db.prepare("INSERT OR IGNORE INTO excursion_keep VALUES (?)");

  const rows = candidates(db, repoId);
  inTransaction(db, () => {
    for (const entity of rows) {
      report.candidates++;
      // 搬移不是迂迴。先擋掉再分級——被搬走的東西連 C 級都不該給，
      // 因為它根本沒有消失。
      if (stillExistsElsewhere(db, entity)) {
        report.excludedAsMoved++;
        continue;
      }
      const { strength, method } = classify(entity);
      const birth = commitId.get(repoId, entity.birthSha) as { id: number } | undefined;
      const death = commitId.get(repoId, entity.deathSha) as { id: number } | undefined;
      if (birth === undefined || death === undefined) continue;

      insert.run(
        repoId,
        entity.id,
        birth.id,
        death.id,
        durationDays(entity.birthAt, entity.deathAt),
        strength,
        method,
        null,
      );
      keep.run(entity.id);
      report.byStrength[strength]++;
      report.byMethod[method] = (report.byMethod[method] ?? 0) + 1;
    }

    db.prepare(
      `DELETE FROM excursion
        WHERE repo_id = ? AND entity_id IS NOT NULL
          AND entity_id NOT IN (SELECT entity_id FROM excursion_keep)`,
    ).run(repoId);

    // 水位線與 declarations 分開：結構層可以先跑完，迂迴偵測可以落後。
    db.prepare(
      `INSERT INTO pass_state
         (repo_id, pass_name, last_commit_id, indexer_version, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, pass_name) DO UPDATE SET
         last_commit_id = excluded.last_commit_id,
         indexer_version = excluded.indexer_version,
         updated_at = excluded.updated_at`,
    ).run(repoId, PASS_NAME, tip.id, version, new Date().toISOString());
  });

  return report;
}
