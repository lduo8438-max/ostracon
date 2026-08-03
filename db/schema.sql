-- =============================================================================
-- 程式碼決策考古 — SQLite Schema（草案 v0.5）
--
-- 設計原則：
--   1. 結構層（1-4 節）完全確定式，零 LLM。可獨立重算並驗證。
--   2. 證據層（5 節）只保存已驗證的 stated/linked 原文引用。
--   3. 結論層（6 節）與證據層分離；inferred 只存在於 claim，且不進正式呈現視圖。
--   4. 每個 pass 各自有水位線，可獨立、增量、可恢復地重跑。
--
-- 標記說明：
--   [OPEN]  = 我做了選擇但你應該質疑
--   [LOCK]  = 建議定稿後不要再動，改動成本極高
-- =============================================================================

-- [注意] journal_mode 是持久化設定，寫在這裡有效。
-- 但 foreign_keys 是「每連線」設定，不會被 schema 記住——
-- 應用層必須在每一條新連線上重新執行一次，否則外鍵形同虛設。
-- 這行留著只是為了讓建表腳本本身有保護，不要以為設過就一勞永逸。
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- =============================================================================
-- 0. 元資料
-- =============================================================================

CREATE TABLE schema_migration (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
) STRICT;

-- 各 pass 的水位線。結構 pass 可以跑到 commit X，證據 pass 落後到 commit Y，
-- claim pass 再落後——三者解耦是刻意的，因為只有 claim pass 要花錢。
CREATE TABLE pass_state (
  repo_id           INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  pass_name         TEXT NOT NULL,      -- 'structural' | 'lifecycle' | 'evidence' | 'claim'
  last_commit_id    INTEGER REFERENCES git_commit(id),
  indexer_version   TEXT NOT NULL,      -- 版本變更時該 pass 的產出需作廢重算
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (repo_id, pass_name)
) STRICT;

-- =============================================================================
-- 1. Git 層
-- =============================================================================

CREATE TABLE repo (
  id             INTEGER PRIMARY KEY,
  root_path      TEXT NOT NULL UNIQUE,
  origin_url     TEXT,
  default_branch TEXT,
  created_at     TEXT NOT NULL
) STRICT;

CREATE TABLE git_commit (
  id            INTEGER PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  sha           TEXT NOT NULL,
  author_name   TEXT,
  author_email  TEXT,
  authored_at   TEXT NOT NULL,          -- ISO8601 UTC
  committed_at  TEXT NOT NULL,
  message       TEXT NOT NULL,          -- 全文，證據 span 要引用
  is_merge      INTEGER NOT NULL DEFAULT 0,
  topo_order    INTEGER,                -- 拓撲序，讓「前一版」有確定意義
  UNIQUE (repo_id, sha)
) STRICT;

CREATE INDEX idx_commit_topo ON git_commit(repo_id, topo_order);
CREATE INDEX idx_commit_time ON git_commit(repo_id, committed_at);

CREATE TABLE git_commit_parent (
  child_id   INTEGER NOT NULL REFERENCES git_commit(id) ON DELETE CASCADE,
  parent_id  INTEGER NOT NULL REFERENCES git_commit(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,          -- 0 = first parent
  PRIMARY KEY (child_id, ordinal)
) STRICT;

-- [LOCK] 檔案血緣。slot 身份依賴它，事後補會很痛。
-- 一條 lineage 代表「git 認為是同一個檔案」的路徑鏈。
CREATE TABLE path_lineage (
  id       INTEGER PRIMARY KEY,
  repo_id  INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE path_lineage_segment (
  lineage_id     INTEGER NOT NULL REFERENCES path_lineage(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  from_commit_id INTEGER NOT NULL REFERENCES git_commit(id),
  to_commit_id   INTEGER REFERENCES git_commit(id),   -- NULL = 至今
  PRIMARY KEY (lineage_id, from_commit_id)
) STRICT;

-- 增量續跑靠這條索引重建存活路徑集合：尚未關閉的 segment 就是存活路徑本身。
CREATE INDEX idx_segment_open ON path_lineage_segment(lineage_id)
  WHERE to_commit_id IS NULL;

CREATE INDEX idx_lineage_path ON path_lineage_segment(path);

CREATE TABLE file_change (
  id            INTEGER PRIMARY KEY,
  commit_id     INTEGER NOT NULL REFERENCES git_commit(id) ON DELETE CASCADE,
  lineage_id    INTEGER NOT NULL REFERENCES path_lineage(id),
  path          TEXT NOT NULL,
  old_path      TEXT,
  change_type   TEXT NOT NULL CHECK (change_type IN ('A','M','D','R','C')),
  rename_score  INTEGER,                -- git 的 -M 相似度 0-100
  blob_sha      TEXT,
  -- [v0.4 修正] 原本沒有唯一約束，走訪層重跑會把整批 file_change 再插一次
  -- （實測 13 筆變 26 筆）。一個 commit 對一個路徑只會有一筆變更，
  -- 這是資料本身的不變量，該由 schema 保證而不是靠索引器自律。
  UNIQUE (commit_id, path)
) STRICT;

CREATE INDEX idx_filechange_commit ON file_change(commit_id);
CREATE INDEX idx_filechange_lineage ON file_change(lineage_id);

-- git 算好的「改動的是哪幾行」。內容完全相同的候選之間匹配器已無資訊可用
-- （完整 Osiris 歷史有 51 條 L4/Jaccard=1 的任意配對），而行號是唯一還沒用上、
-- 且比 AST 位置穩定得多的訊號。
--
-- 存表不塞 JSON：判定要用行號做區間查詢，JSON 會逼你全表掃描。
--
-- **一列一個 hunk，不拆成 old/new 兩列。** 在 -U0 之下純新增是 `@@ -10,0 +11,3 @@`
-- 而修改是 `@@ -10,3 +11,5 @@`，兩者的 new-side 範圍拆開後長得一模一樣。丟掉
-- 配對關係就再也分不出來，於是被修改的宣告會落在「新增範圍」內被誤判成 birth——
-- 正好是最不能犯的錯（誤報 birth ＝ 假斷層）。
--   old_count = 0 ⇔ 純新增；new_count = 0 ⇔ 純刪除。
--
-- 計數為 0 時 start 的語意不同：`-10,0` 是「插入在舊檔第 10 行之後」而非
-- 「舊檔第 10 行」。消費端只有在對應計數 > 0 時才能把它當區間用。
--
-- **沒有列不等於「這個檔案沒有改動」**，而是「沒有 hunk 證據」：合併 commit
-- （combined diff 沒有可靠的單一父 hunk，本表刻意不收）、二進位檔、純 mode 變更
-- 都是零列。消費端必須把零列當成「不得套用 hunk 約束」，不得當成「零新增行」。
-- 合併的排除另有 git_commit.is_merge 可查，不必依賴列數。
CREATE TABLE file_hunk (
  file_change_id INTEGER NOT NULL REFERENCES file_change(id) ON DELETE CASCADE,
  hunk_index     INTEGER NOT NULL,   -- 該檔案內的順序，穩定可重現
  old_start      INTEGER NOT NULL,
  old_count      INTEGER NOT NULL,
  new_start      INTEGER NOT NULL,
  new_count      INTEGER NOT NULL,
  PRIMARY KEY (file_change_id, hunk_index)
) STRICT, WITHOUT ROWID;

-- 可攜模式的內容定址快取。revision 不重複保存 body：
--   本地模式：依 repo.root_path + blob_sha 回 Git object database 讀取。
--   可攜模式：依 (repo_id, blob_sha) 從本表讀取；每個 Git blob 只保存一次。
-- 本表是可選快取，因此 revision.blob_sha 不設強制 FK。
CREATE TABLE blob_cache (
  repo_id         INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  blob_sha        TEXT NOT NULL,
  content_blob    BLOB NOT NULL,
  compression     TEXT NOT NULL DEFAULT 'none'
                    CHECK (compression IN ('none','gzip','zstd')),
  byte_length     INTEGER NOT NULL CHECK (byte_length >= 0),
  content_sha256  TEXT NOT NULL,
  cached_at       TEXT NOT NULL,
  PRIMARY KEY (repo_id, blob_sha),
  UNIQUE (repo_id, content_sha256)
) STRICT;

-- =============================================================================
-- 2. 雙身份：名稱槽位 (slot) 與語意實體 (entity)
--
-- slot   = 「auth.ts::validateToken 這個位置」的歷史。職責的連續性。
-- entity = 「那段程式碼本身」的血緣。改名搬檔仍是同一個；原地重寫則不是。
-- 兩者分歧的位置 = slot_discontinuity = 時間軸上的斷層線。
-- =============================================================================

CREATE TABLE slot (
  id             INTEGER PRIMARY KEY,
  repo_id        INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  lineage_id     INTEGER NOT NULL REFERENCES path_lineage(id),
  qualified_name TEXT NOT NULL,         -- 'ClassName.method' / 'moduleFn'
  -- [OPEN] 多載與泛型：TS 同名不同簽名要不要算兩個 slot？
  -- 目前用 disambiguator 區分（NULL = 唯一）。可能不夠。
  -- SQLite UNIQUE 視 NULL 為彼此不同；若允許 NULL，同一個無多載 slot 可重複插入。
  -- 用空字串代表「無區分子」，讓唯一約束真的成立。
  disambiguator  TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL,         -- 'function'|'method'|'class'|'const'|...
  UNIQUE (repo_id, lineage_id, qualified_name, disambiguator)
) STRICT;

CREATE TABLE entity (
  id             INTEGER PRIMARY KEY,
  repo_id        INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  -- [LOCK] 可重現的穩定鍵：hash(誕生 commit sha + 誕生路徑 + 限定名稱)。
  -- 全量重建索引時 rowid 會變，stable_key 不會。對外 API 一律用它。
  stable_key     TEXT NOT NULL,
  birth_commit_id INTEGER NOT NULL REFERENCES git_commit(id),
  death_commit_id INTEGER REFERENCES git_commit(id),   -- NULL = 仍存在
  UNIQUE (repo_id, stable_key)
) STRICT;

-- 實體間的非線性關係（抽取／合併／拆分）
CREATE TABLE entity_link (
  id           INTEGER PRIMARY KEY,
  from_entity  INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  to_entity    INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL CHECK (relation IN
                 ('extracted_from','merged_into','split_into','inlined_into')),
  commit_id    INTEGER NOT NULL REFERENCES git_commit(id),
  confidence   REAL NOT NULL,
  UNIQUE (from_entity, to_entity, relation, commit_id)
) STRICT;

-- slot 內部的整體置換事件：同一槽位，前後兩個 revision 屬於不同 entity。
-- 這是專案最有價值的輸出之一——它告訴使用者「斷層以前的討論與現在無關」。
CREATE TABLE slot_discontinuity (
  id             INTEGER PRIMARY KEY,
  slot_id        INTEGER NOT NULL REFERENCES slot(id) ON DELETE CASCADE,
  commit_id      INTEGER NOT NULL REFERENCES git_commit(id),
  prev_entity    INTEGER NOT NULL REFERENCES entity(id),
  next_entity    INTEGER NOT NULL REFERENCES entity(id),
  -- NULL = 舊內容無法解析、沒有可比較的 token 集合；0 = 確實比較過且完全無交集。
  -- 兩者不可混成同一個 0，否則查詢端會把「沒有證據」誤說成最強的負證據。
  similarity     REAL CHECK (similarity IS NULL OR (similarity >= 0 AND similarity <= 1)),
  UNIQUE (slot_id, commit_id)
) STRICT;

-- =============================================================================
-- 3. Revision：四層雜湊向量 + 預留的 self-normalized 特徵
--
-- 「兩個 revision 第一次不相等的那一層」= 變更性質。分類器變成一次查表。
-- =============================================================================

CREATE TABLE revision (
  id            INTEGER PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  commit_id     INTEGER NOT NULL REFERENCES git_commit(id) ON DELETE CASCADE,
  slot_id       INTEGER NOT NULL REFERENCES slot(id),
  entity_id     INTEGER NOT NULL REFERENCES entity(id),
  lineage_id    INTEGER NOT NULL REFERENCES path_lineage(id),
  path          TEXT NOT NULL,          -- 該 commit 當下的實際路徑（冗餘，為了查詢方便）

  -- 位置：不存原始碼，存 blob 內的位移。需要時回本地 Git 或 blob_cache 讀。
  blob_sha      TEXT NOT NULL,
  byte_start    INTEGER NOT NULL,
  byte_end      INTEGER NOT NULL,
  line_start    INTEGER NOT NULL,
  line_end      INTEGER NOT NULL,

  -- [LOCK] 四層雜湊階梯（由細到粗）
  hash_raw      TEXT NOT NULL,          -- 原始碼位元組
  hash_token    TEXT NOT NULL,          -- 忽略空白與註解的 token 序列
  hash_alpha    TEXT NOT NULL,          -- 只正規化局部變數（alpha 等價）
  -- L3b：在 hash_alpha 基礎上，再把宣告自身的名稱與解析為該宣告的
  -- self-reference 正規化為 $SELF。只允許同檔、同 profile/kind、
  -- node_count >= 25 且前後唯一 1:1 bucket 的候選使用。
  hash_alpha_self TEXT NOT NULL,
  hash_shape    TEXT NOT NULL,          -- node type + field name + 有序樹；內容抹除，並以 shape_profile domain-separate
  shape_profile TEXT NOT NULL,          -- 語言家族 + 精確 grammar 版本 + serializer 版本

  signature     TEXT,                   -- 簽名文字，供 UI 顯示
  node_count    INTEGER NOT NULL,       -- shape hash 的碰撞閘門依據
  token_count   INTEGER NOT NULL,

  -- token n-gram 集合的候選召回資料。v1 以去重後 ngram_count <= 200
  -- 為 exact mode；超過才使用 128-permutation MinHash。200 是
  -- indexer_version 的參數，不寫死成 schema CHECK。
  ngram_size             INTEGER NOT NULL DEFAULT 3 CHECK (ngram_size > 0),
  ngram_count            INTEGER NOT NULL DEFAULT 0 CHECK (ngram_count >= 0),
  similarity_recall_mode TEXT NOT NULL
                           CHECK (similarity_recall_mode IN ('exact','minhash128')),
  minhash                BLOB,
  minhash_num_perm       INTEGER,
  minhash_version        TEXT,
  minhash_seed_version   TEXT,
  -- 小函式保存排序且去重後的 n-gram hash 集合，直接做精確 Jaccard。
  exact_ngram_hashes     BLOB,

  -- 保留核心不變量：一個 commit snapshot 中，一個 slot 只有一個 revision。
  -- [修正] 原本同時有 (commit_id, slot_id) 與 (repo_id, commit_id, slot_id)。
  -- commit_id 已經決定 repo_id，後者是前者的冗餘超集，只是多付一份寫入成本
  -- 與一份磁碟空間，不提供任何額外保證。刪除。
  UNIQUE (commit_id, slot_id),
  CHECK (
    (similarity_recall_mode = 'exact'
      AND exact_ngram_hashes IS NOT NULL)
    OR
    (similarity_recall_mode = 'minhash128'
      AND minhash IS NOT NULL
      AND minhash_num_perm = 128
      AND minhash_version IS NOT NULL
      AND minhash_seed_version IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_revision_entity ON revision(entity_id, commit_id);
CREATE INDEX idx_revision_slot   ON revision(slot_id, commit_id);
CREATE INDEX idx_revision_shape  ON revision(repo_id, hash_shape) WHERE node_count >= 25;
CREATE INDEX idx_revision_alpha  ON revision(repo_id, hash_alpha);
CREATE INDEX idx_revision_alpha_self
  ON revision(repo_id, lineage_id, hash_alpha_self) WHERE node_count >= 25;

-- 匹配階梯的完整紀錄。連被否決的候選也存，否則第四週調參時無從除錯。
CREATE TABLE revision_match (
  id            INTEGER PRIMARY KEY,
  prev_revision INTEGER NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  next_revision INTEGER NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  tier          TEXT NOT NULL CHECK (tier IN ('L1','L2','L3','L3b','L3c','L4','L5')),
  -- L1 同槽位同名 / L2 hash_raw 或 hash_token 相同 / L3 hash_alpha 相同
  -- L3b 同檔唯一 hash_alpha_self 相同
  -- L3c 同檔、hash_raw 相等、宣告未被任何 hunk 碰到且行號回推唯一命中
  -- L4 相似度過門檻
  -- L5 跨檔案的 L2-L4（搬移或抽取）
  similarity    REAL,
  -- MinHash 的估計值只負責召回；接受前必須完成精確集合／雜湊驗證。
  exact_jaccard REAL,
  exact_verified INTEGER NOT NULL DEFAULT 0 CHECK (exact_verified IN (0,1)),
  accepted      INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0,1)),
  reject_reason TEXT,
  -- 接受這條匹配時，同一個 bucket 裡有幾個等價候選。1 = 唯一。
  -- 現在就記，因為事後補要重算全部匹配；沒有它，UI 無法誠實地說
  -- 「這裡有四個等價候選，我選了一個」。NULL = 該層不適用或尚未填。
  ambiguity_size INTEGER CHECK (ambiguity_size IS NULL OR ambiguity_size >= 1),
  UNIQUE (prev_revision, next_revision),
  -- [修正] 原本是 CHECK (accepted = 0 OR exact_verified = 1)，對 L1-L3c 語意錯誤。
  -- L1/L2/L3/L3b/L3c 是雜湊相等、同槽位同名或位置錨定，根本沒有「Jaccard 相似度」
  -- 這回事；
  -- 強迫它們填 exact_verified = 1 會讓這個欄位失去意義，日後看紀錄無法分辨
  -- 「驗證過」與「不需驗證」。只有靠相似度召回的 L4/L5 才需要精確驗證。
  CHECK (
    accepted = 0
    OR tier IN ('L1','L2','L3','L3b','L3c')
    OR (exact_verified = 1 AND exact_jaccard IS NOT NULL)
  ),
  -- 對應地，L1-L3c 不應該填相似度欄位，避免混入誤導性數字。
  CHECK (tier IN ('L4','L5') OR (exact_jaccard IS NULL AND exact_verified = 0))
) STRICT;

CREATE INDEX idx_match_next ON revision_match(next_revision, accepted);

-- 變更分類：由雜湊向量比對確定式導出，零 LLM。
CREATE TABLE revision_change (
  id             INTEGER PRIMARY KEY,
  prev_revision  INTEGER REFERENCES revision(id) ON DELETE CASCADE,  -- NULL = 誕生
  next_revision  INTEGER REFERENCES revision(id) ON DELETE CASCADE,  -- NULL = 消亡
  commit_id      INTEGER NOT NULL REFERENCES git_commit(id),
  entity_id      INTEGER NOT NULL REFERENCES entity(id),

  -- 第一次相異的層級 = 變更性質
  --   'none'    完全相同
  --   'raw'     僅格式或註解        → 不呼叫 LLM
  --   'token'   僅局部變數改名      → 不呼叫 LLM
  --   'alpha'   字面量／呼叫目標變更，控制流不變 → 視情況
  --   'shape'   真正的結構重構      → 呼叫 LLM
  --   'birth' / 'death'
  change_level   TEXT NOT NULL CHECK (change_level IN
                   ('none','raw','token','alpha','shape','birth','death')),
  sig_changed    INTEGER NOT NULL DEFAULT 0,

  -- what_changed：確定式產生的結構化描述（新增／移除了哪些節點種類）
  what_struct    TEXT,                  -- JSON
  -- 純翻譯用的人話版本。禁止引入 what_struct 以外的資訊。
  what_prose     TEXT,
  what_prose_gen INTEGER NOT NULL DEFAULT 0,

  UNIQUE (commit_id, entity_id),
  -- [修正] 實測確認：原本兩端皆 NULL 的孤兒列可以入庫，且因為本表沒有
  -- repo_id、也沒有任何 CASCADE 路徑會清掉它，會永久殘留。
  CHECK (prev_revision IS NOT NULL OR next_revision IS NOT NULL),
  -- 語意一致性：birth 必然沒有前驅，death 必然沒有後繼。
  CHECK (change_level <> 'birth' OR prev_revision IS NULL),
  CHECK (change_level <> 'death' OR next_revision IS NULL)
) STRICT;

CREATE INDEX idx_change_level ON revision_change(change_level, commit_id);

-- [修正] 這是整個產品最熱的查詢：「給我實體 X 的完整變更時間軸」。
-- 原本只有 UNIQUE (commit_id, entity_id)，前導欄位是 commit_id，
-- 依 entity_id 查詢只能全表掃描。大型 repo 上這條會直接讓 UI 卡死。
CREATE INDEX idx_change_entity ON revision_change(entity_id, commit_id);

-- =============================================================================
-- 4. 構造生命週期
--
-- 追蹤單位從「實體」下放到「實體內可穩定追蹤的語意構造」。
-- construct 由版本化的語言 adapter / semantic extractor 產生，不採固定 AST
-- node-kind 白名單；短命構造只表示 transient implementation，不直接推論意圖。
-- =============================================================================

CREATE TABLE construct (
  id            INTEGER PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  entity_id     INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  -- 語言無關的語意類別，例如 call_target / type_usage / control_strategy /
  -- resource_strategy / annotation。值由 extractor 定義，不在 DB 寫死白名單。
  construct_kind   TEXT NOT NULL,
  -- 在同一 entity 內可跨 revision 對位的穩定語意鍵。
  semantic_key     TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  -- extractor 特有、可重算的結構化屬性；不得作為未驗證的 why。
  properties_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(properties_json)),
  label         TEXT,                   -- 給人看的描述，例如 'mutex 宣告'
  peak_nodes    INTEGER NOT NULL,
  UNIQUE (repo_id, entity_id, construct_kind, semantic_key, extractor_version)
) STRICT;

-- 存在區間（run-length 編碼）。逐 revision 存會讓表大到不能用。
-- 一個構造可以死而復生，故一對多。
CREATE TABLE construct_span (
  id             INTEGER PRIMARY KEY,
  construct_id   INTEGER NOT NULL REFERENCES construct(id) ON DELETE CASCADE,
  span_index     INTEGER NOT NULL,
  birth_commit   INTEGER NOT NULL REFERENCES git_commit(id),
  death_commit   INTEGER REFERENCES git_commit(id),      -- NULL = 仍存在
  lifespan_days  REAL,
  UNIQUE (construct_id, span_index)
) STRICT;

CREATE INDEX idx_span_lifespan ON construct_span(lifespan_days)
  WHERE death_commit IS NOT NULL;

-- =============================================================================
-- 5. 證據層
--
-- 原文全文必須落地，否則 span offset 無法被程式斷言。
-- 這是整個信譽架構的物理基礎。
-- =============================================================================

CREATE TABLE source_doc (
  id               INTEGER PRIMARY KEY,
  repo_id          INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  doc_type         TEXT NOT NULL CHECK (doc_type IN
                     ('commit_message','pr_body','pr_review','pr_comment',
                      'issue_body','issue_comment','code_comment','changelog')),
  -- 獨立性去重的依據：同一個 PR 討論串裡三個人說同一件事，不是三份獨立證據。
  provenance_root  TEXT NOT NULL,       -- 'pr:442' / 'issue:88' / 'commit:abc123'
  -- [修正] 原本可為 NULL，但 SQLite 的 UNIQUE 視每個 NULL 為相異值，
  -- 於是 UNIQUE (repo_id, doc_type, external_id) 對 commit_message 完全失效，
  -- 同一則 commit message 會被重複寫入，證據去重也跟著失效。
  -- 改為 NOT NULL：commit_message 用 sha，pr/issue 用平台編號。
  external_id      TEXT NOT NULL,
  url              TEXT,
  author           TEXT,
  created_at       TEXT,
  body             TEXT NOT NULL,       -- 全文，一字不改
  body_sha256      TEXT NOT NULL,       -- 上游文字被編輯過就能偵測到
  UNIQUE (repo_id, doc_type, external_id)
) STRICT;

CREATE INDEX idx_srcdoc_root ON source_doc(repo_id, provenance_root);

-- commit ↔ PR ↔ issue 的關聯，以及是怎麼推出來的
CREATE TABLE reference_link (
  id           INTEGER PRIMARY KEY,
  repo_id      INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  from_kind    TEXT NOT NULL,           -- 'commit'|'pr'|'issue'
  from_key     TEXT NOT NULL,
  -- [修正] to_kind 是**衍生欄位**，不是身分的一部分。抽取器只看得到 `#162`，
  -- 一律先寫 'issue'；要等 linked 層真的取回才知道那是 PR 還是 issue。
  -- 先前 UNIQUE 把它算進去，後果是：extract 寫 'issue' → linked 修正成 'pr'
  -- → 再跑一次 extract 時 ON CONFLICT 鍵不再吻合，於是**又插一份 'issue'**
  -- （Osiris 實測 23 列變 28 列），而下次 linked 要修正那份重複列時就 UNIQUE 衝突。
  --
  -- 身分是「哪個 commit、提到哪個編號、用哪種方法」。GitHub 的 issue 與 PR
  -- 共用同一組編號，所以 to_key 本身就唯一標定目標，to_kind 由它決定。
  to_kind      TEXT NOT NULL,
  to_key       TEXT NOT NULL,
  method       TEXT NOT NULL CHECK (method IN
                 ('message_ref','merge_commit','trailer','api','heuristic')),
  confidence   REAL NOT NULL,
  UNIQUE (repo_id, from_kind, from_key, to_key, method)
) STRICT;

-- 一段已驗證的正式引用。此表只容納 stated / linked：
-- 程式必須已斷言 span 與 quoted_text 確實存在於對應 source_doc.body。
-- inferred 是 claim 的 epistemic tier，不是 evidence。
CREATE TABLE evidence (
  id             INTEGER PRIMARY KEY,
  repo_id        INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  source_doc_id  INTEGER NOT NULL REFERENCES source_doc(id) ON DELETE CASCADE,
  char_start     INTEGER NOT NULL,
  char_end       INTEGER NOT NULL,
  quoted_text    TEXT NOT NULL,         -- 逐字，用來對位驗證
  doc_body_sha   TEXT NOT NULL,         -- 快照；與 source_doc.body_sha256 不符即失效
  tier           TEXT NOT NULL CHECK (tier IN ('stated','linked')),
  --   stated   來源直接說明（commit message 本身）
  --   linked   透過 issue／PR 關聯推導
  verified       INTEGER NOT NULL DEFAULT 1 CHECK (verified = 1),
  CHECK (char_start >= 0),
  CHECK (char_end > char_start),
  -- [修正] 原本 UNIQUE 含 quoted_text。(source_doc_id, char_start, char_end)
  -- 已經唯一決定 quoted_text，把長文本塞進唯一索引只會撐大索引、拖慢寫入。
  -- tier 保留：同一段文字可能同時是 commit 的 stated 與 PR 關聯的 linked。
  UNIQUE (source_doc_id, char_start, char_end, tier)
) STRICT;

CREATE INDEX idx_evidence_doc ON evidence(repo_id, source_doc_id);

-- 待驗證的 span 候選只進 staging。驗證成功後建立 evidence，並把狀態改為
-- promoted；失敗候選可保留原因供除錯與調整 extractor / prompt。
CREATE TABLE evidence_candidate (
  id                    INTEGER PRIMARY KEY,
  repo_id               INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  source_doc_id         INTEGER NOT NULL REFERENCES source_doc(id) ON DELETE CASCADE,
  proposed_char_start   INTEGER,
  proposed_char_end     INTEGER,
  proposed_quoted_text  TEXT,
  expected_doc_body_sha TEXT,
  proposed_tier         TEXT NOT NULL CHECK (proposed_tier IN ('stated','linked')),
  generator_kind        TEXT NOT NULL CHECK (generator_kind IN ('rule','llm','import')),
  generator_version     TEXT NOT NULL,
  model                 TEXT,
  prompt_version        TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','promoted','rejected')),
  rejection_reason      TEXT,
  promoted_evidence_id  INTEGER REFERENCES evidence(id) ON DELETE CASCADE,
  created_at            TEXT NOT NULL,
  validated_at          TEXT,
  CHECK (
    (status = 'promoted' AND promoted_evidence_id IS NOT NULL)
    OR
    (status <> 'promoted' AND promoted_evidence_id IS NULL)
  ),
  UNIQUE (
    repo_id, source_doc_id, proposed_char_start, proposed_char_end,
    proposed_quoted_text, proposed_tier, generator_kind, generator_version
  )
) STRICT;

CREATE INDEX idx_evidence_candidate_status
  ON evidence_candidate(repo_id, status, source_doc_id);

-- =============================================================================
-- 6. 結論層
--
-- 原子命題。一個 claim 只講一件事。
-- stated/linked 只有連到正式 evidence 才可呈現；inferred 可以保存供除錯或
-- 明確標示的推測介面使用，但不進正式呈現視圖。
-- =============================================================================

CREATE TABLE claim (
  id             INTEGER PRIMARY KEY,
  repo_id        INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  -- Typed nullable foreign keys：恰好一個 subject，完整性由 SQLite 保證。
  revision_change_id INTEGER REFERENCES revision_change(id) ON DELETE CASCADE,
  entity_id          INTEGER REFERENCES entity(id) ON DELETE CASCADE,
  construct_id       INTEGER REFERENCES construct(id) ON DELETE CASCADE,
  excursion_id       INTEGER REFERENCES excursion(id) ON DELETE CASCADE,
  slot_id            INTEGER REFERENCES slot(id) ON DELETE CASCADE,
  claim_type     TEXT NOT NULL CHECK (claim_type IN
                   ('why','constraint','tradeoff','abandoned_reason','ownership')),
  text           TEXT NOT NULL,
  tier           TEXT NOT NULL CHECK (tier IN ('stated','linked','inferred')),
  confidence     REAL NOT NULL,
  model          TEXT,
  prompt_version TEXT,
  created_at     TEXT NOT NULL,
  CHECK (
    (revision_change_id IS NOT NULL) +
    (entity_id IS NOT NULL) +
    (construct_id IS NOT NULL) +
    (excursion_id IS NOT NULL) +
    (slot_id IS NOT NULL) = 1
  )
) STRICT;

CREATE INDEX idx_claim_revision_change
  ON claim(repo_id, revision_change_id, claim_type)
  WHERE revision_change_id IS NOT NULL;
CREATE INDEX idx_claim_entity
  ON claim(repo_id, entity_id, claim_type)
  WHERE entity_id IS NOT NULL;
CREATE INDEX idx_claim_construct
  ON claim(repo_id, construct_id, claim_type)
  WHERE construct_id IS NOT NULL;
CREATE INDEX idx_claim_excursion
  ON claim(repo_id, excursion_id, claim_type)
  WHERE excursion_id IS NOT NULL;
CREATE INDEX idx_claim_slot
  ON claim(repo_id, slot_id, claim_type)
  WHERE slot_id IS NOT NULL;

-- 支持與反對都存。衝突要並列顯示，不可由模型靜默調和。
CREATE TABLE claim_evidence (
  claim_id     INTEGER NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  evidence_id  INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('supports','contradicts')),
  PRIMARY KEY (claim_id, evidence_id)
) STRICT;

-- =============================================================================
-- 7. 迂迴 / 被放棄的方案
-- =============================================================================

CREATE TABLE excursion (
  id                INTEGER PRIMARY KEY,
  repo_id           INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  -- [修正] 你已經把 claim 從多型外鍵改成 typed nullable FK，但 excursion
  -- 還留著舊寫法。維持兩套風格會讓查詢層要處理兩種模式，而且 excursion 的
  -- subject_id 沒有外鍵保護——construct 被刪除後會留下指向空氣的 excursion。
  -- 改成同一套。
  entity_id         INTEGER REFERENCES entity(id) ON DELETE CASCADE,
  construct_id      INTEGER REFERENCES construct(id) ON DELETE CASCADE,
  introduce_commit  INTEGER NOT NULL REFERENCES git_commit(id),
  remove_commit     INTEGER NOT NULL REFERENCES git_commit(id),
  duration_days     REAL NOT NULL,      -- 屬性而非門檻：三週是試錯，三年是技術演進

  strength          TEXT NOT NULL CHECK (strength IN ('A','B','C')),
  --   A 確證   git revert，或 diff 近似反向匹配（結構可驗證，零 LLM）
  --   B 高可信 生命週期符合 + 有文字證據明確提及
  --   C 疑似   僅結構符合，無文字佐證 → UI 標「疑似」，不得作為結論陳述
  method            TEXT NOT NULL CHECK (method IN
                      ('git_revert','inverse_diff','short_lifecycle','trajectory')),
  score             REAL,
  CHECK ((entity_id IS NOT NULL) + (construct_id IS NOT NULL) = 1),
  -- introduce 必須早於 remove；duration 不可為負。
  CHECK (duration_days >= 0)
) STRICT;

-- 兩個部分唯一索引取代原本含 subject_kind 的複合 UNIQUE。
CREATE UNIQUE INDEX uq_excursion_entity
  ON excursion(entity_id, introduce_commit, remove_commit)
  WHERE entity_id IS NOT NULL;
CREATE UNIQUE INDEX uq_excursion_construct
  ON excursion(construct_id, introduce_commit, remove_commit)
  WHERE construct_id IS NOT NULL;

CREATE INDEX idx_excursion_strength ON excursion(repo_id, strength, duration_days);

-- =============================================================================
-- 8. 成本控制
-- =============================================================================

CREATE TABLE llm_cache (
  input_hash     TEXT NOT NULL,         -- hash(prompt 全文 + 輸入資料)
  prompt_version TEXT NOT NULL,
  model          TEXT NOT NULL,
  response_json  TEXT NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (input_hash, prompt_version, model)
) STRICT;

-- =============================================================================
-- 9. 全文檢索
-- =============================================================================

-- [OPEN] tokenizer 選擇：unicode61 不切分中日韓文字。如果 claim.text 會有中文
-- （LLM 產出的敘述、或中文 repo 的 commit message），關鍵字檢索會整個失效。
-- 需要中文就改成 tokenize='trigram'（代價是索引變大、不支援前綴查詢）。
-- 這件事跟你的目標 repo 語言有關，先留成 unicode61。

CREATE VIRTUAL TABLE claim_fts USING fts5(
  text, content='claim', content_rowid='id', tokenize='unicode61'
);

CREATE VIRTUAL TABLE source_doc_fts USING fts5(
  body, content='source_doc', content_rowid='id', tokenize='unicode61'
);

-- [修正] external content 的 FTS5 表不會自動同步。原本沒有 trigger，
-- 實測確認：寫入 claim 後 claim_fts 查得到 0 筆——全文檢索永遠是空的。
-- 這類 bug 很難在開發中被發現，因為建表與查詢都不報錯。

CREATE TRIGGER claim_fts_ai AFTER INSERT ON claim BEGIN
  INSERT INTO claim_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER claim_fts_ad AFTER DELETE ON claim BEGIN
  INSERT INTO claim_fts(claim_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER claim_fts_au AFTER UPDATE ON claim BEGIN
  INSERT INTO claim_fts(claim_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO claim_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER source_doc_fts_ai AFTER INSERT ON source_doc BEGIN
  INSERT INTO source_doc_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER source_doc_fts_ad AFTER DELETE ON source_doc BEGIN
  INSERT INTO source_doc_fts(source_doc_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER source_doc_fts_au AFTER UPDATE ON source_doc BEGIN
  INSERT INTO source_doc_fts(source_doc_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO source_doc_fts(rowid, body) VALUES (new.id, new.body);
END;

-- =============================================================================
-- 10. 常用視圖（示意，非必要）
-- =============================================================================

-- 已消失的構造：README 那張 GIF 的資料來源
CREATE VIEW v_dead_constructs AS
SELECT c.id            AS construct_id,
       c.label,
       c.construct_kind,
       c.semantic_key,
       c.extractor_version,
       e.stable_key    AS entity_key,
       s.birth_commit,
       s.death_commit,
       s.lifespan_days
FROM construct c
JOIN construct_span s ON s.construct_id = c.id
JOIN entity e        ON e.id = c.entity_id
WHERE s.death_commit IS NOT NULL;

-- 正式可呈現 claim：只允許 stated/linked，且必須有已驗證的支持證據。
-- inferred 不會因高 confidence 自動混入可信歷史敘事。
-- [修正] 原本用 DISTINCT cl.*：一個 claim 掛多份證據時會產生重複列，
-- 再對整張寬列去重，成本高且會在 claim 欄位增減時悄悄變慢。改用 EXISTS。
CREATE VIEW v_presentable_claim AS
SELECT cl.*
FROM claim cl
WHERE cl.tier IN ('stated','linked')
  AND EXISTS (
    SELECT 1
    FROM claim_evidence ce
    JOIN evidence ev ON ev.id = ce.evidence_id
    WHERE ce.claim_id = cl.id
      AND ce.role = 'supports'
      AND ev.verified = 1
  );

-- 除錯／明確推測介面可單獨查詢；UI 必須標示「推測」，且預設不顯示低信心。
CREATE VIEW v_inferred_claim_debug AS
SELECT *
FROM claim
WHERE tier = 'inferred';
