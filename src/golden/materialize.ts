#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml } from "yaml";
import { changeLevel } from "../ast/hash.ts";
import { verifyParserAdapters } from "../ast/parser.ts";
import { indexGit, INDEXER_VERSION } from "../git/index.ts";
import { detectExcursions } from "../index/excursion.ts";
import { indexRepoStructure } from "../index/repo-pass.ts";
import { matchLadder, type Candidate } from "../match/ladder.ts";
import { exactJaccard } from "../match/signature.ts";
import { indexLineage } from "../index/lineage-pass.ts";
// 結構層的寫入語意與產品 pass 共用同一份實作。各寫一份的話，黃金測試集驗證的
// 就不是產品實際跑的程式碼。
import {
  commitId,
  createObserver,
  ensureEntity,
  ensureRevision,
  ensureSlot,
  hunksFor,
  isParentOf,
  lineageIdAt,
  lineRange,
  type ObservedDeclaration,
  parentOf,
} from "../index/structural.ts";

interface Anchor {
  commit: string;
  path: string;
  symbol: string;
  occurrence?: number;
}

interface FixtureCase {
  id: string;
  kind: string;
  difficulty: string;
  label_confidence?: "certain" | "probable" | "ambiguous";
  expect?: string;
  at_commit?: string;
  introduce_at?: string;
  remove_at?: string;
  entity?: { path: string; symbol: string };
  slot?: { path: string; symbol: string };
  chain?: Array<{
    anchor: Anchor;
    transition?: { expect_tier_at_most: string };
  }>;
  accept_any_of?: Array<{
    chain: Array<{
      anchor: Anchor;
      transition?: { expect_tier_at_most: string };
    }>;
  }>;
}

interface Fixture {
  repo: { index_until: string };
  cases: FixtureCase[];
}


export async function materializeGoldenCoordinates(
  repo: string,
  fixturePath: string,
  dbPath: string,
): Promise<{
  changeLevels: number;
  lineageTransitions: number;
  discontinuities: number;
  excursions: number;
}> {
  const fixture = parseYaml(readFileSync(fixturePath, "utf8")) as Fixture;
  if (existsSync(dbPath)) {
    throw new Error(`資料庫已存在：${dbPath}；請換新路徑，避免混入舊索引`);
  }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const schema = readFileSync(
    new URL("../../db/schema.sql", import.meta.url),
    "utf8",
  );
  const init = new DatabaseSync(dbPath);
  init.exec(schema);
  init.close();

  await verifyParserAdapters();
  const gitReport = indexGit(repo, {
    dbPath,
    until: fixture.repo.index_until,
  });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  const { observe: observeAll } = createObserver(repo);
  const observe = async (
    commit: string,
    pathName: string,
    symbol: string,
    occurrence = 0,
  ): Promise<ObservedDeclaration | undefined> =>
    (await observeAll(commit, pathName))
      .filter((declaration) => declaration.symbol === symbol)[occurrence];

  let changeLevels = 0;
  let lineageTransitions = 0;
  let discontinuities = 0;
  let excursions = 0;
  try {
    for (const c of fixture.cases.filter((item) => item.kind === "change_level")) {
      if (!c.at_commit || !c.entity) continue;
      const parent = parentOf(repo, c.at_commit);
      const [prev, next] = await Promise.all([
        parent
          ? observe(parent, c.entity.path, c.entity.symbol)
          : Promise.resolve(undefined),
        observe(c.at_commit, c.entity.path, c.entity.symbol),
      ]);
      if (!prev && !next) continue;
      const lineageId =
        lineageIdAt(db, c.at_commit, c.entity.path)
        ?? (parent ? lineageIdAt(db, parent, c.entity.path) : undefined);
      if (lineageId === undefined) continue;
      const representative = next ?? prev!;
      const slotId = ensureSlot(
        db,
        gitReport.repoId,
        lineageId,
        c.entity.symbol,
        representative.kind,
        String(representative.occurrence),
      );
      const birthSha = prev ? parent! : c.at_commit;
      const entityId = ensureEntity(
        db,
        gitReport.repoId,
        slotId,
        birthSha,
        c.entity.path,
        c.entity.symbol,
        String(representative.occurrence),
      );
      const prevRevision = prev && parent
        ? ensureRevision(db, repo, gitReport.repoId, lineageId, entityId, prev)
        : undefined;
      const nextRevision = next
        ? ensureRevision(db, repo, gitReport.repoId, lineageId, entityId, next)
        : undefined;
      const actual = !prev
        ? "birth"
        : !next
          ? "death"
          : changeLevel(prev.hashes, next.hashes);
      db.prepare(
        `INSERT INTO revision_change
           (prev_revision, next_revision, commit_id, entity_id, change_level, sig_changed)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (commit_id, entity_id) DO UPDATE SET
           prev_revision = excluded.prev_revision,
           next_revision = excluded.next_revision,
           change_level = excluded.change_level,
           sig_changed = excluded.sig_changed`,
      ).run(
        prevRevision ?? null,
        nextRevision ?? null,
        commitId(db, c.at_commit),
        entityId,
        actual,
        prev && next && prev.node.text.split("\n", 1)[0] !== next.node.text.split("\n", 1)[0]
          ? 1
          : 0,
      );
      changeLevels++;
    }

    // discontinuity 的錨點仍是純 git 座標。讓產品的 lineage pass 實際建立
    // slot_discontinuity，而不是在 golden 裡另寫一套只會通過 fixture 的捷徑。
    for (const c of fixture.cases.filter((item) => item.kind === "discontinuity")) {
      if (!c.at_commit || !c.slot) continue;
      const lineageId = lineageIdAt(db, c.at_commit, c.slot.path);
      if (lineageId === undefined) continue;
      await indexLineage(db, repo, gitReport.repoId, lineageId);
    }

    // excursion 走產品的偵測器，不在 golden 裡另寫一套只會通過 fixture 的捷徑。
    //
    // **必須是全 repo pass。** 搬移守門要回答「有沒有一份相同的內容活得比它久」，
    // 而那個問題只在候選池涵蓋整個 repo 時才答得出來。先前這裡只索引錨點檔案的
    // 血緣、以 `scope: "lineage"` 呼叫，守門在那裡是瞎的——`expect: absent` 的
    // 負例（「這不是迂迴，因為內容搬到別的檔案了」）在那種 scope 下必然失敗，
    // 因為偵測器根本看不到那個檔案。
    //
    // 代價是這類 fixture 要跑全 repo pass（Osiris 約 5 秒）。這是必要的：
    // `assertExcursionScope` 已經編碼了同一條原則——守門看不到整個 repo 時，
    // 迂迴的結論不可採信。
    const excursionCases = fixture.cases.filter((item) => item.kind === "excursion");
    if (excursionCases.length > 0) {
      await indexRepoStructure(db, repo, gitReport.repoId, INDEXER_VERSION);
      detectExcursions(db, gitReport.repoId, { scope: "repo" });
    }

    for (const c of fixture.cases.filter((item) => item.kind === "lineage")) {
      const chains = c.label_confidence === "ambiguous"
        ? (c.accept_any_of ?? []).map((option) => option.chain)
        : [c.chain ?? []];
      for (const chain of chains) {
        for (let i = 1; i < chain.length; i++) {
        const prevAnchor = chain[i - 1]!.anchor;
        const nextAnchor = chain[i]!.anchor;
        const [prevPool, nextPool] = await Promise.all([
          observeAll(prevAnchor.commit, prevAnchor.path),
          observeAll(nextAnchor.commit, nextAnchor.path),
        ]);
        const prev = prevPool
          .filter((declaration) => declaration.symbol === prevAnchor.symbol)[
            prevAnchor.occurrence ?? 0
          ];
        const next = nextPool
          .filter((declaration) => declaration.symbol === nextAnchor.symbol)[
            nextAnchor.occurrence ?? 0
          ];
        if (!prev || !next) continue;
        const prevLineage = lineageIdAt(db, prev.commit, prev.path);
        const nextLineage = lineageIdAt(db, next.commit, next.path);
        if (prevLineage === undefined || nextLineage === undefined) continue;
        const candidates = (
          side: "prev" | "next",
          declarations: ObservedDeclaration[],
          lineageId: number,
        ): Candidate[] => declarations.map((o) => ({
          id: `${side}\0${o.symbol}\0${o.occurrence}`,
          lineageId,
          qualifiedName: o.symbol,
          // disambiguator 的正式定義屬於下一個設計決定；此處刻意不先用
          // occurrence 偷渡答案，讓 L1 唯一性規則接受真實候選池檢驗。
          kind: o.kind,
          hashes: o.hashes,
          signature: o.signature,
          path: o.path,
          startIndex: o.node.startIndex,
          ...lineRange(o),
        }));
        const prevCandidates = candidates("prev", prevPool, prevLineage);
        const nextCandidates = candidates("next", nextPool, nextLineage);
        const exact = new Map<string, Set<number>>();
        for (const [side, pool] of [
          ["prev", prevPool],
          ["next", nextPool],
        ] as const) {
          for (const declaration of pool) {
            exact.set(
              `${side}\0${declaration.symbol}\0${declaration.occurrence}`,
              declaration.exactNgrams,
            );
          }
        }
        // hunk 描述的是「next commit 相對它的父」。鏈上的兩個錨點若不是父子，
        // 那份 hunk 就不是這一步的差異，餵下去會算出錯誤的位置。寧可不給。
        const hunks = isParentOf(db, prev.commit, next.commit)
          ? hunksFor(db, next.commit, next.path)
          : undefined;
        const ladder = matchLadder(
          prevCandidates,
          nextCandidates,
          {
            verify: (p, n) => exactJaccard(exact.get(p.id)!, exact.get(n.id)!),
            // 零列代表「沒有 hunk 證據」（合併、二進位），不是「沒有改動」，
            // 所以不建鍵而不是建一個空陣列。
            ...(hunks && hunks.length > 0
              ? { hunksByLineage: new Map([[nextLineage, hunks]]) }
              : {}),
          },
        );
        const targetPrevId = `prev\0${prev.symbol}\0${prev.occurrence}`;
        const targetNextId = `next\0${next.symbol}\0${next.occurrence}`;
        const matched = ladder.matches.find(
          (match) => match.prev === targetPrevId && match.next === targetNextId,
        );

        const prevSlot = ensureSlot(
          db,
          gitReport.repoId,
          prevLineage,
          prev.symbol,
          prev.kind,
          String(prev.occurrence),
        );
        const prevEntity = ensureEntity(
          db,
          gitReport.repoId,
          prevSlot,
          prev.commit,
          prev.path,
          prev.symbol,
          String(prev.occurrence),
        );
        const prevRevision = ensureRevision(
          db,
          repo,
          gitReport.repoId,
          prevLineage,
          prevEntity,
          prev,
        );
        const nextSlot = ensureSlot(
          db,
          gitReport.repoId,
          nextLineage,
          next.symbol,
          next.kind,
          String(next.occurrence),
        );
        const nextEntity = ensureEntity(
          db,
          gitReport.repoId,
          nextSlot,
          matched ? prev.commit : next.commit,
          matched ? prev.path : next.path,
          matched ? prev.symbol : next.symbol,
          String(matched ? prev.occurrence : next.occurrence),
        );
        const nextRevision = ensureRevision(
          db,
          repo,
          gitReport.repoId,
          nextLineage,
          nextEntity,
          next,
        );
        if (matched) {
          db.prepare(
            `INSERT INTO revision_match (
               prev_revision, next_revision, tier, similarity,
               exact_jaccard, exact_verified, accepted, ambiguity_size
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT (prev_revision, next_revision) DO UPDATE SET
               tier = excluded.tier,
               similarity = excluded.similarity,
               exact_jaccard = excluded.exact_jaccard,
               exact_verified = excluded.exact_verified,
               accepted = 1,
               ambiguity_size = excluded.ambiguity_size`,
          ).run(
            prevRevision,
            nextRevision,
            matched.tier,
            matched.exactJaccard ?? null,
            matched.exactJaccard ?? null,
            matched.exactVerified ? 1 : 0,
            matched.ambiguitySize,
          );
        }
        lineageTransitions++;
        }
      }
    }
    discontinuities = (db.prepare(
      "SELECT COUNT(*) AS n FROM slot_discontinuity",
    ).get() as { n: number }).n;
    excursions = (db.prepare(
      "SELECT COUNT(*) AS n FROM excursion",
    ).get() as { n: number }).n;
  } finally {
    db.close();
  }
  return { changeLevels, lineageTransitions, discontinuities, excursions };
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
  const repo = valueAfter(args, "--repo");
  const fixture = valueAfter(args, "--fixture") ?? "fixtures/osiris.yaml";
  const db = valueAfter(args, "--db") ?? ".ostracon/osiris.db";
  if (!repo) {
    console.error("用法：pnpm golden:index -- --repo <path> [--fixture file] [--db file]");
    process.exit(2);
  }
  const counts = await materializeGoldenCoordinates(repo, fixture, db);
  console.log(
    `已寫入 ${counts.changeLevels} 條 change_level、` +
    `${counts.lineageTransitions} 段 lineage transition、` +
    `${counts.discontinuities} 條 discontinuity：${db}`,
  );
}
