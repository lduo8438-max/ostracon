import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  discontinuitiesFor,
  entityIdForStableKey,
  evolutionOf,
} from "../src/ui/data.ts";
import {
  SNIPPET_MAX_BYTES,
  SNIPPET_MAX_LINES,
  truncateForTest,
} from "../src/ui/snippets.ts";
import { touches } from "../src/match/position.ts";
import { INSERT_CONTENT_FIXTURE, REVISION_COLUMNS, revisionValues } from "./db-fixture.ts";

const K = (n: number) => String(n).padStart(64, "0");

/**
 * 一個宣告佔第 10–20 行，經歷三種改動：
 *
 * - c2：hunk 落在第 12 行 → **碰到**
 * - c3：hunk 落在第 40 行（同檔別處）→ **沒碰到**
 * - c4：這次改動一個 hunk 都沒有 → **不知道**
 *
 * 三態都要有真實對應的形狀，否則測試只是在複述型別。
 */
function fixtureDb(): string {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-hunk-")), "i.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  // 這個宣告在每一版都佔第 10–20 行。
  const rev = (id: number, commitId: number) =>
    revisionValues({ id, commitId, path: "src/a.ts", lineStart: 10, lineEnd: 20 });
  db.exec(`
    INSERT INTO repo (id, root_path, created_at) VALUES (1, '/tmp/h', '2026-01-01');
    INSERT INTO git_commit (id, repo_id, sha, authored_at, committed_at, message, topo_order)
      VALUES (1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', '2026-01-01', '2026-01-01', 'feat: add', 1),
             (2, 1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2', '2026-01-02', '2026-01-02', 'fix: edit it', 2),
             (3, 1, 'ccccccccccccccccccccccccccccccccccccccc3', '2026-01-03', '2026-01-03', 'fix: edit elsewhere', 3),
             (4, 1, 'ddddddddddddddddddddddddddddddddddddddd4', '2026-01-04', '2026-01-04', 'chore: rename only', 4);
    INSERT INTO path_lineage (id, repo_id) VALUES (1, 1);
    INSERT INTO slot (id, repo_id, lineage_id, qualified_name, kind)
      VALUES (1, 1, 1, 'target', 'function');
    INSERT INTO entity (id, repo_id, stable_key, birth_commit_id) VALUES (1, 1, '${K(1)}', 1);
    ${INSERT_CONTENT_FIXTURE}
    INSERT INTO revision ${REVISION_COLUMNS} VALUES
      ${rev(1, 1)}, ${rev(2, 2)}, ${rev(3, 3)}, ${rev(4, 4)};
    INSERT INTO revision_change (prev_revision, next_revision, commit_id, entity_id, change_level)
      VALUES (NULL, 1, 1, 1, 'birth'), (1, 2, 2, 1, 'shape'),
             (2, 3, 3, 1, 'none'), (3, 4, 4, 1, 'none');
    INSERT INTO file_change (id, commit_id, lineage_id, path, change_type)
      VALUES (1, 1, 1, 'src/a.ts', 'A'), (2, 2, 1, 'src/a.ts', 'M'),
             (3, 3, 1, 'src/a.ts', 'M'), (4, 4, 1, 'src/a.ts', 'R');
    INSERT INTO file_hunk (file_change_id, hunk_index, old_start, old_count, new_start, new_count)
      VALUES (1, 0, 0, 0, 1, 30),      -- 誕生：純新增，涵蓋整個宣告
             (2, 0, 12, 1, 12, 2),     -- 落在宣告之內
             (3, 0, 40, 1, 40, 1);     -- 同檔別處
    -- file_change 4 是純改名，**一個 hunk 都沒有**。
  `);
  db.close();
  return dbPath;
}

/** 沒有任何斷層的語料。「沒東西可讀」與「讀不到」必須分得開。 */
function emptyDb(): string {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "ostracon-empty-")), "i.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO repo (id, root_path, created_at) VALUES (1, '/tmp/e', '2026-01-01');");
  db.close();
  return dbPath;
}

const open = (p: string) => {
  const db = new DatabaseSync(p, { readOnly: true });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
};

function timeline() {
  const db = open(fixtureDb());
  const id = entityIdForStableKey(db, 1, K(1))!;
  return evolutionOf(db, 1, id);
}

describe("hunk 證據是三態，不是布林", () => {
  it("**碰到／沒碰到／不知道**三種都要分得出來", () => {
    const byCommit = new Map(timeline().map((row) => [row.shortSha.slice(0, 1), row.hunkEvidence]));
    assert.equal(byCommit.get("b"), "touched", "hunk 落在宣告之內");
    assert.equal(byCommit.get("c"), "untouched", "hunk 在同檔別處");
    // **這是整條測試的重點。** 沒有 hunk 資料時說「沒碰到」，就是把不知道
    // 當成最強的負證據——與 slot_discontinuity 的 NULL／0 同一條規則。
    assert.equal(byCommit.get("d"), "unknown", "純改名沒有任何 hunk");
  });

  it("**沒碰到就必定沒改動**——兩個獨立機制要互相印證", () => {
    // git 的 hunk 與四層雜湊是兩條互不相干的路徑。hunk 說沒碰到而雜湊說
    // 內容變了，代表其中一邊錯了。實測 vuejs/core 400 個 entity、45,984 列，
    // 例外 0 條。
    for (const row of timeline()) {
      if (row.hunkEvidence !== "untouched") continue;
      assert.equal(
        row.changeLevel,
        "none",
        `${row.shortSha} 沒被 hunk 碰到，change_level 卻是 ${row.changeLevel}`,
      );
    }
  });

  it("判準與 matcher 共用同一支函式", () => {
    // L3c 成立的前提就是「宣告未被任何 hunk 碰到」。畫面另寫一份的話，會出現
    // 「畫面說沒碰到、matcher 當時認為碰到了」——兩邊各自看起來都對。
    const hunk = { oldStart: 12, oldCount: 1, newStart: 12, newCount: 2 };
    assert.equal(touches(hunk, 10, 20), true);
    assert.equal(touches(hunk, 30, 40), false);
    // 純刪除在新側沒有範圍，但刪除點落在宣告之內算碰到。
    assert.equal(touches({ oldStart: 15, oldCount: 3, newStart: 14, newCount: 0 }, 10, 20), true);
    assert.equal(touches({ oldStart: 50, oldCount: 3, newStart: 49, newCount: 0 }, 10, 20), false);
  });
});

describe("斷層的前後片段", () => {
  it("**截斷規則：超過上限只給前面，但要說出原本幾行**", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const snippet = truncateForTest(Buffer.from(long, "utf8"));
    assert.equal(snippet.lines, 40, "原始行數要用完整片段算，不是截斷後的");
    assert.equal(snippet.text.split("\n").length, SNIPPET_MAX_LINES);
    assert.equal(snippet.truncated, true);
    // 顯示 24 行卻不說，使用者會以為那就是全部——而「這段長什麼樣」正是這個
    // 畫面唯一要回答的事。
    assert.equal(snippet.text.startsWith("line 1\n"), true);
  });

  it("沒超過上限就不標截斷", () => {
    const snippet = truncateForTest(Buffer.from("a\nb\nc", "utf8"));
    assert.deepEqual(
      { text: snippet.text, lines: snippet.lines, truncated: snippet.truncated },
      { text: "a\nb\nc", lines: 3, truncated: false },
    );
  });

  it("**位元組上限先觸發時，行數仍要報完整的**", () => {
    // 100 行、每行 100 bytes：位元組上限會在第 40 行左右切斷。若「原始行數」
    // 是從截斷後的內容算的，畫面會說「40 行」——而那是它自己切出來的數字，
    // 不是這段程式碼的長度。上一版測試沒有讓兩個上限分歧，所以咬不到。
    const wide = Array.from({ length: 100 }, () => "x".repeat(99)).join("\n");
    const snippet = truncateForTest(Buffer.from(wide, "utf8"));
    assert.equal(snippet.lines, 100);
    assert.equal(snippet.truncated, true);
    assert.ok(Buffer.byteLength(snippet.text) <= SNIPPET_MAX_BYTES);
  });

  it("**單行極長也擋得住**——行數上限對壓縮過的產物無效", () => {
    const oneHugeLine = "x".repeat(SNIPPET_MAX_BYTES * 2);
    const snippet = truncateForTest(Buffer.from(oneHugeLine, "utf8"));
    assert.equal(snippet.truncated, true);
    assert.ok(
      Buffer.byteLength(snippet.text) <= SNIPPET_MAX_BYTES,
      "位元組上限沒有生效，單行輸入會整個灌進 payload",
    );
  });

  it("**沒東西可讀 ≠ 讀不到**", () => {
    // create-t3-app 有 0 個斷層。給了正確的 --repo 卻回 repo-unavailable，
    // 畫面就會說「語料讀不到」——而語料明明就在。判準是「讀不讀得到」，
    // 不是「有沒有讀到東西」。實測踩到過。
    const empty = discontinuitiesFor(open(emptyDb()), 1, 500, process.cwd());
    assert.equal(empty.total, 0);
    assert.equal(empty.snippets, "included");
  });

  it("**讀不到語料時要說出是哪一種情況**，不是留白", () => {
    const db = open(fixtureDb());
    // 沒給 repo：不是錯誤，但要標明。
    assert.equal(discontinuitiesFor(db, 1).snippets, "not-requested");
    // 給了但讀不到：與「沒給」不是同一件事，畫面說法也不該一樣。
    assert.equal(
      discontinuitiesFor(db, 1, 500, "/definitely/not/a/repo").snippets,
      "repo-unavailable",
    );
  });
});

describe("片段對真實語料成立", () => {
  /**
   * **這一條不是 golden，而且刻意不是。**
   *
   * golden 驗的是索引器的判定（配對、change_level、迂迴），錨點是 git 原生
   * 座標。片段不是索引器的判定——它是讀取時把 `byte_start`／`byte_end` 投影
   * 回 git blob。要驗的東西是「那組位移真的框住了那個宣告」，而那用真實語料
   * 直接讀比在 golden 的詞彙裡新增一種 case 更直接。
   *
   * 語料不在就跳過（本機沒跑過 `pnpm corpus:fetch` 時）。CI 會抓，所以那裡會跑。
   */
  it("**每一段 after 片段都要框住那個宣告的名字**", () => {
    const corpus = "corpora/osiris";
    if (!existsSync(corpus) || !existsSync("reports/demo-osiris.db")) return;
    const db = new DatabaseSync("reports/demo-osiris.db", { readOnly: true });
    const view = discontinuitiesFor(db, 1, 500, corpus);
    db.close();
    if (view.snippets !== "included") return;

    assert.ok(view.rows.length > 0, "這套語料沒有斷層，這條測試會空轉");
    for (const row of view.rows) {
      assert.ok(row.after, `${row.symbol} 沒有 after 片段`);
      // 限定名稱可能是 `Class.method`，片段裡出現的是最後一段。
      const name = row.symbol.split(".").pop()!;
      assert.ok(
        row.after!.text.includes(name),
        `${row.symbol} 的片段裡找不到它自己的名字——byte 位移框錯了：\n`
        + row.after!.text.slice(0, 120),
      );
    }
  });
});

describe("雙欄工作區的版面規則", () => {
  const css = () => readFileSync("workspace/src/index.css", "utf8");
  /** 抓出某個 min-width 媒體查詢的區塊。巢狀只有一層，數大括號就夠。 */
  const mediaBlock = (source: string, query: string): string => {
    const start = source.indexOf(`@media (min-width: ${query})`);
    if (start < 0) return "";
    let depth = 0;
    for (let i = source.indexOf("{", start); i < source.length; i++) {
      if (source[i] === "{") depth++;
      if (source[i] === "}" && --depth === 0) return source.slice(start, i);
    }
    return source.slice(start);
  };

  it("**清單獨立捲動、詳情跟著視窗釘住**", () => {
    // 先前這兩個版面是普通文件流：421／537 列把整頁撐高好幾個螢幕，而右欄的
    // 詳情停在 grid 頂端——捲到第 40 筆點下去，右半邊是一整片空白。
    // 內容是對的，版面讓它看不見。Chrome 實測抓到的。
    if (!existsSync("workspace/src/index.css")) return;
    const desktop = mediaBlock(css(), "921px");
    assert.match(desktop, /\.split-layout \.stack-list \{[^}]*overflow-y: auto/);
    assert.match(desktop, /\.discontinuity-detail \{[^}]*position: sticky/);

    const wide = mediaBlock(css(), "1181px");
    assert.match(wide, /\.removal-cluster > div \{[^}]*overflow-y: auto/);
    assert.match(wide, /\.ostracised-detail \{[^}]*position: sticky/);
  });

  it("**手機版不得套 sticky**——那會把詳情釘在螢幕上擋住清單", () => {
    if (!existsSync("workspace/src/index.css")) return;
    const source = css();
    // 兩個版面在窄螢幕都已經塌成單欄。sticky 只能出現在 min-width 的區塊裡；
    // 寫在最外層的話手機版也會套到，比不修更糟。
    const outside = source
      .replace(mediaBlock(source, "921px"), "")
      .replace(mediaBlock(source, "1181px"), "");
    for (const selector of [
      ".discontinuity-detail",
      ".ostracised-detail",
      ".removal-cluster",
      ".split-layout .list-panel",
    ]) {
      const rule = new RegExp(
        selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{[^}]*position: sticky",
      );
      assert.doesNotMatch(outside, rule, `${selector} 的 sticky 寫在媒體查詢之外`);
    }
  });

  it("釘住的高度要扣掉 sticky 的 topbar", () => {
    if (!existsSync("workspace/src/index.css")) return;
    // 寫死 72px 會在窄螢幕錯位——那裡 topbar 變成 54px 並疊在 mobile-nav 之下。
    assert.match(css(), /--topbar:/);
    assert.doesNotMatch(
      mediaBlock(css(), "921px"),
      /max-height: calc\(100vh - \d+px/,
      "高度寫死了像素，沒有用 --topbar",
    );
  });
});
