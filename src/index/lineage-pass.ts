import type { DatabaseSync } from "node:sqlite";
import {
  changeLevel,
  commitId,
  createEntity,
  createObserver,
  discontinuitySimilarity,
  ensureSlot,
  ensureRevision,
  buildPool,
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
 * 對**單一路徑血緣**跑完整的結構層索引：解析、匹配、寫 slot / entity /
 * revision / revision_match / revision_change。零 LLM。
 *
 * 為什麼先做單一血緣而不是整個 repo：`why <path>:<symbol>` 只需要那個檔案的歷史，
 * 而全 repo 版本要處理跨檔案抽取、效能預算與增量水位線，是另一個量級的工作。
 * 這裡的每一行都是全 repo 版本會用到的，差別只在候選池的範圍——先把可以用眼睛
 * 驗證的那條路走通，再擴大範圍。
 */

export interface LineagePassReport {
  commitsProcessed: number;
  revisions: number;
  matches: number;
  births: number;
  deaths: number;
  discontinuities: number;
  /** 因為是合併而跳過的 commit。合併的 combined diff 沒有可靠的單一父。 */
  mergesSkipped: number;
}

interface Touch {
  sha: string;
  path: string;
  oldPath: string | null;
  changeType: string;
  isMerge: boolean;
}

type TouchRow = Omit<Touch, "isMerge"> & { isMerge: number };

/** 這條血緣被哪些 commit 動過，依拓撲序。 */
function touchesOf(db: DatabaseSync, lineageId: number): TouchRow[] {
  return db.prepare(
    `SELECT c.sha AS sha, f.path AS path, f.old_path AS oldPath,
            f.change_type AS changeType, c.is_merge AS isMerge
       FROM file_change f
       JOIN git_commit c ON c.id = f.commit_id
      WHERE f.lineage_id = ?
      ORDER BY c.topo_order`,
  ).all(lineageId) as unknown as TouchRow[];
}

/** 第一父的 sha。走訪層已經記了 parent edge，不必再問 git。 */
function firstParent(db: DatabaseSync, sha: string): string | undefined {
  const row = db.prepare(
    `SELECT p.sha AS sha
       FROM git_commit_parent e
       JOIN git_commit c ON c.id = e.child_id
       JOIN git_commit p ON p.id = e.parent_id
      WHERE c.sha = ? AND e.ordinal = 0`,
  ).get(sha) as { sha: string } | undefined;
  return row?.sha;
}

/** 版本內部的宣告座標。相同原始碼必定產生相同編號，所以跨版本重解析仍對得上。 */
const keyOf = (o: ObservedDeclaration) => `${o.symbol}\0${o.occurrence}`;

export async function indexLineage(
  db: DatabaseSync,
  repo: string,
  repoId: number,
  lineageId: number,
): Promise<LineagePassReport> {
  const { observe, prefetch } = createObserver(repo);
  const report: LineagePassReport = {
    commitsProcessed: 0,
    revisions: 0,
    matches: 0,
    births: 0,
    deaths: 0,
    discontinuities: 0,
    mergesSkipped: 0,
  };

  // 走到目前為止，這個檔案裡每個宣告屬於哪個 entity。
  // key 是**前一個已處理版本**的宣告座標——兩次 touch 之間檔案內容不變，
  // 所以下次以父版本重新解析時會得到同一組座標。
  let entityAt = new Map<string, number>();
  let revisionAt = new Map<string, number>();

  for (const raw of touchesOf(db, lineageId)) {
    const touch: Touch = { ...raw, isMerge: raw.isMerge === 1 };
    if (touch.isMerge) {
      // combined diff 沒有可靠的單一父 hunk，也不該把被併入分支的改動重算一次。
      report.mergesSkipped++;
      continue;
    }
    const parent = firstParent(db, touch.sha);
    const predecessor = touch.changeType === "A"
      ? recreatedPathPredecessor(db, repoId, lineageId, touch.path, touch.sha)
      : undefined;
    if (predecessor) {
      const indexed = db.prepare(
        "SELECT 1 AS ok FROM revision WHERE lineage_id = ? LIMIT 1",
      ).get(predecessor.lineageId) as { ok: number } | undefined;
      if (!indexed) {
        // why 的快速路徑平常只索引目前血緣。路徑重現若不先補舊血緣，
        // `prev_entity` 就只能捏造；遞迴只沿著更早的 D→A，拓撲序嚴格遞減。
        await indexLineage(db, repo, repoId, predecessor.lineageId);
      }
    }
    // 改名時父版本的路徑不同；血緣追的是檔案，不是路徑字串。
    // 只有改名（R）的前像在另一個路徑上；複製（C）的目的檔是**新血緣**，
    // 在它自己的血緣裡沒有前像版本。把來源當成父會做錯兩件事：來源檔的宣告
    // 被重複算進候選池，且 entity 會對到不存在的座標。搬移仍能被接住——
    // 靠的是跨檔案的候選池與 L5，不是假造一個父版本。
    const parentPath = touch.changeType === "R"
      ? (touch.oldPath ?? touch.path)
      : touch.path;
    const hasParentVersion = touch.changeType !== "A" && touch.changeType !== "C";
    const pairs: Array<[string, string]> = [];
    if (parent && hasParentVersion) pairs.push([parent, parentPath]);
    if (touch.changeType !== "D") pairs.push([touch.sha, touch.path]);
    if (predecessor?.finalCommit) pairs.push([predecessor.finalCommit, touch.path]);
    prefetch(pairs);

    const [prev, next, previousIncarnation] = await Promise.all([
      parent && hasParentVersion
        ? observe(parent, parentPath)
        : Promise.resolve([] as ObservedDeclaration[]),
      touch.changeType === "D"
        ? Promise.resolve([] as ObservedDeclaration[])
        : observe(touch.sha, touch.path),
      predecessor?.finalCommit
        ? observe(predecessor.finalCommit, touch.path)
        : Promise.resolve([] as ObservedDeclaration[]),
    ]);
    if (prev.length === 0 && next.length === 0) continue;
    report.commitsProcessed++;

    const prevPool = buildPool(prev, () => lineageId, "prev");
    const nextPool = buildPool(next, () => lineageId, "next");
    const ladder = matchPools(
      prevPool,
      nextPool,
      new Map([[lineageId, hunksFor(db, touch.sha, touch.path)]]),
    );
    // 用對照表把匹配還原成宣告座標，不從 id 字串切——id 是不透明識別碼。
    const matchedPrev = new Map<string, string>(); // prevKey → nextKey
    const matchedNext = new Map<string, string>(); // nextKey → prevKey
    const matchByNextKey = new Map<string, (typeof ladder.matches)[number]>();
    for (const m of ladder.matches) {
      const prevKey = keyOf(prevPool.byId.get(m.prev)!);
      const nextKey = keyOf(nextPool.byId.get(m.next)!);
      matchedPrev.set(prevKey, nextKey);
      matchedNext.set(nextKey, prevKey);
      matchByNextKey.set(nextKey, m);
    }

    const byKeyPrev = new Map(prev.map((o) => [keyOf(o), o]));
    const nextEntities = new Map<string, number>();
    const nextRevisions = new Map<string, number>();

    // 與 repo-pass 同樣的邊界：一個 commit 一個 transaction。
    inTransaction(db, () => {
      // ── 存活與變更 ──────────────────────────────────────────────────────
      for (const observed of next) {
        const nextKey = keyOf(observed);
        const prevKey = matchedNext.get(nextKey);
        const before = prevKey ? byKeyPrev.get(prevKey) : undefined;
        const slotId = ensureSlot(
          db,
          repoId,
          lineageId,
          observed.symbol,
          observed.kind,
          String(observed.occurrence),
        );
        const previousOccupant = prevKey === undefined
          ? previousSlotEntity(db, slotId, touch.sha)
          : undefined;

        // 匹配到的**沿用前像的 entity**；那是 entity 血緣的全部意義。
        // 沒有匹配就是誕生，一律開新 entity——不得因為 slot 上已經有東西就重用它，
        // 否則舊實體被改名搬走、新同名宣告補上時，兩段血緣會被合併成一個，
        // 時間軸會出現「同一個 entity 誕生兩次」。
        const inherited = prevKey ? entityAt.get(prevKey) : undefined;
        const entityId = inherited ?? createEntity(
          db,
          repoId,
          // 有前像代表它在父 commit 就存在，只是我們第一次觀測到；否則誕生於本次。
          before && parent ? parent : touch.sha,
          before ? parentPath : touch.path,
          observed.symbol,
          String(observed.occurrence),
        );

        const nextRevision = ensureRevision(
          db, repo, repoId, lineageId, entityId, observed,
        );
        report.revisions++;
        nextEntities.set(nextKey, entityId);
        nextRevisions.set(nextKey, nextRevision);

        if (before) {
          const prevRevision = prevKey !== undefined && revisionAt.has(prevKey)
            ? revisionAt.get(prevKey)!
            : ensureRevision(db, repo, repoId, lineageId, entityId, before);
          writeMatch(db, prevRevision, nextRevision, matchByNextKey.get(nextKey)!);
          report.matches++;
          writeChange(db, {
            prevRevision,
            nextRevision,
            commitSha: touch.sha,
            entityId,
            changeLevel: changeLevel(before.hashes, observed.hashes),
            sigChanged: before.node.text.split("\n", 1)[0]
              !== observed.node.text.split("\n", 1)[0],
          });
        } else {
          report.births++;
          writeChange(db, {
            nextRevision,
            commitSha: touch.sha,
            entityId,
            changeLevel: "birth",
            sigChanged: false,
          });

          if (predecessor) {
            const sameName = previousIncarnation.filter(
              (candidate) => candidate.symbol === observed.symbol,
            );
            const priorEntity = previousPathEntity(
              db,
              repoId,
              predecessor.lineageId,
              observed.path,
              observed.symbol,
              touch.sha,
            );
            if (priorEntity !== undefined) {
              writeDiscontinuity(db, {
                slotId,
                commitSha: touch.sha,
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
            const previousAtSlot = byKeyPrev.get(nextKey);
            const similarity = discontinuitySimilarity(
              previousAtSlot?.exactNgrams,
              observed.exactNgrams,
            );
            if (
              similarity !== null
              && similarity <= OCCUPANT_REPLACEMENT_MAX_SIMILARITY
            ) {
              writeDiscontinuity(db, {
                slotId,
                commitSha: touch.sha,
                prevEntity: previousOccupant,
                nextEntity: entityId,
                similarity,
              });
              report.discontinuities++;
            }
          }
        }
      }

      // ── 消亡 ────────────────────────────────────────────────────────────
      for (const observed of prev) {
        const prevKey = keyOf(observed);
        if (matchedPrev.has(prevKey)) continue;
        const entityId = entityAt.get(prevKey);
        // 沒有既有 entity 代表它在我們的觀測範圍內只出現過一次就消失了；
        // 仍要記一筆 death，否則時間軸會缺一段。
        const resolved = entityId ?? createEntity(
          db, repoId, parent ?? touch.sha, parentPath,
          observed.symbol, String(observed.occurrence),
        );
        const prevRevision = revisionAt.get(prevKey)
          ?? ensureRevision(db, repo, repoId, lineageId, resolved, observed);
        report.deaths++;
        writeChange(db, {
          prevRevision,
          commitSha: touch.sha,
          entityId: resolved,
          changeLevel: "death",
          sigChanged: false,
        });
        db.prepare(
          "UPDATE entity SET death_commit_id = ? WHERE id = ? AND death_commit_id IS NULL",
        ).run(commitId(db, touch.sha), resolved);
      }
    });

    entityAt = nextEntities;
    revisionAt = nextRevisions;
  }

  return report;
}
