import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { createSourcePositions } from "../src/ast/positions.ts";

/**
 * 樸素實作就是被取代的那一份：從檔案開頭重算。索引只准比它快，不准比它不同。
 * `line_start` 與 `byte_start` 都是 `revision` 的欄位，答案變了就是不變量 7 的違反。
 */
const naiveLine = (source: string, index: number): number =>
  source.slice(0, index).split("\n").length;
const naiveByte = (source: string, index: number): number =>
  Buffer.byteLength(source.slice(0, index), "utf8");

const SOURCES: Record<string, string> = {
  ascii: "const a = 1;\nfunction f() {\n  return a;\n}\n",
  // 非 ASCII 讓字元位移與位元組位移分家——ASCII 快路徑若誤判就會在這裡爆。
  chinese: "// 版本字串沒有理由改變\nconst 名字 = \"值\";\n\nfunction 函式() {\n  return 名字;\n}\n",
  // 代理對：一個 emoji 佔兩個 UTF-16 碼元、四個 UTF-8 位元組。
  emoji: "const flag = \"🇹🇼\";\nconst face = \"🙂\"; // 註解 🙂\nconst x = 1;\n",
  // CRLF：`\r` 屬於前一行，行首仍只由 `\n` 決定。
  crlf: "const a = 1;\r\nconst b = 2;\r\n\r\nconst c = 3;\r\n",
  noTrailingNewline: "const a = 1;\nconst b = 2;",
  emptyLines: "\n\n\nconst a = 1;\n\n\n",
  single: "const only = 1;",
  empty: "",
};

describe("原始碼位置索引", () => {
  it("**每一個字元位移上都與樸素實作相同**", () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      const positions = createSourcePositions(source);
      for (let i = 0; i <= source.length; i++) {
        assert.equal(positions.lineAt(i), naiveLine(source, i), `${name} 的第 ${i} 個位移行號不同`);
        assert.equal(positions.byteAt(i), naiveByte(source, i), `${name} 的第 ${i} 個位移位元組不同`);
      }
    }
  });

  it("隨機原始碼上仍然逐點相同", () => {
    // 固定種子：失敗要能重現。形狀混合換行、非 ASCII 與代理對。
    let seed = 20260918;
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ["a", " ", "\n", "\r\n", "中", "🙂", "\t", "}"];
    for (let round = 0; round < 40; round++) {
      let source = "";
      const length = Math.floor(next() * 400);
      for (let i = 0; i < length; i++) source += alphabet[Math.floor(next() * alphabet.length)]!;
      const positions = createSourcePositions(source);
      for (let i = 0; i <= source.length; i++) {
        assert.equal(positions.lineAt(i), naiveLine(source, i));
        assert.equal(positions.byteAt(i), naiveByte(source, i));
      }
    }
  });

  it("非 ASCII 檔案不得走 ASCII 快路徑", () => {
    // 快路徑的判準是「位元組數等於字元數」。這條釘住它真的被判成 false——
    // 只驗答案相同的話，快路徑寫成恆真也要靠別的案例才咬得到。
    const source = SOURCES.chinese!;
    const index = source.indexOf("const");
    assert.notEqual(createSourcePositions(source).byteAt(index), index);
    assert.equal(createSourcePositions(source).byteAt(index), naiveByte(source, index));
  });
});
