import type { HashVector } from "../ast/types.ts";
import type { DiffHunk } from "../git/types.ts";
import { insidePureAddHunk, reconstructOldRange } from "./position.ts";
import { recallSimilarity, type Signature } from "./signature.ts";

export type Tier = "L1" | "L2" | "L3" | "L3b" | "L3c" | "L4" | "L5";

export interface Candidate {
  /** 呼叫端的識別碼，原樣帶回 */
  id: string;
  /** 路徑血緣。同一條代表「同一個檔案」，即使路徑改過 */
  lineageId: number;
  /** 限定名稱，例如 RequestDispatcher.handle */
  qualifiedName: string;
  /** 同名多載的區分子 */
  disambiguator?: string;
  /** 宣告種類，function_declaration / method_definition 等 */
  kind: string;
  hashes: HashVector;
  signature: Signature;
  /** 決定性排序用的次要鍵 */
  path: string;
  startIndex: number;
  /**
   * 1-based 起訖行號。L3c 的位置回推用它，不能從 `startIndex` 導出——
   * 那是 UTF-16 位移，換算需要原始碼，而這一層刻意不吃原始碼。
   */
  startLine: number;
  endLine: number;
}

export interface Match {
  prev: string;
  next: string;
  tier: Tier;
  /** 僅 L4/L5 有值 */
  exactJaccard?: number;
  exactVerified: boolean;
  /**
   * 接受這條匹配時，有幾個同等好的候選可選。1 = 唯一。
   *
   * 現在就算，因為事後補要重跑全部匹配；沒有它，UI 無法誠實地說
   * 「這裡有四個等價候選，我選了一個」。
   *
   * - L1–L3b 恆為 1：那幾層的前提就是雙端 bucket 唯一，不唯一時根本不會接受。
   * - **L3c 是內容等價類的大小，不是 1。** 走到 L3c 恰恰是因為內容 bucket 不唯一，
   *   唯一的是位置；填 1 等於宣稱「只有一個候選」。
   * - L4/L5 是接受當下同分且仍可用的前像數。
   */
  ambiguitySize: number;
}

export interface LadderOptions {
  /** 同檔案的相似度門檻 */
  sameFileThreshold?: number;
  /** 跨檔案的相似度門檻，應高於同檔 */
  crossFileThreshold?: number;
  /** shape 與 L3b 的碰撞閘門 */
  minNodeCount?: number;
  /**
   * 每條血緣在這個 commit 的 diff hunk，供 L3c 回推位置。
   *
   * **缺鍵代表「沒有 hunk 證據」**（合併、二進位、純 mode 變更），此時完全不套用
   * 位置約束；不得與「空陣列＝取了但沒有改動」混同。整個選項省略時 L3c 不啟用，
   * 階梯行為與加入這一層之前完全相同。
   */
  hunksByLineage?: ReadonlyMap<number, readonly DiffHunk[]>;
  /**
   * 精確驗證。MinHash 只做召回，接受前必須由呼叫端回頭算精確 Jaccard
   * （必要時重讀原始碼），這是 schema CHECK 要求 exact_verified 的實際內容。
   */
  verify: (prev: Candidate, next: Candidate) => number;
}

export interface LadderResult {
  matches: Match[];
  /** 因為 bucket 不唯一而放棄的層級，供調參時觀察 */
  ambiguities: Array<{
    tier: Tier;
    hash: string;
    prevCount: number;
    nextCount: number;
    /** 保留 bucket 成員，讓審計層能判斷後續 L4 是否源自這次歧義。 */
    prevIds: string[];
    nextIds: string[];
  }>;
  /**
   * 由純新增 hunk 判定為「在這個檔案裡是新生的」候選 id。
   *
   * 它們**仍可能**經由 L2/L3/L5 與別的檔案的前像配對——見 `matchLadder` 中
   * 對這條界線的說明。沒有配對的才是真正的 birth，判定由呼叫端做。
   */
  bornInFile: string[];
}

/** 決定性排序：同樣的輸入必須產生同樣的輸出，不受呼叫端給的順序影響 */
const order = (a: Candidate, b: Candidate) =>
  a.qualifiedName.localeCompare(b.qualifiedName) ||
  a.path.localeCompare(b.path) ||
  a.startIndex - b.startIndex ||
  a.id.localeCompare(b.id);

function bucketBy(list: Candidate[], key: (c: Candidate) => string | undefined) {
  const m = new Map<string, Candidate[]>();
  for (const c of list) {
    const k = key(c);
    if (k === undefined) continue;
    const arr = m.get(k);
    if (arr) arr.push(c);
    else m.set(k, [c]);
  }
  return m;
}

/**
 * 匹配階梯。純函式：吃兩批宣告，吐匹配。不碰資料庫、不碰 git。
 *
 * 由強到弱貪婪套用，每接受一個匹配就把兩端從候選池移除。
 *
 * 貪婪而非最佳二分指派是刻意的。匈牙利演算法在單一 commit 的候選規模下
 * 收益極小，卻讓結果難以解釋——而「為什麼系統認為這兩個是同一個」
 * 必須能對使用者說清楚，那是這個產品的信譽基礎。
 */
export function matchLadder(
  prevAll: Candidate[],
  nextAll: Candidate[],
  opts: LadderOptions,
): LadderResult {
  const sameFile = opts.sameFileThreshold ?? 0.5;
  const crossFile = opts.crossFileThreshold ?? 0.7;
  const minNodes = opts.minNodeCount ?? 25;

  const prev = [...prevAll].sort(order);
  const next = [...nextAll].sort(order);
  const usedPrev = new Set<string>();
  const usedNext = new Set<string>();
  const matches: Match[] = [];
  const ambiguities: LadderResult["ambiguities"] = [];

  const live = (list: Candidate[], used: Set<string>) => list.filter((c) => !used.has(c.id));
  const accept = (
    p: Candidate,
    n: Candidate,
    tier: Tier,
    jaccard?: number,
    ambiguitySize = 1,
  ) => {
    usedPrev.add(p.id);
    usedNext.add(n.id);
    matches.push({
      prev: p.id,
      next: n.id,
      tier,
      exactJaccard: jaccard,
      // L1–L3c 是雜湊相等、同槽位或位置錨定，沒有「相似度」這回事。
      // 硬填 exact_verified 會讓那個欄位失去意義——日後看紀錄
      // 無法分辨「驗證過」與「不需驗證」。
      exactVerified: jaccard !== undefined,
      ambiguitySize,
    });
  };

  // ── 前置：純新增 hunk 判定「在這個檔案裡是新生的」────────────────────────
  //
  // 候選完全落在 old_count = 0 的 hunk 內，代表這幾行在前像根本不存在。
  //
  // **界線：這只能排除同檔案的延續，不能排除跨檔案的搬移。**
  // 計畫原本寫「不得與任何 prev 配對」，那是錯的：函式從 A 檔搬到 B 檔時，
  // 它在 B 檔必然整段落在純新增 hunk 內，硬排除會直接消滅 L5 的搬移／抽取偵測，
  // 而那是 architecture.md §3 明列的能力。git 說的是「這幾行對這個檔案是新的」，
  // 不是「這段程式碼對這個 repo 是新的」——證據只能用到它實際涵蓋的範圍。
  //
  // **數量保險**：只有當「該檔案落在純新增 hunk 的候選數」恰好等於「next 比 prev
  // 多出來的候選數」時才採信。不相等代表 hunk 與宣告邊界對不上（例如一個宣告被
  // 刪除後在別處重新加入，或一個 hunk 橫跨兩個宣告），這時硬排除會排掉不該排的。
  // 誤報 birth ＝ 假斷層，是最不能犯的錯，所以寧可退回原本行為並記一筆 ambiguity。
  const bornNext = new Set<string>();
  if (opts.hunksByLineage) {
    const lineages = new Set(next.map((c) => c.lineageId));
    for (const lineageId of lineages) {
      const hunks = opts.hunksByLineage.get(lineageId);
      if (hunks === undefined) continue; // 沒有 hunk 證據就是沒有
      const nextOf = next.filter((c) => c.lineageId === lineageId);
      const prevOf = prev.filter((c) => c.lineageId === lineageId);
      const born = nextOf.filter((c) => insidePureAddHunk(c.startLine, c.endLine, hunks));
      if (born.length === 0) continue;
      const surplus = nextOf.length - prevOf.length;
      if (born.length !== surplus) {
        ambiguities.push({
          tier: "L1",
          hash: `birth-count\0${lineageId}`,
          prevCount: prevOf.length,
          nextCount: nextOf.length,
          prevIds: prevOf.map((c) => c.id),
          nextIds: born.map((c) => c.id),
        });
        continue;
      }
      for (const c of born) bornNext.add(c.id);
    }
  }
  /** 這個 next 是本檔新生的，所以不得再與**同一個檔案**的前像配對。 */
  const sameFileBirth = (p: Candidate, n: Candidate) =>
    bornNext.has(n.id) && p.lineageId === n.lineageId;

  // ── L1：同槽位（同血緣 + 同限定名稱 + 同區分子）────────────────────────
  //
  // 血緣是路徑的，不是路徑本身，所以「檔案被改名但內容沒動」仍然落在 L1。
  // Candidate 是尚未持久化的批次輸入，不能拿 schema UNIQUE 當作這裡已唯一。
  // 前後 bucket 都恰好一個才接受；否則留下 ambiguity 並往下掉。
  const slotKey = (c: Candidate) => `${c.lineageId}\0${c.qualifiedName}\0${c.disambiguator ?? ""}`;
  {
    const pb = bucketBy(live(prev, usedPrev), slotKey);
    const nb = bucketBy(live(next, usedNext), slotKey);
    for (const [key, ps] of pb) {
      const ns = nb.get(key);
      if (!ns) continue;
      if (ps.length !== 1 || ns.length !== 1) {
        ambiguities.push({
          tier: "L1",
          hash: key,
          prevCount: ps.length,
          nextCount: ns.length,
          prevIds: ps.map((candidate) => candidate.id),
          nextIds: ns.map((candidate) => candidate.id),
        });
        continue;
      }
      if (sameFileBirth(ps[0]!, ns[0]!)) continue;
      accept(ps[0]!, ns[0]!, "L1");
    }
  }

  // ── L2 / L3：雜湊相等，可跨檔案（改名、搬移的主力）────────────────────
  //
  // bucket 不是 1:1 時一律放棄本層、往下掉。
  // 理由：完全相同的宣告（例如五個一模一樣的 getter）任意配對雖然內容無誤，
  // 但會讓 entity 身份在每次重建索引時漂移，而 stable_key 必須可重現。
  // 掉到 L4/L5 反而更安全——那兩層有精確驗證，Jaccard 會是 1.0 照樣接得起來。
  const hashTiers: Array<{ tier: Tier; key: (c: Candidate) => string }> = [
    { tier: "L2", key: (c) => `raw\0${c.hashes.hashRaw}` },
    {
      tier: "L2",
      key: (c) => `tok\0${c.hashes.shapeProfile}\0${c.hashes.hashToken}`,
    },
    {
      tier: "L3",
      key: (c) => `alpha\0${c.hashes.shapeProfile}\0${c.hashes.hashAlpha}`,
    },
  ];
  for (const { tier, key } of hashTiers) {
    const pb = bucketBy(live(prev, usedPrev), key);
    const nb = bucketBy(live(next, usedNext), key);
    for (const [k, ps] of pb) {
      const ns = nb.get(k);
      if (!ns) continue;
      if (ps.length !== 1 || ns.length !== 1) {
        ambiguities.push({
          tier,
          hash: k,
          prevCount: ps.length,
          nextCount: ns.length,
          prevIds: ps.map((candidate) => candidate.id),
          nextIds: ns.map((candidate) => candidate.id),
        });
        continue;
      }
      const [p] = ps as [Candidate];
      const [n] = ns as [Candidate];
      if (usedPrev.has(p.id) || usedNext.has(n.id)) continue;
      // 同檔新生就跳過；跨檔案的雜湊相等仍是合法的搬移證據。
      if (sameFileBirth(p, n)) continue;
      accept(p, n, tier);
    }
  }

  // ── L3b：hash_alpha_self 相等（純改名）────────────────────────────────
  //
  // 這是階梯上最新也最容易過度觸發的一層，所以前置條件全部是硬性的：
  //   同檔案（同血緣）、同 shape_profile、同 kind、
  //   兩端 node_count >= 閘門、前後 bucket 皆為唯一 1:1。
  // 任何一項不滿足就直接放棄，退到 L4 由精確驗證處理。
  {
    const eligible = (c: Candidate) =>
      c.hashes.nodeCount >= minNodes ? c : undefined;
    const key = (c: Candidate) =>
      eligible(c)
        ? `${c.lineageId}\0${c.hashes.shapeProfile}\0${c.kind}\0${c.hashes.hashAlphaSelf}`
        : undefined;
    const pb = bucketBy(live(prev, usedPrev), key);
    const nb = bucketBy(live(next, usedNext), key);
    for (const [k, ps] of pb) {
      const ns = nb.get(k);
      if (!ns) continue;
      if (ps.length !== 1 || ns.length !== 1) {
        ambiguities.push({
          tier: "L3b",
          hash: k,
          prevCount: ps.length,
          nextCount: ns.length,
          prevIds: ps.map((candidate) => candidate.id),
          nextIds: ns.map((candidate) => candidate.id),
        });
        continue;
      }
      const [p] = ps as [Candidate];
      const [n] = ns as [Candidate];
      if (usedPrev.has(p.id) || usedNext.has(n.id)) continue;
      if (sameFileBirth(p, n)) continue;
      accept(p, n, "L3b");
    }
  }

  // ── L3c：位置錨定（同血緣 + hash_raw 相等 + 未變更行的位置回推唯一命中）──
  //
  // 這一層存在的理由與其他層不同：它解的不是「找不到配對」，而是「找得到但
  // 說不出理由」。實測 Osiris 全歷史，51 條 L4/Jaccard=1 的內容歧義配對中有 50 條
  // 可由位置回推唯一決定，且與貪婪匹配現在選的完全一致——也就是說原本就對，
  // 但那個「對」依賴 order() 以 startIndex 排序的巧合，任何擾動排序的改動都會
  // 讓 stable_key 靜默漂移。把它升級成明確的位置證據，正確性才有東西撐著。
  //
  // 判準全部是硬性的、且全部是精確的（沒有任何門檻或近似）：
  //   同血緣、hash_raw 相等、宣告完全未被 hunk 碰到、回推範圍精確命中、雙端唯一。
  // 任一項不滿足就直接放棄，退到 L4 由相似度處理。
  {
    const hunksByLineage = opts.hunksByLineage;
    if (hunksByLineage) {
      const prevById = new Map(prev.map((c) => [c.id, c]));
      const nextById = new Map(next.map((c) => [c.id, c]));
      const chosen = new Map<string, string>();      // nextId → prevId
      const claimants = new Map<string, string[]>(); // prevId → nextId[]

      // 內容等價類的大小：同血緣、hash_raw 相同的前像有幾個。
      //
      // **L3c 的 ambiguity_size 不能填 1。** 其他層填 1 是因為 bucket 本來就唯一；
      // 但走到 L3c 恰恰是因為內容 bucket **不**唯一——唯一的是位置。填 1 等於宣稱
      // 「這裡只有一個候選」，而事實是「有 n 個內容一樣的候選，位置挑了一個」。
      // 那正是 UI 必須誠實說出來的話，也是 ctrl-position-ambiguous 要抓的過度宣稱。
      //
      // 在 L3c 開始前算好，讓同一個等價類裡的每一條都回報相同的數字。
      const contentClassSize = new Map<string, number>();
      for (const p of live(prev, usedPrev)) {
        const key = `${p.lineageId}\0${p.hashes.hashRaw}`;
        contentClassSize.set(key, (contentClassSize.get(key) ?? 0) + 1);
      }

      for (const n of live(next, usedNext)) {
        const hunks = hunksByLineage.get(n.lineageId);
        // 沒有 hunk 證據就是沒有，不是「沒有改動」。
        if (hunks === undefined) continue;
        const old = reconstructOldRange(n.startLine, n.endLine, hunks);
        if (old === null) continue; // 被改過：位置不構成證據
        const hits = live(prev, usedPrev).filter((p) =>
          p.lineageId === n.lineageId
          && p.startLine === old.startLine
          && p.endLine === old.endLine
          && p.hashes.hashRaw === n.hashes.hashRaw);
        if (hits.length !== 1) {
          if (hits.length > 1) {
            ambiguities.push({
              tier: "L3c",
              hash: `pos\0${n.lineageId}\0${old.startLine}-${old.endLine}`,
              prevCount: hits.length,
              nextCount: 1,
              prevIds: hits.map((c) => c.id),
              nextIds: [n.id],
            });
          }
          continue;
        }
        const p = hits[0]!;
        chosen.set(n.id, p.id);
        claimants.set(p.id, [...(claimants.get(p.id) ?? []), n.id]);
      }

      // 雙端唯一性檢查。位置回推理論上是單射（不同的新側範圍位移相同時仍相異），
      // 但不變量要求每一層都實際檢查，不靠「理論上」。
      for (const [nextId, prevId] of chosen) {
        const others = claimants.get(prevId) ?? [];
        if (others.length !== 1) {
          ambiguities.push({
            tier: "L3c",
            hash: `pos-claim\0${prevId}`,
            prevCount: 1,
            nextCount: others.length,
            prevIds: [prevId],
            nextIds: others,
          });
          continue;
        }
        const p = prevById.get(prevId)!;
        const n = nextById.get(nextId)!;
        if (usedPrev.has(p.id) || usedNext.has(n.id)) continue;
        if (sameFileBirth(p, n)) continue;
        accept(
          p, n, "L3c", undefined,
          contentClassSize.get(`${p.lineageId}\0${p.hashes.hashRaw}`) ?? 1,
        );
      }
    }
  }

  // ── L4 / L5：相似度。MinHash 召回，精確驗證判定 ───────────────────────
  for (const [tier, threshold, sameLineage] of [
    ["L4", sameFile, true],
    ["L5", crossFile, false],
  ] as Array<[Tier, number, boolean]>) {
    const pairs: Array<{ p: Candidate; n: Candidate; score: number }> = [];
    for (const p of live(prev, usedPrev)) {
      for (const n of live(next, usedNext)) {
        if (sameLineage !== (p.lineageId === n.lineageId)) continue;
        if (recallSimilarity(p.signature, n.signature) < threshold * 0.8) continue; // 召回放寬
        pairs.push({ p, n, score: 0 });
      }
    }
    // 先算精確 Jaccard，再依分數由高到低貪婪接受。
    for (const pair of pairs) pair.score = opts.verify(pair.p, pair.n);
    pairs.sort(
      (x, y) => y.score - x.score || order(x.p, y.p) || order(x.n, y.n),
    );
    for (const { p, n, score } of pairs) {
      if (score < threshold) continue;
      if (usedPrev.has(p.id) || usedNext.has(n.id)) continue;
      if (sameFileBirth(p, n)) continue;
      // 有幾個「同樣好」的前像可以選：分數完全相等且此刻仍未被佔用的候選數。
      // 這正是內容資訊用盡的程度，必須在接受的當下算——事後補要重跑全部匹配。
      const equallyGood = pairs.filter((other) =>
        other.n.id === n.id
        && other.score === score
        && !usedPrev.has(other.p.id)).length;
      accept(p, n, tier, score, equallyGood);
    }
  }

  matches.sort((a, b) => a.prev.localeCompare(b.prev) || a.next.localeCompare(b.next));
  return { matches, ambiguities, bornInFile: [...bornNext].sort() };
}
