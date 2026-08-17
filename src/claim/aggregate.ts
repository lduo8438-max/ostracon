/**
 * 聚合訊息偵測：一顆 commit 的訊息裡其實裝著**好幾份變更紀錄**。
 *
 * squash merge 會把 N 個 PR 壓成一顆 commit，把它們的標題串成 body 的清單。
 * 對證據層來說那些句子逐字為真；對 claim 層來說它是災難——**「哪一條 bullet
 * 對應哪一個檔案改動」這個映射已經被 squash 銷毀了，git 裡不再存在**。
 * 照常升格的話，甲 PR 的理由會被掛到乙 entity 上，產生錯誤的歷史。
 *
 * 這正是不變量 11 的反面：那些條目各有各的 `provenance_root`，我們卻把它們
 * 當成同一份文件在用。差別在於去重救不了這裡——拆開也還原不了遺失的
 * PR → file/entity join key。
 *
 * **判準是結構，不是數量。** 「body 裡有幾條 bullet」是語料門檻，換一個 repo
 * 就要重調；「有兩個以上的清單條目，各自指向不同的 PR」則是可證明的聚合事實：
 * 一段普通的 commit body 不會逐條標註不同的 PR 編號。實測 create-t3-app
 * 1,378 顆 commit 判出 8 顆聚合，而兩顆各有 5、6 條 bullet 但沒有相異 PR
 * 參照的普通 commit 正確地沒有被判進來。
 */

/** 清單條目：`*`／`-`／`+` 或 `1.`／`1)` 起頭。 */
const LIST_ITEM = /^[ \t]*(?:[*+-]|\d+[.)])[ \t]+(.*)$/;

/** GitHub 的 PR／issue 參照。前一個字元不得是 `#`，避免把 `##` 標題吃進來。 */
const PR_REF = /(?:^|[^\w#])#(\d{1,7})\b/g;

export interface AggregateSignal {
  /** 帶 PR 參照的清單條目數。 */
  items: number;
  /** 那些條目指向的**相異** PR 數。同一個 PR 重複列出不算多份紀錄。 */
  distinctRefs: number;
}

/**
 * 訊息主旨（第一行）的結束位置。
 *
 * CRLF 的 `\r` 要算在主旨之外。**這個換行處理不是小節**——第一版用 `.` 搭配
 * `$` 比對整行，`.` 不匹配 `\r`，於是 CRLF 語料一條清單條目都認不出來，
 * 而且失敗方式是靜默回報零。create-t3-app 的 body 正是 CRLF。
 */
export function subjectEnd(message: string): number {
  const at = message.search(/\r?\n/);
  return at < 0 ? message.length : at;
}

/** 這個字元位置是否落在主旨行內。 */
export function isInSubject(message: string, charStart: number): boolean {
  return charStart < subjectEnd(message);
}

export function aggregateSignal(message: string): AggregateSignal {
  const body = message.slice(subjectEnd(message));
  const refs = new Set<string>();
  let items = 0;
  for (const line of body.split(/\r?\n/)) {
    const item = LIST_ITEM.exec(line);
    if (item === null) continue;
    const found = [...item[1]!.matchAll(PR_REF)].map((m) => m[1]!);
    // 沒有 PR 參照的條目只是普通的分點敘述，不構成「多份紀錄」的證明。
    if (found.length === 0) continue;
    items++;
    for (const ref of found) refs.add(ref);
  }
  return { items, distinctRefs: refs.size };
}

/**
 * 兩個條件都要成立：**至少兩條**帶參照的清單條目，且它們指向**至少兩個不同的**
 * PR。前者排除「正文順帶提到一個 issue」，後者排除「同一個 PR 被列了很多次」。
 */
export function isAggregateMessage(message: string): boolean {
  const signal = aggregateSignal(message);
  return signal.items >= 2 && signal.distinctRefs >= 2;
}

/**
 * 這條證據能不能歸因到單一改動。
 *
 * `charStart` 為 `undefined` 代表證據根本不在這顆 commit 的訊息裡（`linked`
 * 層的 PR 討論串）。那種情況下聚合 commit 一律不得歸因——**連進來的那條
 * `reference_link` 只證明「這顆 commit 提到那個 PR」，而聚合 commit 提到
 * 一百個 PR**，無從得知是哪一個對應到眼前這次改動。
 */
export function attributable(message: string, charStart?: number): boolean {
  if (!isAggregateMessage(message)) return true;
  // 主旨行是作者為「這顆 commit 整體」寫的，沒有被 squash 打散，仍可歸因。
  return charStart !== undefined && isInSubject(message, charStart);
}
