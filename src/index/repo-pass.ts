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

const PASS_NAME = "declarations";

export interface RepoPassReport {
  mode: "full" | "incremental";
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
export const declarationIndexerVersion = (structuralVersion: string): string =>
  `${structuralVersion}+${DISCONTINUITY_VERSION}+${SIGNATURE_VERSION}`;

function watermarkTopo(
  db: DatabaseSync,
  repoId: number,
  expectedVersion: string,
): number | undefined {
  const row = db.prepare(
    `SELECT c.topo_order AS topoOrder, p.indexer_version AS version
       FROM pass_state p
       JOIN git_commit c ON c.id = p.last_commit_id
      WHERE p.repo_id = ? AND p.pass_name = ?`,
  ).get(repoId, PASS_NAME) as { topoOrder: number; version: string } | undefined;
  if (row && row.version !== expectedVersion) {
    throw new Error(
      `資料庫的 declarations indexer_version 是 ${row.version}，`
      + `目前版本是 ${expectedVersion}。請重建 declarations pass。`,
    );
  }
  return row?.topoOrder;
}

export async function indexRepoStructure(
  db: DatabaseSync,
  repo: string,
  repoId: number,
  indexerVersion: string,
): Promise<RepoPassReport> {
  const t0 = Date.now();
  const { observe, prefetch } = createObserver(repo);
  const declarationVersion = declarationIndexerVersion(indexerVersion);
  const after = watermarkTopo(db, repoId, declarationVersion);
  const report: RepoPassReport = {
    mode: after === undefined ? "full" : "incremental",
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
      hunksByLineage.set(change.lineageId, hunksFor(db, commit.sha, change.path));
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
          prevRevision,
          commitSha: commit.sha,
          entityId: resolved,
          changeLevel: "death",
          sigChanged: false,
        });
        db.prepare(
          "UPDATE entity SET death_commit_id = ? WHERE id = ? AND death_commit_id IS NULL",
        ).run(commit.id, resolved);
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
    db.prepare(
      `INSERT INTO pass_state (repo_id, pass_name, last_commit_id, indexer_version, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, pass_name) DO UPDATE SET
         last_commit_id = excluded.last_commit_id,
         indexer_version = excluded.indexer_version,
         updated_at = excluded.updated_at`,
    ).run(repoId, PASS_NAME, last.id, declarationVersion, new Date().toISOString());
  }

  report.elapsedMs = Date.now() - t0;
  return report;
}
