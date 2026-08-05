import type { CommitRecord, LineageResult, LineageSegment, LineageState } from "./types.ts";

/**
 * 路徑血緣建構。
 *
 * 純函式：吃 CommitRecord[] 與（可選的）續跑狀態，吐血緣。不碰 git、不碰資料庫。
 * 刻意如此——血緣邏輯是 slot 身份的地基，而 slot 是雙身份設計的一半，
 * 它必須能在沒有 repo 的情況下用手寫的案例徹底測試。
 *
 * lineageId 直接使用資料庫的主鍵值，不做本地 id 到 DB id 的二次映射。
 * 少一層映射就少一類「續跑時對錯號」的 bug。
 *
 * ── 已知限制（不是 bug，是刻意的取捨）────────────────────────────────
 * 維護的是一張全域的 path → lineage 對照表，而不是逐 commit 的完整樹狀態。
 * 當同一路徑在兩條平行分支上各自演化、之後才合併時，血緣歸屬可能出錯。
 * 完全正確需要對每個 commit 保存樹快照，成本高一到兩個數量級。
 *
 * 實務上這種情況集中在長命分支上，多數 repo 罕見。若某個 repo 受影響嚴重，
 * 用 --first-parent 走訪在原理上可以完全避開（代價是看不到分支上的個別 commit），
 * 但那個選項尚未實作——不要在文件裡把它寫成使用者已經能用的東西。
 * 這個限制必須出現在 README，不能只留在程式碼註解裡。
 */
export function buildLineages(
  commits: CommitRecord[],
  initial?: LineageState,
): LineageResult {
  const active = new Map(initial?.active ?? []);
  let nextId = initial?.nextLineageId ?? 1;

  const segments: LineageSegment[] = [];
  const changeLineage = new Map<string, number>();
  const anomalies: LineageResult["anomalies"] = [];

  const key = (sha: string, path: string) => `${sha}\0${path}`;

  function open(lineageId: number, path: string, sha: string) {
    active.set(path, { lineageId, fromSha: sha, isNew: true });
    segments.push({ lineageId, path, fromSha: sha, toSha: null, isNew: true });
  }

  /** 關閉某路徑開著的那一段。已持久化的段落標 isNew=false，讓 persist 走 UPDATE 而非 INSERT。 */
  function close(path: string, sha: string): number | undefined {
    const cur = active.get(path);
    if (!cur) return undefined;
    active.delete(path);
    if (cur.isNew) {
      const seg = segments.find(
        (s) => s.lineageId === cur.lineageId && s.path === path && s.fromSha === cur.fromSha,
      );
      if (seg) seg.toSha = sha;
    } else {
      segments.push({ lineageId: cur.lineageId, path, fromSha: cur.fromSha, toSha: sha, isNew: false });
    }
    return cur.lineageId;
  }

  for (const c of commits) {
    // 分階段處理，因為同一個 commit 內順序會互相影響：
    // 「A 改名為 B，同時新增一個新的 A」如果先處理新增，A 的血緣就會被覆蓋。
    // git 不保證 --name-status 的輸出順序，所以不能依賴它。
    const renames = c.changes.filter((x) => x.changeType === "R");
    const deletes = c.changes.filter((x) => x.changeType === "D");
    const adds = c.changes.filter((x) => x.changeType === "A" || x.changeType === "C");
    const mods = c.changes.filter((x) => x.changeType === "M");

    // 階段 1：改名先騰出舊路徑。先全部讀出再套用，避免鏈式改名
    // （A→B 且 B→C 出現在同一 commit）互相踩到。
    const renameOps = renames.map((r) => ({ r, lineageId: active.get(r.oldPath!)?.lineageId }));
    for (const { r, lineageId } of renameOps) {
      if (lineageId !== undefined) close(r.oldPath!, c.sha);
    }
    for (const { r, lineageId } of renameOps) {
      if (lineageId === undefined) {
        // 舊路徑不在存活集合中。合併、淺層 clone、或 --until 截斷歷史都會造成。
        // 當作新血緣起點，但要留下痕跡——靜默吞掉會讓血緣斷得莫名其妙。
        anomalies.push({
          sha: c.sha,
          path: r.path,
          reason: `改名來源 ${r.oldPath} 不在存活路徑中，視為新血緣起點`,
        });
        const id = nextId++;
        open(id, r.path, c.sha);
        changeLineage.set(key(c.sha, r.path), id);
        continue;
      }
      open(lineageId, r.path, c.sha);
      changeLineage.set(key(c.sha, r.path), lineageId);
    }

    // 階段 2：刪除。血緣就此關閉；同路徑日後再出現會是「新的」血緣，
    // 這是刻意的——git 沒有任何證據說它們是同一個檔案，
    // 而實體層的 slot_discontinuity 正是要在這裡報斷層。
    for (const d of deletes) {
      const id = close(d.path, c.sha);
      if (id === undefined) {
        anomalies.push({ sha: c.sha, path: d.path, reason: "刪除了不在存活路徑中的檔案" });
        continue;
      }
      changeLineage.set(key(c.sha, d.path), id);
    }

    // 階段 3：新增與複製。複製一律開新血緣——來源檔案仍然存在，
    // 兩者從此各走各的。來源關係保存在 file_change.old_path，不混進血緣。
    for (const a of adds) {
      const cur = active.get(a.path);
      if (cur) {
        anomalies.push({ sha: c.sha, path: a.path, reason: "新增了已存在的路徑" });
        changeLineage.set(key(c.sha, a.path), cur.lineageId);
        continue;
      }
      const id = nextId++;
      open(id, a.path, c.sha);
      changeLineage.set(key(c.sha, a.path), id);
    }

    // 階段 4：修改不改變血緣，只需登記歸屬。
    for (const m of mods) {
      const cur = active.get(m.path);
      if (cur) {
        changeLineage.set(key(c.sha, m.path), cur.lineageId);
        continue;
      }
      // 合併的 combined diff 不做改名偵測，rename-like resolution 會報成 M。
      anomalies.push({ sha: c.sha, path: m.path, reason: "修改了不在存活路徑中的檔案，開新血緣" });
      const id = nextId++;
      open(id, m.path, c.sha);
      changeLineage.set(key(c.sha, m.path), id);
    }
  }

  // 回傳的 state 描述的是「這批寫進資料庫之後」的世界。
  // 本批新開的段落屆時已經持久化，所以一律降級為 isNew=false，
  // 否則下一批要關閉它們時，close() 會去這一批的 segments 陣列裡找，
  // 找不到就靜默不做事——那條血緣的 to_commit_id 會永遠停在 NULL，
  // 路徑看起來像從未被刪除，下游每一個 slot 查詢都會跟著錯。
  const carried = new Map<string, { lineageId: number; fromSha: string; isNew: boolean }>();
  for (const [path, e] of active) {
    carried.set(path, { lineageId: e.lineageId, fromSha: e.fromSha, isNew: false });
  }

  return {
    segments,
    changeLineage,
    anomalies,
    state: { active: carried, nextLineageId: nextId },
  };
}
