import { createHash } from "node:crypto";

/**
 * n-gram 簽章與相似度。
 *
 * 分工是明確的：**MinHash 只做召回，不做判定。**
 * L4/L5 接受一個匹配之前必須拿到精確 Jaccard，schema 層以 CHECK 強制
 * （accepted 且 tier 為 L4/L5 時 exact_verified 必須為 1）。
 */

/** 依 ngram_count 決定簽章形式。門檻進 indexer_version，不寫死在 schema CHECK。 */
export const EXACT_NGRAM_LIMIT = 200;
export const MINHASH_PERMUTATIONS = 128;
/**
 * 這一族 MinHash 的身分：**種子與算術兩者都算數**，因為兩者都決定產出的值。
 *
 * `mh-1.0.0` → `mh-2.0.0`：種子沒變，但 `(a*x+b) mod p` 先前直接以 double 相乘，
 * 乘積達 2^62 而 `Number.MAX_SAFE_INTEGER` 只有 2^53，高位被靜默捨去。
 * 以實際係數實測 **96.7% 的呼叫得到錯誤的值**——結果仍是決定性的（所以正確性沒破，
 * L4/L5 一律要精確 Jaccard 驗證才接受），但那個雜湊族的碰撞性質是任意的，
 * 不是理論值。修正後的值與舊值不可互相比較，故必須換版本。
 */
export const MINHASH_SEED_VERSION = "mh-2.0.0";
export const NGRAM_SIZE = 3;

/** 這個值變動就必須重算所有簽章，因此併入 indexer_version */
export const SIGNATURE_VERSION =
  `ngram${NGRAM_SIZE}/exact<=${EXACT_NGRAM_LIMIT}/minhash${MINHASH_PERMUTATIONS}/${MINHASH_SEED_VERSION}`;

const MERSENNE_31 = 2147483647; // 2^31 - 1，質數

/** 由固定種子推導的置換係數。種子版本進簽章，換了就不可互相比較。 */
const COEFFS = (() => {
  const a: number[] = [];
  const b: number[] = [];
  let state = 0x9e3779b9;
  const next = () => {
    // xorshift32，只需要決定性，不需要密碼學品質
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state % MERSENNE_31;
  };
  for (let i = 0; i < MINHASH_PERMUTATIONS; i++) {
    a.push((next() % (MERSENNE_31 - 1)) + 1); // 不可為 0
    b.push(next());
  }
  return { a, b };
})();

function hash32(s: string): number {
  return createHash("sha1").update(s, "utf8").digest().readUInt32BE(0) % MERSENNE_31;
}

/**
 * 從 token 序列產生去重後的 n-gram 雜湊集合。
 *
 * 用去重後的 ngram_count 而非 token_count 決定簽章形式——n-gram 才是
 * 相似度真正操作的單位，用 token 數換算會在重複度高的程式碼上失準。
 */
export function ngramSet(
  tokens: Array<{ type: string; text: string }>,
  n = NGRAM_SIZE,
): Set<number> {
  const out = new Set<number>();
  if (tokens.length === 0) return out;
  const parts = tokens.map((t) => `${t.type}\u001f${t.text}`);
  if (parts.length < n) {
    out.add(hash32(parts.join("\u001e")));
    return out;
  }
  for (let i = 0; i + n <= parts.length; i++) {
    out.add(hash32(parts.slice(i, i + n).join("\u001e")));
  }
  return out;
}

const TWO_31 = 2147483648;

/**
 * `v mod (2^31 - 1)` 的部分規約。回傳的值與 `v` 同餘，但**未必小於 p**
 * （上界是 p + 2^17，呼叫端負責最後一次條件減法）。
 *
 * 靠的是 Mersenne 質數的性質：`2^31 ≡ 1 (mod 2^31 - 1)`，所以把 `v` 拆成
 * `hi·2^31 + lo` 之後 `v ≡ hi + lo`。除以 2^31 只是調整指數，在 IEEE-754 下
 * **完全精確、不產生捨入**，所以整段沒有精度風險。
 *
 * 用它取代 `%` 是效能決定：double 的 `%` 走 fmod，實測比這三行慢一個數量級。
 */
const reduce31 = (v: number): number => {
  const hi = Math.floor(v / TWO_31);
  return v - hi * TWO_31 + hi;
};

/**
 * `(a * x + b) mod (2^31 - 1)`，全程停留在 IEEE-754 的安全整數範圍內。
 *
 * **為什麼不能直接寫 `(a * x + b) % p`**：`a` 與 `x` 都可接近 2^31，乘積達 2^62，
 * 而 `Number.MAX_SAFE_INTEGER` 是 2^53——高位被靜默捨去，以實際係數實測
 * 96.7% 的呼叫因此得到錯誤的值（128 個係數的 `a` 最小值就有 3.0e7）。
 *
 * 作法是把 `x` 拆成高低 16 位，讓每一次乘法都遠低於 2^53：
 *   `a·xh < 2^31·2^15 = 2^46`；規約後 `t·65536 < 2^47`；`a·xl < 2^47`。
 * 每一步之後做一次 `reduce31`，最後一次條件減法把結果收進 `[0, p)`——
 * 最終值上界是 `p + 2^17`，遠小於 `2p`，所以減一次就夠。
 *
 * **不用 BigInt**：這是 CPU profile 上最大的單一項目，BigInt 會讓它慢一個數量級。
 */
function modMulAddSplit(a: number, xh: number, xl: number, b: number): number {
  let t = reduce31(a * xh);
  t = reduce31(t * 65536);
  t = reduce31(t + a * xl + b);
  return t >= MERSENNE_31 ? t - MERSENNE_31 : t;
}

export function modMulAdd(a: number, x: number, b: number): number {
  return modMulAddSplit(a, x >>> 16, x & 0xffff, b);
}

export function minhash(set: Set<number>): Int32Array {
  const sig = new Int32Array(MINHASH_PERMUTATIONS).fill(MERSENNE_31);
  const { a, b } = COEFFS;
  for (const x of set) {
    // **拆分提到內迴圈外面。** 它只跟 x 有關，留在裡面會對同一個 x 重算 128 次。
    const xh = x >>> 16;
    const xl = x & 0xffff;
    for (let i = 0; i < MINHASH_PERMUTATIONS; i++) {
      const v = modMulAddSplit(a[i]!, xh, xl, b[i]!);
      if (v < sig[i]!) sig[i] = v;
    }
  }
  return sig;
}

/**
 * 簽章與 n-gram 集合的一體快取。
 *
 * 由呼叫端給一個「相同鍵 ⇒ 相同 token 序列」的鍵（實務上是 `hashToken`）。
 * 命中時**同時**省下 `ngramSet` 與 MinHash 兩段計算——這兩件事都是 token 序列
 * 的純函式，所以鍵相同就必定結果相同，不是近似而是恆等。
 *
 * **回傳的 `ngrams` 與 `signature.exact` 是共用物件，呼叫端不得修改。**
 * 目前所有消費端（`exactJaccard`、`recallSimilarity`、序列化）都只讀。
 * 一旦有人就地修改，所有共用同一個 `hashToken` 的宣告會一起壞掉，
 * 而且不會有任何錯誤訊息。
 *
 * 快取只重用既有計算結果：permutation 數、係數、序列化位元與
 * `SIGNATURE_VERSION` 全部不變，所以**不影響任何持久化資料的相容性**。
 */
export interface SignatureBundle {
  signature: Signature;
  /** 精確驗證用的完整 n-gram 集合。唯讀。 */
  ngrams: Set<number>;
}

/** 相異鍵的數量級：Osiris 全歷史 2920 次觀察只有 561 個相異 hashToken。 */
export const SIGNATURE_CACHE_LIMIT = 2048;

export interface SignatureCache {
  get(
    key: string,
    tokens: Array<{ type: string; text: string }>,
  ): SignatureBundle;
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
}

export function createSignatureCache(limit = SIGNATURE_CACHE_LIMIT): SignatureCache {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`簽章快取上限必須是正整數，收到 ${limit}`);
  }
  // 用 Map 的插入順序當 LRU：命中時重新 set 會移到尾端，超量丟最舊的。
  const cache = new Map<string, SignatureBundle>();
  let hits = 0;
  let misses = 0;
  return {
    get(key, tokens) {
      const hit = cache.get(key);
      if (hit !== undefined) {
        cache.delete(key);
        cache.set(key, hit);
        hits++;
        return hit;
      }
      const ngrams = ngramSet(tokens);
      const bundle: SignatureBundle = { signature: signatureFromSet(ngrams), ngrams };
      cache.set(key, bundle);
      while (cache.size > limit) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
      }
      misses++;
      return bundle;
    },
    get hits() { return hits; },
    get misses() { return misses; },
    get size() { return cache.size; },
  };
}

export function exactJaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function estimateJaccard(a: Int32Array, b: Int32Array): number {
  let same = 0;
  for (let i = 0; i < MINHASH_PERMUTATIONS; i++) if (a[i] === b[i]) same++;
  return same / MINHASH_PERMUTATIONS;
}

export interface Signature {
  ngramCount: number;
  /** ngramCount <= EXACT_NGRAM_LIMIT 時保存完整集合 */
  exact?: Set<number>;
  /** 超過門檻時保存 128-permutation MinHash */
  minhash?: Int32Array;
}

export function buildSignature(tokens: Array<{ type: string; text: string }>): Signature {
  return signatureFromSet(ngramSet(tokens));
}

/**
 * 由已算好的 n-gram 集合建簽章。
 *
 * 呼叫端往往兩者都要（簽章給召回用、完整集合給精確驗證用），而 `buildSignature`
 * 內部本來就會算一次集合。分開這個入口讓 n-gram 只算一次——實測全 repo 索引
 * 因此省下約 0.5 秒與一份重複的 Set。
 */
export function signatureFromSet(set: Set<number>): Signature {
  if (set.size <= EXACT_NGRAM_LIMIT) return { ngramCount: set.size, exact: set };
  return { ngramCount: set.size, minhash: minhash(set) };
}

/**
 * 召回用的相似度估計。**不可直接用來接受匹配。**
 *
 * 三種組合都要能處理。其中「一端有完整集合、另一端只有 MinHash」值得特別說明：
 * 完整集合可以現場推導出 MinHash（MinHash 本來就是從集合算的），
 * 所以混合比較永遠可行，不需要為此在資料庫裡同時存兩份。
 */
export function recallSimilarity(a: Signature, b: Signature): number {
  if (a.exact && b.exact) return exactJaccard(a.exact, b.exact);
  const sa = a.minhash ?? minhash(a.exact!);
  const sb = b.minhash ?? minhash(b.exact!);
  return estimateJaccard(sa, sb);
}
