import { createHash } from "node:crypto";

/**
 * span 斷言。**純函式，零 LLM、零 IO。**
 *
 * 這是整個信譽架構的基石。`stated` / `linked` 層是抽取式不是生成式：模型只回傳
 * 原文的字元起訖，程式必須斷言那段文字確實存在於 `source_doc.body`。對不上就
 * **整條丟棄**——不修剪、不正規化、不模糊比對、不降級使用。
 *
 * 為什麼不能有任何寬容：一旦允許「差不多就好」，證據就不再是引用而是改寫，
 * 而「這句話是他自己說的」正是這個產品唯一無法被質疑的東西。放寬一次，
 * 之後沒有任何地方能重新判斷哪些證據是真的。
 *
 * 這個模組刻意不知道 LLM 的存在。候選從哪裡來（規則、模型、匯入）都走同一道驗證。
 */

/**
 * 位移的單位是 **UTF-16 碼元**，也就是 JavaScript 字串的原生索引。
 *
 * 單位選擇本身沒有安全性含意，因為真正的錨點是 `quotedText`：單位對不上就會
 * slice 不出同樣的文字，結果是拒絕而不是寫入錯的東西。明確寫下來是為了讓
 * 產生候選的那一端有唯一的契約可依循。
 */
export interface ProposedSpan {
  charStart: number;
  charEnd: number;
  /** 模型宣稱在該區間的原文。逐字，含空白。 */
  quotedText: string;
  /** 產生候選時看到的 body sha256。上游文字被編輯過就不該再採信。 */
  expectedBodySha: string;
}

export type RejectionReason =
  /** 起訖不是整數、負數，或 end <= start */
  | "malformed_range"
  /** 區間超出文字範圍 */
  | "out_of_range"
  /** 上游文字已被編輯，候選是對舊版算的 */
  | "stale_document"
  /** 區間切在代理對中間，會產生半個字元 */
  | "splits_surrogate_pair"
  /** 該區間的原文與宣稱的引文不同，但引文確實出現在文中的別處 */
  | "offset_mismatch"
  /** 引文根本不在文中——這是幻覺 */
  | "text_not_found"
  /** 引文是空的 */
  | "empty_quote";

export interface VerifiedSpan {
  ok: true;
  charStart: number;
  charEnd: number;
  quotedText: string;
  docBodySha: string;
}

export interface RejectedSpan {
  ok: false;
  reason: RejectionReason;
  /**
   * 給人看的細節，**不得**被程式拿來反推判定。判定語意一律看 `reason`。
   */
  detail: string;
}

export type SpanVerdict = VerifiedSpan | RejectedSpan;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * 驗證一個候選 span。
 *
 * 回傳拒絕理由而不是丟例外：一個壞候選不該讓整批索引停擺，但也絕不靜默——
 * 理由會寫進 `evidence_candidate.rejection_reason`，用來調整產生端。
 */
export function verifySpan(body: string, bodySha: string, span: ProposedSpan): SpanVerdict {
  const { charStart, charEnd, quotedText, expectedBodySha } = span;

  if (quotedText.length === 0) {
    return { ok: false, reason: "empty_quote", detail: "引文為空" };
  }
  if (
    !Number.isInteger(charStart) || !Number.isInteger(charEnd)
    || charStart < 0 || charEnd <= charStart
  ) {
    return {
      ok: false,
      reason: "malformed_range",
      detail: `起訖不合法：[${charStart}, ${charEnd})`,
    };
  }
  if (charEnd > body.length) {
    return {
      ok: false,
      reason: "out_of_range",
      detail: `區間 [${charStart}, ${charEnd}) 超出長度 ${body.length}`,
    };
  }
  // 先比 sha 再比內容：文字被上游編輯過時，內容比對就算碰巧通過也不該採信，
  // 因為候選是針對另一份文字算出來的。
  if (expectedBodySha !== bodySha) {
    return {
      ok: false,
      reason: "stale_document",
      detail: `候選看到的 body sha 是 ${expectedBodySha.slice(0, 12)}，實際是 ${bodySha.slice(0, 12)}`,
    };
  }
  // 切在代理對中間會產生半個字元。slice 出來的字串仍可能與同樣被切壞的引文相等，
  // 所以必須獨立檢查，不能只靠內容比對。
  if (
    (charStart > 0 && isLowSurrogate(body.charCodeAt(charStart))
      && isHighSurrogate(body.charCodeAt(charStart - 1)))
    || (charEnd < body.length && isLowSurrogate(body.charCodeAt(charEnd))
      && isHighSurrogate(body.charCodeAt(charEnd - 1)))
  ) {
    return {
      ok: false,
      reason: "splits_surrogate_pair",
      detail: `區間 [${charStart}, ${charEnd}) 切在代理對中間`,
    };
  }

  const actual = body.slice(charStart, charEnd);
  if (actual !== quotedText) {
    // 分開兩種理由：位移錯了（文字真的存在，只是不在那裡）與整段是幻覺。
    // 兩者要調整的東西完全不同，混為一談就看不出產生端到底哪裡壞掉。
    const found = body.indexOf(quotedText);
    return found >= 0
      ? {
        ok: false,
        reason: "offset_mismatch",
        detail: `引文實際出現在 ${found}，不是 ${charStart}`,
      }
      : {
        ok: false,
        reason: "text_not_found",
        detail: "引文不存在於原文——整條丟棄",
      };
  }

  return {
    ok: true,
    charStart,
    charEnd,
    quotedText,
    docBodySha: bodySha,
  };
}

/**
 * 呈現用：把引文裡的硬換行收成一個空白。
 *
 * commit body 換行在 72 字元是排版，不是內容。跨行的引文在儲存層必須逐字
 * （否則 `verifySpan` 不成立），但印成一行時那些換行會把版面撐斷，
 * 在 CLI 上尤其明顯。
 *
 * **只有一份實作，CLI 與畫面共用。** 各寫一份的話同一條引文會在兩個地方
 * 長得不一樣，而這個專案已經因為「兩份實作分岔」踩過好幾次。
 */
export function unwrapQuote(text: string): string {
  return text.replace(/[ \t]*\r?\n[ \t]*/g, " ");
}
