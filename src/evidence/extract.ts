/**
 * 規則式抽取器。**純函式，零 LLM、零 IO。**
 *
 * 它的用途不是「取代模型」，而是三件事：
 *   1. 讓 span 斷言有真實輸入，驗證那一半才不是紙上談兵；
 *   2. 定義候選的產出契約——模型日後填的是同一個形狀，走同一道驗證；
 *   3. 當成模型必須打敗的基準線。沒有基準線，「模型有幫助嗎」無法回答。
 *
 * 刻意**高精確率、低召回率**：只在有明確理由標記時才產出候選。寧可漏掉，
 * 也不要為了讓覆蓋率好看而把「做了什麼」當成「為什麼」——那會讓 stated 層
 * 從引用退化成摘要，正好毀掉這一層唯一的價值。
 */

/** 尚未綁定文件的候選 span。呼叫端補上 `expectedBodySha`。 */
export interface ExtractedSpan {
  charStart: number;
  charEnd: number;
  quotedText: string;
  /** 命中的規則，寫進 `generator_version` 供事後分析。 */
  rule: string;
}

export const EXTRACTOR_VERSION = "rule-rationale-0.1.0";
export const MARKDOWN_EXTRACTOR_VERSION = "rule-rationale-markdown-0.1.0";

export interface ExtractRationaleOptions {
  /** linked 文件是 Markdown；排除程式碼 fence 與引用行，避免引用別人的理由。 */
  format?: "plain" | "markdown";
}

/**
 * 因果標記。**只收真正引入理由的詞**。
 *
 * 「fix」「update」這類動詞刻意不收：它們說的是做了什麼，不是為什麼。
 * 中英並列是因為這個專案自己的 commit message 就是中文——工具必須能讀
 * 使用者實際寫的語言，不是只讀英文。
 */
const CAUSAL_MARKERS = [
  "because",
  "since ",
  "due to",
  "in order to",
  "so that",
  "otherwise",
  "to avoid",
  "to prevent",
  "to ensure",
  "instead of",
  "rather than",
  "the reason",
  "reason:",
  "why:",
  "因為",
  "由於",
  "為了",
  "避免",
  "以免",
  "否則",
  "理由",
  "原因",
];

/** 行首的清單標記與空白。修剪必須反映在位移上，否則 span 會對不上。 */
const LEADING_NOISE = /^[\s>*\-+•·]+/;
const TRAILING_NOISE = /[\s]+$/;

/**
 * 從文件全文抽出「解釋動機」的候選 span。
 *
 * 以行為單位掃描，因為 commit message 是行導向的（條列、trailer、段落）；
 * 但**span 從因果標記處開始**，不是從行首。理由是實測看到的：
 * `fix: disable ISR to prevent quota burn` 整行當引文，會與時間軸上方已經
 * 印出的 subject 一字不差地重複——那不是引用理由，是把標題抄一遍。
 * 從標記開始才真的只留下「為什麼」的那一段。
 *
 * 右邊界取到行尾。切在標點會更緊，但逗號在中英文的用法差異太大，
 * 硬切容易把理由本身截斷。**收緊右邊界正是模型可能勝過規則的地方**——
 * 那是日後比較兩者時該看的具體差異，不是現在該猜的。
 *
 * 修剪量直接反映在 `charStart` / `charEnd` 上，所以產出的 span 一定能通過
 * `verifySpan`。這不是巧合，是這個模組的責任：抽取器不得產出自己的驗證器
 * 會拒絕的東西。
 */
export function extractRationale(
  body: string,
  options: ExtractRationaleOptions = {},
): ExtractedSpan[] {
  const out: ExtractedSpan[] = [];
  let offset = 0;
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (const rawLine of body.split("\n")) {
    const lineStart = offset;
    offset += rawLine.length + 1; // +1 是被 split 吃掉的換行

    if (options.format === "markdown") {
      const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(rawLine)?.[1];
      if (opening) {
        const marker = opening[0] as "`" | "~";
        if (fence === undefined) {
          fence = { marker, length: opening.length };
        } else if (
          marker === fence.marker
          && opening.length >= fence.length
          && rawLine.slice(rawLine.indexOf(opening) + opening.length).trim() === ""
        ) {
          fence = undefined;
        }
        continue;
      }
      if (fence !== undefined || /^\s{0,3}>/.test(rawLine)) continue;
    }

    const lower = rawLine.toLowerCase();
    // 取最早出現的標記：一行有多個時，理由通常從第一個開始。
    let marker: string | undefined;
    let markerAt = -1;
    for (const candidate of CAUSAL_MARKERS) {
      const at = lower.indexOf(candidate);
      if (at >= 0 && (markerAt === -1 || at < markerAt)) {
        marker = candidate;
        markerAt = at;
      }
    }
    if (marker === undefined) continue;

    const leading = LEADING_NOISE.exec(rawLine)?.[0].length ?? 0;
    const trailing = TRAILING_NOISE.exec(rawLine)?.[0].length ?? 0;
    const start = lineStart + Math.max(markerAt, leading);
    const end = lineStart + rawLine.length - trailing;
    if (end <= start) continue;

    out.push({
      charStart: start,
      charEnd: end,
      quotedText: body.slice(start, end),
      rule: `causal:${marker.trim()}`,
    });
  }
  return out;
}

export interface ExtractedReference {
  toKind: "issue" | "pr";
  toKey: string;
  /** 觸發的關鍵字；`closes` 之類代表關聯強度較高。 */
  method: "message_ref";
  confidence: number;
}

/**
 * 從文件全文抽出 issue / PR 參照。
 *
 * 這些**不是 evidence**：它們是 `reference_link`，指向另一份還沒被取回的文件。
 * `linked` 層的證據要等那份文件真的被收進 `source_doc`（需要網路）才能成立。
 * 把參照本身當成證據，等於宣稱「他提到了 #72」就是「他解釋了為什麼」。
 */
export function extractReferences(body: string): ExtractedReference[] {
  const seen = new Map<string, ExtractedReference>();
  // 「closes/fixes/resolves #N」的關聯性明顯高於裸的「#N」。
  const closing = /\b(clos(?:e|es|ed)|fix(?:e[sd])?|resolv(?:e|es|ed))\s+#(\d+)/gi;
  for (const m of body.matchAll(closing)) {
    const key = m[2]!;
    seen.set(key, { toKind: "issue", toKey: key, method: "message_ref", confidence: 0.9 });
  }
  for (const m of body.matchAll(/#(\d+)/g)) {
    const key = m[1]!;
    if (!seen.has(key)) {
      // 裸參照可能只是「與 #12 相關」，甚至是別的東西的編號。
      seen.set(key, { toKind: "issue", toKey: key, method: "message_ref", confidence: 0.4 });
    }
  }
  return [...seen.values()].sort((a, b) => Number(a.toKey) - Number(b.toKey));
}
