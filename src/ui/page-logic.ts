/**
 * 三欄 UI 裡**可以被測試**的那幾個判斷。
 *
 * 頁面本體（`page.ts`）是一整個樣板字串，裡面的 JS 只能用 regex 去比對，
 * 而 regex 咬不住邏輯。所以把純函式放在這裡，再用 `toString()` 注入頁面——
 * **測試測到的就是頁面真正執行的那一份，沒有副本可以分岔。**
 *
 * 這個做法在 `--experimental-strip-types` 下成立：型別標註被換成空白而不是
 * 刪除，所以 `toString()` 拿到的仍是合法 JS（實測過）。因此**這個檔案裡的
 * 函式必須自給自足**：不引用模組外的任何東西，不用 enum、不用裝飾器。
 */

/** 意圖欄需要的最小形狀。時間軸端點回的列還有很多其他欄位，這裡只認這一個。 */
export interface IntentRow {
  intent: Array<{ scope: string }>;
}

/**
 * 哪幾列有理由，分成專屬與整批兩組。
 *
 * **標頭的計數與跳轉清單必須是同一個陣列。** 兩邊各算一次的話，按鈕會說
 * 「2」卻跳到三個地方——這個專案已經被同型的分岔咬過一次（CLI 說 5 顆聚合
 * commit、UI 說 6 顆，因為畫面另寫了一份 SQL）。
 *
 * 判準沿用原本標頭用的那兩個，一個字都沒改：一列只要有任何一條專屬理由就算
 * 專屬；**整批**要求該列的每一條都是整批。兩者互斥，順序決定歸屬。
 */
export function rationaleTargets(
  rows: IntentRow[],
): { entity: number[]; batch: number[] } {
  const entity: number[] = [];
  const batch: number[] = [];
  rows.forEach((row, index) => {
    if (row.intent.some((claim) => claim.scope === "entity")) entity.push(index);
    else if (
      row.intent.length > 0 && row.intent.every((claim) => claim.scope === "batch")
    ) batch.push(index);
  });
  return { entity, batch };
}

/**
 * 解析時間軸的網址片段：`#<stable_key>` 或 `#<stable_key>/<shortSha>`。
 *
 * **舊形式必須繼續有效。** `#<stable_key>` 已經公開在 demo 的 landing 上，
 * 而網址是使用者存起來、貼給別人的東西——加一個可選的後綴不能讓既有連結失效。
 *
 * 用 `/` 當分隔是安全的：寫入端一律走 `formatTimelineHash`，它對兩段各自
 * 做 `encodeURIComponent`，而那會把資料裡真正的斜線編成 `%2F`。所以片段裡
 * 出現的第一個裸斜線一定是分隔符，不會是 key 的一部分。
 */
export function parseTimelineHash(hash: string): { key: string; sha: string } {
  const raw = hash.replace(/^#/, "");
  const slash = raw.indexOf("/");
  const keyPart = slash < 0 ? raw : raw.slice(0, slash);
  const shaPart = slash < 0 ? "" : raw.slice(slash + 1);
  return {
    key: decodeURIComponent(keyPart).trim(),
    sha: decodeURIComponent(shaPart).trim(),
  };
}

/** 反向：組出時間軸的網址片段。沒有指定某一列時退回舊形式。 */
export function formatTimelineHash(key: string, sha: string): string {
  return "#" + encodeURIComponent(key)
    + (sha === "" ? "" : "/" + encodeURIComponent(sha));
}
