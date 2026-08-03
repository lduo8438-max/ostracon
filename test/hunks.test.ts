import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  COMMIT_MARKER,
  attachHunks,
  parseHunkHeader,
  parsePatchLog,
  unquotePath,
} from "../src/git/hunks.ts";
import { collectHunks, collectHunksForCommits, walkCommits } from "../src/git/walk.ts";
import type { CommitRecord } from "../src/git/types.ts";

const M = COMMIT_MARKER;

describe("parseHunkHeader", () => {
  it("省略計數等同 1", () => {
    assert.deepEqual(parseHunkHeader("@@ -179 +180 @@ export async function GET() {"), {
      oldStart: 179,
      oldCount: 1,
      newStart: 180,
      newCount: 1,
    });
  });

  it("純新增的 oldCount 為 0", () => {
    assert.deepEqual(parseHunkHeader("@@ -246,0 +247,3 @@"), {
      oldStart: 246,
      oldCount: 0,
      newStart: 247,
      newCount: 3,
    });
  });

  it("純刪除的 newCount 為 0", () => {
    assert.deepEqual(parseHunkHeader("@@ -10,4 +9,0 @@"), {
      oldStart: 10,
      oldCount: 4,
      newStart: 9,
      newCount: 0,
    });
  });

  it("非 hunk 標頭回傳 null", () => {
    assert.equal(parseHunkHeader("@@@ -1,2 -1,2 +1,3 @@@"), null);
    assert.equal(parseHunkHeader("+++ b/src/a.ts"), null);
    assert.equal(parseHunkHeader(""), null);
  });
});

describe("unquotePath", () => {
  it("未加引號的路徑原樣回傳", () => {
    assert.equal(unquotePath("src/app/page.tsx"), "src/app/page.tsx");
  });

  it("八進位逸出以位元組還原後再解 UTF-8", () => {
    // "é" 的 UTF-8 是 C3 A9，git 會寫成 \303\251；逐字元解會變兩個亂碼字元。
    assert.equal(unquotePath('"src/caf\\303\\251.ts"'), "src/café.ts");
  });

  it("還原引號與反斜線", () => {
    assert.equal(unquotePath('"a \\"b\\" \\\\c.ts"'), 'a "b" \\c.ts');
  });
});

describe("parsePatchLog", () => {
  it("解析多 commit、多檔案", () => {
    const raw = [
      `${M}aaa`,
      "",
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +2,2 @@",
      "+one",
      "+two",
      "@@ -9 +11 @@",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1,3 @@",
      "+x",
      "+y",
      "+z",
      `${M}bbb`,
      "",
      "diff --git a/src/c.ts b/src/c.ts",
      "deleted file mode 100644",
      "--- a/src/c.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-p",
      "-q",
      "",
    ].join("\n");

    const out = parsePatchLog(raw);
    assert.deepEqual([...out.keys()], ["aaa", "bbb"]);

    const first = out.get("aaa")!;
    assert.deepEqual(first.map((f) => f.path), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(first[0]!.hunks, [
      { oldStart: 1, oldCount: 0, newStart: 2, newCount: 2 },
      { oldStart: 9, oldCount: 1, newStart: 11, newCount: 1 },
    ]);

    // 刪除檔的後像是 /dev/null，路徑必須退回前像，才能對上 file_change.path
    assert.deepEqual(out.get("bbb")!.map((f) => f.path), ["src/c.ts"]);
  });

  it("內容行與檔案標頭同形時不被誤判", () => {
    // 一行內容 "++ b/evil.ts" 在 -U0 之下會輸出成 "+++ b/evil.ts"。
    // 只有「照 hunk 宣告行數硬吃」的狀態機才不會把它當成新檔案。
    const raw = [
      `${M}aaa`,
      "diff --git a/doc.md b/doc.md",
      "--- a/doc.md",
      "+++ b/doc.md",
      "@@ -3,0 +4,3 @@",
      "+++ b/evil.ts",
      "+diff --git a/evil.ts b/evil.ts",
      "+@@ -1,1 +1,1 @@",
      "",
    ].join("\n");

    const out = parsePatchLog(raw);
    const files = out.get("aaa")!;
    assert.deepEqual(files.map((f) => f.path), ["doc.md"]);
    assert.equal(files[0]!.hunks.length, 1);
  });

  it("\\ No newline 不計入 hunk 行數", () => {
    const raw = [
      `${M}aaa`,
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -5,0 +6 @@",
      "+tail",
      "",
    ].join("\n");

    const files = parsePatchLog(raw).get("aaa")!;
    assert.deepEqual(files.map((f) => f.path), ["a.txt", "b.txt"]);
  });

  it("沒有 hunk 的檔案不產生條目", () => {
    // 純改名、mode 變更、二進位檔都沒有 hunk；留空條目會讓消費端誤以為
    // 「取過而且確定沒新增」，但那和「這檔案根本沒被 patch 覆蓋」不同。
    const raw = [
      `${M}aaa`,
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/logo.png b/logo.png",
      "index 111..222 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");

    assert.deepEqual(parsePatchLog(raw).get("aaa"), []);
  });
});

describe("attachHunks", () => {
  const commit = (sha: string, paths: string[]): CommitRecord => ({
    sha,
    parents: [],
    authorName: "a",
    authorEmail: "a@b",
    authoredAt: "",
    committedAt: "",
    message: "",
    isMerge: false,
    topoOrder: 0,
    changes: paths.map((p) => ({ changeType: "M" as const, path: p })),
  });

  it("依 sha + path 掛回，未覆蓋的檔案維持 undefined", () => {
    const commits = [commit("aaa", ["src/a.ts", "logo.png"])];
    const res = attachHunks(
      commits,
      new Map([
        ["aaa", [{ path: "src/a.ts", hunks: [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }] }]],
      ]),
    );

    assert.equal(res.orphans.length, 0);
    assert.equal(res.filesWithHunks, 1);
    assert.equal(commits[0]!.changes[0]!.hunks?.length, 1);
    // 二進位檔沒被 patch 覆蓋：必須是 undefined 而不是 []，否則 hunk 約束
    // 會把它當成「確定沒有新增行」。
    assert.equal(commits[0]!.changes[1]!.hunks, undefined);
  });

  it("patch 有、name-status 沒有的路徑記為 orphan 而不丟例外", () => {
    const commits = [commit("aaa", ["src/a.ts"])];
    const res = attachHunks(
      commits,
      new Map([["aaa", [{ path: "src/ghost.ts", hunks: [] }]]]),
    );
    assert.deepEqual(res.orphans, [{ sha: "aaa", path: "src/ghost.ts" }]);
  });
});

describe("collectHunks（真實 git）", () => {
  const repo = mkdtempSync(join(tmpdir(), "ostracon-hunk-"));
  after(() => rmSync(repo, { recursive: true, force: true }));

  const run = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

  const commitAll = (msg: string) => {
    run("add", "-A");
    run(
      "-c", "user.name=t", "-c", "user.email=t@t",
      "commit", "-m", msg, "--no-gpg-sign",
    );
  };

  it("hunk 與 name-status 對得起來", () => {
    run("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n");
    commitAll("init");

    writeFileSync(join(repo, "a.ts"), "one\ninserted\ntwo\nthree\nchanged\n");
    writeFileSync(join(repo, "b.ts"), "new file\n");
    commitAll("edit");

    const commits = walkCommits(repo, "HEAD");
    const res = attachHunks(commits, collectHunks(repo, "HEAD"));

    assert.equal(res.orphans.length, 0, "orphan 代表路徑解析錯了");

    const second = commits[1]!;
    const a = second.changes.find((c) => c.path === "a.ts")!;
    // 插入在第 1 行之後 → 純新增（oldCount 0）；結尾的 "changed" 是新增行
    assert.ok(a.hunks!.length >= 1);
    assert.ok(a.hunks!.every((h) => h.newCount > 0));
    assert.deepEqual(a.hunks![0], { oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 });

    const b = second.changes.find((c) => c.path === "b.ts")!;
    assert.deepEqual(b.hunks, [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }]);
  });

  it("合併 commit 不產生 hunk", () => {
    // 必須做成有衝突解決的合併：乾淨合併的 combined diff 是空的，
    // 那樣測不到「合併有 change 但沒有 hunk」這件事。
    writeFileSync(join(repo, "conflict.ts"), "base\n");
    commitAll("base");
    run("checkout", "-q", "-b", "side");
    writeFileSync(join(repo, "conflict.ts"), "side\n");
    commitAll("side");
    run("checkout", "-q", "main");
    writeFileSync(join(repo, "conflict.ts"), "main\n");
    commitAll("main");
    try {
      run("-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "side");
    } catch {
      // 預期衝突
    }
    writeFileSync(join(repo, "conflict.ts"), "resolved\n");
    commitAll("merge");

    const commits = walkCommits(repo, "HEAD");
    const merge = commits.find((c) => c.isMerge)!;
    const byCommit = collectHunks(repo, "HEAD");
    // git log --patch 對合併仍印出 commit 標頭、但不印 diff，所以條目存在而為空。
    assert.deepEqual(byCommit.get(merge.sha), []);

    const res = attachHunks(commits, byCommit);
    assert.equal(res.orphans.length, 0);
    // 真正的訊號在檔案層級：合併的每個 change 都必須是 undefined（＝沒去取），
    // 不能是 []（＝取了但沒有新增行）。hunk 約束靠這個區別決定要不要套用。
    assert.ok(merge.changes.length > 0);
    assert.ok(merge.changes.every((c) => c.hunks === undefined));
  });

  it("分批取 hunk 的結果與一次取完完全相同", () => {
    // 索引流程走的是分批路徑（--no-walk --stdin），一次取完的路徑只剩測試與
    // 臨時工具在用。兩者若有分歧，實際索引產出就會與這個檔案其他測試驗證的
    // 行為脫節，所以這裡直接把兩條路徑釘在一起。
    const commits = walkCommits(repo, "HEAD");
    const shas = commits.filter((c) => !c.isMerge).map((c) => c.sha);
    assert.ok(shas.length >= 4, "批次大小 1 要能切出多批才有意義");

    const whole = collectHunks(repo, "HEAD");
    // 批次大小 1：每個 commit 一次 git 呼叫，是最容易暴露跨批次狀態殘留的設定。
    const batched = collectHunksForCommits(repo, shas, {}, 1);

    for (const sha of shas) {
      assert.deepEqual(batched.get(sha), whole.get(sha), `${sha} 的 hunk 分批後不同`);
    }
    // 合併不在清單裡，所以分批結果不該有它——不是「空陣列」而是「沒有這個鍵」。
    for (const merge of commits.filter((c) => c.isMerge)) {
      assert.equal(batched.has(merge.sha), false);
    }
  });
});
