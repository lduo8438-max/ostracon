import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { markerOf } from "../src/claim/derive.ts";
import {
  EXTRACTOR_VERSION,
  MARKDOWN_EXTRACTOR_VERSION,
  extractRationale,
} from "../src/evidence/extract.ts";
import {
  discardStaleRuleEvidence,
  extractFromCommitMessages,
  extractFromLinkedDocuments,
  ingestCommitMessages,
} from "../src/evidence/store.ts";
import { sha256 } from "../src/evidence/span.ts";

const quotes = (body: string) =>
  extractRationale(body, { format: "markdown" }).map((s) => s.quotedText);

/**
 * 這一整組測試釘住的是一個裁決結果，不是一個直覺。
 *
 * demo 語料 103 條可疑引文全部人工裁決後：長度 < 30 的 68 條裡有 55 條是真理由，
 * 只有 8 條是空殼。**長度門檻要殺 55 條才換到 8 條**，所以它被否決。
 * 9 條空殼的實際成因是標記配到了另一個詞義——那是 bug，不是品質門檻問題。
 */
describe("因果標記的詞義", () => {
  it("since 的時間義不是理由", () => {
    // 裁決樣本 #18 / #211 / #430（同一則 commit message）、#47、#357、#364。
    assert.deepEqual(quotes("We've been using it since August."), []);
    assert.deepEqual(quotes("Has this been broken since version 7?"), []);
    assert.deepEqual(quotes("A few things landed since then which I'd like in."), []);
    assert.deepEqual(quotes("We've used T3 since launch. The founder is a fan."), []);
    assert.deepEqual(quotes("Nothing has changed since 2024."), []);
  });

  it("since 的因果義照常抽出", () => {
    // 這條是前一條的價格標籤：demo 語料 86 條 since 只有 5 條是時間義，
    // 詞義規則放寬一點點就會開始吃掉這 81 條。
    assert.deepEqual(
      quotes("Split it up since it was getting a bit long for one function."),
      ["since it was getting a bit long for one function."],
    );
    assert.deepEqual(
      quotes("Dropped it since doing these async caused some issues"),
      ["since doing these async caused some issues"],
    );
    // `maybe` 不是五月。詞界沒寫好的話這條會掉。
    assert.deepEqual(
      quotes("Kept it since maybe someone depends on the old shape"),
      ["since maybe someone depends on the old shape"],
    );
    // 裸數字不算時間：`since 3 people complained` 是理由，不是日期。
    // 只認四位數年份與帶 v/version 的版本號。
    assert.deepEqual(
      quotes("Reverted it since 3 people complained about the output"),
      ["since 3 people complained about the output"],
    );
  });

  it("**被否決的標記不連累整行**", () => {
    // 舊版取最早出現的標記就定案，`since` 一被否決整行就沒有理由了。
    // 實際上理由在後面那個標記上。
    assert.deepEqual(
      quotes("Broken since August. Pinned the version to avoid the CI flake."),
      ["to avoid the CI flake."],
    );
  });

  it("標記後沒有實質內容就不是理由", () => {
    // 裁決樣本 #116 / #120 / #187 / #260。
    assert.deepEqual(quotes("I think this is the reason"), []);
    assert.deepEqual(quotes("Needs the flag, otherwise."), []);
  });

  it("**判準是有沒有內容，不是剩幾個字元**", () => {
    // 裁決樣本 #164：`4` 只有一個字元，但它就是內容——被拒絕的替代方案
    // 正是這個工具的題目。以「標記後不足 4 字元」為判準會殺掉它。
    //
    // 抽取器 0.4.0 起對比標記的左邊界拉到句首，所以引文連「選了什麼」一起
    // 帶出來。這兩條的期望值因此變長——變的是引文範圍，不是判準。
    assert.deepEqual(quotes("Pinned to 3 instead of 4."), ["Pinned to 3 instead of 4."]);
    assert.deepEqual(quotes("Use pnpm instead of npm"), ["Use pnpm instead of npm"]);
  });

  it("so that 接繫詞時理由在標記之前，左邊界往前拉到句首", () => {
    // 裁決樣本 #128 / #358 / #397：這一類全被判為「該拉長」。
    // `so that's` 是「所以，那個是」，不是表目的的 `so that`——理由在前半句。
    assert.deepEqual(
      quotes("I realised light mode looked trash so that's been fixed now too."),
      ["I realised light mode looked trash so that's been fixed now too."],
    );
    assert.deepEqual(
      quotes("That comment is updated each release so that is the latest"),
      ["That comment is updated each release so that is the latest"],
    );
    // 句首以句末標點為界，不是整行——前一句是另一件事。
    assert.deepEqual(
      quotes("Biome has three commands. I always use check, so that is what I added."),
      ["I always use check, so that is what I added."],
    );
  });

  it("表目的的 so that 不受影響", () => {
    assert.deepEqual(
      quotes("Cache it so that the CLI doesn't crash before the check."),
      ["so that the CLI doesn't crash before the check."],
    );
  });

  it("往前拉過的 span 仍與原文逐字對齊", () => {
    // 左邊界是新算的，位移算錯的話 span 斷言會整條丟棄——而且是靜默的。
    const body = "note\n\nI always use check, so that is what I added.\n";
    for (const span of extractRationale(body, { format: "markdown" })) {
      assert.equal(
        body.slice(span.charStart, span.charEnd),
        span.quotedText,
        "quotedText 必須等於 body 上同一段位移",
      );
    }
  });
});

/**
 * 中文沒有詞界，而標記是用 `indexOf` 配的。
 *
 * 這一組釘住的是自我索引語料量出來的東西：33 條 evidence 裡有 15 條的引文
 * 從詞中間開始，13 條來自裸的 `理由`。兩套黃金測試集都是英文語料，
 * 所以中文那一半從來沒有被驗過——同一個功能、兩種語言，只驗了一種。
 */
describe("中文標記的詞界", () => {
  it("**切點把否定詞留在外面，逐字為真卻意思相反**", () => {
    // 實測案例：原文說「版本字串沒有理由改變」，舊版抽出「理由改變。」
    // span 斷言完全擋不住——引文確實逐字出自原文。不變量 8 的字面滿足了，
    // 誠信沒有。這是這條規則存在的全部理由。
    assert.deepEqual(quotes("所以版本字串沒有理由改變。"), []);
    assert.deepEqual(quotes("前者讓使用者以為沒有理由可查而其實有。"), []);
  });

  it("裸的「理由」是名詞不是連接詞，不再當標記", () => {
    assert.deepEqual(quotes("103 條可疑引文全部人工裁決：真理由 87／空殼 9。"), []);
    assert.deepEqual(quotes("相交就能判斷理由是不是在講這段程式碼。"), []);
    assert.deepEqual(quotes("被抑制的只是被當成理由讀的那段文字。"), []);
    assert.deepEqual(quotes("那些決定的理由目前只存在於 commit message 裡。"), []);
  });

  it("帶冒號的「理由：」「原因：」照常抽出，全形半形都收", () => {
    // 與英文的 `reason:` / `why:` 是同一個形狀：名詞要靠冒號錨定成引導語。
    assert.deepEqual(quotes("理由：界線先前不存在。"), ["理由：界線先前不存在。"]);
    assert.deepEqual(quotes("原因：界線先前不存在。"), ["原因：界線先前不存在。"]);
    assert.deepEqual(quotes("理由: 快取失效。"), ["理由: 快取失效。"]);
    assert.deepEqual(quotes("原因: 快取失效。"), ["原因: 快取失效。"]);
  });

  it("連接詞類不受影響，接在漢字後面也是合法的", () => {
    // 「這是因為…」是最常見的中文寫法。用「前一字不得是漢字」這條泛規則
    // 會把它殺掉——實測代價 1 條、收益 0 條，所以泛規則被否決。
    assert.deepEqual(
      quotes("這是因為偵測器看不到內容搬去的那個檔案。"),
      ["因為偵測器看不到內容搬去的那個檔案。"],
    );
    assert.deepEqual(
      quotes("SIGNATURE_VERSION 必須進水位線否則規則只是願望。"),
      ["否則規則只是願望。"],
    );
    assert.deepEqual(
      quotes("改用 histogram，由於 Myers 的邊界不穩定。"),
      ["由於 Myers 的邊界不穩定。"],
    );
  });

  it("既有的中文因果標記全部還在", () => {
    for (const [body, want] of [
      ["因為邊界不穩定。", "因為邊界不穩定。"],
      ["為了讓安裝零摩擦。", "為了讓安裝零摩擦。"],
      ["改用 A 以免 B。", "以免 B。"],
      ["先鎖版本，避免 CI 抖動。", "避免 CI 抖動。"],
    ] as const) {
      assert.deepEqual(quotes(body), [want], body);
    }
  });
});

const freshDb = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.exec(
    `INSERT INTO repo (id, root_path, created_at) VALUES (1, '/tmp/r', '2026-01-01');
     INSERT INTO git_commit
       (id, repo_id, sha, author_name, authored_at, committed_at, message, is_merge, topo_order)
     VALUES (1, 1, 'aaa', 'x', '2026-01-01', '2026-01-01',
             'chore: bump' || char(10) || char(10) || 'Pinned it since August.', 0, 0);`,
  );
  return db;
};

/** 假裝資料庫是舊版抽取器建的：塞一條它會產出、而新版不會產出的引文。 */
function seedStaleEvidence(db: DatabaseSync): number {
  const body = "chore: bump\n\nPinned it since August.";
  const at = body.indexOf("since August.");
  ingestCommitMessages(db, 1);
  const docId = (db.prepare(
    "SELECT id FROM source_doc WHERE repo_id = 1 AND doc_type = 'commit_message'",
  ).get() as { id: number }).id;
  const ev = db.prepare(
    `INSERT INTO evidence
       (repo_id, source_doc_id, char_start, char_end, quoted_text, doc_body_sha, tier, verified)
     VALUES (1, ?, ?, ?, 'since August.', ?, 'stated', 1)`,
  ).run(docId, at, at + "since August.".length, sha256(body));
  db.prepare(
    `INSERT INTO evidence_candidate
       (repo_id, source_doc_id, proposed_char_start, proposed_char_end,
        proposed_quoted_text, expected_doc_body_sha, proposed_tier,
        generator_kind, generator_version, status, promoted_evidence_id, created_at)
     VALUES (1, ?, ?, ?, 'since August.', ?, 'stated', 'rule',
             'rule-rationale-0.1.0/causal:since', 'promoted', ?, '2026-01-01')`,
  ).run(docId, at, at + "since August.".length, sha256(body), Number(ev.lastInsertRowid));
  return Number(ev.lastInsertRowid);
}

describe("舊版抽取器的產出會被作廢", () => {
  it("**升版本但不作廢，等於這個修正在用過的資料庫上無效**", () => {
    const db = freshDb();
    seedStaleEvidence(db);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number }).n,
      1,
      "前提：舊版留下的空殼引文確實在資料庫裡",
    );

    const report = extractFromCommitMessages(db, 1);
    assert.equal(report.discarded.evidence, 1);
    assert.equal(report.discarded.candidates, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number }).n,
      0,
      "新版不會重新產出 since August.，所以重抽之後應該一條都不剩",
    );
    db.close();
  });

  it("當前版本的產出不會被自己刪掉", () => {
    const db = freshDb();
    ingestCommitMessages(db, 1);
    db.exec(
      `INSERT INTO source_doc
         (repo_id, doc_type, provenance_root, external_id, author, created_at, body, body_sha256)
       VALUES (1, 'pr_body', 'pr:1', 'pr:1:body', 'x', '2026-01-01',
               'Use pnpm instead of npm', '${sha256("Use pnpm instead of npm")}');`,
    );
    const linked = extractFromLinkedDocuments(db, 1);
    assert.equal(linked.promoted, 1);

    // stated 與 linked 是兩個版本字串。只把其中一個當成「當前」的話，
    // 後跑的那一支會把先跑的那一支剛寫好的列當成陳舊的刪掉。
    const again = extractFromCommitMessages(db, 1);
    assert.equal(again.discarded.evidence, 0);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number }).n,
      1,
      "linked 的引文必須還在",
    );
    db.close();
  });

  it("作廢不碰 source_doc——linked 文件是花網路取回來的", () => {
    const db = freshDb();
    seedStaleEvidence(db);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM source_doc").get() as
      { n: number }).n;
    discardStaleRuleEvidence(db, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM source_doc").get() as { n: number }).n,
      before,
    );
    db.close();
  });

  it("版本字串沒有互為前綴，否則作廢會漏掉一整類", () => {
    // `rule-rationale-markdown-x` 若以 `rule-rationale-x` 為前綴，
    // linked 的舊產出會被誤判成當前版本而留下來。
    assert.ok(!MARKDOWN_EXTRACTOR_VERSION.startsWith(`${EXTRACTOR_VERSION}/`));
    assert.ok(!EXTRACTOR_VERSION.startsWith(`${MARKDOWN_EXTRACTOR_VERSION}/`));
  });
});

describe("對比標記要引到被拒方案", () => {
  const only = (line: string) => {
    const spans = extractRationale(line);
    assert.equal(spans.length, 1, `${line} 應該只抽出一條`);
    return spans[0]!;
  };

  it("**`instead of` 的左半邊才是被拒絕的那個方案**", () => {
    // 只引右半邊會得到「instead of question while merging the router」——
    // 逐字為真、span 斷言通過、意思殘缺。tradeoff 的定義就是那組對比。
    const line = "* fix: use auth instead of question while merging the router (#330)";
    const span = only(line);
    assert.equal(
      span.quotedText,
      "fix: use auth instead of question while merging the router (#330)",
    );
    assert.equal(line.slice(span.charStart, span.charEnd), span.quotedText,
      "span 仍須逐字可驗證");
  });

  it("Osiris 的兩條乾淨案例補回左側方案", () => {
    assert.equal(
      only("fix: load all CCTV regions globally instead of UK-only hardcode").quotedText,
      "fix: load all CCTV regions globally instead of UK-only hardcode",
    );
    assert.equal(
      only("Fix active fires layer to use global NASA FIRMS Open Data CSVs"
        + " instead of US-biased EONET").quotedText,
      "Fix active fires layer to use global NASA FIRMS Open Data CSVs"
      + " instead of US-biased EONET",
    );
  });

  it("往前只拉到句首，不吃掉前一句", () => {
    const span = only("We shipped it. Use edge rather than lambda for the cold start.");
    assert.equal(span.quotedText, "Use edge rather than lambda for the cold start.");
  });

  it("**`to avoid`／`to prevent` 不跟著擴張**", () => {
    // 它們的內容在標記右邊，往前拉只會把不相干的前文收進引文。
    assert.equal(
      only("chore: pin the runner to avoid the CI flake").quotedText,
      "to avoid the CI flake",
    );
    assert.equal(
      only("fix: disable ISR to prevent quota burn").quotedText,
      "to prevent quota burn",
    );
  });

  it("**左邊界拉長過的規則字串仍取得回標記**", () => {
    // `/result` 後綴會讓錨在 `$` 的樣式整個失配，於是標記變成 undefined、
    // claim 被算成 unmapped——畫面靜默少一整類意圖。
    assert.equal(markerOf("rule-rationale-0.4.0/causal:instead of/result"), "instead of");
    assert.equal(markerOf("rule-rationale-0.4.0/causal:so that/result"), "so that");
    assert.equal(markerOf("rule-rationale-0.4.0/causal:since"), "since");
    assert.equal(markerOf(null), undefined);
  });
});
