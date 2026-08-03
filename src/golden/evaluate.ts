import { DatabaseSync } from "node:sqlite";
import type { CaseEvaluation, Difficulty } from "./report.ts";

interface FixtureCase {
  id: string;
  kind: string;
  difficulty: Difficulty;
  label_confidence?: "certain" | "probable" | "ambiguous";
  expect?: unknown;
  entity?: { path?: string; symbol?: string };
  slot?: { path?: string; symbol?: string };
  at_commit?: string;
  /** excursion 的錨點：引入與移除的 commit，以及最低可接受的強度。 */
  introduce_at?: string;
  remove_at?: string;
  expect_strength_at_least?: string;
  chain?: Array<{
    anchor?: { commit?: string; path?: string; symbol?: string; occurrence?: number };
    transition?: FixtureTransition;
  }>;
  accept_any_of?: Array<{
    chain: Array<{
      anchor?: { commit?: string; path?: string; symbol?: string; occurrence?: number };
      transition?: FixtureTransition;
    }>;
  }>;
}

/**
 * `type` 是給人看的描述（rename / move / unrelated…），runner **刻意不讀它**：
 * 判定語意必須來自結構化欄位，不得從人類文字反推。但它確實存在於 fixture
 * 與 spec 裡，介面漏掉它就等於型別沒有描述真實資料。
 */
interface FixtureTransition {
  type?: string;
  expect_tier_at_most?: string;
}

/**
 * fixture 少了必要欄位是**壞掉的 fixture**，不是「還沒被索引到」。
 * 兩者絕不能混為一談：runner 的頭號設計決定就是 missing 只代表覆蓋不足，
 * 一旦壞 fixture 也報成 missing，覆蓋率這個頭條數字就再也不可信。
 * 所以這裡硬失敗，不回傳 missing。
 */
function required(value: string | undefined, field: string, caseId: string): string {
  if (value === undefined) {
    throw new Error(`fixture 案例 ${caseId} 缺少必要欄位 ${field}`);
  }
  return value;
}

const TIER_ORDER = new Map([
  ["L1", 1],
  ["L2", 2],
  ["L3", 3],
  ["L3b", 4],
  // L3c 比 L3b 弱（位置證據而非宣告內容），但比 L4 強（精確，非相似度門檻）。
  ["L3c", 5],
  ["L4", 6],
  ["L5", 7],
]);

function result<T>(
  c: FixtureCase,
  expected: T,
  actual: T | null,
  detail?: string,
): CaseEvaluation<T> {
  return {
    id: c.id,
    kind: c.kind,
    difficulty: c.difficulty,
    labelConfidence: c.label_confidence,
    polarity: fixturePolarity(c),
    status: actual === null ? "missing" : Object.is(expected, actual) ? "pass" : "fail",
    binary: { expected, actual },
    detail,
  };
}

function fixturePolarity(c: FixtureCase): "positive" | "negative" | "neutral" {
  if (c.expect === "absent") return "negative";
  if (["lineage", "discontinuity", "construct", "excursion"].includes(c.kind)) {
    return "positive";
  }
  return "neutral";
}

function evaluateChangeLevel(db: DatabaseSync, c: FixtureCase): CaseEvaluation {
  const expected = c.expect as string;
  const row = db.prepare(
    `SELECT rc.change_level AS actual
       FROM revision_change rc
       JOIN git_commit gc ON gc.id = rc.commit_id
       LEFT JOIN revision nr ON nr.id = rc.next_revision
       LEFT JOIN slot ns ON ns.id = nr.slot_id
       LEFT JOIN revision pr ON pr.id = rc.prev_revision
       LEFT JOIN slot ps ON ps.id = pr.slot_id
      WHERE gc.sha = ?
        AND COALESCE(nr.path, pr.path) = ?
        AND COALESCE(ns.qualified_name, ps.qualified_name) = ?
      LIMIT 1`,
  ).get(
    required(c.at_commit, "at_commit", c.id),
    required(c.entity?.path, "entity.path", c.id),
    required(c.entity?.symbol, "entity.symbol", c.id),
  ) as { actual: string } | undefined;
  return result(c, expected, row?.actual ?? null);
}

function evaluateDiscontinuity(db: DatabaseSync, c: FixtureCase): CaseEvaluation {
  const expected = c.expect as "present" | "absent";
  const row = db.prepare(
    `SELECT 1 AS present
       FROM slot_discontinuity d
       JOIN git_commit gc ON gc.id = d.commit_id
       JOIN slot s ON s.id = d.slot_id
       JOIN revision r ON r.commit_id = d.commit_id
                      AND r.slot_id = d.slot_id
                      AND r.entity_id = d.next_entity
      WHERE gc.sha = ? AND r.path = ? AND s.qualified_name = ?
      LIMIT 1`,
  ).get(
    required(c.at_commit, "at_commit", c.id),
    required(c.slot?.path, "slot.path", c.id),
    required(c.slot?.symbol, "slot.symbol", c.id),
  ) as { present: number } | undefined;
  return result(c, expected, row ? "present" : "absent");
}

/** 迂迴強度的順序：A 最強。與 `TIER_ORDER` 同樣的比較方式。 */
const STRENGTH_ORDER = new Map([["A", 1], ["B", 2], ["C", 3]]);

/**
 * 迂迴案例的判定。
 *
 * 錨點是 `entity: {path, symbol}` 加上引入／移除的 commit——**都是 git 原生座標**，
 * 不引用索引器產生的 ID。查到的強度必須不弱於 `expect_strength_at_least`；
 * 沒查到就是 absent。
 */
function evaluateExcursion(db: DatabaseSync, c: FixtureCase): CaseEvaluation {
  const expectsPresence = (c.expect ?? "present") !== "absent";
  const row = db.prepare(
    `SELECT x.strength AS strength
       FROM excursion x
       JOIN git_commit ic ON ic.id = x.introduce_commit
       JOIN git_commit rc ON rc.id = x.remove_commit
       JOIN revision r ON r.entity_id = x.entity_id
       JOIN slot s ON s.id = r.slot_id
      WHERE ic.sha = ? AND rc.sha = ? AND r.path = ? AND s.qualified_name = ?
      LIMIT 1`,
  ).get(
    required(c.introduce_at, "introduce_at", c.id),
    required(c.remove_at, "remove_at", c.id),
    required(c.entity?.path, "entity.path", c.id),
    required(c.entity?.symbol, "entity.symbol", c.id),
  ) as { strength: string } | undefined;

  if (!expectsPresence) {
    return result(c, "absent", row ? "present" : "absent");
  }
  const floor = c.expect_strength_at_least;
  if (floor === undefined) {
    return result(c, "present", row ? "present" : "absent");
  }
  // 強度不弱於下限才算通過；比下限強是好事，不是退步。
  const actual = row === undefined
    ? "absent"
    : (STRENGTH_ORDER.get(row.strength) ?? Infinity)
        <= (STRENGTH_ORDER.get(floor) ?? -Infinity)
      ? floor
      : row.strength;
  return result(c, floor, actual);
}

function revisionId(
  db: DatabaseSync,
  anchor: NonNullable<NonNullable<FixtureCase["chain"]>[number]["anchor"]>,
  caseId: string,
): number | undefined {
  const row = db.prepare(
    `SELECT r.id AS id
       FROM revision r
       JOIN git_commit gc ON gc.id = r.commit_id
       JOIN slot s ON s.id = r.slot_id
      WHERE gc.sha = ? AND r.path = ? AND s.qualified_name = ?
        AND s.disambiguator = ?
      ORDER BY r.byte_start
      LIMIT 1`,
  ).get(
    required(anchor.commit, "chain[].anchor.commit", caseId),
    required(anchor.path, "chain[].anchor.path", caseId),
    required(anchor.symbol, "chain[].anchor.symbol", caseId),
    String(anchor.occurrence ?? 0),
  ) as { id: number } | undefined;
  return row?.id;
}

interface ChainEvaluation {
  expected: string[];
  actual: string[] | null;
  passed: boolean | null;
}

function evaluateLineageChain(
  db: DatabaseSync,
  c: FixtureCase,
  chain: NonNullable<FixtureCase["chain"]>,
): ChainEvaluation {
  const expectsAbsence = c.expect === "absent";
  const expected = chain.slice(1).map((step) =>
    expectsAbsence ? "unmatched" : (step.transition?.expect_tier_at_most ?? ""));
  const actual: Array<string> = [];
  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1]?.anchor;
    const next = chain[i]?.anchor;
    if (!prev || !next) return { expected, actual: null, passed: null };
    const prevId = revisionId(db, prev, c.id);
    const nextId = revisionId(db, next, c.id);
    if (prevId === undefined || nextId === undefined) {
      return { expected, actual: null, passed: null };
    }
    const match = db.prepare(
      `SELECT tier FROM revision_match
        WHERE prev_revision = ? AND next_revision = ? AND accepted = 1`,
    ).get(prevId, nextId) as { tier: string } | undefined;
    actual.push(match?.tier ?? "unmatched");
  }
  const passed = expectsAbsence
    ? actual.every((tier) => tier === "unmatched")
    : actual.every((tier, i) =>
      (TIER_ORDER.get(tier) ?? Infinity) <=
      (TIER_ORDER.get(expected[i] ?? "") ?? -Infinity));
  return { expected, actual, passed };
}

function evaluateAmbiguousLineage(
  db: DatabaseSync,
  c: FixtureCase,
): CaseEvaluation {
  const alternatives = (c.accept_any_of ?? []).map((option) =>
    evaluateLineageChain(db, c, option.chain));
  const selectedAlternatives = alternatives.flatMap((alternative, index) =>
    alternative.passed ? [index] : []);

  // 系統實際宣稱的歧義程度。`ambiguity_size` 記的是「接受這條匹配時有幾個
  // 同等好的候選」，所以 > 1 就是「我從 n 個裡挑了一個」，= 1 是「這裡只有一個」。
  const claimed = selectedAlternatives
    .map((index) => ambiguitySizeOf(db, c, (c.accept_any_of ?? [])[index]!.chain))
    .filter((size): size is number => size !== undefined);
  const reportedAmbiguity = claimed.length > 0 ? Math.max(...claimed) : null;

  // 兩個條件都必須成立才算過：
  //   1. 系統選中的配對落在可接受集合內（恰好一種，不是零種也不是多種）；
  //   2. 它沒有把那個任選宣稱成唯一——`ambiguity_size` 必須 > 1。
  // 第 2 點是這條案例存在的唯一理由。少了它，一個「永遠宣稱唯一」的匹配器
  // 只要碰巧選到可接受的那一個就會過關。
  const selectedExactlyOne = selectedAlternatives.length === 1;
  const status = reportedAmbiguity === null
    ? "missing" as const
    : (selectedExactlyOne && reportedAmbiguity > 1 ? "pass" as const : "fail" as const);

  return {
    id: c.id,
    kind: c.kind,
    difficulty: c.difficulty,
    labelConfidence: c.label_confidence,
    polarity: fixturePolarity(c),
    status,
    binary: {
      expected: {
        acceptedAlternatives: alternatives.map((_, index) => index),
        mustNotClaimUnique: true,
      },
      actual: reportedAmbiguity === null ? null : {
        selectedAlternatives,
        claimedUnique: reportedAmbiguity === 1,
      },
    },
    observed: {
      selectedAlternatives,
      alternatives: alternatives.map(({ expected, actual }) => ({
        expectedTiers: expected,
        actualTiers: actual,
      })),
      reportedConfidence: reportedAmbiguity,
    },
    detail: reportedAmbiguity === null
      ? "沒有任何可接受的配對被索引到，無法判定"
      : `系統選中 ${selectedAlternatives.length} 種可接受配對，`
        + `宣稱的等價候選數為 ${reportedAmbiguity}`,
  };
}

/**
 * 取這條鏈最後一步的 `ambiguity_size`。
 *
 * 讀的是結構化欄位，不是 detail 或任何人類文字——runner 不得從敘述反推判定語意。
 */
function ambiguitySizeOf(
  db: DatabaseSync,
  c: FixtureCase,
  chain: NonNullable<FixtureCase["chain"]>,
): number | undefined {
  const prev = chain[chain.length - 2]?.anchor;
  const next = chain[chain.length - 1]?.anchor;
  if (!prev || !next) return undefined;
  const prevId = revisionId(db, prev, c.id);
  const nextId = revisionId(db, next, c.id);
  if (prevId === undefined || nextId === undefined) return undefined;
  const row = db.prepare(
    `SELECT ambiguity_size AS size FROM revision_match
      WHERE prev_revision = ? AND next_revision = ? AND accepted = 1`,
  ).get(prevId, nextId) as { size: number | null } | undefined;
  return row?.size ?? undefined;
}

function evaluateLineage(db: DatabaseSync, c: FixtureCase): CaseEvaluation {
  if (c.label_confidence === "ambiguous") {
    return evaluateAmbiguousLineage(db, c);
  }
  const evaluation = evaluateLineageChain(db, c, c.chain ?? []);
  if (evaluation.actual === null) {
    return result(c, evaluation.expected, null);
  }
  return {
    id: c.id,
    kind: c.kind,
    difficulty: c.difficulty,
    labelConfidence: c.label_confidence,
    polarity: fixturePolarity(c),
    status: evaluation.passed ? "pass" : "fail",
    binary: { expected: evaluation.expected, actual: evaluation.actual },
  };
}

/**
 * 評估層只讀結構化欄位。禁止從 detail/message 字串解析 expected 或 actual。
 * 尚未實作查詢的 case kind 明確回 missing，不得偽裝成 fail。
 */
export function evaluateFixtureCase(
  db: DatabaseSync,
  c: FixtureCase,
): CaseEvaluation {
  if (c.kind === "change_level") return evaluateChangeLevel(db, c);
  if (c.kind === "lineage") return evaluateLineage(db, c);
  if (c.kind === "discontinuity") return evaluateDiscontinuity(db, c);
  if (c.kind === "excursion") return evaluateExcursion(db, c);
  return result(c, c.expect ?? "present", null, `${c.kind} 查詢尚未接入`);
}

export function evaluateFixtureCases(
  db: DatabaseSync,
  cases: FixtureCase[],
): CaseEvaluation[] {
  return cases.map((c) => evaluateFixtureCase(db, c));
}
