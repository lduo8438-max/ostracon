#!/usr/bin/env node
/**
 * 跑過整段歷史的宣告匹配，輸出所有非 L1 配對供人工審核。
 *
 * 這不是黃金答案產生器；它刻意只提供「系統實際連了什麼」及精確
 * Jaccard，標註者仍須閱讀前後原始碼判斷是否為同一實體。
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hashDeclaration, tokenStream } from "../ast/hash.ts";
import { grammarForPath, parseSource, verifyParserAdapters } from "../ast/parser.ts";
import { collectHunksForCommits } from "../git/walk.ts";
import type { DiffHunk } from "../git/types.ts";
import { matchLadder, type Candidate, type Tier } from "../match/ladder.ts";
import {
  buildSignature,
  exactJaccard,
  ngramSet,
} from "../match/signature.ts";

interface DiffPath {
  status: string;
  prevPath?: string;
  nextPath?: string;
  lineageId: number;
}

interface AuditedDeclaration {
  candidate: Candidate;
  commit: string;
  path: string;
  symbol: string;
  occurrence: number;
  snippetHead: string;
  exact: Set<number>;
}

export interface AuditedMatch {
  commit: string;
  subject: string;
  tier: Tier;
  exactJaccard?: number;
  prev: Omit<AuditedDeclaration, "candidate" | "exact"> & {
    nodeCount: number;
    tokenCount: number;
  };
  next: Omit<AuditedDeclaration, "candidate" | "exact"> & {
    nodeCount: number;
    tokenCount: number;
  };
  /**
   * 這對候選在較早層級曾同時落入的 n×m bucket。
   * L4 + exactJaccard=1 且此陣列非空，代表內容本身無法解歧義。
   */
  ambiguityOrigins: Array<{
    tier: Tier;
    bucketKey: string;
    prevCount: number;
    nextCount: number;
  }>;
}

export interface AuditedAmbiguity {
  commit: string;
  subject: string;
  tier: Tier;
  bucketKey: string;
  prevCount: number;
  nextCount: number;
}

export interface MatchAuditReport {
  reportVersion: 2;
  summary: {
    nonL1Matches: number;
    ambiguityBuckets: number;
    /** 系統以 L4 選中、內容 Jaccard 恰為 1，且先前落入 n×m bucket 的配對數。 */
    l4ExactOneAfterAmbiguity: number;
  };
  matches: AuditedMatch[];
  ambiguities: AuditedAmbiguity[];
}

const git = (repo: string, args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });

function trySource(repo: string, spec: string): string | undefined {
  try {
    return git(repo, ["show", spec]);
  } catch {
    return undefined;
  }
}

function diffPaths(repo: string, parent: string, commit: string): DiffPath[] {
  const lines = git(repo, [
    "diff",
    "--name-status",
    "-M20%",
    parent,
    commit,
  ]).split("\n").filter(Boolean);
  const out: DiffPath[] = [];
  let lineageId = 1;
  for (const line of lines) {
    const [status, first, second] = line.split("\t");
    if (!status || !first) continue;
    if (status.startsWith("R")) {
      if (second && (grammarForPath(first) || grammarForPath(second))) {
        out.push({
          status,
          prevPath: grammarForPath(first) ? first : undefined,
          nextPath: grammarForPath(second) ? second : undefined,
          lineageId: lineageId++,
        });
      }
    } else if (status === "D" && grammarForPath(first)) {
      out.push({ status, prevPath: first, lineageId: lineageId++ });
    } else if (status === "A" && grammarForPath(first)) {
      out.push({ status, nextPath: first, lineageId: lineageId++ });
    } else if (grammarForPath(first)) {
      out.push({
        status,
        prevPath: first,
        nextPath: first,
        lineageId: lineageId++,
      });
    }
  }
  return out;
}

async function declarationsAt(
  repo: string,
  commit: string,
  pathName: string,
  lineageId: number,
  side: "prev" | "next",
): Promise<AuditedDeclaration[]> {
  const source = trySource(repo, `${commit}:${pathName}`);
  const grammar = grammarForPath(pathName);
  if (source === undefined || !grammar) return [];
  const parsed = await parseSource(source, grammar);
  const occurrences = new Map<string, number>();
  const lineOf = (index: number) => {
    let n = 1;
    for (let i = 0; i < index; i++) if (source[i] === "\n") n++;
    return n;
  };
  return parsed.declarations.map((declaration, index) => {
    const occurrence = occurrences.get(declaration.qualifiedName) ?? 0;
    occurrences.set(declaration.qualifiedName, occurrence + 1);
    const hashes = hashDeclaration(declaration.node, source, parsed.profile);
    const tokens = tokenStream(declaration.node, parsed.profile);
    const id = `${side}:${lineageId}:${index}:${declaration.qualifiedName}`;
    return {
      candidate: {
        id,
        lineageId,
        qualifiedName: declaration.qualifiedName,
        kind: declaration.kind,
        hashes,
        signature: buildSignature(tokens),
        path: pathName,
        startIndex: declaration.node.startIndex,
        startLine: lineOf(declaration.node.startIndex),
        endLine: lineOf(declaration.node.endIndex),
      },
      commit,
      path: pathName,
      symbol: declaration.qualifiedName,
      occurrence,
      snippetHead: declaration.node.text.split("\n", 1)[0] ?? "",
      exact: ngramSet(tokens),
    };
  });
}

function publicDeclaration(d: AuditedDeclaration) {
  return {
    commit: d.commit,
    path: d.path,
    symbol: d.symbol,
    occurrence: d.occurrence,
    snippetHead: d.snippetHead,
    nodeCount: d.candidate.hashes.nodeCount,
    tokenCount: d.candidate.hashes.tokenCount,
  };
}

export async function auditHistory(
  repo: string,
  until = "HEAD",
  /**
   * 關掉 L3c 的位置約束。存在的理由只有一個：量「加上約束前後差多少」時，
   * 兩邊必須由同一份程式碼、同一條歷史產生，否則比較的是兩個不同的東西。
   */
  useHunkConstraint = true,
): Promise<MatchAuditReport> {
  await verifyParserAdapters();
  const untilSha = git(repo, ["rev-parse", `${until}^{commit}`]).trim();
  const commits = git(repo, [
    "rev-list",
    "--reverse",
    "--topo-order",
    untilSha,
  ]).split("\n").filter(Boolean);
  const output: AuditedMatch[] = [];
  const ambiguities: AuditedAmbiguity[] = [];

  for (const commit of commits) {
    const parentLine = git(repo, ["rev-list", "--parents", "-n", "1", commit])
      .trim()
      .split(" ");
    if (parentLine.length !== 2) continue;
    const parent = parentLine[1]!;
    const paths = diffPaths(repo, parent, commit);
    if (!paths.length) continue;
    const prev = (
      await Promise.all(paths.flatMap((p) =>
        p.prevPath
          ? [declarationsAt(repo, parent, p.prevPath, p.lineageId, "prev")]
          : []))
    ).flat();
    const next = (
      await Promise.all(paths.flatMap((p) =>
        p.nextPath
          ? [declarationsAt(repo, commit, p.nextPath, p.lineageId, "next")]
          : []))
    ).flat();
    if (!prev.length || !next.length) continue;
    const byId = new Map([...prev, ...next].map((d) => [d.candidate.id, d]));
    // 審計走的是真正的父子關係（parentLine 已排除合併），所以 hunk 就是這一步的
    // 差異，可以直接餵給 L3c。零 hunk 的路徑不建鍵——那代表沒有證據。
    const patches = collectHunksForCommits(repo, [commit]);
    const hunkByPath = new Map(
      (patches.get(commit) ?? []).map((file) => [file.path, file.hunks]),
    );
    const hunksByLineage = new Map<number, DiffHunk[]>();
    for (const p of paths) {
      const hunks = p.nextPath ? hunkByPath.get(p.nextPath) : undefined;
      if (hunks && hunks.length > 0) hunksByLineage.set(p.lineageId, hunks);
    }
    const result = matchLadder(
      prev.map((d) => d.candidate),
      next.map((d) => d.candidate),
      {
        verify: (p, n) =>
          exactJaccard(byId.get(p.id)!.exact, byId.get(n.id)!.exact),
        ...(useHunkConstraint ? { hunksByLineage } : {}),
      },
    );
    const subject = git(repo, ["show", "-s", "--format=%s", commit]).trim();
    for (const ambiguity of result.ambiguities) {
      ambiguities.push({
        commit,
        subject,
        tier: ambiguity.tier,
        bucketKey: ambiguity.hash,
        prevCount: ambiguity.prevCount,
        nextCount: ambiguity.nextCount,
      });
    }
    for (const match of result.matches) {
      if (match.tier === "L1") continue;
      const before = byId.get(match.prev)!;
      const after = byId.get(match.next)!;
      const ambiguityOrigins = result.ambiguities
        .filter((ambiguity) =>
          ambiguity.prevIds.includes(match.prev)
          && ambiguity.nextIds.includes(match.next))
        .map((ambiguity) => ({
          tier: ambiguity.tier,
          bucketKey: ambiguity.hash,
          prevCount: ambiguity.prevCount,
          nextCount: ambiguity.nextCount,
        }));
      output.push({
        commit,
        subject,
        tier: match.tier,
        exactJaccard: match.exactJaccard,
        prev: publicDeclaration(before),
        next: publicDeclaration(after),
        ambiguityOrigins,
      });
    }
  }
  return {
    reportVersion: 2,
    summary: {
      nonL1Matches: output.length,
      ambiguityBuckets: ambiguities.length,
      l4ExactOneAfterAmbiguity: output.filter((match) =>
        match.tier === "L4"
        && match.exactJaccard === 1
        && match.ambiguityOrigins.length > 0
      ).length,
    },
    matches: output,
    ambiguities,
  };
}

export async function auditHistoryMatches(
  repo: string,
  until = "HEAD",
): Promise<AuditedMatch[]> {
  return (await auditHistory(repo, until)).matches;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const repo = valueAfter(args, "--repo");
  const until = valueAfter(args, "--until") ?? "HEAD";
  const output = valueAfter(args, "--output");
  if (!repo) {
    console.error(
      "用法：node src/golden/audit-matches.ts --repo <path> " +
      "[--until sha] [--output report.json] [--no-hunk-constraint]",
    );
    process.exit(2);
  }
  const report = await auditHistory(repo, until, !args.includes("--no-hunk-constraint"));
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) writeFileSync(output, json, "utf8");
  else process.stdout.write(json);
  console.error(
    `已審計 ${report.matches.length} 條非 L1 配對、` +
    `${report.ambiguities.length} 個歧義 bucket；` +
    `其中 ${report.summary.l4ExactOneAfterAmbiguity} 條 L4/Jaccard=1 ` +
    `源自歧義 bucket`,
  );
}
