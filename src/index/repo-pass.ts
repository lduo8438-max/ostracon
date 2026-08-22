import type { DatabaseSync } from "node:sqlite";
import type { DiffHunk } from "../git/types.ts";
import { grammarForPath } from "../ast/parser.ts";
import { SIGNATURE_VERSION } from "../match/signature.ts";
import {
  buildPool,
  changeLevel,
  commitId,
  createEntity,
  createObserver,
  DISCONTINUITY_VERSION,
  discontinuitySimilarity,
  ensureSlot,
  ensureRevision,
  previousDeclarationRecord,
  hunksFor,
  inTransaction,
  matchPools,
  OCCUPANT_REPLACEMENT_MAX_SIMILARITY,
  previousPathEntity,
  previousSlotEntity,
  recreatedPathPredecessor,
  type ObservedDeclaration,
  writeChange,
  writeDiscontinuity,
  writeMatch,
  reconcileEntityDeaths,
} from "./structural.ts";

/**
 * 全 repo 的結構層索引。零 LLM。
 *
 * 與 `indexLineage` 的唯一實質差別：**一個 commit 的候選池涵蓋該次改動的所有檔案**，
 * 而不是單一血緣。這正是 L5（跨檔案搬移與函式抽取）唯一能成立的條件——候選池
 * 只有一個檔案時，跨檔案的配對在定義上不可能出現。
 *
 * 有自己的水位線 `pass_name = 'declarations'`，與走訪層的 `'structural'` 分開：
 * 走訪可以跑完整個 repo，宣告解析可以落後，兩者獨立恢復。
 */

export const DECLARATIONS_PASS_NAME = "declarations";

/**
 * 結構層是由哪一種候選池寫出來的。
 *
 * - `repo`：`indexRepoStructure`，候選池涵蓋整個 commit 的所有檔案。
 * - `lineage`：`indexLineage`，候選池只有一條路徑血緣，**跨檔案搬移在定義上看不見**。
 *
 * 兩者對同一個 entity 會給出不同的 `stable_key`：Osiris 的 `isRateLimited`
 * 在 repo scope 下誕生於 `src/app/api/scanner/route.ts`（6 次改動），在 lineage
 * scope 下誕生於它被搬進 `src/lib/ssrf-guard.ts` 的那一刻（1 次改動）。兩個答案
 * 各自對它看得到的範圍是誠實的，但**不是同一份產出，不得混在同一個資料庫裡**
 * （不變量 7）。
 *
 * `excursion` pass 早就把 scope 編進版本字串了；宣告層沒有，於是實測出這個 bug：
 * 先跑 `why`（lineage）再跑 `why --full`（repo），全 repo pass 會重算整趟、L5 也
 * 確實配對到了，但每一次寫入都撞上 lineage pass 留下的 `revision` 列而直接回傳
 * 既有 id，**算對的答案被整個丟掉**。使用者看到的是 `--full` 靜默無效。
 * 規則本來就寫在衍生層上，只是沒套用到它所依賴的那一層。
 */
export type DeclarationScope = "repo" | "lineage";

/**
 * `mode === "rebuilt"` 時每一支 CLI 都要印的那句話。
 *
 * **共用一個常數而不是各寫一份。** 這個專案已經被「抑制與交代抑制分散在兩個
 * 地方」咬過一次（`why` 的 stated 引文被靜默丟掉），兩份平行的文字一定會分岔。
 * 丟掉使用者既有的索引是同一件事實，不論是哪一支指令觸發的。
 */
export const REBUILD_NOTICE =
  "注意：這個資料庫先前是用單一血緣的候選池建的，看不見跨檔案搬移。"
  + "已作廢重建為全 repo 範圍。";

export interface RepoPassReport {
  /**
   * `rebuilt`：資料庫原本是 lineage scope 的產出，本趟已作廢重建。
   * 與 `full` 分開是因為前者**刪掉了使用者既有的索引**——那件事必須說出來
   * （`REBUILD_NOTICE`）。
   */
  mode: "full" | "incremental" | "rebuilt";
  commitsScanned: number;
  commitsWithDeclarations: number;
  mergesSkipped: number;
  revisions: number;
  matches: number;
  crossFileMatches: number;
  births: number;
  deaths: number;
  discontinuities: number;
  elapsedMs: number;
}

interface CommitRow {
  id: number;
  sha: string;
  topoOrder: number;
  isMerge: number;
}

interface ChangeRow {
  path: string;
  oldPath: string | null;
  changeType: string;
  lineageId: number;
}

interface ObservationTargets {
  prev?: [commit: string, pathName: string];
  next?: [commit: string, pathName: string];
}

/**
 * 複製（C）的目的檔是新血緣，不能把來源假造成它的父版本。prefetch 與實際觀察
 * 必須共用這個判定，否則兩條路徑一漂移就會抓錯內容或退回逐檔 spawn。
 */
function observationTargets(
  change: ChangeRow,
  parent: string | undefined,
  commit: string,
): ObservationTargets {
  const parentPath = change.changeType === "R"
    ? (change.oldPath ?? change.path)
    : change.path;
  const hasParentVersion = change.changeType !== "A" && change.changeType !== "C";
  return {
    prev: parent && hasParentVersion ? [parent, parentPath] : undefined,
    next: change.changeType === "D" ? undefined : [commit, change.path],
  };
}

/** 宣告在整個 repo 內的座標：血緣 + 限定名稱 + 版本內序號。 */
const keyOf = (lineageId: number, o: ObservedDeclaration) =>
  `${lineageId}\0${o.symbol}\0${o.occurrence}`;

/**
 * declarations pass 的版本。
 *
 * **`SIGNATURE_VERSION` 必須在裡面。** 簽章決定 L4/L5 的召回，換了它就可能換掉
 * 配對，進而換掉 `stable_key`。先前它只被寫進每一列 `revision` 的
 * `minhash_version` 欄位，沒有進水位線——結果是改了簽章演算法之後續跑不會報錯，
 * 資料庫裡會靜默混進兩族互不可比的簽章。註解裡寫「換了就要重算」但系統不強制，
 * 那不是規則，是願望。
 */
export const declarationIndexerVersion = (
  structuralVersion: string,
  scope: DeclarationScope,
): string =>
  `${structuralVersion}+${DISCONTINUITY_VERSION}+${SIGNATURE_VERSION}+scope:${scope}`;

/**
 * 作廢整個 repo 的結構層產出。
 *
 * 走 `ON DELETE CASCADE`：`slot` / `entity` 刪掉，`revision`、`revision_match`、
 * `revision_change`、`slot_discontinuity`、`construct`、`excursion` 一併消失。
 * **所以外鍵必須是開的**——不變量 13 說 `PRAGMA foreign_keys` 是每連線設定，
 * 關著的話這裡只會刪掉一半，留下一個比重建前更難察覺的殘骸。半修好的資料庫
 * 比兩個極端都糟，所以這裡斷言而不是預設。
 *
 * 證據層（`source_doc` / `evidence`）刻意不動：它衍生自 commit message，
 * 與結構層的候選池無關，重建結構不該把它一起丟掉。
 */
function discardDeclarations(db: DatabaseSync, repoId: number): void {
  const pragma = db.prepare("PRAGMA foreign_keys").get() as
    { foreign_keys: number } | undefined;
  if (!pragma?.foreign_keys) {
    throw new Error(
      "作廢結構層需要 PRAGMA foreign_keys = ON，否則級聯刪除只會刪掉一半。"
      + "每一條連線都要自己設定一次（不變量 13）。",
    );
  }
  inTransaction(db, () => {
    // excursion 的 entity_id 可為 NULL（construct 型），級聯不保證涵蓋，明刪。
    db.prepare("DELETE FROM excursion WHERE repo_id = ?").run(repoId);
    db.prepare("DELETE FROM revision WHERE repo_id = ?").run(repoId);
    db.prepare("DELETE FROM slot WHERE repo_id = ?").run(repoId);
    db.prepare("DELETE FROM entity WHERE repo_id = ?").run(repoId);
    // 迂迴是結構層的衍生產出，水位線一併歸零，否則它會以為自己還是最新的。
    db.prepare(
      "DELETE FROM pass_state WHERE repo_id = ? AND pass_name IN (?, ?)",
    ).run(repoId, DECLARATIONS_PASS_NAME, "excursion");
  });
}

interface DeclarationState {
  topoOrder: number | undefined;
  version: string;
}

function declarationState(
  db: DatabaseSync,
  repoId: number,
): DeclarationState | undefined {
  // LEFT JOIN，不是 JOIN：lineage pass 記的是 scope 而非 commit 覆蓋率，
  // last_commit_id 是 NULL。用 INNER JOIN 的話那一列會被靜默濾掉，
  // 版本檢查就永遠看不到它——正是這次要修的那種「有算但丟掉」。
  const row = db.prepare(
    `SELECT c.topo_order AS topoOrder, p.indexer_version AS version
       FROM pass_state p
       LEFT JOIN git_commit c ON c.id = p.last_commit_id
      WHERE p.repo_id = ? AND p.pass_name = ?`,
  ).get(repoId, DECLARATIONS_PASS_NAME) as
    { topoOrder: number | null; version: string } | undefined;
  return row === undefined
    ? undefined
    : { topoOrder: row.topoOrder ?? undefined, version: row.version };
}

/**
 * 這個資料庫的宣告層是用哪一種候選池建的。
 *
 * **讀取端必須看得到這件事。** `why` 的快路徑只走單一血緣，搬移守門在那個範圍
 * 下是瞎的，跨檔案搬移看不見，而且匹配不到的宣告會被當成誕生——實測 vuejs/core
 * 上，對一個已經跑過全 repo pass 的資料庫再跑一次 `why`，會多出 3 個假 entity
 * 與約 155 列改動。
 *
 * 索引端已經處理了這件事（marker 降級成 `lineage`，下次 `--full` 會作廢重建），
 * 但**畫面與匯出原本讀得一聲不響**——我自己就從一個被降級的資料庫匯出過線上
 * demo，數字因此比乾淨重建多了 8 列改動與 147 列「沒動」。
 */
export function declarationScopeOf(
  db: DatabaseSync,
  repoId: number,
): DeclarationScope | undefined {
  const version = declarationState(db, repoId)?.version;
  if (version === undefined) return undefined;
  return version.endsWith(":lineage") ? "lineage" : "repo";
}

/** 讀取端看到 `lineage` 時該說的話。一份文字，CLI 與匯出共用。 */
export const PARTIAL_INDEX_NOTICE =
  "這個索引是 `ostracon why` 的快路徑建的，只走單一血緣：跨檔案搬移看不見，"
  + "配不到的宣告會被算成誕生。先跑一次 `ostracon ostracised --repo <repo> --db <db>`"
  + "（或 `why --full`）重建成全 repo 範圍。";

/**
 * 決定這一趟該續跑、該重建、還是該拒絕。
 *
 * 只有一種 scope 不合是可以自動處理的：`lineage` → `repo`。使用者打 `--full`
 * 表達的就是「我要看得到整個 repo」，系統有權替他丟掉一份範圍更小的產出，
 * 而且全 repo pass 實測 1,378 commit 只要 8.88 秒。反方向不作廢——repo scope
 * 的產出對 lineage 的問題已經是正確且更完整的答案。
 *
 * 版本字串在 scope 以外還不同，代表演算法變了。那種情況系統無權替使用者決定
 * 要不要丟掉舊索引，照舊拋錯。
 */
function resolveResumePoint(
  db: DatabaseSync,
  repoId: number,
  structuralVersion: string,
): { after: number | undefined; mode: RepoPassReport["mode"] } {
  const state = declarationState(db, repoId);
  if (state === undefined) return { after: undefined, mode: "full" };

  const expected = declarationIndexerVersion(structuralVersion, "repo");
  if (state.version === expected) {
    return {
      after: state.topoOrder,
      mode: state.topoOrder === undefined ? "full" : "incremental",
    };
  }
  if (state.version === declarationIndexerVersion(structuralVersion, "lineage")) {
    discardDeclarations(db, repoId);
    return { after: undefined, mode: "rebuilt" };
  }
  // 版本字串不符只有兩種可能：scope 不同（上面已自動處理），或演算法變了。
  // 後者代表既有的每一列都是用另一套規則算的，系統無權替使用者決定要不要
  // 丟掉。訊息必須說出「怎麼辦」——只說「請重建」的話，讀的人得先讀原始碼
  // 才知道重建的動作就是刪掉檔案。
  throw new Error(
    `資料庫的 declarations indexer_version 是 ${state.version}，`
    + `目前版本是 ${expected}。\n`
    + "演算法改變後既有的索引不可續跑（不變量 7）。"
    + "請刪除 --db 指向的檔案後重跑，索引會自動重建。",
  );
}

/**
 * 記下結構層是由哪一種 scope 寫出來的。
 *
 * `lineage` scope 傳 `lastCommitId: null`：它做完的是「這幾條血緣」而不是
 * 「到某個 commit 為止的全部」，寫一個 topo 進去會是謊話，而下一趟續跑會信它。
 */
export function recordDeclarationScope(
  db: DatabaseSync,
  repoId: number,
  structuralVersion: string,
  scope: DeclarationScope,
  lastCommitId: number | null,
): void {
  db.prepare(
    `INSERT INTO pass_state (repo_id, pass_name, last_commit_id, indexer_version, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, pass_name) DO UPDATE SET
       last_commit_id = excluded.last_commit_id,
       indexer_version = excluded.indexer_version,
       updated_at = excluded.updated_at`,
  ).run(
    repoId,
    DECLARATIONS_PASS_NAME,
    lastCommitId,
    declarationIndexerVersion(structuralVersion, scope),
    new Date().toISOString(),
  );
}

export async function indexRepoStructure(
  db: DatabaseSync,
  repo: string,
  repoId: number,
  indexerVersion: string,
): Promise<RepoPassReport> {
  const t0 = Date.now();
  const { observe, prefetch } = createObserver(repo);
  const { after, mode } = resolveResumePoint(db, repoId, indexerVersion);
  const report: RepoPassReport = {
    mode,
    commitsScanned: 0,
    commitsWithDeclarations: 0,
    mergesSkipped: 0,
    revisions: 0,
    matches: 0,
    crossFileMatches: 0,
    births: 0,
    deaths: 0,
    discontinuities: 0,
    elapsedMs: 0,
  };

  const commits = db.prepare(
    `SELECT id, sha, topo_order AS topoOrder, is_merge AS isMerge
       FROM git_commit
      WHERE repo_id = ? AND topo_order > ?
      ORDER BY topo_order`,
  ).all(repoId, after ?? -1) as unknown as CommitRow[];

  const changesOf = db.prepare(
    `SELECT path, old_path AS oldPath, change_type AS changeType,
            lineage_id AS lineageId
       FROM file_change WHERE commit_id = ?`,
  );
  const parentOf = db.prepare(
    `SELECT p.sha AS sha
       FROM git_commit_parent e
       JOIN git_commit p ON p.id = e.parent_id
      WHERE e.child_id = ? AND e.ordinal = 0`,
  );

  // 整個 repo 目前每個宣告屬於哪個 entity / revision。
  // 未被本次 commit 觸及的檔案，狀態原封不動留著——那正是「沒有改動」的意思。
  const entityAt = new Map<string, number>();
  const revisionAt = new Map<string, number>();

  for (const commit of commits) {
    report.commitsScanned++;
    if (commit.isMerge === 1) {
      // combined diff 沒有可靠的單一父，被併入分支的改動也會在各自的 commit 走到。
      report.mergesSkipped++;
      continue;
    }
    const parent = (parentOf.get(commit.id) as { sha: string } | undefined)?.sha;
    const changes = (changesOf.all(commit.id) as unknown as ChangeRow[])
      .filter((c) => grammarForPath(c.path) !== undefined);
    if (changes.length === 0) continue;

    // ── 觀察本次改動涉及的所有檔案，前後兩側各一個池 ──────────────────
    const lineageOfPrev = new Map<ObservedDeclaration, number>();
    const lineageOfNext = new Map<ObservedDeclaration, number>();
    const hunksByLineage = new Map<number, DiffHunk[]>();
    const prevDecls: ObservedDeclaration[] = [];
    const nextDecls: ObservedDeclaration[] = [];

    const plans = changes.map((change) => ({
      change,
      targets: observationTargets(change, parent, commit.sha),
      predecessor: change.changeType === "A"
        ? recreatedPathPredecessor(
          db, repoId, change.lineageId, change.path, commit.sha,
        )
        : undefined,
    }));
    prefetch(plans.flatMap(({ targets }) =>
      [targets.prev, targets.next].filter(
        (pair): pair is [string, string] => pair !== undefined,
      )
    ).concat(plans.flatMap(({ change, predecessor }) =>
      predecessor?.finalCommit ? [[predecessor.finalCommit, change.path]] : []
    )));

    const recreatedByLineage = new Map<
      number,
      { predecessor: NonNullable<(typeof plans)[number]["predecessor"]>; previous: ObservedDeclaration[] }
    >();

    for (const { change, targets, predecessor } of plans) {
      const [before, current, previousIncarnation] = await Promise.all([
        targets.prev
          ? observe(...targets.prev)
          : Promise.resolve([] as ObservedDeclaration[]),
        targets.next
          ? observe(...targets.next)
          : Promise.resolve([] as ObservedDeclaration[]),
        predecessor?.finalCommit
          ? observe(predecessor.finalCommit, change.path)
          : Promise.resolve([] as ObservedDeclaration[]),
      ]);
      for (const o of before) {
        lineageOfPrev.set(o, change.lineageId);
        prevDecls.push(o);
      }
      for (const o of current) {
        lineageOfNext.set(o, change.lineageId);
        nextDecls.push(o);
      }
      hunksByLineage.set(change.lineageId, hunksFor(db, repoId, commit.sha, change.path));
      if (predecessor) {
        recreatedByLineage.set(change.lineageId, {
          predecessor,
          previous: previousIncarnation,
        });
      }
    }
    if (prevDecls.length === 0 && nextDecls.length === 0) continue;
    report.commitsWithDeclarations++;

    const prevPool = buildPool(prevDecls, (o) => lineageOfPrev.get(o)!, "prev");
    const nextPool = buildPool(nextDecls, (o) => lineageOfNext.get(o)!, "next");
    const ladder = matchPools(prevPool, nextPool, hunksByLineage);

    const matchedPrev = new Set<string>();
    const matchedNext = new Map<string, { prevKey: string; prevLineage: number }>();
    const matchByNextKey = new Map<string, (typeof ladder.matches)[number]>();
    for (const m of ladder.matches) {
      const before = prevPool.byId.get(m.prev)!;
      const current = nextPool.byId.get(m.next)!;
      const prevLineage = lineageOfPrev.get(before)!;
      const nextLineage = lineageOfNext.get(current)!;
      const prevKey = keyOf(prevLineage, before);
      const nextKey = keyOf(nextLineage, current);
      matchedPrev.add(prevKey);
      matchedNext.set(nextKey, { prevKey, prevLineage });
      matchByNextKey.set(nextKey, m);
      if (prevLineage !== nextLineage) report.crossFileMatches++;
    }
    const prevByKey = new Map(
      prevDecls.map((o) => [keyOf(lineageOfPrev.get(o)!, o), o]),
    );

    // 這個 commit 的所有寫入包成單一 transaction。沒有明確 transaction 時
    // SQLite 每一句都是自己的隱含 transaction。邊界取在單一 commit 而不是整趟：
    // 整趟包成一個的話，一萬個 commit 的 WAL 會膨脹到不可接受，中途失敗也會
    // 把已完成的工作全部丟掉。
    inTransaction(db, () => {
      // ── 存活與變更 ──────────────────────────────────────────────────────
      const touchedKeys = new Set<string>();
      for (const observed of nextDecls) {
        const lineageId = lineageOfNext.get(observed)!;
        const nextKey = keyOf(lineageId, observed);
        touchedKeys.add(nextKey);
        const link = matchedNext.get(nextKey);
        const before = link ? prevByKey.get(link.prevKey) : undefined;
        const slotId = ensureSlot(
          db,
          repoId,
          lineageId,
          observed.symbol,
          observed.kind,
          String(observed.occurrence),
        );
        const previousOccupant = link === undefined
          ? previousSlotEntity(db, slotId, commit.sha)
          : undefined;

        // 匹配到就沿用前像的 entity——跨檔案搬移時 entity 會跟著程式碼走到新檔案，
        // 那正是 entity 血緣與 slot 的差別。沒匹配就是誕生，一律開新 entity。
        //
        // **記憶體 Map 落空時必須回資料庫查。** `entityAt` 每次呼叫都重建，所以
        // 增量續跑的第一批 commit 一定 miss；只看 Map 的話會把「匹配到了但這一趟
        // 還沒見過它」誤判成誕生，在水位線處切斷血緣（實測多出 169 個 entity）。
        // 兩張 Map 在續跑時會同時落空，而它們指的是同一筆記錄，所以只查一次。
        const resumed = link && before
            && (!entityAt.has(link.prevKey) || !revisionAt.has(link.prevKey))
          ? previousDeclarationRecord(db, repoId, link.prevLineage, before, commit.sha)
          : undefined;
        const inherited = link
          ? entityAt.get(link.prevKey) ?? resumed?.entityId
          : undefined;
        const entityId = inherited ?? createEntity(
          db,
          repoId,
          before && parent ? parent : commit.sha,
          before ? before.path : observed.path,
          observed.symbol,
          String(observed.occurrence),
        );

        const nextRevision = ensureRevision(
          db, repo, repoId, lineageId, entityId, observed,
        );
        report.revisions++;

        if (before && link) {
          const prevRevision = revisionAt.get(link.prevKey)
            ?? resumed?.revisionId
            ?? ensureRevision(db, repo, repoId, link.prevLineage, entityId, before);
          writeMatch(db, prevRevision, nextRevision, matchByNextKey.get(nextKey)!);
          report.matches++;
          writeChange(db, {
        repoId,
            prevRevision,
            nextRevision,
            commitSha: commit.sha,
            entityId,
            changeLevel: changeLevel(before.hashes, observed.hashes),
            sigChanged: before.node.text.split("\n", 1)[0]
              !== observed.node.text.split("\n", 1)[0],
          });
          // 前像的座標可能與後像不同（改名或搬檔），舊 key 必須讓出來。
          if (link.prevKey !== nextKey) {
            entityAt.delete(link.prevKey);
            revisionAt.delete(link.prevKey);
          }
        } else {
          report.births++;
          writeChange(db, {
        repoId,
            nextRevision,
            commitSha: commit.sha,
            entityId,
            changeLevel: "birth",
            sigChanged: false,
          });

          const recreated = recreatedByLineage.get(lineageId);
          if (recreated) {
            const sameName = recreated.previous.filter(
              (candidate) => candidate.symbol === observed.symbol,
            );
            const priorEntity = previousPathEntity(
              db,
              repoId,
              recreated.predecessor.lineageId,
              observed.path,
              observed.symbol,
              commit.sha,
            );
            // 同名多載若不能唯一指出前一位就不記。D→A 能證明路徑斷過，
            // 卻不能授權我們任選一個 entity 填進外鍵。
            if (priorEntity !== undefined) {
              writeDiscontinuity(db, {
          repoId,
                slotId,
                commitSha: commit.sha,
                prevEntity: priorEntity,
                nextEntity: entityId,
                similarity: discontinuitySimilarity(
                  sameName.length === 1 ? sameName[0]!.exactNgrams : undefined,
                  observed.exactNgrams,
                ),
              });
              report.discontinuities++;
            }
          } else if (previousOccupant !== undefined) {
            const previousAtSlot = prevByKey.get(nextKey);
            const similarity = discontinuitySimilarity(
              previousAtSlot?.exactNgrams,
              observed.exactNgrams,
            );
            // matcher 沒接起來本身不是斷層證據；只有可精確比較且低於保守門檻
            // 才把同一 slot 的新 entity 宣告成佔用者置換。
            if (
              similarity !== null
              && similarity <= OCCUPANT_REPLACEMENT_MAX_SIMILARITY
            ) {
              writeDiscontinuity(db, {
          repoId,
                slotId,
                commitSha: commit.sha,
                prevEntity: previousOccupant,
                nextEntity: entityId,
                similarity,
              });
              report.discontinuities++;
            }
          }
        }
        entityAt.set(nextKey, entityId);
        revisionAt.set(nextKey, nextRevision);
      }

      // ── 消亡 ────────────────────────────────────────────────────────────
      for (const observed of prevDecls) {
        const lineageId = lineageOfPrev.get(observed)!;
        const prevKey = keyOf(lineageId, observed);
        if (matchedPrev.has(prevKey)) continue;
        // 被本次改動重新佔用的座標不算消亡（同一個 key 上換了新實體）。
        //
        // 這裡與存活分支一樣要處理續跑：`entityAt` 落空時若直接 createEntity，
        // 死亡會被記到一個當場才生出來的 entity 上，而真正該死的那個仍標為存活。
        // 實測 create-t3-app 有 18 個 entity 是這樣多出來的——每個都只有一筆
        // revision，就是那筆為了記死亡而憑空補的。
        const resumed = !entityAt.has(prevKey) || !revisionAt.has(prevKey)
          ? previousDeclarationRecord(db, repoId, lineageId, observed, commit.sha)
          : undefined;
        const entityId = entityAt.get(prevKey) ?? resumed?.entityId;
        const resolved = entityId ?? createEntity(
          db, repoId, parent ?? commit.sha, observed.path,
          observed.symbol, String(observed.occurrence),
        );
        const prevRevision = revisionAt.get(prevKey)
          ?? resumed?.revisionId
          ?? ensureRevision(db, repo, repoId, lineageId, resolved, observed);
        report.deaths++;
        writeChange(db, {
        repoId,
          prevRevision,
          commitSha: commit.sha,
          entityId: resolved,
          changeLevel: "death",
          sigChanged: false,
        });
        // 死亡點由 `reconcileEntityDeaths` 在 pass 結尾依 revision_change 重算。
        if (!touchedKeys.has(prevKey)) {
          entityAt.delete(prevKey);
          revisionAt.delete(prevKey);
        }
      }
    });
  }

  // 水位線只在真的走過 commit 時前進。空批次不動它，避免把「沒東西可做」
  // 誤記成「已經處理到這裡」。
  const last = commits[commits.length - 1];
  if (last) {
    recordDeclarationScope(db, repoId, indexerVersion, "repo", last.id);
  } else if (report.mode === "rebuilt") {
    // 剛作廢完卻一個 commit 都沒有：水位線也被刪了，不補一列的話資料庫會停在
    // 「沒跑過宣告層」的狀態，下一趟又會判成 full。空 repo 才會走到這裡。
    recordDeclarationScope(db, repoId, indexerVersion, "repo", null);
  }

  // 死亡點是衍生欄位，整批依 revision_change 重算——走訪順序與續跑都不影響
  // 結果，而且順手修好舊資料庫。
  reconcileEntityDeaths(db, repoId);

  report.elapsedMs = Date.now() - t0;
  return report;
}
