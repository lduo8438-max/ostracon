import { Buffer } from "node:buffer";

/**
 * 一份原始碼的位置索引：字元位移 → 行號／UTF-8 位元組位移。
 *
 * **存在的理由是成本形狀，不是語意。** `lineRange` 與 `utf8ByteRange` 原本各自
 * 用 `source.slice(0, index)` 從檔案開頭重算，於是同一份檔案的每個宣告都要再掃
 * 一次整份原始碼——成本是「宣告數 × 檔案大小」。playwright 全歷史實測 `lineRange`
 * 自身佔 457 秒（repo pass 的 27%）、`utf8ByteRange` 103 秒，而全部 SQL 只有 124 秒。
 *
 * 索引一份檔案建一次、宣告共用，查詢是二分搜尋加「行首到該位置」的一小段。
 * 答案必須與逐次重算逐位元相同，這是不變量 7 的要求——`byte_start` 等欄位是
 * 產出的一部分。等價性由 `test/positions.test.ts` 對照樸素實作釘住。
 */
export interface SourcePositions {
  /** 1-based 行號，與 `lineRange` 記進 `revision.line_start` 的定義相同。 */
  lineAt(index: number): number;
  /** 該字元位移之前有幾個 UTF-8 位元組。 */
  byteAt(index: number): number;
}

export function createSourcePositions(source: string): SourcePositions {
  // 惰性建表：只解析、不寫入 revision 的路徑（例如只比雜湊）不必付這個成本。
  let lineStarts: number[] | undefined;
  let lineBytes: number[] | undefined;
  // 純 ASCII 時位元組位移恆等於字元位移，連表都不用查。實測大多數原始碼屬於這類。
  let ascii: boolean | undefined;

  const build = (): void => {
    if (lineStarts !== undefined) return;
    const starts = [0];
    for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) {
      starts.push(i + 1);
    }
    lineStarts = starts;
    ascii = Buffer.byteLength(source, "utf8") === source.length;
    if (ascii) return;
    const bytes = new Array<number>(starts.length);
    bytes[0] = 0;
    for (let line = 1; line < starts.length; line++) {
      bytes[line] = bytes[line - 1]!
        + Buffer.byteLength(source.slice(starts[line - 1]!, starts[line]!), "utf8");
    }
    lineBytes = bytes;
  };

  /** 回傳 `index` 落在第幾行（0-based），即最後一個不大於它的行首。 */
  const lineIndex = (index: number): number => {
    build();
    const starts = lineStarts!;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= index) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  return {
    lineAt: (index) => lineIndex(index) + 1,
    byteAt: (index) => {
      const line = lineIndex(index);
      if (ascii) return index;
      return lineBytes![line]! + Buffer.byteLength(source.slice(lineStarts![line]!, index), "utf8");
    },
  };
}
