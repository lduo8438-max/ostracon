import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { insidePureAddHunk, reconstructOldRange } from "../src/match/position.ts";
import type { DiffHunk } from "../src/git/types.ts";

const h = (oldStart: number, oldCount: number, newStart: number, newCount: number): DiffHunk =>
  ({ oldStart, oldCount, newStart, newCount });

describe("reconstructOldRange", () => {
  it("沒有 hunk 時位置不變", () => {
    assert.deepEqual(reconstructOldRange(10, 20, []), { startLine: 10, endLine: 20 });
  });

  it("前方的純新增把宣告往後推，回推要減掉", () => {
    // 第 1 行後插入 3 行 → 原本的第 10 行現在是第 13 行
    assert.deepEqual(
      reconstructOldRange(13, 23, [h(1, 0, 2, 3)]),
      { startLine: 10, endLine: 20 },
    );
  });

  it("前方的純刪除把宣告往前拉", () => {
    assert.deepEqual(
      reconstructOldRange(7, 17, [h(2, 3, 1, 0)]),
      { startLine: 10, endLine: 20 },
    );
  });

  it("後方的 hunk 完全不影響", () => {
    assert.deepEqual(
      reconstructOldRange(10, 20, [h(50, 0, 51, 5)]),
      { startLine: 10, endLine: 20 },
    );
  });

  it("多個前方 hunk 的位移累加", () => {
    assert.deepEqual(
      reconstructOldRange(15, 25, [h(1, 0, 2, 3), h(5, 3, 8, 5)]),
      { startLine: 10, endLine: 20 },
    );
  });

  it("宣告被 hunk 碰到就沒有位置證據", () => {
    assert.equal(reconstructOldRange(10, 20, [h(15, 1, 15, 1)]), null);
    assert.equal(reconstructOldRange(10, 20, [h(10, 2, 10, 2)]), null, "起點重疊");
    assert.equal(reconstructOldRange(10, 20, [h(20, 2, 20, 2)]), null, "終點重疊");
  });

  it("位移為零但落在宣告正中間的 hunk 必須擋下來", () => {
    // 兩行換兩行：端點回推得到完全正確的舊行號，但宣告內容其實改了。
    // 只比對端點的實作會在這裡產生一個假的位置證明。
    assert.equal(reconstructOldRange(10, 20, [h(15, 2, 15, 2)]), null);
  });

  it("落在宣告內的純刪除也算碰到", () => {
    // 新側不佔任何行，範圍相交測不到；但宣告確實少了幾行。
    assert.equal(reconstructOldRange(10, 20, [h(16, 3, 15, 0)]), null);
  });

  it("緊鄰宣告之前的純刪除不算碰到", () => {
    assert.deepEqual(
      reconstructOldRange(10, 20, [h(5, 2, 9, 0)]),
      { startLine: 12, endLine: 22 },
    );
  });

  it("hunk 順序顛倒不改變結果", () => {
    const hunks = [h(5, 3, 8, 5), h(1, 0, 2, 3)];
    assert.deepEqual(
      reconstructOldRange(15, 25, hunks),
      { startLine: 10, endLine: 20 },
      "呼叫端排錯順序時不得安靜地算出錯誤位移",
    );
  });
});

describe("insidePureAddHunk", () => {
  it("完全落在純新增 hunk 內", () => {
    assert.equal(insidePureAddHunk(11, 13, [h(10, 0, 11, 3)]), true);
  });

  it("超出純新增 hunk 的範圍不算", () => {
    assert.equal(insidePureAddHunk(11, 14, [h(10, 0, 11, 3)]), false);
  });

  it("修改 hunk 即使新側範圍相同也不算純新增", () => {
    // 這正是 file_hunk 一列一個 hunk 的理由：拆成 old/new 兩列之後
    // 這兩種情況的新側範圍完全同形，被修改的宣告會被誤判成 birth。
    assert.equal(insidePureAddHunk(11, 13, [h(10, 3, 11, 3)]), false);
  });

  it("純刪除不是純新增", () => {
    assert.equal(insidePureAddHunk(11, 13, [h(10, 3, 10, 0)]), false);
  });
});
