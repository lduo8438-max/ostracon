import type {
  CommitRecord,
  LineageEvent,
  LineageResult,
  LineageSegment,
  LineageState,
} from "./types.ts";

/**
 * 路徑血緣建構。
 *
 * 每個 commit 的狀態只從自己的第一父繼承；merge 的 `stateChanges` 是第一父樹到
 * merge 結果的差異，因此能把另一父新帶進來的路徑接回原 lineage，又不會把分支上
 * 的每次修改重算成 merge 自己的改動。狀態用稀疏 overlay，成本與實際 path event
 * 成正比，不是 commits × repository paths 的完整快照。
 *
 * `segments` 是 schema v4 的線性相容投影。新索引以 `events` 為真相；segment 無法
 * 表示 DAG 存活區間，不能再拿來回答任意 commit 的 path state。
 */
export function buildLineages(
  commits: CommitRecord[],
  initial?: LineageState,
): LineageResult {
  type Present = { lineageId: number; fromSha: string };
  type StateNode = {
    sha: string;
    parentSha?: string;
    delta: Map<string, Present | null>;
    cache: Map<string, Present | null>;
    lineageDelta: Map<number, string | null>;
    lineageCache: Map<number, string | null>;
  };

  const nodes = new Map<string, StateNode>();
  const eventsByKey = new Map<string, LineageEvent>();
  const changeLineage = new Map<string, number>();
  const anomalies: LineageResult["anomalies"] = [];
  let nextId = initial?.nextLineageId ?? 1;
  let previousSyntheticSha: string | undefined;
  const graphAware = commits.some((commit) => commit.parents.length > 0);
  const key = (sha: string, path: string) => `${sha}\0${path}`;

  const initialValue = (sha: string, path: string): Present | undefined => {
    if (initial?.resolveAt) {
      const resolved = initial.resolveAt(sha, path);
      return resolved === undefined ? undefined : { lineageId: resolved, fromSha: sha };
    }
    const active = initial?.active.get(path);
    return active ? { lineageId: active.lineageId, fromSha: active.fromSha } : undefined;
  };

  function valueAt(sha: string | undefined, path: string): Present | undefined {
    if (sha === undefined) return undefined;
    let cursor: string | undefined = sha;
    let found: Present | undefined;
    while (cursor !== undefined) {
      const node = nodes.get(cursor);
      if (!node) {
        found = initialValue(cursor, path);
        break;
      }
      if (node.delta.has(path)) {
        found = node.delta.get(path) ?? undefined;
        break;
      }
      if (node.cache.has(path)) {
        found = node.cache.get(path) ?? undefined;
        break;
      }
      cursor = node.parentSha;
    }
    // 只快取原始查詢節點。若沿途每個 commit 都回填，最後為 tip 列舉 path 時會
    // 退化成 commits × paths，正是稀疏事件模型要避免的完整快照成本。
    nodes.get(sha)?.cache.set(path, found ?? null);
    return found;
  }

  function pathAt(sha: string | undefined, lineageId: number): string | undefined {
    if (sha === undefined) return undefined;
    let cursor: string | undefined = sha;
    let found: string | undefined;
    while (cursor !== undefined) {
      const node = nodes.get(cursor);
      if (!node) {
        found = initial?.resolvePathAt
          ? initial.resolvePathAt(cursor, lineageId)
          : [...(initial?.active ?? [])].find(([, value]) => value.lineageId === lineageId)?.[0];
        break;
      }
      if (node.lineageDelta.has(lineageId)) {
        found = node.lineageDelta.get(lineageId) ?? undefined;
        break;
      }
      if (node.lineageCache.has(lineageId)) {
        found = node.lineageCache.get(lineageId) ?? undefined;
        break;
      }
      cursor = node.parentSha;
    }
    nodes.get(sha)?.lineageCache.set(lineageId, found ?? null);
    return found;
  }

  function setEvent(sha: string, path: string, value: Present | undefined): void {
    eventsByKey.set(key(sha, path), { sha, path, lineageId: value?.lineageId ?? null });
  }

  function uniqueOtherParentValue(commit: CommitRecord, path: string): Present | undefined {
    const ids = new Map<number, Present>();
    for (const parent of commit.parents.slice(1)) {
      const value = valueAt(parent, path);
      if (value) ids.set(value.lineageId, value);
    }
    return ids.size === 1 ? ids.values().next().value : undefined;
  }

  for (const commit of commits) {
    // 舊的純函式測試沒有填 parents；整批都沒有 edge 時維持線性測試語意。
    // 真實 git walk 一定帶 parent，不能讓這個相容分支介入 DAG。
    const parentSha = graphAware ? commit.parents[0] : previousSyntheticSha;
    const node: StateNode = {
      sha: commit.sha,
      ...(parentSha === undefined ? {} : { parentSha }),
      delta: new Map(),
      cache: new Map(),
      lineageDelta: new Map(),
      lineageCache: new Map(),
    };
    nodes.set(commit.sha, node);

    const parentValue = (path: string): Present | undefined => {
      if (parentSha !== undefined) return valueAt(parentSha, path);
      if (!graphAware) {
        const value = initial?.active.get(path);
        return value ? { lineageId: value.lineageId, fromSha: value.fromSha } : undefined;
      }
      return initialValue(commit.sha, path);
    };
    const current = (path: string): Present | undefined => {
      if (node.delta.has(path)) return node.delta.get(path) ?? undefined;
      return parentValue(path);
    };
    const assign = (path: string, value: Present | undefined): void => {
      const previous = current(path);
      if (previous && previous.lineageId !== value?.lineageId) {
        node.lineageDelta.set(previous.lineageId, null);
      }
      node.delta.set(path, value ?? null);
      if (value) node.lineageDelta.set(value.lineageId, path);
      setEvent(commit.sha, path, value);
    };
    const fresh = (path: string): Present => ({ lineageId: nextId++, fromSha: commit.sha });

    // 一般 commit 的 changes 已是相對唯一 parent 的狀態差異。merge 的 combined
    // changes 只是「與所有父都不同」的貢獻；狀態必須改用第一父 diff。
    const stateChanges = commit.isMerge ? (commit.stateChanges ?? commit.changes) : commit.changes;
    const renames = stateChanges.filter((change) => change.changeType === "R");
    const deletes = stateChanges.filter((change) => change.changeType === "D");
    const adds = stateChanges.filter((change) => change.changeType === "A" || change.changeType === "C");
    const mods = stateChanges.filter((change) => change.changeType === "M");

    // 所有 rename source 都先從 parent state 讀出，避免 A→B、B→C 鏈式改名互踩。
    const renameOps = renames.map((change) => ({
      change,
      value: parentValue(change.oldPath!),
    }));
    for (const { change } of renameOps) assign(change.oldPath!, undefined);
    for (const { change, value } of renameOps) {
      let next = value;
      if (!next && commit.isMerge) next = uniqueOtherParentValue(commit, change.path);
      if (!next) {
        anomalies.push({
          sha: commit.sha,
          path: change.path,
          reason: `改名來源 ${change.oldPath} 不在 parent 路徑中，視為新血緣起點`,
        });
        next = fresh(change.path);
      }
      assign(change.path, next);
    }

    for (const change of deletes) {
      const previous = current(change.path)
        ?? (commit.isMerge ? uniqueOtherParentValue(commit, change.path) : undefined);
      if (!previous) {
        anomalies.push({ sha: commit.sha, path: change.path, reason: "刪除了不在 parent 路徑中的檔案" });
      }
      assign(change.path, undefined);
    }

    for (const change of adds) {
      const existing = current(change.path);
      if (existing) {
        anomalies.push({ sha: commit.sha, path: change.path, reason: "新增了 parent 已存在的路徑" });
        assign(change.path, existing);
        continue;
      }
      // merge 對第一父看見 A/C 時，檔案通常是另一支早已建立後被帶進來；沿用那支
      // 的 lineage，不能在 merge 點製造第二次 birth。一般 commit 的 C 仍開新 lineage。
      const imported = commit.isMerge ? uniqueOtherParentValue(commit, change.path) : undefined;
      // 另一父把同一 lineage 搬到新 path、第一父卻仍把它留在舊 path，而 merge 結果
      // 同時保留兩者時，Git 的結果是一份 fork/copy，不可能讓一個 lineage 佔兩格。
      const alreadyAt = imported ? pathAt(commit.sha, imported.lineageId) : undefined;
      assign(change.path, imported && (alreadyAt === undefined || alreadyAt === change.path)
        ? imported
        : fresh(change.path));
    }

    for (const change of mods) {
      let existing = current(change.path);
      if (!existing && commit.isMerge) existing = uniqueOtherParentValue(commit, change.path);
      if (!existing) {
        anomalies.push({
          sha: commit.sha,
          path: change.path,
          reason: "修改了不在 parent 路徑中的檔案，開新血緣",
        });
        existing = fresh(change.path);
      }
      assign(change.path, existing);
    }

    // file_change 仍只保存 commit 自己的 combined contribution。它的 lineage 從
    // 已完成的輸出 state 取；D 則從各 parent 的輸入 state 取。
    for (const change of commit.changes) {
      let value = change.changeType === "D"
        ? parentValue(change.path)
        : current(change.path);
      if (!value && commit.isMerge) value = uniqueOtherParentValue(commit, change.path);
      if (value) changeLineage.set(key(commit.sha, change.path), value.lineageId);
    }

    previousSyntheticSha = commit.sha;
  }

  const events = [...eventsByKey.values()];
  const segments = compatibilitySegments(commits, events, initial);
  const tipSha = commits.at(-1)?.sha;
  const active = new Map<string, { lineageId: number; fromSha: string; isNew: boolean }>();
  if (tipSha !== undefined) {
    // 只沿 tip 的第一父鏈折疊 event；每個 path 的第一筆就是終點狀態。這是 O(events)，
    // 不為每個 path 各走一次整條歷史。
    const seen = new Set<string>();
    let cursor: string | undefined = tipSha;
    while (cursor !== undefined) {
      const node = nodes.get(cursor);
      if (!node) break;
      for (const [path, value] of node.delta) {
        if (seen.has(path)) continue;
        seen.add(path);
        if (value) active.set(path, { ...value, isNew: false });
      }
      cursor = node.parentSha;
    }
    for (const [path, value] of initial?.active ?? []) {
      if (!seen.has(path)) active.set(path, value);
    }
  } else {
    for (const [path, value] of initial?.active ?? []) active.set(path, value);
  }

  return {
    segments,
    events,
    changeLineage,
    anomalies,
    state: {
      active,
      nextLineageId: nextId,
      resolveAt: (sha, path) => valueAt(sha, path)?.lineageId,
      resolvePathAt: (sha, lineageId) => pathAt(sha, lineageId),
    },
  };
}

/** schema v4／公開回傳值的線性投影；DAG 查詢不得使用。 */
function compatibilitySegments(
  commits: CommitRecord[],
  events: LineageEvent[],
  initial?: LineageState,
): LineageSegment[] {
  const order = new Map(commits.map((commit, index) => [commit.sha, index]));
  const sorted = [...events].sort((a, b) => (order.get(a.sha) ?? 0) - (order.get(b.sha) ?? 0));
  const active = new Map<string, { lineageId: number; fromSha: string; persisted: boolean }>();
  for (const [path, value] of initial?.active ?? []) {
    active.set(path, { lineageId: value.lineageId, fromSha: value.fromSha, persisted: true });
  }
  const segments: LineageSegment[] = [];
  for (const event of sorted) {
    const previous = active.get(event.path);
    if (event.lineageId === null) {
      if (previous) {
        if (previous.persisted) {
          segments.push({
            lineageId: previous.lineageId,
            path: event.path,
            fromSha: previous.fromSha,
            toSha: event.sha,
            isNew: false,
          });
        } else {
          const segment = segments.find((candidate) =>
            candidate.lineageId === previous.lineageId
            && candidate.path === event.path
            && candidate.fromSha === previous.fromSha
            && candidate.toSha === null);
          if (segment) segment.toSha = event.sha;
        }
        active.delete(event.path);
      }
      continue;
    }
    if (previous?.lineageId === event.lineageId) continue;
    const from = { lineageId: event.lineageId, fromSha: event.sha, persisted: false };
    active.set(event.path, from);
    segments.push({ ...from, path: event.path, toSha: null, isNew: true });
  }
  return segments;
}
