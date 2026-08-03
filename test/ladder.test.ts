import { test } from "node:test";
import assert from "node:assert/strict";
import { matchLadder, type Candidate } from "../src/match/ladder.ts";
import {
  buildSignature, EXACT_NGRAM_LIMIT, exactJaccard, ngramSet, recallSimilarity,
} from "../src/match/signature.ts";
import type { HashVector } from "../src/ast/types.ts";

const PROFILE = "typescript/0.23.x/sexp-1.0.0";

function hv(o: Partial<HashVector> = {}): HashVector {
  return {
    hashRaw: "r", hashToken: "t", hashAlpha: "a", hashAlphaSelf: "as", hashShape: "s",
    nodeCount: 40, tokenCount: 60, shapeProfile: PROFILE, ...o,
  };
}
let seq = 0;
function cand(o: Partial<Candidate> & { id?: string } = {}): Candidate {
  const id = o.id ?? `c${++seq}`;
  const tokens = Array.from({ length: 30 }, (_, i) => ({ type: "identifier", text: `${id}_${i}` }));
  return {
    id, lineageId: 1, qualifiedName: "f", kind: "function_declaration",
    hashes: hv(), signature: buildSignature(tokens), path: "src/a.ts", startIndex: 0,
    // 預設行號故意不重疊也不連號：沒有指定 hunksByLineage 時 L3c 不啟用，
    // 這些值不該影響任何既有測試的結果。
    startLine: 1, endLine: 10, ...o,
  };
}
/** 測試用的精確驗證：兩端都有完整集合時直接算 */
const verify = (p: Candidate, n: Candidate) =>
  p.signature.exact && n.signature.exact ? exactJaccard(p.signature.exact, n.signature.exact) : 0;

const run = (prev: Candidate[], next: Candidate[], o = {}) =>
  matchLadder(prev, next, { verify, ...o });

// ── 階梯層級 ───────────────────────────────────────────────────────────────

test("L1：同槽位即使內容大改也維持最強層級", () => {
  seq = 0;
  const p = cand({ id: "p", hashes: hv({ hashRaw: "x", hashToken: "x", hashAlpha: "x", hashShape: "x" }) });
  const n = cand({ id: "n", hashes: hv({ hashRaw: "y", hashToken: "y", hashAlpha: "y", hashShape: "y" }) });
  const { matches } = run([p], [n]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.tier, "L1");
  assert.equal(matches[0]!.exactVerified, false, "雜湊層不該宣稱做過精確驗證");
});

test("L1 跨檔案改名仍成立：血緣相同就是同一個檔案", () => {
  seq = 0;
  const p = cand({ id: "p", path: "src/old.ts" });
  const n = cand({ id: "n", path: "src/new.ts" }); // 同 lineageId
  assert.equal(run([p], [n]).matches[0]!.tier, "L1");
});

test("L1 只有前後 slot bucket 都是 1:1 才接受", () => {
  seq = 0;
  const distinct = (id: string, suffix: string) =>
    cand({
      id,
      hashes: hv({
        hashRaw: `raw-${suffix}`,
        hashToken: `token-${suffix}`,
        hashAlpha: `alpha-${suffix}`,
        hashAlphaSelf: `self-${suffix}`,
      }),
    });
  const { matches, ambiguities } = run(
    [distinct("p0", "p0"), distinct("p1", "p1")],
    [distinct("n0", "n0"), distinct("n1", "n1")],
  );
  assert.equal(matches.some((match) => match.tier === "L1"), false);
  assert.deepEqual(
    ambiguities.filter((ambiguity) => ambiguity.tier === "L1")
      .map(({ prevCount, nextCount, prevIds, nextIds }) => ({
        prevCount,
        nextCount,
        prevIds,
        nextIds,
      })),
    [{
      prevCount: 2,
      nextCount: 2,
      prevIds: ["p0", "p1"],
      nextIds: ["n0", "n1"],
    }],
  );
});

test("L1 單側重複也不得用 Map 最後一筆靜默覆蓋", () => {
  seq = 0;
  const p0 = cand({ id: "p0", hashes: hv({ hashRaw: "p0" }) });
  const p1 = cand({ id: "p1", hashes: hv({ hashRaw: "p1" }) });
  const n0 = cand({ id: "n0", hashes: hv({ hashRaw: "n0" }) });
  const first = run([p0, p1], [n0]);
  const reversed = run([p1, p0], [n0]);
  for (const result of [first, reversed]) {
    assert.equal(result.matches.some((match) => match.tier === "L1"), false);
    assert.ok(result.ambiguities.some((ambiguity) =>
      ambiguity.tier === "L1"
      && ambiguity.prevCount === 2
      && ambiguity.nextCount === 1));
  }
});

test("L2：函式改名但內容完全不變", () => {
  seq = 0;
  const p = cand({ id: "p", qualifiedName: "oldName" });
  const n = cand({ id: "n", qualifiedName: "newName" });
  const { matches } = run([p], [n]);
  assert.equal(matches[0]!.tier, "L2");
});

test("L3：改名且區域變數也改名", () => {
  seq = 0;
  const p = cand({ id: "p", qualifiedName: "old", hashes: hv({ hashRaw: "r1", hashToken: "t1" }) });
  const n = cand({ id: "n", qualifiedName: "new", hashes: hv({ hashRaw: "r2", hashToken: "t2" }) });
  assert.equal(run([p], [n]).matches[0]!.tier, "L3");
});

// ── L3b 的硬性前置條件 ─────────────────────────────────────────────────────

const pureRename = (over: Partial<HashVector> = {}) => {
  const base = { hashRaw: "r1", hashToken: "t1", hashAlpha: "a1", hashAlphaSelf: "SAME", ...over };
  return {
    p: cand({ id: "p", qualifiedName: "CompanyIntel", hashes: hv(base) }),
    n: cand({ id: "n", qualifiedName: "CompanyIntelInner",
      hashes: hv({ ...base, hashRaw: "r2", hashToken: "t2", hashAlpha: "a2" }) }),
  };
};

test("L3b：純改名由 hash_alpha_self 相等判定", () => {
  seq = 0;
  const { p, n } = pureRename();
  assert.equal(run([p], [n]).matches[0]!.tier, "L3b");
});

test("L3b 不跨檔案", () => {
  seq = 0;
  const { p, n } = pureRename();
  n.lineageId = 2;
  const { matches } = run([p], [n]);
  assert.notEqual(matches[0]?.tier, "L3b");
});

test("L3b 要求 node_count 過閘門", () => {
  seq = 0;
  const { p, n } = pureRename();
  p.hashes = { ...p.hashes, nodeCount: 10 };
  n.hashes = { ...n.hashes, nodeCount: 10 };
  assert.notEqual(run([p], [n]).matches[0]?.tier, "L3b");
});

test("L3b 要求 shape_profile 相同", () => {
  seq = 0;
  const { p, n } = pureRename();
  n.hashes = { ...n.hashes, shapeProfile: "typescript/0.24.x/sexp-1.0.0" };
  assert.notEqual(run([p], [n]).matches[0]?.tier, "L3b");
});

test("L3b 要求 kind 相同", () => {
  seq = 0;
  const { p, n } = pureRename();
  n.kind = "method_definition";
  assert.notEqual(run([p], [n]).matches[0]?.tier, "L3b");
});

test("L3b bucket 不唯一時退回，並記下 ambiguity", () => {
  seq = 0;
  const { p, n } = pureRename();
  const p2 = cand({ id: "p2", qualifiedName: "Other", hashes: p.hashes });
  const { matches, ambiguities } = run([p, p2], [n]);
  assert.equal(matches.some((m) => m.tier === "L3b"), false);
  assert.ok(ambiguities.some((a) => a.tier === "L3b" && a.prevCount === 2));
});

// ── 歧義與決定性 ───────────────────────────────────────────────────────────

test("雜湊 bucket 不唯一時放棄該層，改由精確驗證接手", () => {
  // 五個一模一樣的 getter：任意配對內容雖然無誤，但會讓 entity 身份
  // 在每次重建索引時漂移，而 stable_key 必須可重現。
  seq = 0;
  const same = hv({ hashRaw: "same", hashToken: "same", hashAlpha: "same" });
  const tok = Array.from({ length: 30 }, (_, i) => ({ type: "identifier", text: `g${i}` }));
  const mk = (id: string, name: string) =>
    cand({ id, qualifiedName: name, hashes: same, signature: buildSignature(tok) });
  const { matches, ambiguities } = run(
    [mk("p1", "a"), mk("p2", "b")],
    [mk("n1", "c"), mk("n2", "d")],
  );
  assert.ok(ambiguities.some((a) => a.tier === "L2"));
  assert.equal(matches.length, 2, "應由 L4 接住");
  assert.ok(matches.every((m) => m.tier === "L4" && m.exactVerified));
});

test("輸入順序不影響結果", () => {
  seq = 0;
  const a = cand({ id: "a", qualifiedName: "x" });
  const b = cand({ id: "b", qualifiedName: "y" });
  const c = cand({ id: "c", qualifiedName: "x" });
  const d = cand({ id: "d", qualifiedName: "y" });
  const r1 = run([a, b], [c, d]).matches;
  const r2 = run([b, a], [d, c]).matches;
  assert.deepEqual(r1, r2);
});

test("每一端最多只被消耗一次", () => {
  seq = 0;
  const p = cand({ id: "p", qualifiedName: "f" });
  const n1 = cand({ id: "n1", qualifiedName: "f" });
  const n2 = cand({ id: "n2", qualifiedName: "f", startIndex: 10 });
  const { matches } = run([p], [n1, n2]);
  assert.ok(matches.filter((m) => m.prev === "p").length <= 1);
});

// ── 相似度層 ───────────────────────────────────────────────────────────────

test("L4 接受的匹配必定帶精確 Jaccard", () => {
  seq = 0;
  const tok = (k: number) => Array.from({ length: 40 }, (_, i) => ({
    type: "identifier", text: i < 35 ? `s${i}` : `d${k}_${i}`,
  }));
  const p = cand({ id: "p", qualifiedName: "a", hashes: hv({ hashRaw: "1", hashToken: "1", hashAlpha: "1", hashAlphaSelf: "1" }), signature: buildSignature(tok(1)) });
  const n = cand({ id: "n", qualifiedName: "b", hashes: hv({ hashRaw: "2", hashToken: "2", hashAlpha: "2", hashAlphaSelf: "2" }), signature: buildSignature(tok(2)) });
  const m = run([p], [n]).matches[0]!;
  assert.equal(m.tier, "L4");
  assert.equal(m.exactVerified, true);
  assert.ok(m.exactJaccard! > 0.5);
});

test("相似度不足時不產生匹配", () => {
  seq = 0;
  const mk = (id: string, name: string, salt: string) => cand({
    id, qualifiedName: name,
    hashes: hv({ hashRaw: id, hashToken: id, hashAlpha: id, hashAlphaSelf: id }),
    signature: buildSignature(Array.from({ length: 40 }, (_, i) => ({ type: "identifier", text: `${salt}${i}` }))),
  });
  assert.equal(run([mk("p", "a", "x")], [mk("n", "b", "y")]).matches.length, 0);
});

test("跨檔案用較高門檻", () => {
  seq = 0;
  const tok = (k: number) => Array.from({ length: 40 }, (_, i) => ({
    type: "identifier", text: i < 32 ? `s${i}` : `d${k}_${i}`,
  }));
  const mk = (id: string, lineage: number, k: number) => cand({
    id, lineageId: lineage, qualifiedName: id,
    hashes: hv({ hashRaw: id, hashToken: id, hashAlpha: id, hashAlphaSelf: id }),
    signature: buildSignature(tok(k)),
  });
  const same = run([mk("p", 1, 1)], [mk("n", 1, 2)]);
  const cross = run([mk("p", 1, 1)], [mk("n", 2, 2)]);
  // 這組資料的精確 Jaccard 約 0.65：高於同檔門檻 0.5，低於跨檔門檻 0.7。
  // 跨檔案配對的代價高得多（搬移 + 大改寫的誤配會把兩個無關的實體接成一條血緣），
  // 所以門檻必須更嚴。
  assert.equal(same.matches[0]?.tier, "L4");
  assert.ok(same.matches[0]!.exactJaccard! > 0.5 && same.matches[0]!.exactJaccard! < 0.7);
  assert.equal(cross.matches.length, 0, "同樣的相似度在跨檔案時應被較高門檻擋下");
});

// ── 簽章 ───────────────────────────────────────────────────────────────────

test("ngram_count 決定簽章形式，門檻不寫死在 schema", () => {
  const small = buildSignature(Array.from({ length: 20 }, (_, i) => ({ type: "t", text: `${i}` })));
  assert.ok(small.exact && !small.minhash);
  const big = buildSignature(Array.from({ length: EXACT_NGRAM_LIMIT + 300 }, (_, i) => ({ type: "t", text: `${i}` })));
  assert.ok(big.minhash && !big.exact);
  assert.ok(big.ngramCount > EXACT_NGRAM_LIMIT);
});

test("n-gram 集合去重：重複度高的程式碼不會虛胖", () => {
  const repeated = Array.from({ length: 100 }, () => ({ type: "t", text: "same" }));
  assert.equal(ngramSet(repeated).size, 1);
});

test("完整集合可現場推導 MinHash，混合比較永遠可行", () => {
  const tok = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "t", text: `${i}` }));
  const small = buildSignature(tok(50));
  const big = buildSignature(tok(EXACT_NGRAM_LIMIT + 400));
  const s = recallSimilarity(small, big);
  assert.ok(s >= 0 && s <= 1, "混合比較必須回傳有效值而非爆炸");
});

test("MinHash 估計值與精確 Jaccard 接近", () => {
  const mk = (offset: number, n: number) =>
    ngramSet(Array.from({ length: n }, (_, i) => ({ type: "t", text: `${i + offset}` })));
  const a = mk(0, 600);
  const b = mk(150, 600);
  const exact = exactJaccard(a, b);
  const est = recallSimilarity(
    { ngramCount: a.size, minhash: undefined, exact: a } as never,
    { ngramCount: b.size, exact: b } as never,
  );
  assert.ok(Math.abs(exact - est) < 0.001, "兩端皆有完整集合時應走精確路徑");
});

// ── L3c：位置錨定 ──────────────────────────────────────────────────────────
//
// 這一層解的不是「找不到配對」，而是「找得到但說不出理由」。所以測試的重點
// 全部在判定依據是否成立，而不是配對數量。

/** 三個內容完全相同、只有位置不同的候選——正是 fetchEndpoint 那個族群的形狀。 */
const identical = (side: "p" | "n", lines: Array<[number, number]>) =>
  lines.map(([startLine, endLine], i) =>
    cand({
      id: `${side}${i}`,
      hashes: hv({ hashRaw: "same", hashToken: "same", hashAlpha: "same" }),
      signature: buildSignature(
        Array.from({ length: 30 }, (_, k) => ({ type: "identifier", text: `shared_${k}` })),
      ),
      startLine,
      endLine,
    }));

test("L3c：內容完全相同時，未變更的行由位置回推唯一決定配對", () => {
  seq = 0;
  // 檔案開頭插入 5 行，三個宣告整體往後推，本身都沒被碰到。
  const prev = identical("p", [[10, 20], [30, 40], [50, 60]]);
  const next = identical("n", [[15, 25], [35, 45], [55, 65]]);
  const { matches } = run(prev, next, {
    hunksByLineage: new Map([[1, [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 5 }]]]),
  });

  assert.equal(matches.length, 3);
  assert.ok(matches.every((m) => m.tier === "L3c"), "應由位置錨定接住，不是相似度");
  assert.ok(
    matches.every((m) => m.exactJaccard === undefined && m.exactVerified === false),
    "L3c 是精確判定，不得填相似度欄位",
  );
  assert.deepEqual(
    matches.map((m) => `${m.prev}->${m.next}`).sort(),
    ["p0->n0", "p1->n1", "p2->n2"],
    "位置保序的雙射",
  );
  // L3c 的 ambiguity_size 是內容等價類的大小，不是 1。走到這一層恰恰是因為
  // 內容 bucket 不唯一——唯一的是位置。填 1 等於宣稱「這裡只有一個候選」。
  assert.ok(
    matches.every((m) => m.ambiguitySize === 3),
    "三個內容相同的前像，必須誠實回報 3",
  );
});

test("L3c 不啟用時行為與加入這一層之前完全相同", () => {
  seq = 0;
  const prev = identical("p", [[10, 20], [30, 40], [50, 60]]);
  const next = identical("n", [[15, 25], [35, 45], [55, 65]]);
  const { matches } = run(prev, next); // 沒給 hunksByLineage
  assert.equal(matches.length, 3);
  assert.ok(matches.every((m) => m.tier === "L4"), "沒有 hunk 證據就退回相似度");
});

test("L3c：沒有 hunk 資料的血緣完全不套用約束", () => {
  seq = 0;
  const prev = identical("p", [[10, 20], [30, 40]]);
  const next = identical("n", [[15, 25], [35, 45]]);
  // 空 Map：血緣 1 缺鍵 = 沒有 hunk 證據（合併、二進位），不是「沒有改動」。
  const { matches } = run(prev, next, { hunksByLineage: new Map() });
  assert.ok(matches.every((m) => m.tier === "L4"));
});

test("L3c：被 hunk 碰到的宣告拿不到位置證據", () => {
  seq = 0;
  const prev = identical("p", [[10, 20], [30, 40]]);
  const next = identical("n", [[10, 20], [30, 40]]);
  // hunk 落在第一個宣告正中間；第二個宣告未被碰到。
  const { matches } = run(prev, next, {
    hunksByLineage: new Map([[1, [{ oldStart: 15, oldCount: 2, newStart: 15, newCount: 2 }]]]),
  });
  const byPair = new Map(matches.map((m) => [`${m.prev}->${m.next}`, m.tier]));
  assert.equal(byPair.get("p1->n1"), "L3c", "未被碰到的仍該拿到位置證據");
  assert.equal(byPair.get("p0->n0"), "L4", "被碰到的退回相似度");
});

test("L3c：hash_raw 不同就不接受，位置不能單獨當證據", () => {
  seq = 0;
  const prev = [cand({ id: "p0", hashes: hv({ hashRaw: "a" }), startLine: 10, endLine: 20 })];
  const next = [cand({ id: "n0", hashes: hv({ hashRaw: "b" }), startLine: 10, endLine: 20 })];
  const { matches } = run(prev, next, { hunksByLineage: new Map([[1, []]]) });
  assert.ok(
    matches.every((m) => m.tier !== "L3c"),
    "位置對得上但內容不同，只能代表這個位置被換了東西",
  );
});

test("L3c：回推位置沒有精確命中就放棄，不做最近似配對", () => {
  seq = 0;
  const prev = identical("p", [[10, 20]]);
  const next = identical("n", [[11, 21]]); // 差一行，且沒有 hunk 解釋這個位移
  const { matches } = run(prev, next, { hunksByLineage: new Map([[1, []]]) });
  assert.ok(matches.every((m) => m.tier !== "L3c"), "近似命中不是證據");
});

test("ambiguity_size 記下 L4 當下有幾個同分候選", () => {
  seq = 0;
  const prev = identical("p", [[10, 20], [30, 40], [50, 60]]);
  const next = identical("n", [[10, 20], [30, 40], [50, 60]]);
  const { matches } = run(prev, next);
  assert.equal(matches[0]!.tier, "L4");
  assert.equal(
    matches[0]!.ambiguitySize,
    3,
    "第一條被接受時三個前像同分；沒有這個數字，UI 無法誠實說明選擇",
  );
});

// ── 純新增 hunk → 本檔新生 ─────────────────────────────────────────────────

/** 落在純新增 hunk 內的候選：新檔第 100-110 行由 `@@ -50,0 +100,20 @@` 涵蓋。 */
const PURE_ADD = { oldStart: 50, oldCount: 0, newStart: 100, newCount: 20 };

test("純新增 hunk 內的候選不與同檔前像配對", () => {
  seq = 0;
  const p = cand({ id: "p0", startLine: 10, endLine: 20 });
  const born = cand({ id: "n1", startLine: 100, endLine: 110 });
  const kept = cand({ id: "n0", startLine: 10, endLine: 20 });
  const { matches, bornInFile } = run([p], [kept, born], {
    hunksByLineage: new Map([[1, [PURE_ADD]]]),
  });

  assert.deepEqual(bornInFile, ["n1"]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.next, "n0", "新生的那個不得接走唯一的前像");
});

test("數量保險：純新增候選數與 next-prev 差額不符時整個放棄", () => {
  seq = 0;
  // 兩個前像、兩個後像（差額 0），但其中一個後像落在純新增 hunk 內。
  // 代表宣告被刪掉後在別處重新加入——硬排除會排掉不該排的。
  const prev = [
    cand({ id: "p0", startLine: 10, endLine: 20 }),
    cand({ id: "p1", startLine: 30, endLine: 40 }),
  ];
  const next = [
    cand({ id: "n0", startLine: 10, endLine: 20 }),
    cand({ id: "n1", startLine: 100, endLine: 110 }),
  ];
  const { bornInFile, ambiguities } = run(prev, next, {
    hunksByLineage: new Map([[1, [PURE_ADD]]]),
  });

  assert.deepEqual(bornInFile, [], "保險沒過就一個都不排除");
  assert.ok(
    ambiguities.some((a) => a.hash.startsWith("birth-count")),
    "退回原本行為，但必須留下紀錄而不是靜默",
  );
});

test("跨檔案搬移不受本檔新生判定影響", () => {
  seq = 0;
  // 函式從血緣 2 搬到血緣 1：它在血緣 1 必然整段落在純新增 hunk 內。
  // 若照「不得與任何 prev 配對」硬排除，L2 的搬移偵測會被直接消滅。
  const moved = hv({ hashRaw: "moved", hashToken: "moved", hashAlpha: "moved" });
  const source = cand({ id: "p-other", lineageId: 2, hashes: moved, path: "src/b.ts" });
  const landed = cand({ id: "n-moved", lineageId: 1, hashes: moved, startLine: 100, endLine: 110 });

  const { matches, bornInFile } = run([source], [landed], {
    hunksByLineage: new Map([[1, [PURE_ADD]]]),
  });

  assert.deepEqual(bornInFile, ["n-moved"], "它在這個檔案裡確實是新的");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.tier, "L2", "但跨檔案的雜湊相等仍是合法的搬移證據");
});

test("沒有 hunk 資料時不做任何 birth 判定", () => {
  seq = 0;
  const p = cand({ id: "p0", startLine: 10, endLine: 20 });
  const n = cand({ id: "n0", startLine: 100, endLine: 110 });
  // 缺鍵 = 合併／二進位，不是「沒有改動」。
  const { matches, bornInFile } = run([p], [n], { hunksByLineage: new Map() });
  assert.deepEqual(bornInFile, []);
  assert.equal(matches.length, 1, "沒有證據就維持原本行為");
});

test("修改 hunk 不會被當成純新增", () => {
  seq = 0;
  const p = cand({ id: "p0", startLine: 100, endLine: 110 });
  const n = cand({ id: "n0", startLine: 100, endLine: 110 });
  // old_count > 0：這是修改，不是新增。誤判成 birth 就是假斷層。
  const { bornInFile, matches } = run([p], [n], {
    hunksByLineage: new Map([[1, [{ oldStart: 100, oldCount: 20, newStart: 100, newCount: 20 }]]]),
  });
  assert.deepEqual(bornInFile, []);
  assert.equal(matches.length, 1);
});
