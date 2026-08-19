import type { DatabaseSync } from "node:sqlite";
import { attributable } from "./aggregate.ts";

/**
 * 意圖層的第一刀：把已驗證的證據升格成**分型的 claim**。**零 LLM。**
 *
 * 這一層看起來像是模型的地盤，其實不是。`v_presentable_claim` 在 schema 層就
 * 規定了：只收 `stated`／`linked`，而且必須有 `verified = 1` 的支持證據
 * （不變量 9）。所以**能上畫面的意圖層完全可以確定式地建出來**——
 * 型別來自抽取器命中的標記，文字是逐字引文。
 *
 * 模型日後能加的是 `inferred`，而那一層依定義永遠不進 `v_presentable_claim`。
 * 換句話說：抽掉 LLM 之後，意圖層剩下的不是空的，是全部。
 *
 * claim 與 evidence 的差別在於**主體**：evidence 掛在文件上（「這個 commit
 * 的訊息裡有這句話」），claim 掛在改動上（「這次改動的理由是這個」）。
 * 中間那一步——這句話是不是在講這個 entity——是既有的相關性判準，
 * 不在這裡另訂一套。
 */

/**
 * 標記 → claim 型別。**確定式，沒有門檻也沒有機率。**
 *
 * `instead of` 說的是「本來要用 A，改用 B」——那是被拒絕的替代方案，正是
 * 這個專案的題目，所以它自成一類而不是併進 `why`。`to avoid`／`否則` 說的是
 * 「不這樣做會怎樣」，那是約束不是理由。其餘歸 `why`。
 *
 * 沒有列在這裡的標記**不產出 claim**，不是預設歸 `why`——沉默比猜一個型別好。
 */
type RuleClaimType = "why" | "constraint" | "tradeoff" | "abandoned_reason";

const CLAIM_TYPE_BY_MARKER: Record<string, Exclude<RuleClaimType, "abandoned_reason">> = {
  "instead of": "tradeoff",
  "rather than": "tradeoff",
  "to avoid": "constraint",
  "to prevent": "constraint",
  "otherwise": "constraint",
  "避免": "constraint",
  "以免": "constraint",
  "否則": "constraint",
  "because": "why",
  "since": "why",
  "due to": "why",
  "in order to": "why",
  "so that": "why",
  "to ensure": "why",
  "the reason": "why",
  "reason:": "why",
  "why:": "why",
  "因為": "why",
  "由於": "why",
  "為了": "why",
  "理由：": "why",
  "理由:": "why",
  "原因：": "why",
  "原因:": "why",
};

/**
 * 升格規則的版本。**改了對照表或主體綁定就要提升**（不變量 7）。
 *
 * 版本一變，舊規則產生的 claim 必須作廢重建，否則這個模組的任何修正在用過的
 * 資料庫上都是靜默無效的——證據層與結構層都各踩過一次同型的坑。
 */
export const CLAIM_DERIVATION_VERSION = "rule-claim-0.4.0+excursion-entity-binding";
export const CLAIM_PASS_NAME = "claim";

/**
 * 從 `generator_version`（形如 `rule-rationale-0.4.0/causal:since`）取回標記。
 *
 * **`/result` 後綴必須吃掉。** 左邊界被往前拉過的 span 會寫成
 * `causal:instead of/result`，而原本錨在 `$` 的樣式對它整個失配——結果是
 * 標記變成 `undefined`、claim 被算成 `unmapped`，畫面靜默少一整類意圖。
 */
export function markerOf(generatorVersion: string | null): string | undefined {
  return /causal:([^/]+)(?:\/result)?$/.exec(generatorVersion ?? "")?.[1];
}

export interface ClaimReport {
  /** 掃過的候選（證據 × 相關改動）配對數。 */
  candidates: number;
  /** 實際寫入的 claim 列數。 */
  written: number;
  /** 標記不在對照表裡而略過的配對數。沉默地不產出，但要報出來。 */
  unmapped: number;
  /** 這次開始前清掉的規則式 claim 列數。 */
  discarded: number;
  /** 記錄的版本與目前不同——跨版本重建，不只是重算。 */
  rebuilt: boolean;
  /**
   * 因為來自聚合訊息而無法歸因到單一改動的部分。**證據沒有被刪**，
   * 壞掉的只是歸屬；抑制也不得靜默，所以要報出來。
   */
  unattributable: UnattributableSummary;
  /**
   * 移除 commit 動了不只一樣東西，因而無法支持 entity 級放棄宣稱的候選。
   * 證據仍在，一般的改動 claim 也仍在；被收回的只是「這個做法被放棄」那句話。
   */
  unboundExcursion: UnattributableSummary;
}

/**
 * 被聚合守門擋下的量。三個數字單位不同，**不可互換**：
 * 一條引文會扇出成多個候選（同一顆 commit 的每個相關改動、每段迂迴各一個）。
 */
export interface UnattributableSummary {
  /** 候選＝證據 × 主體的配對數。CLI 報這個，因為它對應「少寫了幾條 claim」。 */
  candidates: number;
  /** 相異引文數。畫面報這個，因為使用者看到的單位是「有幾句話」。 */
  quotes: number;
  /** 這些引文出自幾顆聚合 commit。 */
  commits: number;
}

interface Candidate {
  revisionChangeId: number | null;
  excursionId: number | null;
  evidenceId: number;
  text: string;
  tier: "stated" | "linked";
  marker: string | undefined;
  confidence: number;
  /** 這條候選所屬 commit 的完整訊息，用來判定是不是聚合。 */
  commitMessage: string;
  commitSha: string;
  /**
   * 引文在 commit 訊息裡的起點；`undefined` 代表證據不在訊息裡（`linked`）。
   */
  charStart: number | undefined;
  /**
   * 這顆 commit 總共移除了幾個 entity。只有迂迴主體的候選有值。
   *
   * **不是「幾段迂迴」而是「幾次死亡」**：commit 移除了 35 個東西、其中 3 個
   * 剛好被判為迂迴時，引文一樣指不到其中任何一個。
   */
  commitDeaths: number | undefined;
}

/**
 * `stated`：commit message 自己說的。
 *
 * 相關性判準是 `change_level <> 'none'`——**與 `suppressUnrelatedRationale`
 * 同一條規則**。各寫一份的話兩者遲早分岔，而分岔的後果是畫面上出現一條
 * 時間軸不承認的理由。
 */
const STATED_SQL = `
  SELECT rc.id AS revisionChangeId, NULL AS excursionId, e.id AS evidenceId,
         e.quoted_text AS text, e.tier AS tier,
         cand.generator_version AS gen, 1.0 AS confidence,
         d.body AS commitMessage, gc.sha AS commitSha, e.char_start AS charStart,
         NULL AS commitDeaths
    FROM evidence e
    JOIN source_doc d ON d.id = e.source_doc_id
    JOIN git_commit gc ON gc.repo_id = e.repo_id AND gc.sha = d.external_id
    JOIN revision_change rc ON rc.commit_id = gc.id
    LEFT JOIN evidence_candidate cand ON cand.promoted_evidence_id = e.id
   WHERE e.repo_id = ? AND e.tier = 'stated' AND e.verified = 1
     AND d.doc_type = 'commit_message'
     AND e.doc_body_sha = d.body_sha256
     AND rc.change_level <> 'none'
   ORDER BY rc.id, e.id`;

/**
 * `linked`：被這個 commit 參照的 PR／issue 討論串說的。
 *
 * `confidence` 直接繼承 `reference_link.confidence`，不另外發明一組數字：
 * 那條連結本身就是機率性的（`closes #N` 是 0.9，裸的 `#N` 是 0.4），而 claim
 * 的可信度不可能高於「這個 commit 真的跟那個討論串有關」。
 */
const LINKED_SQL = `
  SELECT rc.id AS revisionChangeId, NULL AS excursionId, e.id AS evidenceId,
         e.quoted_text AS text, e.tier AS tier,
         cand.generator_version AS gen, rl.confidence AS confidence,
         gc.message AS commitMessage, gc.sha AS commitSha, NULL AS charStart,
         NULL AS commitDeaths
    FROM evidence e
    JOIN source_doc d ON d.id = e.source_doc_id
    JOIN reference_link rl ON rl.repo_id = e.repo_id
                          AND rl.from_kind = 'commit'
                          AND d.provenance_root = rl.to_kind || ':' || rl.to_key
    JOIN git_commit gc ON gc.repo_id = e.repo_id AND gc.sha = rl.from_key
    JOIN revision_change rc ON rc.commit_id = gc.id
    LEFT JOIN evidence_candidate cand ON cand.promoted_evidence_id = e.id
   WHERE e.repo_id = ? AND e.tier = 'linked' AND e.verified = 1
     AND e.doc_body_sha = d.body_sha256
     AND rc.change_level <> 'none'
   ORDER BY rc.id, e.id`;

/**
 * 迂迴的放棄理由只取**移除 commit** 的證據，主體綁 `excursion_id`。
 *
 * 同一段文字仍會另外產生一般的改動 claim；那條說的是「這次改動為什麼發生」。
 * 這條說的是「這個曾經存在的做法為什麼被放棄」。兩者文字可以相同，主體不能
 * 混用——迂迴是跨越 introduce/remove 的整段歷史，不是一個 revision。
 *
 * `change_level = 'death'` 是既有 entity 相關性判準在這裡最窄的版本：只因為同一個
 * commit 有因果引文還不夠，該 commit 必須真的移除了這個 excursion 的 entity。
 */
const STATED_EXCURSION_SQL = `
  SELECT NULL AS revisionChangeId, x.id AS excursionId, e.id AS evidenceId,
         e.quoted_text AS text, e.tier AS tier,
         cand.generator_version AS gen, 1.0 AS confidence,
         d.body AS commitMessage, gc.sha AS commitSha, e.char_start AS charStart,
         (SELECT COUNT(*) FROM revision_change dth
           WHERE dth.commit_id = gc.id AND dth.change_level = 'death') AS commitDeaths
    FROM excursion x
    JOIN git_commit gc ON gc.id = x.remove_commit
    JOIN revision_change rc ON rc.commit_id = gc.id
                           AND rc.entity_id = x.entity_id
                           AND rc.change_level = 'death'
    JOIN source_doc d ON d.repo_id = x.repo_id
                     AND d.doc_type = 'commit_message'
                     AND d.external_id = gc.sha
    JOIN evidence e ON e.source_doc_id = d.id
    LEFT JOIN evidence_candidate cand ON cand.promoted_evidence_id = e.id
   WHERE x.repo_id = ? AND x.entity_id IS NOT NULL
     AND e.tier = 'stated' AND e.verified = 1
     AND e.doc_body_sha = d.body_sha256
   ORDER BY x.id, e.id`;

const LINKED_EXCURSION_SQL = `
  SELECT NULL AS revisionChangeId, x.id AS excursionId, e.id AS evidenceId,
         e.quoted_text AS text, e.tier AS tier,
         cand.generator_version AS gen, rl.confidence AS confidence,
         gc.message AS commitMessage, gc.sha AS commitSha, NULL AS charStart,
         (SELECT COUNT(*) FROM revision_change dth
           WHERE dth.commit_id = gc.id AND dth.change_level = 'death') AS commitDeaths
    FROM excursion x
    JOIN git_commit gc ON gc.id = x.remove_commit
    JOIN revision_change rc ON rc.commit_id = gc.id
                           AND rc.entity_id = x.entity_id
                           AND rc.change_level = 'death'
    JOIN reference_link rl ON rl.repo_id = x.repo_id
                          AND rl.from_kind = 'commit'
                          AND rl.from_key = gc.sha
    JOIN source_doc d ON d.repo_id = x.repo_id
                     AND d.provenance_root = rl.to_kind || ':' || rl.to_key
    JOIN evidence e ON e.source_doc_id = d.id
    LEFT JOIN evidence_candidate cand ON cand.promoted_evidence_id = e.id
   WHERE x.repo_id = ? AND x.entity_id IS NOT NULL
     AND e.tier = 'linked' AND e.verified = 1
     AND e.doc_body_sha = d.body_sha256
   ORDER BY x.id, e.id`;

function collect(db: DatabaseSync, sql: string, repoId: number): Candidate[] {
  return (db.prepare(sql).all(repoId) as unknown as Array<{
    revisionChangeId: number | null;
    excursionId: number | null;
    evidenceId: number;
    text: string;
    tier: "stated" | "linked";
    gen: string | null;
    confidence: number;
    commitMessage: string;
    commitSha: string;
    charStart: number | null;
    commitDeaths: number | null;
  }>).map((row) => ({
    revisionChangeId: row.revisionChangeId,
    excursionId: row.excursionId,
    evidenceId: row.evidenceId,
    text: row.text,
    tier: row.tier,
    marker: markerOf(row.gen),
    confidence: row.confidence,
    commitMessage: row.commitMessage,
    commitSha: row.commitSha,
    charStart: row.charStart ?? undefined,
    commitDeaths: row.commitDeaths ?? undefined,
  }));
}

/**
 * 這條引文能不能**支持到單一 entity 的**放棄宣稱。
 *
 * `abandoned_reason` 說的是「這個做法為什麼被放棄」，主體是一段迂迴、也就是
 * 一個 entity。但證據掛在 commit 上：一顆移除了 36 個宣告的 commit，它訊息裡
 * 那一句話指的是哪一個？**沒有任何結構資訊回答得了。**
 *
 * 實測 vuejs/core：104 條 `abandoned_reason` 只來自 18 條引文，其中 7 條被掛到
 * 多個 entity，最嚴重的一條掛到 36 個。`so that SourceLocation.source is no
 * longer needed` 掛在 35 個舊 parser 宣告上——那句話也許能解釋整批重構，但
 * **不足以逐一支持每個 entity 級的宣稱**。
 *
 * 所以判準是唯一性：**該 commit 只移除了一樣東西**，引文才指得到它。這與匹配
 * 階梯的雙端 bucket 唯一性是同一個原則——候選不只一個就不接受，而不是挑一個。
 *
 * 刻意**不**採用「引文裡有沒有提到該 entity 的名字」。量過：vuejs/core 只救回
 * 7 條，而其中 `plugin` 配到的是引文裡的外部套件連結、`retry`／`resolve` 同時
 * 撞到四個 suspense 方法。通用識別字與英文常用詞碰撞，**誤報比漏報嚴重**。
 * 真正的語意配對是另一件工程，不是這道守門該偷渡的東西。
 */
function boundToEntity(candidate: Candidate): boolean {
  if (candidate.excursionId === null) return true;
  return candidate.commitDeaths === 1;
}

/**
 * 四道查詢的聯集，就是「證據 × 主體」的全部候選。
 *
 * **抽成一個函式是為了讓分岔不可能發生。** 先前畫面另寫了一份自己的 SQL 去數
 * 無法歸因的引文，少了 `change_level <> 'none'` 這道前置過濾，於是 CLI 說 5 顆
 * 聚合 commit、標頭說 6 顆——第 6 顆的空白其實是相關性抑制造成的，跟 squash
 * 無關。同一個事實有兩份實作，遲早各說各話。
 */
function collectCandidates(db: DatabaseSync, repoId: number): Candidate[] {
  return [
    ...collect(db, STATED_SQL, repoId),
    ...collect(db, LINKED_SQL, repoId),
    ...collect(db, STATED_EXCURSION_SQL, repoId),
    ...collect(db, LINKED_EXCURSION_SQL, repoId),
  ];
}

function summarise(
  candidates: Candidate[],
  rejected: (c: Candidate) => boolean,
): UnattributableSummary {
  const commits = new Set<string>();
  const quotes = new Set<number>();
  let count = 0;
  for (const c of candidates) {
    if (!rejected(c)) continue;
    count++;
    quotes.add(c.evidenceId);
    commits.add(c.commitSha);
  }
  return { candidates: count, quotes: quotes.size, commits: commits.size };
}

const isAggregated = (c: Candidate) => !attributable(c.commitMessage, c.charStart);
/** 聚合守門先擋，所以這裡只算「過得了聚合、但綁不到 entity」的。 */
const isUnbound = (c: Candidate) => !isAggregated(c) && !boundToEntity(c);

/**
 * 給呈現層用：這個資料庫裡有多少引文因為聚合而進不了意圖層。
 *
 * 與 `deriveClaims` 走同一份候選，所以兩邊的數字必然一致。畫面不能自己數。
 */
export function unattributableEvidence(
  db: DatabaseSync,
  repoId: number,
): UnattributableSummary {
  return summarise(collectCandidates(db, repoId), isAggregated);
}

/**
 * 作廢規則式 claim。**只碰 `model IS NULL` 的列。**
 *
 * `model` 非 NULL 的是模型產生的，那一層有自己的版本與成本，不該被規則層的
 * 版本提升連帶清掉。`claim_evidence` 由 `ON DELETE CASCADE` 跟著走。
 */
function discardRuleClaims(db: DatabaseSync, repoId: number): number {
  return Number(db.prepare(
    "DELETE FROM claim WHERE repo_id = ? AND model IS NULL",
  ).run(repoId).changes);
}

function recordedVersion(db: DatabaseSync, repoId: number): string | undefined {
  return (db.prepare(
    "SELECT indexer_version AS v FROM pass_state WHERE repo_id = ? AND pass_name = ?",
  ).get(repoId, CLAIM_PASS_NAME) as { v: string } | undefined)?.v;
}

/**
 * 把證據升格成 claim。可重複呼叫；版本相同時是冪等的。
 *
 * **不是增量。** claim 的輸入是整個證據集合，而證據會因為重抽而整批換掉
 * （抽取器版本一升就作廢重建）。在這種輸入上做水位線只會製造一個
 * 「看起來是增量、其實漏掉一半」的介面。全量重算在 demo 語料是毫秒級。
 */
export function deriveClaims(db: DatabaseSync, repoId: number): ClaimReport {
  // **無條件清掉再重算**，不是只在版本變動時清。輸入（證據）會因為抽取器升版
  // 而整批換掉，所以「版本沒變」不代表產出還成立——殘留的 claim 會指向已經被
  // 重新裁定過的引文。`recordedVersion` 只用來回報這次是不是跨版本重建。
  const rebuilt = recordedVersion(db, repoId) !== CLAIM_DERIVATION_VERSION;
  const discarded = discardRuleClaims(db, repoId);

  const candidates = collectCandidates(db, repoId);

  const insertClaim = db.prepare(
    `INSERT INTO claim
       (repo_id, revision_change_id, excursion_id, claim_type, text, tier,
        confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLink = db.prepare(
    `INSERT INTO claim_evidence (claim_id, evidence_id, role)
     VALUES (?, ?, 'supports') ON CONFLICT DO NOTHING`,
  );
  const now = new Date().toISOString();

  let written = 0;
  let unmapped = 0;
  for (const c of candidates) {
    // 聚合訊息的歸屬先擋，再談型別：這條候選被丟掉的理由是「無法歸因」，
    // 不是「標記不認得」，兩個數字混在一起就看不出畫面為什麼是空的。
    if (!attributable(c.commitMessage, c.charStart)) continue;
    // 綁不到單一 entity 的迂迴不產出宣稱。**留白，不是猜一個。**
    if (!boundToEntity(c)) continue;
    const mappedType = c.marker === undefined
      ? undefined
      : CLAIM_TYPE_BY_MARKER[c.marker];
    if (mappedType === undefined) {
      unmapped++;
      continue;
    }
    const claimType: RuleClaimType = c.excursionId === null
      ? mappedType
      : "abandoned_reason";
    const info = insertClaim.run(
      repoId,
      c.revisionChangeId,
      c.excursionId,
      claimType,
      c.text,
      c.tier,
      c.confidence,
      now,
    );
    // 支持關係要在同一輪寫進去：沒有它這條 claim 就進不了
    // `v_presentable_claim`，等於寫了一條永遠看不見的列。
    insertLink.run(Number(info.lastInsertRowid), c.evidenceId);
    written++;
  }

  db.prepare(
    `INSERT INTO pass_state (repo_id, pass_name, last_commit_id, indexer_version, updated_at)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT (repo_id, pass_name) DO UPDATE SET
       indexer_version = excluded.indexer_version,
       updated_at = excluded.updated_at`,
  ).run(repoId, CLAIM_PASS_NAME, CLAIM_DERIVATION_VERSION, now);

  return {
    candidates: candidates.length,
    written,
    unmapped,
    discarded,
    rebuilt,
    unattributable: summarise(candidates, isAggregated),
    unboundExcursion: summarise(candidates, isUnbound),
  };
}

/**
 * 抑制不能靜默：使用者看到空白時必須分得出「沒人寫理由」與「有人寫了但
 * 這段歷史已經無法歸因」。
 */
export function aggregateSuppressionNotice(
  report: ClaimReport,
): string | undefined {
  const { candidates, quotes, commits } = report.unattributable;
  if (candidates === 0) return undefined;
  return `注意：${quotes} 條引文（${candidates} 個候選）來自 ${commits} 顆聚合 `
    + `commit（squash 合併了多個 PR），因無法歸因到單一改動而未升格成意圖。`
    + `證據本身仍保留。`;
}

/**
 * 同理：綁不到單一 entity 的放棄理由被收回時要說出來，否則畫面上少掉的那一
 * 整類意圖會被讀成「這個 repo 沒有被推翻的做法」。
 */
export function unboundExcursionNotice(
  report: ClaimReport,
): string | undefined {
  const { candidates, quotes, commits } = report.unboundExcursion;
  if (candidates === 0) return undefined;
  return `注意：${quotes} 條引文（${candidates} 個候選）出自 ${commits} 顆一次移除`
    + `多樣東西的 commit，無法逐一支持 entity 級的放棄理由，因此未升格。`
    + `證據與一般改動的意圖都仍保留。`;
}

export interface PresentableClaim {
  claimType: string;
  text: string;
  tier: string;
  confidence: number;
  /** 這條 claim 的主體所屬的 entity。 */
  entityId: number;
  excursionId: number | null;
  sha: string;
}

/**
 * 讀取可呈現的 claim。**一律走 `v_presentable_claim`。**
 *
 * 直接查 `claim` 表會把 `inferred` 一起撈出來，而那正是不變量 9 禁止的事。
 * 這個函式的存在就是為了讓呼叫端沒有理由自己寫查詢。
 */
export function presentableClaimsFor(
  db: DatabaseSync,
  repoId: number,
  entityId: number,
): PresentableClaim[] {
  return db.prepare(
    `SELECT cl.claim_type AS claimType, cl.text AS text, cl.tier AS tier,
            cl.confidence AS confidence,
            COALESCE(rc.entity_id, x.entity_id) AS entityId,
            cl.excursion_id AS excursionId, gc.sha AS sha
       FROM v_presentable_claim cl
       LEFT JOIN revision_change rc ON rc.id = cl.revision_change_id
       LEFT JOIN excursion x ON x.id = cl.excursion_id
       JOIN git_commit gc ON gc.id = COALESCE(rc.commit_id, x.remove_commit)
      WHERE cl.repo_id = ? AND COALESCE(rc.entity_id, x.entity_id) = ?
      ORDER BY gc.topo_order, cl.claim_type, cl.id`,
  ).all(repoId, entityId) as unknown as PresentableClaim[];
}
