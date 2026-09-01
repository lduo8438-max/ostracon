import { existsSync } from "node:fs";
import { readBlobsBatch } from "../index/structural.ts";

/**
 * 一段宣告的原始碼片段。
 *
 * **索引不存原始碼**（`revision` 只有 `blob_sha` 與 byte 位移），所以片段是
 * 讀取時從 git blob 切出來的。這個檔案是那條路徑的唯一入口。
 */
export interface Snippet {
  text: string;
  /** 這段宣告原本有幾行。截斷時 `text` 只含前面幾行。 */
  lines: number;
  /**
   * 有沒有被截斷。**截斷必須看得見**——顯示前 24 行卻不說，使用者會以為
   * 那就是全部，而「這段程式碼長什麼樣」正是這個畫面唯一要回答的事。
   */
  truncated: boolean;
}

/**
 * 行數上限。**量出來的，不是猜的。**
 *
 * 549 段真實片段（vuejs/core 的斷層與跨檔案搬移）的行數分佈：中位數 5 行、
 * p90 是 20 行、p99 是 75 行。上限 24 行會截斷 7.8%，而斷層畫面是前後並列，
 * 兩欄各 24 行已經是一個螢幕。再往上放寬換到的比例很少（32 行 5.8%）。
 */
export const SNIPPET_MAX_LINES = 24;

/**
 * 位元組上限。行數上限擋不住單行極長的輸入（壓縮過的產物、產生的程式碼），
 * 那種一行就可能是幾百 KB。實測最大的一段宣告是 3.8 KB，所以 4,000 bytes
 * 只會在病態輸入上生效，不會切到正常的宣告。
 */
export const SNIPPET_MAX_BYTES = 4_000;

/** 一段要讀的片段：哪個 blob 的哪一段 byte。 */
export interface SnippetRequest {
  /** 呼叫端自己的識別碼，原樣帶回。 */
  id: string;
  blobSha: string;
  byteStart: number;
  byteEnd: number;
}

/**
 * 截斷規則本身。**匯出給測試，因為它是這個檔案唯一有判斷的地方**——
 * 其餘都是 git 與位移運算，而規則寫錯不會有任何東西報錯，只會安靜地
 * 把「還有 100 行」說成「就這樣」。
 */
export function truncateForTest(raw: Buffer): Snippet {
  return truncate(raw);
}

function truncate(raw: Buffer): Snippet {
  const capped = raw.length > SNIPPET_MAX_BYTES
    ? raw.subarray(0, SNIPPET_MAX_BYTES)
    : raw;
  const all = capped.toString("utf8").split("\n");
  // 原始行數以完整片段算，不是以截斷後的算——標「還有幾行」要有正確的分母。
  const lines = raw.toString("utf8").split("\n").length;
  const kept = all.slice(0, SNIPPET_MAX_LINES);
  return {
    text: kept.join("\n"),
    lines,
    truncated: kept.length < lines || capped.length < raw.length,
  };
}

/**
 * 從本地 git 讀出片段。
 *
 * **一次批次讀完所有 blob**（`readBlobsBatch` 用 `git cat-file --batch`）：
 * 實測 vuejs/core 的 549 段片段只落在 222 個相異 blob 上，逐段讀會是 549 次
 * 行程啟動。
 *
 * repo 不存在時回空 Map 而不是丟例外——呼叫端要能把「讀不到」說出來，
 * 而不是整個畫面掛掉。**但呼叫端不得靜默省略**：payload 要帶原因。
 */
export interface SnippetResult {
  snippets: Map<string, Snippet>;
  /**
   * 語料讀得到嗎。**與「有沒有東西可讀」是兩件事。**
   *
   * 先前用 `snippets.size > 0` 當成功判準，於是 create-t3-app（0 個斷層、
   * 沒有任何片段要讀）被報成 `repo-unavailable`——語料明明就在。
   * 把「沒東西可讀」說成「讀不到」，與 NULL／0 是同一型的錯。
   */
  readable: boolean;
}

export function readSnippets(
  repoRoot: string,
  requests: readonly SnippetRequest[],
): SnippetResult {
  const out = new Map<string, Snippet>();
  if (!existsSync(repoRoot)) return { snippets: out, readable: false };
  if (requests.length === 0) return { snippets: out, readable: true };

  const specs = [...new Set(requests.map((r) => r.blobSha))];
  let blobs: Map<string, Buffer>;
  try {
    blobs = readBlobsBatch(repoRoot, specs);
  } catch {
    // 目錄在但不是 git repo、或 blob 已被 gc。
    return { snippets: out, readable: false };
  }

  for (const request of requests) {
    const blob = blobs.get(request.blobSha);
    if (blob === undefined) continue;
    out.set(request.id, truncate(blob.subarray(request.byteStart, request.byteEnd)));
  }
  return { snippets: out, readable: true };
}
