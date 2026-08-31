import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatTimelineHash,
  parseTimelineHash,
  rationaleTargets,
} from "../src/ui/page-logic.ts";
import { PAGE } from "../src/ui/page.ts";

const row = (...scopes: string[]) => ({ intent: scopes.map((scope) => ({ scope })) });

describe("意圖跳轉的判斷", () => {
  it("**標頭的計數與跳轉清單是同一個陣列**", () => {
    const rows = [row(), row("entity"), row(), row("batch"), row(), row("entity")];
    const { entity, batch } = rationaleTargets(rows);
    // 索引就是列號，所以標頭印的數量與按鈕跳到的位置不可能分岔。
    assert.deepEqual(entity, [1, 5]);
    assert.deepEqual(batch, [3]);
    assert.equal(entity.length + batch.length < rows.length, true, "空白仍然存在");
  });

  it("一列同時有專屬與整批理由時算專屬，不重複計入", () => {
    const { entity, batch } = rationaleTargets([row("batch", "entity")]);
    assert.deepEqual(entity, [0]);
    assert.deepEqual(batch, [], "整批要求該列每一條都是整批");
  });

  it("沒有理由的時間軸兩組都是空的（0 不該變成可點的控制項）", () => {
    const { entity, batch } = rationaleTargets([row(), row(), row()]);
    assert.deepEqual(entity, []);
    assert.deepEqual(batch, []);
  });
});

describe("時間軸的網址片段", () => {
  it("**舊的純 key 形式必須繼續有效**（它已經公開在 demo 上）", () => {
    assert.deepEqual(parseTimelineHash("#74b3030695a8"), {
      key: "74b3030695a8",
      sha: "",
    });
    assert.deepEqual(parseTimelineHash("74b3030695a8"), {
      key: "74b3030695a8",
      sha: "",
    });
  });

  it("帶 short sha 時兩段都解得出來", () => {
    assert.deepEqual(parseTimelineHash("#74b3030695a8/fd402bd52d"), {
      key: "74b3030695a8",
      sha: "fd402bd52d",
    });
  });

  it("**key 裡真的有斜線也不會被誤切**", () => {
    // 寫入端一律 encodeURIComponent，所以資料裡的斜線是 %2F，
    // 片段裡第一個裸斜線必定是分隔符。
    const key = "a/b";
    const round = parseTimelineHash(formatTimelineHash(key, "abc1234"));
    assert.deepEqual(round, { key, sha: "abc1234" });
  });

  it("組與解互為反向，含非 ASCII", () => {
    for (const [key, sha] of [["中文鍵", "abc"], ["k", ""], ["a b", "c d"]] as const) {
      assert.deepEqual(parseTimelineHash(formatTimelineHash(key, sha)), { key, sha });
    }
  });

  it("沒有指定列時退回舊形式，不留下空的斜線", () => {
    assert.equal(formatTimelineHash("abc", ""), "#abc");
  });
});

describe("頁面確實用的是這一份實作", () => {
  it("三個函式的本體被注入頁面，頁面裡沒有另一份抄本", () => {
    // 這是這組測試能不能咬得住的前提：頁面若自己抄一份，上面全部白測。
    for (const fn of [parseTimelineHash, formatTimelineHash, rationaleTargets]) {
      assert.ok(
        PAGE.includes(fn.toString()),
        fn.name + " 的本體不在頁面裡——頁面可能自己抄了一份",
      );
    }
  });

  it("注入的內容是合法 JS（型別標註在 strip-types 下會變成空白）", () => {
    for (const fn of [parseTimelineHash, formatTimelineHash, rationaleTargets]) {
      assert.doesNotThrow(
        () => new Function("return (" + fn.toString() + ")"),
        fn.name + " 注入頁面後不是合法 JS",
      );
    }
  });

  it("**頁面的 JS 語法是對的**", () => {
    // 整份頁面是一個樣板字串，所以 tsc 只檢查得到它是不是合法字串，
    // **檢查不到裡面的 JS**。而樣板字串裡的反引號與插值起頭都是活的——
    // 光是加這個功能就踩了三次：巢狀樣板的逸出、註解裡的插值起頭、
    // 頁面內 JSDoc 的反引號。前兩次 tsc 剛好報錯，第三次也是；
    // 但只要逸出「剛好」湊成合法的 TS，錯就會靜默地送到瀏覽器。
    const script = PAGE.slice(
      PAGE.indexOf("<script>") + "<script>".length,
      PAGE.lastIndexOf("</script>"),
    );
    assert.ok(script.length > 1000, "沒抓到 script 內容");
    // 只編譯不執行：這裡沒有 DOM，而要驗的是語法不是行為。
    assert.doesNotThrow(() => new Function(script), "頁面的 JS 有語法錯誤");
    // 不能改用「成品裡不該出現插值語法」當守門：頁面**故意**有巢狀樣板
    // 字串（給瀏覽器求值的），成品裡的字面插值是對的。寫過那條，當場紅。
  });

  it("跳轉不改變列高——**改了對齊就散了**", () => {
    // 命中列用 inset box-shadow 標示。邊框或內距都會改高度，而意圖欄與演化欄
    // 是逐列量測對齊的：高度一變，理由就印在別人的改動底下。
    assert.match(PAGE, /\.rev\.hit, \.slot\.hit \{ box-shadow: inset/);
    assert.doesNotMatch(
      PAGE,
      /\.(rev|slot)\.hit \{[^}]*\b(border|padding|margin)\b/,
      "命中列不得用會改變盒模型的屬性",
    );
  });
});
