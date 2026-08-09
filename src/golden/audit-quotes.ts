#!/usr/bin/env node
/**
 * 把「可能沒有資訊量」的引文分組列出，供人工裁決。
 *
 * 這不是品質判定器，是**裁決工作台**。span 斷言保證引文逐字為真，不保證它
 * 說了什麼；而「說了什麼」沒有結構性判準，只能由人看。工具負責的是把問題
 * 縮到可裁決的大小、並讓每一條的裁決可以換算成「某條規則要付多少代價」。
 *
 * 三個設計決定：
 *
 * 1. **列出完整聯集，不抽樣。** 可疑集合只有百來條，全部裁決得到的是精確值；
 *    抽樣得到的是外推值，而這個數字要拿來決定是否收緊抽取器，外推的信賴區間
 *    比省下的時間貴。
 * 2. **附上原文前後文。** 只看引文的話，裁決者唯一能給的答案是「留或刪」。
 *    看得到前後文才分得出第三種：理由其實在隔壁行，該做的是**把 span 拉長**
 *    而不是丟掉這條。那是完全不同的抽取器改動。
 * 3. **逐規則歸屬，而且不預先標記。** 每條引文記下它被哪些規則抓到，裁決完就
 *    能算出每條規則各自誤殺幾條。工具不寫任何「疑似空殼」之類的暗示——
 *    那會把裁決者推向工具已經有的偏見。
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 候選收緊規則。**每一條都要能單獨定價**，因為它們的代價差很多：
 * 實測 `R1` 抓到的 68 條裡有 42 條是 `instead of …`——被拒絕的替代方案，
 * 正好是這個專案的核心內容。規則寫在這裡是為了被否決，不是為了被採用。
 */
export interface QuoteRule {
  id: string;
  description: string;
  matches: (quote: string) => boolean;
}

/** 開頭的因果標記。切掉它才問得出「標記後面到底還剩什麼」。 */
const LEADING_MARKER =
  /^(instead of|rather than|because(?: of)?|since|due to|in order to|so that|otherwise|to avoid|to prevent|to ensure|the reason|reason:|why:|因為|由於|為了|避免|以免|否則|理由|原因)[\s:,.，。：]*/i;

/** 標記與尾端標點都拿掉之後還剩的實質內容。 */
export function residueOf(quote: string): string {
  return quote.replace(LEADING_MARKER, "").replace(/[\s\p{P}]+$/u, "").trim();
}

export const QUOTE_RULES: QuoteRule[] = [
  {
    id: "R1",
    description: "長度 < 30 字元",
    matches: (q) => q.length < 30,
  },
  {
    id: "R2",
    description: "以 ? 結尾（是提問不是解釋）",
    matches: (q) => /\?\s*$/.test(q),
  },
  {
    id: "R3",
    description: "以 : 結尾（指向後文，本身無內容）",
    matches: (q) => /:\s*$/.test(q),
  },
  {
    id: "R4",
    description: "標記後不足 4 個字元（標記自身就是整句）",
    matches: (q) => residueOf(q).length < 4,
  },
  {
    id: "R5",
    description: "標記後只剩指示代名詞",
    matches: (q) => /^(this|that|it|these|those|這|那|它)[\s\p{P}]*$/iu.test(residueOf(q)),
  },
];

export interface QuoteCase {
  evidenceId: number;
  tier: string;
  docType: string;
  externalId: string;
  quote: string;
  /** 命中的規則 id。多條命中代表它同時被多個方案殺掉。 */
  rules: string[];
  /** 引文在原文中的前後文，引文本身以 ⟦ ⟧ 標出。 */
  context: string;
}

/** 引文所在行，加上前後各 `radius` 行。看得到隔壁行才判得出「該拉長 span」。 */
function contextOf(body: string, start: number, end: number, radius = 2): string {
  const before = body.slice(0, start);
  const after = body.slice(end);
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = after.indexOf("\n");
  const head = body.slice(0, lineStart).split("\n").slice(-1 - radius, -1);
  const tail = (lineEnd === -1 ? "" : body.slice(end + lineEnd + 1))
    .split("\n").slice(0, radius);
  const focus = body.slice(lineStart, start)
    + `⟦${body.slice(start, end)}⟧`
    + (lineEnd === -1 ? after : after.slice(0, lineEnd));
  return [...head, focus, ...tail]
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line, i, all) => line !== "" || (i > 0 && i < all.length - 1))
    .join("\n");
}

export function collectQuoteCases(db: DatabaseSync): QuoteCase[] {
  const rows = db.prepare(
    `SELECT e.id AS evidenceId, e.tier AS tier, e.quoted_text AS quote,
            e.char_start AS charStart, e.char_end AS charEnd,
            d.doc_type AS docType, d.external_id AS externalId, d.body AS body
       FROM evidence e
       JOIN source_doc d ON d.id = e.source_doc_id
      ORDER BY e.id`,
  ).all() as unknown as {
    evidenceId: number; tier: string; quote: string;
    charStart: number; charEnd: number;
    docType: string; externalId: string; body: string;
  }[];

  const out: QuoteCase[] = [];
  for (const row of rows) {
    const rules = QUOTE_RULES.filter((r) => r.matches(row.quote)).map((r) => r.id);
    if (rules.length === 0) continue;
    out.push({
      evidenceId: row.evidenceId,
      tier: row.tier,
      docType: row.docType,
      externalId: row.externalId,
      quote: row.quote,
      rules,
      context: contextOf(row.body, row.charStart, row.charEnd),
    });
  }
  return out;
}

export interface QuoteAudit {
  totalEvidence: number;
  /** 至少被一條規則抓到的條數。這就是要裁決的量。 */
  flagged: number;
  perRule: { id: string; description: string; hits: number }[];
  cases: QuoteCase[];
}

export function auditQuotes(db: DatabaseSync): QuoteAudit {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as
    { n: number }).n;
  const cases = collectQuoteCases(db);
  return {
    totalEvidence: total,
    flagged: cases.length,
    perRule: QUOTE_RULES.map((r) => ({
      id: r.id,
      description: r.description,
      hits: cases.filter((c) => c.rules.includes(r.id)).length,
    })),
    cases,
  };
}

/**
 * 給人讀、給人在上面畫記的版本。
 *
 * 每一條留一個空的裁決欄，三個選項互斥：`真理由` / `空殼` / `該拉長`。
 * 第三個存在是因為它導向的修法與前兩個完全不同——看不到這個選項的話，
 * 裁決結果會把「span 切太短」誤記成「這條沒有價值」。
 */
/**
 * 比內容裡最長的一串反引號再長一格的圍欄。
 *
 * PR 留言本身常含程式碼區塊，實測 103 條裡有 7 條。用固定的三格圍欄的話，
 * 內層的 ``` 會把外層打斷，那 7 條在算繪後會爛掉——而爛掉的正是上下文，
 * 也就是這份報告存在的理由。
 */
function fenceFor(content: string): string {
  const longest = Math.max(
    2,
    ...[...content.matchAll(/`+/g)].map((m) => m[0].length),
  );
  return "`".repeat(longest + 1);
}

export function renderQuoteAudit(audit: QuoteAudit): string {
  const out: string[] = [];
  out.push(`# 引文裁決樣本`);
  out.push("");
  out.push(
    `evidence 共 ${audit.totalEvidence} 條，其中 **${audit.flagged} 條**`
    + `（${(audit.flagged / audit.totalEvidence * 100).toFixed(1)}%）被至少一條候選規則抓到。`,
  );
  out.push(`以下是那 ${audit.flagged} 條的全部，不是抽樣——全部裁決才得到精確值。`);
  out.push("");
  out.push("| 規則 | 說明 | 命中 |");
  out.push("|---|---|---:|");
  for (const r of audit.perRule) {
    out.push(`| ${r.id} | ${r.description} | ${r.hits} |`);
  }
  out.push("");
  out.push("裁決欄三選一，互斥：");
  out.push("");
  out.push("- `真理由`　　這條有資訊量，抓掉它就是誤殺");
  out.push("- `空殼`　　　這條沒有資訊量，抓掉它是對的");
  out.push("- `該拉長`　　理由其實在前後文，該改的是 span 邊界不是丟掉它");
  out.push("");
  out.push("---");
  out.push("");

  const byRule = new Map<string, QuoteCase[]>();
  for (const c of audit.cases) {
    // 歸到命中的第一條規則底下，避免同一條在報告裡出現多次；
    // 完整的命中清單仍逐條列出，定價時用那個。
    const key = c.rules[0]!;
    const group = byRule.get(key);
    if (group) group.push(c);
    else byRule.set(key, [c]);
  }

  for (const rule of audit.perRule) {
    const group = byRule.get(rule.id) ?? [];
    // 標頭要同時說出「這一段有幾條」與「這條規則總共命中幾條」。
    // 只寫其中一個的話，表格與內文就會各說各話：規則彼此重疊，一條引文只
    // 列在最先命中它的規則底下，於是 R4 命中 5 條卻可能一條都不在自己段落裡。
    // 段落是空的就明講，不要整段消失——消失會讓讀者以為表格算錯了。
    const elsewhere = rule.hits - group.length;
    const suffix = elsewhere > 0
      ? `　（此段 ${group.length} 條；另 ${elsewhere} 條同時命中更前面的規則，列在那裡）`
      : `　（此段 ${group.length} 條）`;
    out.push(`## ${rule.id}　${rule.description}${suffix}`);
    out.push("");
    if (group.length === 0) {
      out.push(
        `這條規則命中的 ${rule.hits} 條全部同時命中更前面的規則，已列在上面。`
        + "**它沒有獨立的代價**——採用它不會多刪任何一條，也不會少刪。",
      );
      out.push("");
      continue;
    }
    for (const c of group) {
      out.push(`### #${c.evidenceId}　${c.tier}／${c.docType} ${c.externalId}`);
      out.push(`規則：${c.rules.join(" ")}　　裁決：______`);
      out.push("");
      out.push(fenceFor(c.context));
      out.push(c.context);
      out.push(fenceFor(c.context));
      out.push("");
    }
  }
  return out.join("\n");
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(args: string[]): Promise<void> {
  const dbPath = valueAfter(args, "--db");
  if (dbPath === undefined) {
    console.error(
      "用法：pnpm quotes:audit -- --db <file> [--output <file.md>] [--json <file.json>]",
    );
    process.exitCode = 2;
    return;
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    const audit = auditQuotes(db);
    const markdown = renderQuoteAudit(audit);
    const output = valueAfter(args, "--output");
    if (output) {
      writeFileSync(output, markdown);
      console.log(`已寫入 ${audit.flagged} 條待裁決引文：${output}`);
    } else {
      console.log(markdown);
    }
    // JSON 是為了「改完抽取器再量一次」——裁決結果要能對回同一批 evidence id。
    const json = valueAfter(args, "--json");
    if (json) {
      writeFileSync(json, JSON.stringify(audit, null, 2));
      console.log(`裁決基準：${json}`);
    }
  } finally {
    db.close();
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main(process.argv.slice(2));
}
