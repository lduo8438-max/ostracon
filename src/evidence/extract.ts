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

export const EXTRACTOR_VERSION = "rule-rationale-0.4.0";
export const MARKDOWN_EXTRACTOR_VERSION = "rule-rationale-markdown-0.4.0";

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
 *
 * **中文的名詞標記一律要求冒號**（`理由：`／`原因：`），與英文的 `reason:`／
 * `why:` 是同一個形狀。理由是中文沒有詞界而 `indexOf` 照配：裸的 `理由` 會
 * 命中 `真理由`、`判斷理由`、`當成理由`，抽出來的引文從詞中間開始。最壞的
 * 一種是把否定詞留在 span 外面——`版本字串沒有理由改變` 會抽出 `理由改變。`，
 * 逐字為真、意思相反。**span 斷言擋不住這個**：它保證引文出自原文，
 * 不保證切點沒有把句子的意思切反。
 *
 * 連接詞類（`因為`／`由於`／`否則`）不受此限，它們接在漢字後面是合法的
 * （`這是因為…`）。實測自我索引語料：泛用的「前一字不得是漢字」規則
 * **代價 1 條、收益 0 條**，所以被否決；27 次 `理由`／`原因` 裡只有 1 次
 * 帶冒號，其餘 26 次沒有一條是真的理由。
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
  // 半形冒號一併收：中文輸入法下兩種都會打出來。
  "理由：",
  "理由:",
  "原因：",
  "原因:",
];

/**
 * `since` 的時間義。英文的 `since` 同時是「因為」與「自從」，`indexOf` 分不出來。
 *
 * 這不是品質門檻，是**配錯詞義**：`since August.` 從來就不是一條理由，
 * 不是一條寫得太短的理由。實測 demo 語料 86 條 `since` 裡有 5 條是時間義，
 * 5 條全部沒有理由內容，而收緊長度要連帶殺掉另外 55 條有內容的短引文。
 *
 * 數字只認四位數年份與帶 `v`／`version` 的版本號。裸數字太寬——
 * `since 3 people complained` 是真的理由，把它當成時間義丟掉就是這個修正
 * 本身要消滅的那種靜默錯誤。
 */
const TEMPORAL_SINCE =
  /^(?:\d{4}\b|v\d|version\b|then\b|last\b|early\b|late\b|yesterday\b|today\b|launch\b|the\s+(?:last|beginning|start)\b|jan(?:uary)?\b|feb(?:ruary)?\b|mar(?:ch)?\b|apr(?:il)?\b|may\b|jun(?:e)?\b|jul(?:y)?\b|aug(?:ust)?\b|sep(?:t|tember)?\b|oct(?:ober)?\b|nov(?:ember)?\b|dec(?:ember)?\b)/i;

/**
 * `so that` 後面接繫詞時是「所以，那個是……」，不是表目的的 `so that`。
 *
 * 這一類的理由在標記**之前**（`X，所以那就是 Y`），與其他標記方向相反，
 * 所以不是丟掉而是把左邊界往前拉到句首。裁決把這一類全判為「該拉長」。
 */
const DEMONSTRATIVE_SO_THAT = /^(?:['’]s\b|\s+(?:is|was|are|were)\b)/i;

/**
 * 對比標記的**被拒方案在標記左邊**，所以左邊界要拉到句首。
 *
 * `instead of` 的整個內容就是那組對比：「本來要用 A，改用 B」。只引右半邊會
 * 得到 `instead of question while merging the router (#330)`——逐字為真、span
 * 斷言通過、意思殘缺，與中文標記那條 `理由改變。` 是同一型的缺陷。
 *
 * 實測四條全部掉了左側：`fix: use auth`、`refactor: using path`、
 * `fix: load all CCTV regions globally`、`Fix active fires layer to use
 * global NASA FIRMS Open Data CSVs`。在 UI 上看 Osiris 覺得沒問題，是因為
 * entity 的上下文剛好補回了左半——換個沒有上下文的場合就露餡。
 *
 * `to avoid`／`to prevent` 這類**不**跟著擴張：它們的內容在標記右邊，往前拉
 * 只會把不相干的前文收進引文。
 */
const CONTRASTIVE_MARKERS = new Set(["instead of", "rather than"]);

/** 行首的清單標記與空白。修剪必須反映在位移上，否則 span 會對不上。 */
const LEADING_NOISE = /^[\s>*\-+•·]+/;
const TRAILING_NOISE = /[\s]+$/;

/**
 * 標記之後是否還有實質內容。
 *
 * `the reason`、`otherwise.` 這種「標記自己就是整句」的引文毫無資訊量，
 * 但它們短不是問題的本質——`instead of 4.` 一樣短，那個 `4` 卻正是內容。
 * 判準是標記後有沒有字母或數字，不是剩幾個字元。
 */
function hasContentAfterMarker(rest: string): boolean {
  return /[\p{L}\p{N}]/u.test(rest);
}

/**
 * 往前找句首：標記之前最後一個句末標點之後，找不到就退回行首。
 *
 * 只在行內找。跨行往前拉會把別人的句子收進來——`provenance_root` 去重是
 * 以文件為單位的，行與行之間可能根本不是同一個人在說話。
 */
function sentenceStart(line: string, upTo: number, leading: number): number {
  let at = leading;
  for (const m of line.slice(0, upTo).matchAll(/[.!?]["'’)\]]?\s+/g)) {
    at = Math.max(at, m.index + m[0].length);
  }
  return at;
}

interface MarkerHit {
  marker: string;
  /** 標記在行內的起點。 */
  at: number;
  /** span 的左邊界。多數等於 `at`；結果標記會往前拉到句首。 */
  from: number;
}

/**
 * 行內所有通過詞義檢查的標記，依位置排序。
 *
 * 逐一檢查而不是「取最早的一個就算」，是因為被否決的標記不該連累整行：
 * `since August. Dropped X to avoid Y` 的理由在第二個標記上。
 */
function markerHits(rawLine: string, leading: number, end: number): MarkerHit[] {
  const lower = rawLine.toLowerCase();
  const hits: MarkerHit[] = [];
  for (const marker of CAUSAL_MARKERS) {
    for (let at = lower.indexOf(marker); at >= 0; at = lower.indexOf(marker, at + 1)) {
      const rest = rawLine.slice(at + marker.length, end);
      if (marker === "since " && TEMPORAL_SINCE.test(rest)) continue;
      if (!hasContentAfterMarker(rest)) continue;
      const demonstrative = marker === "so that" && DEMONSTRATIVE_SO_THAT.test(rest);
      // 兩種情況的理由都在標記**之前**，方向與其他標記相反。
      const pullBack = demonstrative || CONTRASTIVE_MARKERS.has(marker);
      hits.push({
        marker,
        at,
        from: pullBack ? sentenceStart(rawLine, at, leading) : at,
      });
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

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

    const leading = LEADING_NOISE.exec(rawLine)?.[0].length ?? 0;
    const trailing = TRAILING_NOISE.exec(rawLine)?.[0].length ?? 0;
    const lineEnd = rawLine.length - trailing;

    // 取最早通過詞義檢查的標記：一行有多個時，理由通常從第一個開始。
    const hit = markerHits(rawLine, leading, lineEnd)[0];
    if (hit === undefined) continue;

    const start = lineStart + Math.max(hit.from, leading);
    const end = lineStart + lineEnd;
    if (end <= start) continue;

    out.push({
      charStart: start,
      charEnd: end,
      quotedText: body.slice(start, end),
      rule: hit.from === hit.at
        ? `causal:${hit.marker.trim()}`
        // 左邊界被往前拉過，事後分析要分得出來這條與一般 span 不同。
        : `causal:${hit.marker.trim()}/result`,
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
