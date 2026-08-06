import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { utf8ByteRange } from "../ast/adapter.ts";
import { changeLevel, hashDeclaration, tokenStream } from "../ast/hash.ts";
import { grammarForPath, parseSource } from "../ast/parser.ts";
import type { HashVector, LanguageProfile, SynNode } from "../ast/types.ts";
import type { DiffHunk } from "../git/types.ts";
import { matchLadder, type Candidate } from "../match/ladder.ts";
import {
  exactJaccard,
  MINHASH_PERMUTATIONS,
  MINHASH_SEED_VERSION,
  NGRAM_SIZE,
  createSignatureCache,
  type SignatureCache,
  SIGNATURE_VERSION,
  type Signature,
} from "../match/signature.ts";

/**
 * 全歷史校準：Osiris 的真置換 fetchQuote=0.092，受控 compute 補位=0.242，
 * 假置換 fetchEndpoint=1.0。取 0.25 涵蓋兩個已裁決真例，並刻意只有 matcher
 * 同檔延續門檻 0.5 的一半；0.25–0.5 的灰區寧可漏報。
 */
export const OCCUPANT_REPLACEMENT_MAX_SIMILARITY = 0.25;
/** 門檻或 D→A 判定規則變更時必須提升，避免新舊斷層產出混在同一個 pass。 */
export const DISCONTINUITY_VERSION = "discontinuity-1.0.0+jaccard0.25";

/**
 * 結構層（pass 1 的解析與匹配部分）。**零 LLM**——這個檔案裡不得出現任何模型呼叫。
 *
 * 這一層先前只存在於 golden materializer 裡，形狀綁在 fixture 錨點上。抽出來的
 * 理由不是「整潔」，而是 `why` CLI 需要同一套寫入語意：如果兩邊各寫一份，
 * 黃金測試集驗證的就不是產品實際跑的程式碼。
 */

export interface ObservedDeclaration {
  commit: string;
  path: string;
  symbol: string;
  occurrence: number;
  source: string;
  node: SynNode;
  kind: string;
  profile: LanguageProfile;
  hashes: HashVector;
  signature: Signature;
  exactNgrams: Set<number>;
  /** 該版本檔案的 git blob id。本地算，見 `blobShaOf`。 */
  blobSha: string;
}

export const git = (repo: string, args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

/** `git show` 的內容是雜湊輸入，不能像 metadata 一樣 trim。 */
export function trySourceBytes(repo: string, spec: string): Buffer | undefined {
  try {
    return execFileSync("git", ["-C", repo, "show", spec], {
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
}

export function trySource(repo: string, spec: string): string | undefined {
  return trySourceBytes(repo, spec)?.toString("utf8");
}

export const CATFILE_BATCH_SIZE = 200;

/**
 * 以 `git cat-file --batch` 一次讀取多個版本的 blob。
 *
 * 輸出必須按位元組解析：header 的 size 是 byte 數，若先把整段輸出轉成字串，
 * 非 ASCII 內容會讓下一筆 header 的起點錯位。missing 記錄只有 header，
 * 沒有內容後的額外換行。
 */
export function readBlobsBatch(
  repo: string,
  specs: string[],
  batchSize = CATFILE_BATCH_SIZE,
): Map<string, Buffer> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error(`cat-file 批次大小必須是正整數，收到 ${batchSize}`);
  }

  const blobs = new Map<string, Buffer>();
  for (let offset = 0; offset < specs.length; offset += batchSize) {
    const batch = specs.slice(offset, offset + batchSize);
    const out = execFileSync("git", ["-C", repo, "cat-file", "--batch"], {
      input: `${batch.join("\n")}\n`,
      maxBuffer: 1 << 28,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let cursor = 0;

    for (const spec of batch) {
      const newline = out.indexOf(0x0a, cursor);
      if (newline < 0) {
        throw new Error(`cat-file 回應提早結束：${spec}`);
      }
      const header = out.subarray(cursor, newline).toString("utf8");
      cursor = newline + 1;

      if (header.endsWith(" missing")) {
        if (header !== `${spec} missing`) {
          throw new Error(`cat-file missing 回應錯位：預期 ${spec}，收到 ${header}`);
        }
        continue;
      }

      const [oid, type, sizeText, ...extra] = header.split(" ");
      const size = Number(sizeText);
      if (
        !oid
        || type !== "blob"
        || extra.length > 0
        || !Number.isSafeInteger(size)
        || size < 0
      ) {
        throw new Error(`無法解析 cat-file header：${header}`);
      }
      const end = cursor + size;
      if (end >= out.length || out[end] !== 0x0a) {
        throw new Error(`cat-file 內容長度錯誤：${spec}`);
      }

      // 複製切片，避免快取一個小檔案時連帶保留整批輸出的 backing buffer。
      const bytes = Buffer.from(out.subarray(cursor, end));
      if (blobShaOf(bytes) !== oid) {
        throw new Error(`cat-file blob oid 自我檢查失敗：${spec}`);
      }
      blobs.set(spec, bytes);
      cursor = end + 1;
    }

    if (cursor !== out.length) {
      throw new Error(`cat-file 回應含有未解析的尾端資料：${out.length - cursor} bytes`);
    }
  }
  return blobs;
}

/**
 * git blob id：`sha1("blob {位元組長度}\0" + 內容)`。
 *
 * 本地算而不是問 `git rev-parse`：先前每寫一筆 revision 就 spawn 一次 git，
 * Osiris 一趟全 repo 索引就是 1579 次程序啟動，佔了大半的時間。
 * 對原始位元組取雜湊，所以沒有任何編碼往返的風險。
 */
export function blobShaOf(bytes: Buffer): string {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}

export function parentOf(repo: string, sha: string): string | undefined {
  return git(repo, ["rev-list", "--parents", "-n", "1", sha]).split(" ")[1];
}

/**
 * 解析某個 commit 的某個檔案，產出全部宣告的觀察值。
 *
 * `occurrence` 依宣告在檔案中出現的順序編號。相同的原始碼必定產生相同的順序，
 * 所以它可以當作「這個版本裡的第幾個同名宣告」的穩定座標——但**只在版本內部穩定**，
 * 跨版本不可當身份用。
 */
export async function observeFile(
  repo: string,
  commit: string,
  pathName: string,
  signatures: SignatureCache = createSignatureCache(),
): Promise<ObservedDeclaration[]> {
  const bytes = trySourceBytes(repo, `${commit}:${pathName}`);
  if (bytes === undefined) return [];
  return observeBytes(commit, pathName, bytes, signatures);
}

async function observeBytes(
  commit: string,
  pathName: string,
  bytes: Buffer,
  signatures: SignatureCache,
): Promise<ObservedDeclaration[]> {
  const grammar = grammarForPath(pathName);
  if (!grammar) return [];
  const source = bytes.toString("utf8");
  const blobSha = blobShaOf(bytes);
  const parsed = await parseSource(source, grammar);
  const occurrences = new Map<string, number>();
  return parsed.declarations.map((declaration) => {
    const occurrence = occurrences.get(declaration.qualifiedName) ?? 0;
    occurrences.set(declaration.qualifiedName, occurrence + 1);
    const tokens = tokenStream(declaration.node, parsed.profile);
    const hashes = hashDeclaration(declaration.node, source, parsed.profile);
    // 以 hashToken 當鍵重用簽章與 n-gram 集合。
    //
    // 這個鍵是恆等而非近似：`hashToken` 雜湊的是 `type\u001f text` 的 token 序列，
    // 而 `ngramSet` 消費的是同一個序列化——鍵相同就必定是同一組 token，
    // 因此 n-gram 集合與 MinHash 必定相同。實測 Osiris 全歷史 2920 次宣告觀察
    // 只有 561 個相異 hashToken，命中率 80.8%。
    const bundle = signatures.get(hashes.hashToken, tokens);
    return {
      commit,
      path: pathName,
      symbol: declaration.qualifiedName,
      occurrence,
      source,
      node: declaration.node,
      kind: declaration.kind,
      profile: parsed.profile,
      hashes,
      signature: bundle.signature,
      // 共用物件，唯讀。就地修改會讓所有同 hashToken 的宣告一起壞掉。
      exactNgrams: bundle.ngrams,
      blobSha,
    };
  });
}

/**
 * 依 commit + path 快取解析結果，**容量有上限**。
 *
 * 沒有上限的話，一次全 repo 索引會把整段歷史的每個版本的 AST 都留在記憶體裡：
 * `ObservedDeclaration` 帶著整份原始碼與節點子樹，Osiris（99 commit）實測就吃掉
 * 750 MB。而實際存取樣式是局部的——處理 commit C 時只需要 C 與它的父，
 * 走訪又是拓撲序，所以最近用過的少量項目就能吃到幾乎全部的命中。
 *
 * 用 Map 的插入順序當 LRU：重新 set 會把 key 移到尾端，超量就丟最舊的。
 */
export const OBSERVER_CACHE_LIMIT = 64;

export function createObserver(repo: string, limit = OBSERVER_CACHE_LIMIT): {
  observe: (commit: string, pathName: string) => Promise<ObservedDeclaration[]>;
  prefetch: (pairs: Array<[commit: string, pathName: string]>) => void;
} {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`observer 快取上限必須是正整數，收到 ${limit}`);
  }
  const cache = new Map<string, Promise<ObservedDeclaration[]>>();
  // 整趟索引共用一個簽章快取。跨檔案、跨 commit 的重複宣告都吃得到，
  // 而不是每個檔案各自重算。
  const signatures = createSignatureCache();
  const cacheKey = (commit: string, pathName: string) => `${commit}\0${pathName}`;
  const trim = (effectiveLimit: number) => {
    while (cache.size > effectiveLimit) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  };

  const observe = (
    commit: string,
    pathName: string,
  ): Promise<ObservedDeclaration[]> => {
    const key = cacheKey(commit, pathName);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const pending = observeFile(repo, commit, pathName, signatures);
    cache.set(key, pending);
    trim(limit);
    return pending;
  };

  const prefetch = (pairs: Array<[commit: string, pathName: string]>) => {
    const requested = new Map<string, [commit: string, pathName: string]>();
    for (const pair of pairs) requested.set(cacheKey(pair[0], pair[1]), pair);

    const missing = new Map<string, [commit: string, pathName: string]>();
    for (const [key, pair] of requested) {
      if (!cache.has(key)) missing.set(key, pair);
    }
    if (missing.size === 0) return;

    const specs = [...missing.values()].map(([commit, pathName]) => `${commit}:${pathName}`);
    const blobs = readBlobsBatch(repo, specs);
    for (const [key, [commit, pathName]] of missing) {
      const bytes = blobs.get(`${commit}:${pathName}`);
      cache.set(
        key,
        bytes === undefined
          ? Promise.resolve([])
          : observeBytes(commit, pathName, bytes, signatures),
      );
    }

    // 大 commit 的前後版本必須同時留到本輪 observe；上限仍由最大單批大小約束，
    // 不會退回把整段歷史永久留在記憶體的無界快取。
    trim(Math.max(limit, requested.size * 2));
  };

  return { observe, prefetch };
}

/**
 * 宣告的 1-based 起訖行號。`revision` 的 line_start/line_end 與 `Candidate` 的
 * 位置證據共用同一個算法——兩處若各算各的，L3c 的回推就會與資料庫記的行號對不上。
 */
export function lineRange(
  observed: ObservedDeclaration,
): { startLine: number; endLine: number } {
  const startLine = observed.source.slice(0, observed.node.startIndex).split("\n").length;
  return { startLine, endLine: startLine + observed.node.text.split("\n").length - 1 };
}

export const stableKey = (
  birthSha: string,
  pathName: string,
  symbol: string,
  disambiguator: string,
): string =>
  createHash("sha256")
    .update(`${birthSha}\0${pathName}\0${symbol}\0${disambiguator}`, "utf8")
    .digest("hex");

/**
 * 每個資料庫連線的 prepared statement 快取。
 *
 * 這些寫入函式先前每次呼叫都 `db.prepare()` 一次：Osiris 一趟全 repo 索引就是
 * 約一萬次編譯同樣的幾條 SQL。SQL 文字是常數，編譯結果可以重用。
 *
 * 用 WeakMap 掛在連線上而不是模組層 Map：連線關掉之後 statement 必須跟著被回收，
 * 否則長期執行的行程會抓著已關閉資料庫的 statement 不放。
 */
type Prepared = ReturnType<DatabaseSync["prepare"]>;
const statementCache = new WeakMap<DatabaseSync, Map<string, Prepared>>();

function prep(db: DatabaseSync, sql: string): Prepared {
  let byText = statementCache.get(db);
  if (byText === undefined) {
    byText = new Map();
    statementCache.set(db, byText);
  }
  let statement = byText.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    byText.set(sql, statement);
  }
  return statement;
}

/**
 * 把一批寫入包進單一 transaction。
 *
 * 沒有明確 transaction 時 SQLite 每一句都是自己的隱含 transaction，
 * 每次都要走一遍 commit 流程。批次的邊界取在**單一 commit**：
 * 整趟包成一個的話，一萬個 commit 的 WAL 會膨脹到不可接受，
 * 而且中途失敗會把所有已完成的工作一起丟掉。
 *
 * 失敗時 ROLLBACK 並往上拋。水位線只在整趟結束時才前進，所以重跑會把
 * 這個 commit 重做一次——所有寫入都是 ON CONFLICT 冪等的。
 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function commitId(db: DatabaseSync, sha: string): number {
  const row = db.prepare("SELECT id FROM git_commit WHERE sha = ?").get(sha) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`資料庫找不到 commit ${sha}`);
  return row.id;
}

/**
 * 這個路徑在 `sha` 之前**曾經**屬於哪些血緣，最近的排前面。
 *
 * `lineageIdAt` 問的是「此刻誰擁有這個路徑」，檔案已經被刪除時它必然回傳
 * undefined——而**迂迴的定義就是已經消失**，所以 111 條迂迴裡有 91 條（82%）
 * 在終點無法定址。這個函式是給「那個檔案以前在這裡」用的。
 *
 * **回傳全部而不是挑一條。** 路徑被刪除後又重建（D→A，已有斷層機制）時會有多條
 * 血緣曾經擁有它，靜默挑「最近的一條」會讓更早的那段歷史整個消失——而
 * 「讓使用者忽略真實歷史」正是誤報斷層那一級的錯。呼叫端負責全部呈現並說明，
 * 與 `entitiesFor` 面對同名多實體時的處理一致。
 *
 * **不是 `lineageIdAt` 的替代品。** 後者的語意（此刻誰擁有）是結構層與 golden
 * materializer 依賴的東西，不得更動；這裡只在前者失敗時當 fallback。
 */
export function lineagesEverAt(
  db: DatabaseSync,
  sha: string,
  pathName: string,
): number[] {
  return (db.prepare(
    `SELECT s.lineage_id AS id, MAX(from_c.topo_order) AS lastSeen
       FROM path_lineage_segment s
       JOIN git_commit from_c ON from_c.id = s.from_commit_id
       JOIN git_commit target ON target.sha = ? AND target.repo_id = from_c.repo_id
      WHERE s.path = ?
        AND from_c.topo_order <= target.topo_order
      GROUP BY s.lineage_id
      ORDER BY lastSeen DESC, s.lineage_id`,
  ).all(sha, pathName) as unknown as Array<{ id: number }>).map((row) => row.id);
}

export function lineageIdAt(
  db: DatabaseSync,
  sha: string,
  pathName: string,
): number | undefined {
  const direct = db.prepare(
    `SELECT fc.lineage_id AS id
       FROM file_change fc
       JOIN git_commit gc ON gc.id = fc.commit_id
      WHERE gc.sha = ? AND fc.path = ?`,
  ).get(sha, pathName) as { id: number } | undefined;
  if (direct) return direct.id;

  const row = db.prepare(
    `SELECT s.lineage_id AS id
       FROM path_lineage_segment s
       JOIN git_commit from_c ON from_c.id = s.from_commit_id
       LEFT JOIN git_commit to_c ON to_c.id = s.to_commit_id
       JOIN git_commit target ON target.sha = ? AND target.repo_id = from_c.repo_id
      WHERE s.path = ?
        AND from_c.topo_order <= target.topo_order
        AND (to_c.id IS NULL OR target.topo_order < to_c.topo_order)
      ORDER BY from_c.topo_order DESC
      LIMIT 1`,
  ).get(sha, pathName) as { id: number } | undefined;
  return row?.id;
}

/** 讀回某個 commit／路徑的 hunk。零列代表沒有 hunk 證據，不是沒有改動。 */
export function hunksFor(db: DatabaseSync, sha: string, pathName: string): DiffHunk[] {
  return db.prepare(
    `SELECT h.old_start AS oldStart, h.old_count AS oldCount,
            h.new_start AS newStart, h.new_count AS newCount
       FROM file_hunk h
       JOIN file_change f ON f.id = h.file_change_id
       JOIN git_commit c ON c.id = f.commit_id
      WHERE c.sha = ? AND f.path = ?
      ORDER BY h.hunk_index`,
  ).all(sha, pathName) as unknown as DiffHunk[];
}

export function isParentOf(
  db: DatabaseSync,
  parentSha: string,
  childSha: string,
): boolean {
  const row = db.prepare(
    `SELECT 1 AS ok FROM git_commit_parent p
       JOIN git_commit child  ON child.id  = p.child_id
       JOIN git_commit parent ON parent.id = p.parent_id
      WHERE child.sha = ? AND parent.sha = ?`,
  ).get(childSha, parentSha) as { ok: number } | undefined;
  return row !== undefined;
}

export function ensureSlot(
  db: DatabaseSync,
  repoId: number,
  lineageId: number,
  symbol: string,
  kind: string,
  disambiguator: string,
): number {
  prep(db, 
    `INSERT INTO slot
       (repo_id, lineage_id, qualified_name, disambiguator, kind)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, lineage_id, qualified_name, disambiguator)
     DO UPDATE SET kind = excluded.kind`,
  ).run(repoId, lineageId, symbol, disambiguator, kind);
  return (prep(db, 
    `SELECT id FROM slot
      WHERE repo_id = ? AND lineage_id = ?
        AND qualified_name = ? AND disambiguator = ?`,
  ).get(repoId, lineageId, symbol, disambiguator) as { id: number }).id;
}

export interface RecreatedPathPredecessor {
  lineageId: number;
  deletedAt: string;
  /** 刪除 commit 的第一父；這才是舊檔最後仍可讀到內容的版本。 */
  finalCommit?: string;
}

/**
 * 找同一路徑最近一次明確的 D → A，而不是把所有關閉 segment 都當成重現。
 *
 * segment 也會因 rename 關閉；若只看 `to_commit_id IS NOT NULL`，A→B 後又新增 A
 * 會被誤報成「檔案死過」。因此必須回到 `file_change.change_type = 'D'` 取得硬證據。
 */
export function recreatedPathPredecessor(
  db: DatabaseSync,
  repoId: number,
  currentLineageId: number,
  pathName: string,
  atSha: string,
): RecreatedPathPredecessor | undefined {
  const row = prep(db,
    `SELECT seg.lineage_id AS lineageId, deleted.sha AS deletedAt,
            parent.sha AS finalCommit
       FROM path_lineage_segment seg
       JOIN path_lineage old_lineage ON old_lineage.id = seg.lineage_id
       JOIN git_commit deleted ON deleted.id = seg.to_commit_id
       JOIN git_commit target ON target.repo_id = old_lineage.repo_id AND target.sha = ?
       JOIN file_change fc ON fc.commit_id = deleted.id
                          AND fc.lineage_id = seg.lineage_id
                          AND fc.path = seg.path
                          AND fc.change_type = 'D'
       LEFT JOIN git_commit_parent edge ON edge.child_id = deleted.id AND edge.ordinal = 0
       LEFT JOIN git_commit parent ON parent.id = edge.parent_id
      WHERE old_lineage.repo_id = ?
        AND seg.lineage_id <> ?
        AND seg.path = ?
        AND deleted.topo_order < target.topo_order
      ORDER BY deleted.topo_order DESC
      LIMIT 1`,
  ).get(atSha, repoId, currentLineageId, pathName) as
    | { lineageId: number; deletedAt: string; finalCommit: string | null }
    | undefined;
  return row
    ? {
      lineageId: row.lineageId,
      deletedAt: row.deletedAt,
      ...(row.finalCommit === null ? {} : { finalCommit: row.finalCommit }),
    }
    : undefined;
}

/** 同一 slot 在目標 commit 之前最後一位佔用者。 */
/**
 * 某個已觀察到的宣告在資料庫裡已經屬於哪個 entity。
 *
 * **這是增量續跑的必要條件。** 全 repo pass 用一張記憶體 Map（`entityAt`）把
 * 「前像的座標 → entity」帶到下一個 commit，但那張 Map 每次呼叫都重建。
 * 續跑時 matcher 仍然接得到前像（它重新從 git 觀察父 commit，不受水位線影響），
 * 但 Map 是空的——於是「匹配到了卻找不到 entity」被誤判成誕生，**開了一個新
 * entity**，把血緣從水位線處切斷。
 *
 * 實測 create-t3-app：先索引到中繼點再續 100 個 commit，會多出 **169 個 entity**
 * （574 對 405），而且全部誕生在水位線的 topo_order 之後。`matches` 與 tier 分佈
 * 完全正常，所以除了 entity 數以外沒有任何指標看得出來。
 *
 * 使用者看到的是水位線處一次假的「誕生」，外加一句「這個檔案的歷史上有 2 個不同
 * 的實體（slot 延續但內容血緣斷開）」——憑空報告一個不存在的斷層。
 * 而 `why` 本身就是增量的，所以這是預設路徑而不是邊緣情境。
 *
 * **唯讀，不建立 slot。** 查不到就是真的沒有前像記錄，那時開新 entity 才是對的。
 *
 * **查的是「早於 `atSha` 的最後一筆」，不是「剛好落在前像那個 commit」。**
 * `revision` 只在檔案被觸及時才寫入，所以前像宣告最後一次被記錄的 commit
 * 通常比父 commit 更早——第一版用 `c.sha = observed.commit` 查，169 個多餘
 * entity 一個都沒少。這與 `previousSlotEntity` 是同一個道理，差別只在這裡
 * 是拿前像自己的 slot 座標去找，而不是拿後像的。
 *
 * **entity 與 revision 必須一起回傳。** 兩張記憶體 Map（`entityAt` / `revisionAt`）
 * 在續跑時同時落空，而它們指的是同一筆記錄。只補 entity 的話，`revisionAt` 的
 * 落空會走 `ensureRevision(前像)` ——在父 commit **新建**一筆全量跑從來沒寫過的
 * revision（實測多出 169 筆），而且 match 會掛到那筆假的前像上。
 */
export function previousDeclarationRecord(
  db: DatabaseSync,
  repoId: number,
  lineageId: number,
  observed: ObservedDeclaration,
  atSha: string,
): { entityId: number; revisionId: number } | undefined {
  const row = prep(db,
    `SELECT r.entity_id AS entityId, r.id AS revisionId
       FROM revision r
       JOIN slot s ON s.id = r.slot_id
       JOIN git_commit c ON c.id = r.commit_id
       JOIN git_commit target ON target.repo_id = c.repo_id AND target.sha = ?
      WHERE s.repo_id = ? AND s.lineage_id = ?
        AND s.qualified_name = ? AND s.disambiguator = ?
        AND c.topo_order < target.topo_order
      ORDER BY c.topo_order DESC, r.id DESC
      LIMIT 1`,
  ).get(
    atSha,
    repoId,
    lineageId,
    observed.symbol,
    String(observed.occurrence),
  ) as { entityId: number; revisionId: number } | undefined;
  return row;
}

export function previousSlotEntity(
  db: DatabaseSync,
  slotId: number,
  atSha: string,
): number | undefined {
  const row = prep(db,
    `SELECT r.entity_id AS entityId
       FROM revision r
       JOIN git_commit c ON c.id = r.commit_id
       JOIN git_commit target ON target.repo_id = c.repo_id AND target.sha = ?
      WHERE r.slot_id = ? AND c.topo_order < target.topo_order
      ORDER BY c.topo_order DESC, r.id DESC
      LIMIT 1`,
  ).get(atSha, slotId) as { entityId: number } | undefined;
  return row?.entityId;
}

/**
 * 舊路徑最後一個版本裡的同名 entity。若同一版本有多個不同 entity 就放棄：
 * 路徑重現是硬事實，但「前一位是誰」仍不可任選，誤接會製造假斷層。
 */
export function previousPathEntity(
  db: DatabaseSync,
  repoId: number,
  lineageId: number,
  pathName: string,
  symbol: string,
  beforeSha: string,
): number | undefined {
  const rows = prep(db,
    `WITH latest AS (
       SELECT MAX(c.topo_order) AS topoOrder
         FROM revision r
         JOIN git_commit c ON c.id = r.commit_id
        WHERE r.repo_id = ? AND r.lineage_id = ? AND r.path = ?
          AND c.topo_order < (
            SELECT topo_order FROM git_commit WHERE repo_id = ? AND sha = ?
          )
     )
     SELECT DISTINCT r.entity_id AS entityId
       FROM revision r
       JOIN slot s ON s.id = r.slot_id
       JOIN git_commit c ON c.id = r.commit_id
       JOIN latest l ON l.topoOrder = c.topo_order
      WHERE r.repo_id = ? AND r.lineage_id = ? AND r.path = ?
        AND s.qualified_name = ?`,
  ).all(
    repoId, lineageId, pathName, repoId, beforeSha,
    repoId, lineageId, pathName, symbol,
  ) as unknown as Array<{ entityId: number }>;
  return rows.length === 1 ? rows[0]!.entityId : undefined;
}

/** NULL 是不可比較；精確比較後真的沒有交集才是 0。 */
export function discontinuitySimilarity(
  prev: Set<number> | undefined,
  next: Set<number> | undefined,
): number | null {
  return prev && next ? exactJaccard(prev, next) : null;
}

export function writeDiscontinuity(
  db: DatabaseSync,
  args: {
    slotId: number;
    commitSha: string;
    prevEntity: number;
    nextEntity: number;
    similarity: number | null;
  },
): void {
  if (args.prevEntity === args.nextEntity) {
    throw new Error("斷層前後不可是同一個 entity");
  }
  prep(db,
    `INSERT INTO slot_discontinuity
       (slot_id, commit_id, prev_entity, next_entity, similarity)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (slot_id, commit_id) DO UPDATE SET
       prev_entity = excluded.prev_entity,
       next_entity = excluded.next_entity,
       similarity = excluded.similarity`,
  ).run(
    args.slotId,
    commitId(db, args.commitSha),
    args.prevEntity,
    args.nextEntity,
    args.similarity,
  );
}

/**
 * 依誕生座標建立 entity，**不看 slot**。
 *
 * `ensureEntity` 會重用「同一個 slot 上任何既有 revision 的 entity」，那對誕生是
 * 錯的：同一個 slot 上先後出現兩段不同血緣的程式碼時（舊的被改名搬走、新的同名
 * 宣告補上），重用會把兩個實體合併成一個，時間軸就會出現「同一個 entity 誕生兩次」。
 * slot 是「這個位置」的職責連續性，entity 是「這段程式碼」的血緣——不可合併。
 */
export function createEntity(
  db: DatabaseSync,
  repoId: number,
  birthSha: string,
  pathName: string,
  symbol: string,
  disambiguator: string,
): number {
  const key = stableKey(birthSha, pathName, symbol, disambiguator);
  prep(db, 
    `INSERT INTO entity (repo_id, stable_key, birth_commit_id)
     VALUES (?, ?, ?)
     ON CONFLICT (repo_id, stable_key) DO NOTHING`,
  ).run(repoId, key, commitId(db, birthSha));
  return (prep(db, 
    "SELECT id FROM entity WHERE repo_id = ? AND stable_key = ?",
  ).get(repoId, key) as { id: number }).id;
}

export function ensureEntity(
  db: DatabaseSync,
  repoId: number,
  slotId: number,
  birthSha: string,
  pathName: string,
  symbol: string,
  disambiguator: string,
): number {
  const existing = prep(db, 
    `SELECT entity_id AS id FROM revision
      WHERE slot_id = ? ORDER BY id LIMIT 1`,
  ).get(slotId) as { id: number } | undefined;
  if (existing) return existing.id;
  const key = stableKey(birthSha, pathName, symbol, disambiguator);
  prep(db, 
    `INSERT INTO entity (repo_id, stable_key, birth_commit_id)
     VALUES (?, ?, ?)
     ON CONFLICT (repo_id, stable_key) DO NOTHING`,
  ).run(repoId, key, commitId(db, birthSha));
  return (prep(db, 
    "SELECT id FROM entity WHERE repo_id = ? AND stable_key = ?",
  ).get(repoId, key) as { id: number }).id;
}

function encodeExact(values: Set<number>): Buffer {
  const array = Uint32Array.from([...values].sort((a, b) => a - b));
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function encodeMinhash(values: Int32Array): Buffer {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

export function ensureRevision(
  db: DatabaseSync,
  repo: string,
  repoId: number,
  lineageId: number,
  entityId: number,
  observed: ObservedDeclaration,
): number {
  const slotId = ensureSlot(
    db,
    repoId,
    lineageId,
    observed.symbol,
    observed.kind,
    String(observed.occurrence),
  );
  const existing = prep(db, 
    "SELECT id FROM revision WHERE commit_id = ? AND slot_id = ?",
  ).get(commitId(db, observed.commit), slotId) as { id: number } | undefined;
  if (existing) return existing.id;

  const bytes = utf8ByteRange(observed.node, observed.source);
  const { startLine: lineStart, endLine: lineEnd } = lineRange(observed);
  const exactMode = observed.signature.exact !== undefined;

  const info = prep(db, 
    `INSERT INTO revision (
       repo_id, commit_id, slot_id, entity_id, lineage_id, path,
       blob_sha, byte_start, byte_end, line_start, line_end,
       hash_raw, hash_token, hash_alpha, hash_alpha_self, hash_shape, shape_profile,
       signature, node_count, token_count,
       ngram_size, ngram_count, similarity_recall_mode,
       minhash, minhash_num_perm, minhash_version, minhash_seed_version,
       exact_ngram_hashes
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?,
       ?
     )`,
  ).run(
    repoId,
    commitId(db, observed.commit),
    slotId,
    entityId,
    lineageId,
    observed.path,
    observed.blobSha,
    bytes.startByte,
    bytes.endByte,
    lineStart,
    lineEnd,
    observed.hashes.hashRaw,
    observed.hashes.hashToken,
    observed.hashes.hashAlpha,
    observed.hashes.hashAlphaSelf,
    observed.hashes.hashShape,
    observed.hashes.shapeProfile,
    observed.node.text.split("\n", 1)[0] ?? "",
    observed.hashes.nodeCount,
    observed.hashes.tokenCount,
    NGRAM_SIZE,
    observed.signature.ngramCount,
    exactMode ? "exact" : "minhash128",
    exactMode ? null : encodeMinhash(observed.signature.minhash!),
    exactMode ? null : MINHASH_PERMUTATIONS,
    exactMode ? null : SIGNATURE_VERSION,
    exactMode ? null : MINHASH_SEED_VERSION,
    exactMode ? encodeExact(observed.signature.exact!) : null,
  );
  return Number(info.lastInsertRowid);
}

export function writeMatch(
  db: DatabaseSync,
  prevRevision: number,
  nextRevision: number,
  match: { tier: string; exactJaccard?: number; exactVerified: boolean; ambiguitySize: number },
): void {
  prep(db, 
    `INSERT INTO revision_match (
       prev_revision, next_revision, tier, similarity,
       exact_jaccard, exact_verified, accepted, ambiguity_size
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (prev_revision, next_revision) DO UPDATE SET
       tier = excluded.tier,
       similarity = excluded.similarity,
       exact_jaccard = excluded.exact_jaccard,
       exact_verified = excluded.exact_verified,
       accepted = 1,
       ambiguity_size = excluded.ambiguity_size`,
  ).run(
    prevRevision,
    nextRevision,
    match.tier,
    match.exactJaccard ?? null,
    match.exactJaccard ?? null,
    match.exactVerified ? 1 : 0,
    match.ambiguitySize,
  );
}

export function writeChange(
  db: DatabaseSync,
  args: {
    prevRevision?: number;
    nextRevision?: number;
    commitSha: string;
    entityId: number;
    changeLevel: string;
    sigChanged: boolean;
  },
): void {
  prep(db, 
    `INSERT INTO revision_change
       (prev_revision, next_revision, commit_id, entity_id, change_level, sig_changed)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (commit_id, entity_id) DO UPDATE SET
       prev_revision = excluded.prev_revision,
       next_revision = excluded.next_revision,
       change_level = excluded.change_level,
       sig_changed = excluded.sig_changed`,
  ).run(
    args.prevRevision ?? null,
    args.nextRevision ?? null,
    commitId(db, args.commitSha),
    args.entityId,
    args.changeLevel,
    args.sigChanged ? 1 : 0,
  );
}

/**
 * 候選池：候選陣列 + id → 觀察值的對照。
 *
 * 回傳對照表而不是讓呼叫端從 id 字串切回座標。id 只是匹配器的不透明識別碼，
 * 一旦有人開始解析它，格式就變成隱性契約，跨檔案時加上血緣就會靜默壞掉。
 */
export interface CandidatePool {
  candidates: Candidate[];
  byId: Map<string, ObservedDeclaration>;
  exact: Map<string, Set<number>>;
}

/** 把觀察值轉成匹配器的候選。行號與 `revision` 記的是同一個算法。 */
export function buildPool(
  decls: ObservedDeclaration[],
  lineageOf: (o: ObservedDeclaration) => number,
  side: "prev" | "next",
): CandidatePool {
  const candidates: Candidate[] = [];
  const byId = new Map<string, ObservedDeclaration>();
  const exact = new Map<string, Set<number>>();
  for (const o of decls) {
    const lineageId = lineageOf(o);
    // 血緣必須進 id：跨檔案的候選池裡，同名同序號的宣告可能來自不同檔案。
    const id = `${side}\0${lineageId}\0${o.symbol}\0${o.occurrence}`;
    candidates.push({
      id,
      lineageId,
      qualifiedName: o.symbol,
      // disambiguator 恆為 NULL：同名宣告交由 bucket 唯一性與內容導向的層級處理，
      // 不用 occurrence 序號偷渡位置身份。
      kind: o.kind,
      hashes: o.hashes,
      signature: o.signature,
      path: o.path,
      startIndex: o.node.startIndex,
      ...lineRange(o),
    });
    byId.set(id, o);
    exact.set(id, o.exactNgrams);
  }
  return { candidates, byId, exact };
}

/**
 * 對兩個候選池跑一次匹配。
 *
 * hunk 只有在 prev 確實是 next 的父時才成立——hunk 描述的是「相對第一父」的差異，
 * 拿到非父子的兩點之間會算出錯誤的位置。空陣列的血緣不建鍵：零列代表
 * 「沒有 hunk 證據」（合併、二進位），不是「沒有改動」。
 */
export function matchPools(
  prev: CandidatePool,
  next: CandidatePool,
  hunksByLineage: ReadonlyMap<number, DiffHunk[]>,
) {
  const usable = new Map<number, DiffHunk[]>();
  for (const [lineageId, hunks] of hunksByLineage) {
    if (hunks.length > 0) usable.set(lineageId, hunks);
  }
  return matchLadder(prev.candidates, next.candidates, {
    verify: (p, n) => exactJaccard(prev.exact.get(p.id)!, next.exact.get(n.id)!),
    ...(usable.size > 0 ? { hunksByLineage: usable } : {}),
  });
}

export { changeLevel };
