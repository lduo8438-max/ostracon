import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateSignal,
  attributable,
  isAggregateMessage,
  isInSubject,
  subjectEnd,
} from "../src/claim/aggregate.ts";

/** create-t3-app 的 release squash 長這樣：主旨一行，body 是上百條 PR 標題。 */
const SQUASH = [
  "chore: next-merge + trpc bump (#494)",
  "",
  "* fix: typo in T3 axiom #3",
  "",
  "* docs: write some docs (#323)",
  "",
  "* fix: use auth instead of question while merging the router (#330)",
  "",
  "* refactor: using path instead of passing prop",
].join("\n");

describe("聚合訊息的判定", () => {
  it("判準是結構而不是數量", () => {
    // 「幾條 bullet」是語料門檻，換個 repo 就要重調。「至少兩條清單條目，
    // 各自指向不同的 PR」才是可證明的聚合事實。
    assert.equal(isAggregateMessage(SQUASH), true);
    assert.deepEqual(aggregateSignal(SQUASH), { items: 3, distinctRefs: 3 });
  });

  it("**CRLF 的 body 一樣要認得出來**", () => {
    // 第一版用 `.` 比對整行，而 `.` 不匹配 `\r`，於是 CRLF 語料一條也認不出，
    // 靜默回報零。create-t3-app 的 body 正是 CRLF——LF 驗過、CRLF 沒驗過。
    const crlf = SQUASH.replaceAll("\n", "\r\n");
    assert.equal(isAggregateMessage(crlf), true);
    assert.deepEqual(aggregateSignal(crlf), aggregateSignal(SQUASH));
  });

  it("普通的多行 commit 不是聚合", () => {
    const normal = [
      "fix: cap the upstream fetch",
      "",
      "The provider rate-limits us, so cap concurrency to avoid the quota burn.",
      "Measured 4.2s -> 0.9s on the demo corpus.",
    ].join("\n");
    assert.equal(isAggregateMessage(normal), false);
  });

  it("有清單但沒有 PR 參照的不是聚合", () => {
    // 實測 create-t3-app 有兩顆這種 commit（5 條與 6 條分點），舊的數量門檻
    // 會把它們一起殺掉。一個作者替一次改動分點敘述，不是多份紀錄。
    const bulleted = [
      "refactor: split the fetcher",
      "",
      "* move retry into its own module",
      "* drop the unused timeout option",
      "* rename the export because the old name lied",
    ].join("\n");
    assert.equal(isAggregateMessage(bulleted), false);
    assert.deepEqual(aggregateSignal(bulleted), { items: 0, distinctRefs: 0 });
  });

  it("同一個 PR 被列很多次不是聚合", () => {
    const repeated = [
      "chore: land #412",
      "",
      "* first attempt at #412",
      "* fix review comments on #412",
      "* rebase #412",
    ].join("\n");
    assert.equal(aggregateSignal(repeated).items, 3);
    assert.equal(aggregateSignal(repeated).distinctRefs, 1);
    assert.equal(isAggregateMessage(repeated), false);
  });

  it("正文提到好幾個 issue 但沒有清單，不是聚合", () => {
    const prose = [
      "fix: stop double-counting evidence",
      "",
      "This is the same root cause as #101 and #205; both reported the",
      "duplicate rows because the dedup key ignored #310's new column.",
    ].join("\n");
    assert.equal(isAggregateMessage(prose), false);
  });

  it("只有一條清單條目帶參照，不足以證明聚合", () => {
    const single = ["fix: thing", "", "* closes #77", "* tidy up"].join("\n");
    assert.equal(aggregateSignal(single).items, 1);
    assert.equal(isAggregateMessage(single), false);
  });
});

describe("聚合訊息的歸因", () => {
  it("主旨行是作者替整顆 commit 寫的，仍可歸因", () => {
    assert.equal(subjectEnd(SQUASH), "chore: next-merge + trpc bump (#494)".length);
    assert.equal(isInSubject(SQUASH, 6), true);
    assert.equal(attributable(SQUASH, 6), true);
  });

  it("**body 深處的引文不得歸因**", () => {
    // 「哪一條 bullet 對應哪一個檔案改動」已經被 squash 銷毀，git 裡不再存在。
    // 照常升格的話，甲 PR 的理由會掛到乙 entity 上。
    const at = SQUASH.indexOf("instead of question");
    assert.ok(at > 0);
    assert.equal(attributable(SQUASH, at), false);
  });

  it("linked 證據在聚合 commit 上一律不得歸因", () => {
    // 證據根本不在這顆 commit 的訊息裡，而聚合 commit 提到上百個 PR，
    // 無從得知是哪一個對應到眼前這次改動。拆 provenance_root 也救不了——
    // 遺失的是 PR → file/entity 的 join key。
    assert.equal(attributable(SQUASH, undefined), false);
  });

  it("非聚合訊息完全不受影響", () => {
    const normal = "fix: cap it\n\nCapped to avoid the quota burn.";
    assert.equal(attributable(normal, normal.length - 5), true);
    assert.equal(attributable(normal, undefined), true);
  });

  it("單行訊息沒有 body，整條都是主旨", () => {
    const oneLine = "fix: use auth instead of a question";
    assert.equal(subjectEnd(oneLine), oneLine.length);
    assert.equal(attributable(oneLine, oneLine.length - 1), true);
  });
});
