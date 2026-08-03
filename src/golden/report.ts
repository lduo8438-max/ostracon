export type EvaluationStatus = "pass" | "fail" | "missing";
export type Difficulty = "easy" | "hard" | "adversarial";
export type Polarity = "positive" | "negative" | "neutral";

export interface BinaryEvaluation<T = unknown> {
  expected: T;
  /** null 代表資料尚未被索引，必須對應 status=missing */
  actual: T | null;
}

export interface CaseEvaluation<T = unknown> {
  id: string;
  kind: string;
  difficulty: Difficulty;
  labelConfidence?: "certain" | "probable" | "ambiguous";
  polarity: Polarity;
  status: EvaluationStatus;
  binary: BinaryEvaluation<T>;
  /** 不參與 pass/fail 判定的結構化診斷；不得從 detail 字串反解析。 */
  observed?: unknown;
  detail?: string;
}

export interface MetricSlice {
  total: number;
  evaluated: number;
  pass: number;
  fail: number;
  missing: number;
  coverage: number;
  /** 沒有任何已評估案例時為 null，不偽造 0% 或 100%。 */
  passRate: number | null;
}

export interface Regression {
  id: string;
  difficulty: Exclude<Difficulty, "easy">;
  previous: "pass";
  current: "fail" | "missing";
}

export interface GoldenReport {
  reportVersion: 3;
  generatedAt: string;
  summary: MetricSlice;
  interpretable: boolean;
  warnings: string[];
  byDifficulty: Record<string, MetricSlice>;
  byKind: Record<string, MetricSlice>;
  byPolarity: Record<Polarity, MetricSlice>;
  /** 依 fixture 規格不計入主要指標，仍完整保留選項命中觀察。 */
  ambiguousCases: CaseEvaluation[];
  cases: CaseEvaluation[];
  regressions: Regression[];
}

export interface BaselineReport {
  cases: Array<Pick<CaseEvaluation, "id" | "difficulty" | "status">>;
}

export const MAX_MISSING_FOR_INTERPRETATION = 0.2;

function metric(cases: CaseEvaluation[]): MetricSlice {
  const pass = cases.filter((c) => c.status === "pass").length;
  const fail = cases.filter((c) => c.status === "fail").length;
  const missing = cases.filter((c) => c.status === "missing").length;
  const evaluated = pass + fail;
  const total = cases.length;
  return {
    total,
    evaluated,
    pass,
    fail,
    missing,
    coverage: total === 0 ? 0 : evaluated / total,
    passRate: evaluated === 0 ? null : pass / evaluated,
  };
}

function groupMetrics(
  cases: CaseEvaluation[],
  key: (c: CaseEvaluation) => string,
): Record<string, MetricSlice> {
  const groups = new Map<string, CaseEvaluation[]>();
  for (const c of cases) {
    const k = key(c);
    const list = groups.get(k);
    if (list) list.push(c);
    else groups.set(k, [c]);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, list]) => [k, metric(list)]),
  );
}

function polarityMetrics(cases: CaseEvaluation[]): Record<Polarity, MetricSlice> {
  return {
    positive: metric(cases.filter((c) => c.polarity === "positive")),
    negative: metric(cases.filter((c) => c.polarity === "negative")),
    neutral: metric(cases.filter((c) => c.polarity === "neutral")),
  };
}

/**
 * 回歸只做逐案例比對。新增覆蓋的案例不與基準線彙總率比較，避免「進展」
 * 因為帶進新的 fail 而被誤報為退步。
 */
export function findRegressions(
  current: CaseEvaluation[],
  baseline?: BaselineReport,
): Regression[] {
  if (!baseline) return [];
  const previous = new Map(baseline.cases.map((c) => [c.id, c]));
  const out: Regression[] = [];
  for (const c of current) {
    if (c.difficulty === "easy") continue;
    const old = previous.get(c.id);
    if (old?.status !== "pass") continue;
    if (c.status !== "fail" && c.status !== "missing") continue;
    out.push({
      id: c.id,
      difficulty: c.difficulty,
      previous: "pass",
      current: c.status,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function buildGoldenReport(
  input: CaseEvaluation[],
  baseline?: BaselineReport,
  generatedAt = new Date().toISOString(),
): GoldenReport {
  const cases = [...input].sort((a, b) => a.id.localeCompare(b.id));
  for (const c of cases) {
    if (c.status === "missing" && c.binary.actual !== null) {
      throw new Error(`${c.id}: missing 的 binary.actual 必須是 null`);
    }
    if (c.status !== "missing" && c.binary.actual === null) {
      throw new Error(`${c.id}: pass/fail 的 binary.actual 不可為 null`);
    }
  }
  const primaryCases = cases.filter((c) => c.labelConfidence !== "ambiguous");
  const ambiguousCases = cases.filter((c) => c.labelConfidence === "ambiguous");
  const summary = metric(primaryCases);
  const missingRate = summary.total === 0 ? 1 : summary.missing / summary.total;
  const interpretable = missingRate <= MAX_MISSING_FOR_INTERPRETATION;
  const warnings = interpretable
    ? []
    : ["missing 超過 20%；下面所有通過率與分層比率都不可解讀"];
  return {
    reportVersion: 3,
    generatedAt,
    summary,
    interpretable,
    warnings,
    byDifficulty: groupMetrics(primaryCases, (c) => c.difficulty),
    byKind: groupMetrics(primaryCases, (c) => c.kind),
    byPolarity: polarityMetrics(primaryCases),
    ambiguousCases,
    cases,
    // **迴歸閘門看全部案例，不是只看 primary。**
    //
    // `label_confidence: ambiguous` 排除在「比率」之外是對的：那些案例的配對
    // 沒有唯一正解，算進通過率只會稀釋分母。但它們斷言的另一件事——系統不得把
    // 任選宣稱成唯一——是二元的、有明確對錯的，而且正是那條案例存在的理由。
    // 一併排除在迴歸之外，等於寫了一條永遠不會擋下任何東西的測試。
    regressions: findRegressions(cases, baseline),
  };
}

export function exitCodeForReport(report: GoldenReport): number {
  return report.regressions.length > 0 ? 1 : 0;
}

const pct = (n: number | null): string =>
  n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;

export function formatGoldenReport(report: GoldenReport): string {
  const s = report.summary;
  const lines = [
    `覆蓋率 ${s.evaluated}/${s.total} (${pct(s.coverage)})`,
    `pass ${s.pass} / fail ${s.fail} / missing ${s.missing}`,
    `已評估案例通過率 ${pct(s.passRate)}`,
  ];
  if (!report.interpretable) {
    lines.push("", "⚠ missing 超過 20%；下面所有比率都不可解讀");
  }
  const appendSlices = (
    title: string,
    slices: Record<string, MetricSlice>,
  ): void => {
    lines.push("", `${title}：`);
    for (const [name, m] of Object.entries(slices)) {
      lines.push(
        `- ${name}: coverage ${m.evaluated}/${m.total} (${pct(m.coverage)}), ` +
        `pass ${m.pass} / fail ${m.fail} / missing ${m.missing}, ` +
        `pass rate ${pct(m.passRate)}`,
      );
    }
  };
  appendSlices("依 difficulty 分層", report.byDifficulty);
  appendSlices("依 kind 分層", report.byKind);
  appendSlices("依 polarity 分層", report.byPolarity);
  if (report.ambiguousCases.length) {
    lines.push("", "ambiguous 案例（不計入主要指標）：");
    for (const c of report.ambiguousCases) {
      lines.push(`- ${c.id}: ${c.status}; observation ${JSON.stringify(c.observed ?? null)}`);
    }
  }
  if (report.regressions.length) {
    lines.push("", `迴歸 ${report.regressions.length} 條：`);
    for (const r of report.regressions) {
      lines.push(`- ${r.id}: pass → ${r.current} (${r.difficulty})`);
    }
  }
  return lines.join("\n");
}
