import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  QUOTE_RULES,
  renderQuoteAudit,
  residueOf,
  type QuoteAudit,
  type QuoteCase,
} from "../src/golden/audit-quotes.ts";

const ruleById = (id: string) => {
  const rule = QUOTE_RULES.find((r) => r.id === id);
  assert.ok(rule, `沒有 ${id} 這條規則`);
  return rule;
};

const audit = (
  cases: QuoteCase[],
  perRule: QuoteAudit["perRule"],
  otherRepos: QuoteAudit["otherRepos"] = [],
): QuoteAudit => ({
  repoId: 1,
  totalEvidence: 100,
  flagged: cases.length,
  perRule,
  cases,
  otherRepos,
});

const caseOf = (over: Partial<QuoteCase> = {}): QuoteCase => ({
  evidenceId: 1,
  tier: "linked",
  docType: "pr_comment",
  externalId: "pr:1:comment:1",
  quote: "the reason",
  rules: ["R1"],
  context: "the reason",
  ...over,
});

describe("引文裁決樣本", () => {
  it("residue 切掉標記後留下真正的內容", () => {
    assert.equal(residueOf("the reason"), "");
    assert.equal(residueOf("otherwise."), "");
    assert.equal(residueOf("instead of main"), "main");
    // 標記後只有一個數字仍然是內容——被拒絕的替代方案就是這個工具的題目。
    assert.equal(residueOf("instead of 4."), "4");
  });

  it("R1 會抓到「instead of …」這類簡短但有內容的引文", () => {
    // 這條測試不是在肯定 R1，是釘住它的代價：實測 demo 語料 68 條 R1 命中
    // 裡有 42 條是被拒絕的替代方案。規則要能被定價才談得上採不採用。
    const r1 = ruleById("R1");
    assert.equal(r1.matches("instead of main"), true);
    assert.equal(r1.matches("to avoid early return"), true);
  });

  it("R4 比長度精確，但仍會誤傷只有一個字的內容", () => {
    const r4 = ruleById("R4");
    assert.equal(r4.matches("the reason"), true);
    assert.equal(r4.matches("instead of main"), false);
    // 實測命中：`4` 是內容不是空殼。這條測試存在是為了讓這個代價不會被忘記。
    assert.equal(r4.matches("instead of 4."), true);
  });

  it("**規則彼此重疊時，標頭不得與表格各說各話**", () => {
    // 一條引文只列在最先命中它的規則底下。若後面的規則整段是空的卻直接消失，
    // 讀者會以為表格的數字算錯了。空段落要明講「沒有獨立代價」。
    const text = renderQuoteAudit(audit(
      [caseOf({ rules: ["R1", "R4"] })],
      [
        { id: "R1", description: "長度 < 30 字元", hits: 1 },
        { id: "R4", description: "標記後不足 4 個字元", hits: 1 },
      ],
    ));
    assert.match(text, /## R1.*（此段 1 條）/);
    assert.match(text, /## R4/, "命中數非零的規則不得整段消失");
    assert.match(text, /沒有獨立的代價/);
  });

  it("**上下文自帶程式碼圍欄時外層圍欄要更長**", () => {
    // PR 留言常含程式碼區塊（實測 103 條裡 7 條）。固定三格圍欄會被內層打斷，
    // 而被打斷的正是上下文——這份報告存在的理由。
    const context = "見下：\n```js\nconst a = 1;\n```";
    const text = renderQuoteAudit(audit(
      [caseOf({ context })],
      [{ id: "R1", description: "長度 < 30 字元", hits: 1 }],
    ));
    // 數「圍欄行的奇偶」會把內層的收尾 ``` 一起算進去，那不是要守的事。
    // 要守的是外層嚴格長於內容裡最長的反引號串——那才是內層打不斷它的條件。
    const longestInside = Math.max(
      ...[...context.matchAll(/`+/g)].map((m) => m[0].length),
    );
    const outer = /\n(`{3,})\n見下：/.exec(text)?.[1];
    assert.ok(outer, "找不到包住上下文的外層圍欄");
    assert.ok(
      outer.length > longestInside,
      `外層圍欄 ${outer.length} 格，內層最長 ${longestInside} 格——會被提早關閉`,
    );
    const standalone = text.split("\n").filter((line) => line === outer).length;
    assert.equal(standalone, 2, "外層圍欄必須恰好一開一收");
  });

  it("裁決欄三個選項都要出現，不只留刪二選一", () => {
    // 只給「留／刪」的話，「理由其實在隔壁行、該拉長 span」會被誤記成
    // 「這條沒有價值」，而那兩者導向完全不同的抽取器改動。
    const text = renderQuoteAudit(audit(
      [caseOf()],
      [{ id: "R1", description: "長度 < 30 字元", hits: 1 }],
    ));
    for (const verdict of ["真理由", "空殼", "該拉長"]) {
      assert.match(text, new RegExp(verdict));
    }
  });
});
