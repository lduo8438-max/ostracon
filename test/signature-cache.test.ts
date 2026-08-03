import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSignature,
  createSignatureCache,
  EXACT_NGRAM_LIMIT,
  ngramSet,
  signatureFromSet,
} from "../src/match/signature.ts";

const tokens = (seed: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ type: "identifier", text: `${seed}_${i}` }));

/** 超過 EXACT_NGRAM_LIMIT 才會走 MinHash 路徑，那是這個快取要省的東西。 */
const bigTokens = (seed: string) => tokens(seed, EXACT_NGRAM_LIMIT + 400);

describe("createSignatureCache", () => {
  it("命中與未命中產生**逐位元相同**的 MinHash", () => {
    // 快取只重用既有計算結果。只要有一個位元不同，所有已持久化的簽章
    // 就與新算的不可比較，而那不會有任何錯誤訊息。
    const cache = createSignatureCache();
    const t = bigTokens("a");
    const fresh = signatureFromSet(ngramSet(t));
    const first = cache.get("k", t);
    const second = cache.get("k", t);

    assert.ok(fresh.minhash, "測試前提：這組 token 必須走 MinHash 路徑");
    assert.deepEqual([...first.signature.minhash!], [...fresh.minhash!]);
    assert.deepEqual([...second.signature.minhash!], [...fresh.minhash!]);
    assert.equal(cache.hits, 1);
    assert.equal(cache.misses, 1);
  });

  it("小宣告走精確集合路徑時也一致", () => {
    const cache = createSignatureCache();
    const t = tokens("s", 20);
    const fresh = buildSignature(t);
    const got = cache.get("k", t);
    assert.ok(fresh.exact);
    assert.deepEqual([...got.signature.exact!].sort(), [...fresh.exact!].sort());
    assert.equal(got.signature.ngramCount, fresh.ngramCount);
  });

  it("相同鍵回傳**同一個物件**——共用是刻意的，呼叫端必須唯讀", () => {
    const cache = createSignatureCache();
    const t = bigTokens("a");
    const first = cache.get("k", t);
    const second = cache.get("k", t);
    assert.equal(first, second, "共用才是省記憶體的來源");
    assert.equal(first.ngrams, second.ngrams);
  });

  it("不同鍵不得互相污染", () => {
    // 鍵的契約是「相同鍵 ⇒ 相同 token 序列」。這條測試守住實作沒有把
    // 不同內容的結果混在一起——那會讓相似度全面錯亂而且看不出來。
    const cache = createSignatureCache();
    const a = cache.get("a", bigTokens("alpha"));
    const b = cache.get("b", bigTokens("beta"));
    assert.notDeepEqual([...a.signature.minhash!], [...b.signature.minhash!]);
    assert.notEqual(a.ngrams, b.ngrams);
  });

  it("超過上限時逐出最舊的，且逐出後重算的結果仍相同", () => {
    const cache = createSignatureCache(2);
    const ta = bigTokens("a");
    const expected = [...cache.get("a", ta).signature.minhash!];

    cache.get("b", bigTokens("b"));
    cache.get("c", bigTokens("c")); // 逐出 a
    assert.equal(cache.size, 2);

    const missesBefore = cache.misses;
    const again = cache.get("a", ta);
    assert.equal(cache.misses, missesBefore + 1, "a 應該已被逐出");
    assert.deepEqual([...again.signature.minhash!], expected, "重算結果必須完全相同");
  });

  it("命中會把項目移到最新，不會被誤逐", () => {
    const cache = createSignatureCache(2);
    cache.get("a", bigTokens("a"));
    cache.get("b", bigTokens("b"));
    cache.get("a", bigTokens("a")); // a 變成最新
    cache.get("c", bigTokens("c")); // 應逐出 b 而不是 a

    const missesBefore = cache.misses;
    cache.get("a", bigTokens("a"));
    assert.equal(cache.misses, missesBefore, "a 仍在快取中");
  });

  it("上限必須是正整數", () => {
    assert.throws(() => createSignatureCache(0));
    assert.throws(() => createSignatureCache(1.5));
  });
});
