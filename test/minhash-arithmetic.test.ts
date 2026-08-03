import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSignature,
  EXACT_NGRAM_LIMIT,
  minhash,
  MINHASH_PERMUTATIONS,
  MINHASH_SEED_VERSION,
  modMulAdd,
  ngramSet,
} from "../src/match/signature.ts";

/**
 * MinHash 的模乘算術。
 *
 * 這一族雜湊只做召回——L4/L5 接受任何配對之前一定會做精確 Jaccard 驗證，
 * 所以算錯**不會**產生錯誤的配對。但它會讓碰撞性質變成任意的：召回階段可能
 * 漏掉真正相似的候選，而漏掉的東西不會有任何錯誤訊息。
 */

const MERSENNE_31 = 2147483647;

/** 參考實作：BigInt 沒有精度上限，用它當真值。 */
const reference = (a: number, x: number, b: number): number =>
  Number((BigInt(a) * BigInt(x) + BigInt(b)) % BigInt(MERSENNE_31));

/** 修正前的寫法。保留在測試裡，用來證明修正真的改變了結果。 */
const naive = (a: number, x: number, b: number): number =>
  (a * x + b) % MERSENNE_31;

describe("MinHash 的模乘算術", () => {
  it("**全值域隨機比對 BigInt 參考實作，一次都不得不同**", () => {
    // 決定性不等於正確。修正前的結果同樣是決定性的，只是算錯。
    // **RNG 本身必須全位元運算。** 第一版用 LCG（`seed * 1103515245`），
    // 那個乘法自己就超過 2^53，產生的樣本嚴重偏小，量出來的錯誤率
    // 只有 13.7%——測試的亂數源踩了它要測的同一個坑。
    let seed = 0x2545f491;
    const rnd = () => {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed % MERSENNE_31;
    };
    let naiveWrong = 0;
    const rounds = 50_000;
    for (let t = 0; t < rounds; t++) {
      const a = (rnd() % (MERSENNE_31 - 1)) + 1;
      const x = rnd();
      const b = rnd();
      const truth = reference(a, x, b);
      assert.equal(modMulAdd(a, x, b), truth, `a=${a} x=${x} b=${b}`);
      if (naive(a, x, b) !== truth) naiveWrong++;
    }
    // 測試前提：舊寫法在這個值域上大量出錯。若哪天它不再出錯，
    // 代表值域或係數推導變了，這條測試就該重新檢視而不是繼續空轉。
    assert.ok(
      naiveWrong / rounds > 0.9,
      `舊寫法只錯了 ${naiveWrong}/${rounds}，測試前提可能已失效`,
    );
  });

  it("每一格的輸出都落在 [0, p) 內", () => {
    const row = [...minhash(new Set([12345, 67890, MERSENNE_31 - 2]))];
    assert.equal(row.length, MINHASH_PERMUTATIONS);
    for (const v of row) {
      assert.ok(Number.isInteger(v) && v >= 0 && v < MERSENNE_31, `越界：${v}`);
    }
  });

  it("邊界值窮舉：每一組都必須等於 BigInt 真值", () => {
    // 隨機測試容易漏掉 0、2^16 交界與 p-1 這些邊界。
    const edges = [0, 1, 2, 32767, 32768, 65535, 65536, 65537,
      2 ** 30, 2 ** 30 + 1, MERSENNE_31 - 2, MERSENNE_31 - 1];
    let n = 0;
    for (const a of edges) {
      if (a === 0) continue; // 係數 a 依定義不可為 0
      for (const x of edges) {
        for (const b of edges) {
          assert.equal(modMulAdd(a, x, b), reference(a, x, b), `a=${a} x=${x} b=${b}`);
          n++;
        }
      }
    }
    assert.ok(n > 1500, `邊界組合太少：${n}`);
  });

  it("邊界值：a 與 x 都接近 2^31 時 naive 會錯，修正後不會", () => {
    // 這是缺陷的核心：兩個接近 2^31 的數相乘是 2^62，
    // 而 Number.MAX_SAFE_INTEGER 只有 2^53。
    const cases: Array<[number, number, number]> = [
      [MERSENNE_31 - 1, MERSENNE_31 - 1, 0],
      [MERSENNE_31 - 1, MERSENNE_31 - 1, MERSENNE_31 - 1],
      [2147483646, 2147483646, 12345],
      [1073741827, 2147483645, 999],
    ];
    let naiveWrong = 0;
    for (const [a, x, b] of cases) {
      const truth = reference(a, x, b);
      if (naive(a, x, b) !== truth) naiveWrong++;
      assert.equal(modMulAdd(a, x, b), truth, `a=${a} x=${x} b=${b}`);
    }
    assert.equal(naiveWrong, cases.length, "測試前提：這些案例 naive 全都算錯");
  });

  it("最壞情況的中間值都遠低於 2^53，且最後只需一次條件減法", () => {
    // 註解宣稱 a·xh < 2^46、t·65536 < 2^47、最終值上界 p + 2^17 < 2p。
    // 宣稱要有測試守住，否則將來有人改係數上限或位元切分就會靜默壞掉。
    const TWO_31 = 2147483648;
    const reduce31 = (v: number) => {
      const hi = Math.floor(v / TWO_31);
      return v - hi * TWO_31 + hi;
    };
    const a = MERSENNE_31 - 1;
    const x = MERSENNE_31 - 1;
    const xh = x >>> 16;
    const xl = x & 0xffff;

    const s1 = a * xh;
    assert.ok(s1 < 2 ** 46, `a·xh 應 < 2^46，實際 ${s1}`);
    const s2 = reduce31(s1) * 65536;
    assert.ok(s2 < 2 ** 47, `t·65536 應 < 2^47，實際 ${s2}`);
    const s3 = reduce31(s2) + a * xl + (MERSENNE_31 - 1);
    assert.ok(s3 < Number.MAX_SAFE_INTEGER, `最終加總溢位：${s3}`);
    const s4 = reduce31(s3);
    assert.ok(
      s4 < 2 * MERSENNE_31,
      `規約後應 < 2p 才能只減一次，實際 ${s4}`,
    );
  });

  it("除以 2^31 必須是精確的——整段的精度保證都建立在這件事上", () => {
    // 2^31 是 2 的冪，IEEE-754 的除法只調整指數，不產生捨入。
    // 這條若不成立，reduce31 的每一次規約都會靜默偏移。
    const TWO_31 = 2147483648;
    for (const v of [0, 1, TWO_31 - 1, TWO_31, TWO_31 + 1, 2 ** 46, 2 ** 47, 2 ** 52 - 1]) {
      const hi = Math.floor(v / TWO_31);
      const lo = v - hi * TWO_31;
      assert.equal(hi * TWO_31 + lo, v, `拆分不可逆：v=${v}`);
      assert.ok(lo >= 0 && lo < TWO_31, `低位越界：${lo}`);
    }
  });

  it("**版本字串必須跟著算術一起換**，舊值與新值不可互相比較", () => {
    // 不變量 7：任何改變產出的變更都要提升對應的 *_version。
    assert.equal(MINHASH_SEED_VERSION, "mh-2.0.0");
  });

  it("實際簽章路徑仍是決定性的，且只在超過門檻時走 MinHash", () => {
    const many = Array.from(
      { length: EXACT_NGRAM_LIMIT + 400 },
      (_, i) => ({ type: "identifier", text: `sym_${i}` }),
    );
    const first = buildSignature(many);
    const second = buildSignature(many);
    assert.ok(first.minhash && !first.exact, "測試前提：這組必須走 MinHash");
    assert.deepEqual([...first.minhash!], [...second.minhash!]);
    assert.deepEqual([...minhash(ngramSet(many))], [...first.minhash!]);
  });
});
