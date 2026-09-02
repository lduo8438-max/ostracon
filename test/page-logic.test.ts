import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatTimelineHash,
  parseTimelineHash,
  rationaleTargets,
} from "../src/ui/page-logic.ts";

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

describe("前端確實用的是這一份實作", () => {
  /**
   * 舊版這裡有三條，全是為了 `page.ts` 而存在：函式本體有沒有被注入、注入後
   * 是不是合法 JS、整份頁面的 script 語法對不對。**頁面刪掉之後三條都沒有
   * 對象了**——那是一段送到瀏覽器的樣板字串，node 這一端執行不了它，所以
   * 只能用 regex 與 `new Function` 從外面戳。
   *
   * 現在的前端是真的模組：Vite 會 import 這個檔案，`tsc` 會檢查它，
   * vitest 會把用到它的元件掛起來跑。所以「有沒有抄一份」才是剩下的風險，
   * 而它由下面這一條顧。
   */
  it("**前端不得自己抄一份共用邏輯**", async () => {
    // 舊頁面與新前端共用同一組網址（#<stable_key> 與 #<key>/<sha>）。任何一邊
    // 改了編碼規則，另一邊產生的連結就失效，而那種錯只會在使用者貼連結給別人
    // 時才發現。做這個功能時我差一點就把兩個函式抄進 workspace/src——所以改成
    // 讓抄本不存在，並在這裡釘住。
    //
    // `rationaleTargets` 是**後來補進來的**：`api.ts` 原本自己抄了同樣的三個
    // predicate（`some(entity)`、`every(batch)`、`find(entity)`）。兩份剛好
    // 一樣不等於同一份——標頭的計數與跳轉清單分岔過一次就夠了。
    const fs = await import("node:fs/promises");
    const dir = "workspace/src";
    let files: string[];
    try {
      // **要遞迴。** 原本只讀最上層，子目錄裡的抄本看不見。
      files = (await fs.readdir(dir, { recursive: true })) as string[];
    } catch {
      return; // workspace/ 不在（例如只 clone 了子集）時不強制
    }
    let scanned = 0;
    for (const file of files) {
      if (!/\.tsx?$/.test(file)) continue;
      scanned += 1;
      const source = await fs.readFile(`${dir}/${file}`, "utf8");
      for (
        const name of ["parseTimelineHash", "formatTimelineHash", "rationaleTargets"]
      ) {
        assert.doesNotMatch(
          source,
          new RegExp(`(function|const)\\s+${name}\\b`),
          `${file} 自己定義了 ${name}——那是抄本，必須改成從 src/ui/page-logic.ts 匯入`,
        );
      }
    }
    assert.ok(scanned > 0, "一個 .ts/.tsx 都沒掃到——這條測試會空轉");
  });

  it("**共用的那一份真的被前端 import 了**", async () => {
    // 上一條只證明「沒有抄本」。抄本不存在也可能是因為根本沒人用它——
    // 那樣兩邊仍然會分岔，只是分岔在別的地方。
    const fs = await import("node:fs/promises");
    let sources: string[];
    try {
      const files = (await fs.readdir("workspace/src", { recursive: true })) as string[];
      sources = await Promise.all(
        files.filter((file) => /\.tsx?$/.test(file))
          .map((file) => fs.readFile(`workspace/src/${file}`, "utf8")),
      );
    } catch {
      return;
    }
    const all = sources.join("\n");
    for (const name of ["parseTimelineHash", "formatTimelineHash", "rationaleTargets"]) {
      assert.match(
        all,
        new RegExp(`\\b${name}\\b`),
        `前端沒有用到 ${name}——共用的那一份等於沒有共用`,
      );
    }
    assert.match(all, /from '\.\.\/\.\.\/src\/ui\/page-logic'/);
  });
});
