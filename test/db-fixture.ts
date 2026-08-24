/**
 * 手寫資料庫 fixture 的共用片段。
 *
 * schema v2 起內容衍生欄位（四層雜湊、簽章、n-gram 資料）住在
 * `declaration_content`，`revision` 只留身分與位置。**七個測試檔在直接寫
 * `revision` 列**，它們驗的都不是雜湊本身，所以共用同一列假內容——各抄一份的話，
 * 下次動到內容表就要改七個地方，而那正是這次改動要消滅的那種重複。
 */

/** 所有 fixture 共用的假內容列 id。 */
export const CONTENT_ID = 1;

/** 先插這一列，`revision.content_id` 才有得指。 */
export const INSERT_CONTENT_FIXTURE = `
  INSERT INTO declaration_content
    (id, content_key, hash_raw, hash_token, hash_alpha, hash_alpha_self,
     hash_shape, shape_profile, signature, node_count, token_count,
     similarity_recall_mode, exact_ngram_hashes)
  VALUES (${CONTENT_ID}, x'01', x'02', x'03', x'04', x'05', x'06',
          'p', 'sig', 30, 10, 'exact', x'00');`;

/** `INSERT INTO revision` 的欄位清單。與 `revisionValues` 一對一。 */
export const REVISION_COLUMNS =
  "(id, repo_id, commit_id, slot_id, entity_id, lineage_id, path, content_id,"
  + " blob_sha, byte_start, byte_end, line_start, line_end)";

/**
 * 一列 revision 的 VALUES。`blob_sha` 是 BLOB（schema v2 起），
 * 在 STRICT 表上塞字串會直接被拒絕，所以這裡給 x'0b'。
 */
export function revisionValues(row: {
  id: number;
  repoId?: number;
  commitId: number;
  slotId?: number;
  entityId?: number;
  lineageId?: number;
  path?: string;
  contentId?: number;
}): string {
  const {
    id,
    repoId = 1,
    commitId,
    slotId = 1,
    entityId = 1,
    lineageId = 1,
    path = "src/a.ts",
    contentId = CONTENT_ID,
  } = row;
  return `(${id}, ${repoId}, ${commitId}, ${slotId}, ${entityId}, ${lineageId},`
    + ` '${path}', ${contentId}, x'0b', 0, 1, 1, 2)`;
}
