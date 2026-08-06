import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  renderTimeline,
  suppressUnrelatedRationale,
  why,
  type TimelineRow,
} from "../src/cli/why.ts";
import { sha256 } from "../src/evidence/span.ts";

const row = (over: Partial<TimelineRow> = {}): TimelineRow => ({
  sha: "a".repeat(40),
  shortSha: "aaaaaaaaaa",
  committedAt: "2026-01-01T00:00:00Z",
  authorName: "t",
  subject: "commit 標題",
  changeLevel: "raw",
  tier: "L1",
  ambiguitySize: 1,
  path: "src/a.ts",
  lineStart: 1,
  lineEnd: 10,
  signature: "function f() {",
  symbol: "f",
  rationale: null,
  linked: [],
  suppressedReferences: [],
  suppressedStatedQuotes: 0,
  ...over,
});

describe("renderTimeline（純函式）", () => {
  it("印出判定依據，因為那是「為什麼是同一個」的唯一說明", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row({ tier: "L3c", ambiguitySize: 4 })],
    );
    assert.match(text, /L3c/);
    assert.match(text, /4 個等價候選/, "有歧義就必須說出來，不能藏起來");
  });

  it("唯一候選時不顯示歧義數字，避免雜訊", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row({ tier: "L1", ambiguitySize: 1 })],
    );
    assert.match(text, /\[L1\]/);
    assert.doesNotMatch(text, /等價候選/);
  });

  it("誕生沒有 tier，不得硬印一個", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row({ changeLevel: "birth", tier: null, ambiguitySize: null })],
    );
    assert.match(text, /誕生/);
    assert.doesNotMatch(text, /\[/);
  });

  it("改名在發生的那一行明講，並在標頭提示現在的名字", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "old", stableKey: "0".repeat(64) },
      [
        row({ symbol: "old", changeLevel: "birth", tier: null, ambiguitySize: null }),
        row({ symbol: "neo", shortSha: "bbbbbbbbbb", tier: "L4" }),
      ],
    );
    assert.match(text, /現在叫 neo/);
    assert.match(text, /改名：old → neo/);
  });

  it("沒有任何改動時明說，不回傳空字串", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [],
    );
    assert.match(text, /沒有找到任何改動/);
  });

  it("A 級迂迴可以直述，並說出判定依據", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row({ changeLevel: "death" })],
      {
        kind: "excursion",
        strength: "A",
        method: "inverse_diff",
        durationDays: 212.5,
        survivingNamesakes: [],
      },
    );
    assert.match(text, /這個做法被推翻了/);
    assert.match(text, /212\.5 天/);
    assert.match(text, /逐字相同/, "判定依據要說人話，不能只印 method 欄位");
    assert.doesNotMatch(text, /疑似/, "A 是確證，標成疑似會低估自己的證據");
  });

  it("**C 級必須標「疑似」**，不得寫成結論", () => {
    // architecture.md §5：C 只有生命週期符合，沒有任何反向證據。
    // 把它印成「被推翻了」就是拿疑似當確證，是這一層最不能犯的錯。
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row({ changeLevel: "death" })],
      {
        kind: "excursion",
        strength: "C",
        method: "trajectory",
        durationDays: 3,
        survivingNamesakes: [],
      },
    );
    assert.match(text, /疑似被推翻/);
    assert.match(text, /未經證實/);
    assert.doesNotMatch(
      text,
      /^這個做法被推翻了/m,
      "C 級不得出現與 A 級相同的斷定句",
    );
  });

  it("**同名者仍存活時必須說出來**，否則會被讀成「這個想法被放棄了」", () => {
    // 實測 create-t3-app：71 條 A 級裡有 11 條（15%）限定名稱仍然存在，
    // 只是內容被改寫過所以內容守門抓不到。沉默會讓使用者把「實作被換掉」
    // 讀成「概念被放棄」，而那是錯的。
    const text = renderTimeline(
      { path: "src/old.ts", symbol: "createContext", stableKey: "0".repeat(64) },
      [row({ changeLevel: "death", symbol: "createContext" })],
      {
        kind: "excursion",
        strength: "A",
        method: "inverse_diff",
        durationDays: 40,
        survivingNamesakes: ["src/new.ts"],
      },
    );
    assert.match(text, /仍存在於 src\/new\.ts/);
    assert.match(text, /不必然是這個想法/);
  });

  it("同名者太多時只列前三個並給總數，不把 39 條路徑倒進終端機", () => {
    // 純名稱比對對泛用名字會大量命中：create-t3-app 的 `Home` 有 39 個同名存活者。
    const paths = Array.from({ length: 39 }, (_, i) => `src/p${i}.tsx`);
    const text = renderTimeline(
      { path: "src/old.tsx", symbol: "Home", stableKey: "0".repeat(64) },
      [row({ changeLevel: "death", symbol: "Home" })],
      {
        kind: "excursion",
        strength: "A",
        method: "inverse_diff",
        durationDays: 40,
        survivingNamesakes: paths,
      },
    );
    assert.match(text, /等 39 處/);
    assert.doesNotMatch(text, /p38\.tsx/, "第 39 條不該被印出來");
    assert.match(text, /p0\.tsx、src\/p1\.tsx、src\/p2\.tsx/);
  });

  it("沒跑全 repo 就說不知道，不得沉默", () => {
    // 沉默會被讀成「不是迂迴」——那是憑空替使用者排除了一段歷史。
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row({ changeLevel: "death" })],
      { kind: "needs-full-scan" },
    );
    assert.match(text, /還無法判斷/);
    assert.match(text, /--full/);
    assert.doesNotMatch(text, /被推翻了/);
  });

  it("**無變更的列不得出現理由引文**——那是斷言一個不存在的因果", () => {
    // demo 語料實測：6,367 次引文顯示裡有 41.7% 落在 change_level='none' 上。
    // 引文逐字為真、issue 編號正確、span 驗證通過，但那個 entity 在該 commit
    // 什麼都沒發生。使用者沒有任何辦法察覺這條因果是假的。
    const suppressed = suppressUnrelatedRationale(row({
      changeLevel: "none",
      rationale: "because the cache needs a cap",
      linked: [{
        provenanceRoot: "pr:162",
        quote: "because the cache needs a cap",
        kind: "pr",
        referenceKey: "162",
        method: "message_ref",
        confidence: 0.9,
        additionalDocuments: 0,
      }],
    }));
    assert.equal(suppressed.rationale, null, "stated 引文必須被抑制");
    assert.deepEqual(suppressed.linked, [], "linked 引文必須被抑制");
    // **指標要留著**：「這個 commit 提到 PR #162」是關於 commit 的事實，
    // 對導覽有用；被抑制的只是被當成理由讀的那段文字。
    assert.equal(suppressed.suppressedReferences.length, 1);
    assert.equal(suppressed.suppressedReferences[0]!.referenceKey, "162");
    assert.equal(
      JSON.stringify(suppressed.suppressedReferences).includes("quote"),
      false,
      "被抑制的指標裡不得夾帶引文",
    );
  });

  it("有實際改動的列完全不受影響", () => {
    for (const lvl of ["raw", "token", "alpha", "shape", "birth", "death"]) {
      const kept = suppressUnrelatedRationale(row({
        changeLevel: lvl,
        rationale: "because X",
        linked: [{
          provenanceRoot: "pr:1",
          quote: "because X",
          kind: "pr",
          referenceKey: "1",
          method: "message_ref",
          confidence: 0.9,
          additionalDocuments: 0,
        }],
      }));
      assert.equal(kept.rationale, "because X", `${lvl} 不該被抑制`);
      assert.equal(kept.linked.length, 1, `${lvl} 不該被抑制`);
      assert.deepEqual(kept.suppressedReferences, []);
    }
  });

  it("**被抑制的數量必須在標頭交代**，不得靜默丟掉", () => {
    // 靜默丟掉與靜默誤植同樣不誠實：前者讓使用者以為沒有理由可查，而其實有。
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [
        row({ changeLevel: "shape" }),
        row({
          shortSha: "bbbbbbbbbb",
          changeLevel: "none",
          suppressedReferences: [
            { provenanceRoot: "pr:1", kind: "pr", referenceKey: "1", method: "message_ref", confidence: 0.9 },
            { provenanceRoot: "issue:2", kind: "issue", referenceKey: "2", method: "message_ref", confidence: 0.9 },
          ],
        }),
        row({
          shortSha: "cccccccccc",
          changeLevel: "none",
          suppressedReferences: [
            { provenanceRoot: "pr:1", kind: "pr", referenceKey: "1", method: "message_ref", confidence: 0.9 },
          ],
        }),
      ],
    );
    assert.match(text, /另有 2 次改動的 commit 帶著 2 則 PR／issue/, "commit 數與去重後的討論串數要分開算");
    assert.match(text, /沒有修改到這個實體/);
  });

  it("**只有 commit message 理由被抑制時，標頭一樣要交代**", () => {
    // 這是第一版的漏洞：stated 的抑制寫在 SQL 的 WHERE 裡，而標頭只數 linked，
    // 所以「沒有任何 PR 參照、只有 commit message 理由」的列被靜默丟掉。
    // 實測 Osiris 有 17 列、create-t3-app 有 3 列踩到。
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [
        row({ changeLevel: "shape" }),
        row({ shortSha: "bbbbbbbbbb", changeLevel: "none", suppressedStatedQuotes: 2 }),
      ],
    );
    assert.match(text, /另有 1 次改動的 commit/);
    assert.match(text, /2 段 commit message 理由/);
    assert.doesNotMatch(text, /PR／issue/, "沒有參照就不該提參照");
  });

  it("stated 被抑制時要數對條數", () => {
    const suppressed = suppressUnrelatedRationale(row({
      changeLevel: "none",
      rationale: ["理由一", "理由二", "理由三"].join("\u001f"),
    }));
    assert.equal(suppressed.rationale, null);
    assert.equal(suppressed.suppressedStatedQuotes, 3);
  });

  it("沒有被抑制的東西時，標頭完全不提", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row({ changeLevel: "shape" })],
    );
    assert.doesNotMatch(text, /另有|沒有修改到/);
  });

  it("沒有迂迴時完全不提，不留下暗示", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row()],
    );
    assert.doesNotMatch(text, /推翻|疑似|--full/);
  });
});

describe("why（真實 git + 真實 schema）", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "ostracon-why-"));
  const dbDir = mkdtempSync(path.join(tmpdir(), "ostracon-why-db-"));
  after(() => {
    // tmp 由作業系統回收；留著方便失敗時檢查。
  });

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), body);
  };
  const commit = (msg: string) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg, "--no-gpg-sign");
    return git("rev-parse", "HEAD");
  };

  it("時間軸涵蓋誕生、變更層級、改名，以及 slot 延續但血緣斷開", async () => {
    git("init", "-q", "-b", "main");
    write("src/a.ts", `
export function compute(input: number): number {
  const scaled = input * 2;
  const shifted = scaled + 1;
  return shifted;
}
`.trimStart());
    commit("加入 compute");

    // 只改局部變數名 → token 層
    write("src/a.ts", `
export function compute(input: number): number {
  const doubled = input * 2;
  const shifted = doubled + 1;
  return shifted;
}
`.trimStart());
    commit("改名局部變數");

    // 改名宣告本身，並新增一個同名的新函式：slot 延續，entity 斷開。
    write("src/a.ts", `
export function computeCore(input: number): number {
  const doubled = input * 2;
  const shifted = doubled + 1;
  return shifted;
}

export function compute(input: number): number {
  return computeCore(input);
}
`.trimStart());
    const replaced = commit("抽出 computeCore，compute 變成轉呼叫");

    const dbPath = path.join(dbDir, "index.db");
    const text = await why(repo, "src/a.ts:compute", dbPath, "HEAD");

    // 兩個實體：舊的 compute（後來叫 computeCore）與新的轉呼叫 compute。
    assert.match(text, /2 個不同的實體/, "slot 延續但血緣斷開時必須說清楚");
    assert.match(text, /改名：compute → computeCore/);
    assert.match(text, /局部變數改名/, "token 層必須被辨識出來");
    assert.equal(
      (text.match(/誕生/g) ?? []).length,
      2,
      "兩個實體各誕生一次；同一個實體不得誕生兩次",
    );

    const db = new DatabaseSync(dbPath);
    const discontinuity = db.prepare(
      `SELECT d.prev_entity AS prevEntity, d.next_entity AS nextEntity
         FROM slot_discontinuity d
         JOIN git_commit c ON c.id = d.commit_id
         JOIN slot s ON s.id = d.slot_id
        WHERE c.sha = ? AND s.qualified_name = 'compute'`,
    ).all(replaced) as unknown as Array<{ prevEntity: number; nextEntity: number }>;
    db.close();
    assert.equal(discontinuity.length, 1, "同名新函式補位必須成為佔用者置換斷層");
    assert.notEqual(discontinuity[0]!.prevEntity, discontinuity[0]!.nextEntity);
  });

  it("重跑同一個資料庫不得改變任何結果", async () => {
    // 不變量 7：相同輸入必須產生相同輸出。索引寫入全部走 ON CONFLICT，
    // 重跑若會累加，時間軸就會憑空多出改動。
    const dbPath = path.join(dbDir, "idempotent.db");
    const first = await why(repo, "src/a.ts:compute", dbPath, "HEAD");
    const counts = () => {
      const db = new DatabaseSync(dbPath);
      const row = db.prepare(
        `SELECT (SELECT COUNT(*) FROM revision) r,
                (SELECT COUNT(*) FROM entity) e,
                (SELECT COUNT(*) FROM revision_match) m,
                (SELECT COUNT(*) FROM revision_change) c`,
      ).get();
      db.close();
      return JSON.stringify(row);
    };
    const before = counts();
    const second = await why(repo, "src/a.ts:compute", dbPath, "HEAD");
    assert.equal(counts(), before, "重跑不得新增任何列");
    assert.equal(second, first, "輸出必須逐字相同");
  });

  it("linked evidence 寫入時全留，時間軸才依 provenance_root 收斂", async () => {
    const dbPath = path.join(dbDir, "linked.db");
    await why(repo, "src/a.ts:compute", dbPath, "HEAD");

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const targets = db.prepare(
      `SELECT c.repo_id AS repoId, c.sha
         FROM revision_change rc
         JOIN git_commit c ON c.id = rc.commit_id
        WHERE rc.entity_id IN (
          SELECT DISTINCT r.entity_id
            FROM revision r JOIN slot s ON s.id = r.slot_id
           WHERE s.qualified_name = 'compute'
        )
        ORDER BY c.topo_order ASC LIMIT 2`,
    ).all() as unknown as Array<{ repoId: number; sha: string }>;
    const target = targets[0]!;
    db.prepare(
      `INSERT INTO reference_link
         (repo_id, from_kind, from_key, to_kind, to_key, method, confidence)
       VALUES (?, 'commit', ?, 'pr', '7', 'message_ref', 0.9)`,
    ).run(target.repoId, target.sha);
    db.prepare(
      `INSERT INTO reference_link
         (repo_id, from_kind, from_key, to_kind, to_key, method, confidence)
       VALUES (?, 'commit', ?, 'pr', '7', 'message_ref', 0.4)`,
    ).run(targets[1]!.repoId, targets[1]!.sha);
    const docs = [
      ["pr_body", "pr:7:body", "because every worker shares the same budget", "2026-01-01"],
      ["pr_comment", "pr:7:comment:701", "to prevent unbounded growth", "2026-01-02"],
    ] as const;
    const insert = db.prepare(
      `INSERT INTO source_doc
         (repo_id, doc_type, provenance_root, external_id, url, author, created_at,
          body, body_sha256)
       VALUES (?, ?, 'pr:7', ?, 'https://github.com/acme/demo/pull/7', 't', ?, ?, ?)`,
    );
    for (const [type, externalId, body, createdAt] of docs) {
      insert.run(target.repoId, type, externalId, createdAt, body, sha256(body));
    }
    db.close();

    const text = await why(repo, "src/a.ts:compute", dbPath, "HEAD");
    assert.equal((text.match(/關聯「/g) ?? []).length, 1, "同一 PR 只呈現一份獨立證據");
    assert.match(text, /PR #7；message_ref 0\.9；另有 1 則同串留言/);

    const verify = new DatabaseSync(dbPath);
    const evidence = verify.prepare(
      "SELECT COUNT(*) AS n FROM evidence WHERE tier = 'linked'",
    ).get() as { n: number };
    assert.equal(evidence.n, 2, "查詢去重不得刪掉同串另一則 evidence");
    const edited = "Upstream text was edited.";
    verify.prepare(
      "UPDATE source_doc SET body = ?, body_sha256 = ? WHERE provenance_root = 'pr:7'",
    ).run(edited, sha256(edited));
    verify.close();

    const afterEdit = await why(repo, "src/a.ts:compute", dbPath, "HEAD");
    assert.doesNotMatch(afterEdit, /關聯「/, "body hash 已變的 stale evidence 不得繼續呈現");
  });

  it("找不到符號時說明，而不是丟出例外或印空白", async () => {
    const dbPath = path.join(dbDir, "index2.db");
    const text = await why(repo, "src/a.ts:nonexistent", dbPath, "HEAD");
    assert.match(text, /沒有這個符號/);
  });
});

describe("時間軸顯示已驗證的理由", () => {
  it("有引文就逐字印出，並與 subject 分開", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row({ rationale: "to prevent quota burn" })],
    );
    assert.match(text, /理由「to prevent quota burn」/);
    assert.match(text, /commit 標題/, "subject 仍然要在，兩者不可混為一談");
  });

  it("多段引文各印一行", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row({ rationale: "第一個理由\u001f第二個理由" })],
    );
    assert.match(text, /理由「第一個理由」/);
    assert.match(text, /理由「第二個理由」/);
  });

  it("沒有理由就完全不提——不替 commit 編一個", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row({ rationale: null })],
    );
    assert.doesNotMatch(text, /理由/);
  });

  it("linked 與 stated 視覺分開，且顯示關聯方法與強度", () => {
    const text = renderTimeline(
      { path: "src/a.ts", symbol: "f", stableKey: "0".repeat(64) },
      [row({
        linked: [{
          provenanceRoot: "pr:7",
          quote: "because workers share the same budget",
          kind: "pr",
          referenceKey: "7",
          method: "message_ref",
          confidence: 0.9,
          additionalDocuments: 2,
        }],
      })],
    );
    assert.match(text, /關聯「because workers share the same budget」/);
    assert.match(text, /PR #7；message_ref 0\.9/);
    assert.match(text, /另有 2 則同串留言/);
    assert.doesNotMatch(text, /理由「because workers/, "linked 不得偽裝成作者自己的 stated 理由");
  });
});

/**
 * 這一組守的是**接線**，不是純函式。
 *
 * `suppressUnrelatedRationale` 與同名存活查詢各自都有單元測試而且會咬，
 * 但實測把它們從 `timelineOf` / `excursionOf` 拆掉之後，250 條測試**全部通過**——
 * 純函式對不代表它真的被呼叫到。這兩條走完整的 `why`，斷言的是使用者實際看到的輸出。
 */
describe("why 的呈現接線（真實 git，完整路徑）", () => {
  const makeRepo = () => {
    const repo = mkdtempSync(path.join(tmpdir(), "ostracon-wiring-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    const write = (rel: string, body: string) => {
      mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      writeFileSync(path.join(repo, rel), body);
    };
    const remove = (rel: string) => git("rm", "-q", path.join(repo, rel));
    const commit = (msg: string) => {
      git("add", "-A");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg, "--no-gpg-sign");
      return git("rev-parse", "HEAD");
    };
    const dbPath = path.join(
      mkdtempSync(path.join(tmpdir(), "ostracon-wiring-db-")),
      "i.db",
    );
    return { repo, write, remove, commit, dbPath };
  };

  const fn = (name: string, body: string) => `export function ${name}(input: number): number {
  const scaled = input * ${body};
  const shifted = scaled + 1;
  return shifted;
}`;

  it("**無變更的列不得顯示 commit 的理由，而且標頭要交代**", async () => {
    // commit 的理由是關於整次改動的，時間軸卻是逐 entity 的。demo 語料實測
    // 41.7% 的引文落在該實體毫無變動的列上——使用者沒有辦法察覺那條因果是假的。
    const { repo, write, commit, dbPath } = makeRepo();
    write("src/a.ts", `${fn("target", "2")}\n\n${fn("other", "3")}\n`);
    commit("加入兩個函式");

    // 只動 other，target 逐字未變 → target 在這個 commit 是 change_level='none'。
    // commit message 帶因果標記，抽取器會產生一條 stated 理由。
    write("src/a.ts", `${fn("target", "2")}\n\n${fn("other", "9")}\n`);
    commit("adjust other because the old multiplier was wrong");

    const text = await why(repo, "src/a.ts:target", dbPath, "HEAD");

    assert.doesNotMatch(
      text,
      /理由「/,
      "target 在那個 commit 沒有變更，不得掛上該 commit 的理由",
    );
    assert.match(
      text,
      /另有 1 次改動的 commit 帶著 1 段 commit message 理由/,
      "抑制不得靜默——標頭要說出丟掉了什麼",
    );
    assert.match(text, /沒有修改到這個實體/);
  });

  it("**同名存活者的提示必須真的出現在輸出裡**", async () => {
    // 內容守門比對的是雜湊，所以「名稱還在、實作被改寫」它抓不到。
    // create-t3-app 實測 71 條 A 級裡有 11 條（15%）屬於這種，沉默會讓使用者
    // 把「實作被換掉」讀成「概念被放棄」。
    const { repo, write, remove, commit, dbPath } = makeRepo();
    write("src/keep.ts", "export const keep = 1;\n");
    write("src/old.ts", `${fn("handler", "2")}\n`);
    // 同名但**內容不同**——內容相同的話會被搬移守門排除，就測不到這條路徑了。
    write("src/new.ts", `export function handler(text: string): string {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();
  return \`[\${upper}]\`;
}
`);
    commit("兩個同名不同實作的 handler");

    remove("src/old.ts");
    commit("移除舊的實作");

    // 迂迴偵測只在全 repo pass 之後跑——守門在單一血緣下是瞎的。
    const text = await why(repo, "src/old.ts:handler", dbPath, "HEAD", { full: true });

    assert.match(text, /這個做法被推翻了/, "測試前提：這必須先是一條 A 級迂迴");
    assert.match(
      text,
      /仍存在於 src\/new\.ts/,
      "同名存活者必須被列出，否則「實作被換掉」會被讀成「概念被放棄」",
    );
    assert.match(
      text,
      /不必然是這個想法/,
      "措辭必須保留不確定性——這是純名稱比對，不是語意判定",
    );
  });
});
