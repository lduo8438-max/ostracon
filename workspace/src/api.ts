import type {
  Discontinuity,
  Hotspot,
  LadderTier,
  MoveEvidence,
  OstracisedEntity,
  TimelineRow,
  WorkspaceData,
} from './types'

/**
 * 對後端的唯一出入口。
 *
 * 路徑一律是相對的 `/api/*.json`：**伺服器（`ostracon ui`）與匯出的靜態站台
 * 用的是同一組 URL**，所以這裡不需要、也不該有「哪一種後端」的分支。
 * 開發時由 vite 的 proxy 轉到 127.0.0.1:4319。
 */
const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
  return response.json() as Promise<T>
}

/** 後端回的形狀。與 `src/ui/data.ts` 的型別一一對應，只取畫面用得到的欄位。 */
interface ApiSummary {
  rootPath: string
  changes: number
  untouched: number
  changesWithEntityIntent: number
  changesWithBatchIntent: number
  counts: { commits: number; revisions: number; entities: number }
  schemaVersion: number | null
  changeLevels: Record<string, number>
  ostracised: { shown: number; hiddenTests: number; suspected: number }
}

interface ApiEntity {
  stableKey: string
  path: string
  symbol: string
  revisions: number
  withEntityIntent: number
}

interface ApiLadder {
  tiers: Array<{
    tier: string
    accepted: number
    multiCandidate: number
    ambiguityMeaning: string
    verified: number | null
  }>
  crossFileTotal: number
  moves: Array<{
    symbol: string
    fromPath: string
    toPath: string
    shortSha: string
    subject: string
    exactJaccard: number | null
    ambiguitySize: number | null
  }>
}

interface ApiDiscontinuities {
  total: number
  incomparable: number
  rows: Array<{
    path: string
    symbol: string
    shortSha: string
    subject: string
    similarity: number | null
    prevStableKey: string
    nextStableKey: string
  }>
}

interface ApiHotspots {
  total: number
  hiddenTests: number
  rows: Array<Hotspot & { firstAt: string; lastAt: string }>
}

interface ApiEvolutionRow {
  shortSha: string
  committedAt: string
  changeLevel: string
  tier: string | null
  path: string
  lineStart: number
  lineEnd: number
  intent: Array<{ scope: string; text: string }>
}

interface ApiOstracised {
  rows: OstracisedEntity[]
  hiddenTests: number
  suspected: number
}

/**
 * 每一層的判準與說明。**這是關於演算法的靜態文字，不是資料**，所以留在前端。
 *
 * 判準的措辭要與 `src/match/ladder.ts` 一致——先前這裡把 L3c 寫成
 * 「shape identical」，而 L3c 其實是**同檔、`hash_raw` 相等、宣告未被任何
 * hunk 碰到、行號回推唯一命中**：是位置錨定，不是形狀。階梯裡根本沒有
 * 「形狀相等」這一層（`hash_shape` 用在 `change_level`，不在配對層）。
 */
const TIER_COPY: Record<string, { criterion: string; explanation: string }> = {
  L1: {
    criterion: 'same slot · same name',
    explanation: 'The declaration still occupies the same slot under the same qualified name.',
  },
  L2: {
    criterion: 'raw or token hash equal',
    explanation: 'Bytes or the token stream are identical, so nothing but trivia moved.',
  },
  L3: {
    criterion: 'alpha hash equal',
    explanation: 'Local identifiers were renamed; the alpha-normalised body is unchanged.',
  },
  L3b: {
    criterion: 'same file · alpha-self hash equal',
    explanation: 'The declaration renamed itself. Self references are normalised before comparison, and both buckets must be unique.',
  },
  L3c: {
    criterion: 'same file · raw equal · untouched by any hunk',
    explanation: 'Content alone is ambiguous here. The diff hunks prove the declaration was not touched, and reconstructing its old line range hits exactly one candidate.',
  },
  L4: {
    criterion: 'similarity recall · exact verification',
    explanation: 'MinHash only recalls candidates. Acceptance requires exact n-gram Jaccard, never the estimate.',
  },
  L5: {
    criterion: 'cross-file · exact verification',
    explanation: 'The same recall and verification as L4, but the candidate pool spans every file the commit touched. This is the only tier that can see a move.',
  },
}

const TIER_ORDER = ['L1', 'L2', 'L3', 'L3b', 'L3c', 'L4', 'L5']

const firstDifference = (changeLevel: string) => ({
  none: 'nothing differs',
  raw: 'raw bytes differ',
  token: 'tokens differ',
  alpha: 'alpha-normalised body differs',
  shape: 'structure differs',
  birth: 'first appearance',
  death: 'removed',
}[changeLevel] ?? changeLevel)

const changeSummary = (changeLevel: string) =>
  changeLevel === 'none'
    ? 'observed, but nothing changed'
    : changeLevel === 'shape'
      ? 'structural refactor'
      : `change level · ${changeLevel}`

/**
 * 時間軸要展示哪一個宣告：**有專屬理由、而且時間軸最長的那一個**。
 *
 * 不寫死 stable_key——換一套語料就會指到不存在的東西，而那正是稀疏訊號
 * 最需要被找到的場景（實測 vuejs/core 的 compileScript 是 306 列裡藏 2 條）。
 */
const featuredEntity = (entities: ApiEntity[]): ApiEntity | undefined =>
  entities
    .filter((entity) => entity.withEntityIntent > 0)
    .sort((a, b) => b.revisions - a.revisions)[0] ?? entities[0]

export async function fetchWorkspace(): Promise<WorkspaceData> {
  // **五個端點平行抓。** 舊的三欄頁面把三個 fetch 串起來，實測那樣光是伺服器
  // 就要 830 ms——那是冷開空白的一半。這幾個資源彼此獨立，沒有理由排隊。
  const [summary, entities, ladder, discontinuities, hotspots, ostracised] =
    await Promise.all([
      get<ApiSummary>('/api/summary.json'),
      get<ApiEntity[]>('/api/entities.json'),
      get<ApiLadder>('/api/ladder.json'),
      get<ApiDiscontinuities>('/api/discontinuities.json'),
      get<ApiHotspots>('/api/hotspots.json'),
      get<ApiOstracised>('/api/ostracised.json'),
    ])

  const featured = featuredEntity(entities)
  // 時間軸依賴上一步的結果（要先知道挑哪一個），所以只有它在第二段。
  const rows = featured
    ? await get<ApiEvolutionRow[]>(`/api/evolution/${featured.stableKey}.json`)
    : []

  const tiers: LadderTier[] = TIER_ORDER.flatMap((id) => {
    const tier = ladder.tiers.find((item) => item.tier === id)
    if (tier === undefined) return []
    return [{
      id: id as LadderTier['id'],
      count: tier.accepted,
      multiCandidate: tier.multiCandidate,
      // **這個欄位在不同層是不同的意思**，所以後端把語意一起送過來，
      // 畫面不自己解讀，也不把三層加總。
      ambiguityMeaning: tier.ambiguityMeaning as LadderTier['ambiguityMeaning'],
      // null = 這一層沒有「驗證過幾次」這回事，不是驗證了 0 次。
      exactVerified: tier.verified !== null,
      ...TIER_COPY[id]!,
    }]
  })

  const moves: MoveEvidence[] = ladder.moves.map((move) => ({
    symbol: move.symbol,
    fromPath: move.fromPath,
    toPath: move.toPath,
    sha: move.shortSha,
    subject: move.subject,
    exactJaccard: move.exactJaccard,
    ambiguitySize: move.ambiguitySize,
  }))

  const discontinuityRows: Discontinuity[] = discontinuities.rows.map((row, index) => ({
    id: index,
    symbol: row.symbol,
    similarity: row.similarity,
    sha: row.shortSha,
    subject: row.subject,
    path: row.path,
    beforeEntity: row.prevStableKey,
    afterEntity: row.nextStableKey,
  }))

  const timelineRows: TimelineRow[] = rows.map((row, index) => {
    const entityRationale = row.intent.find((claim) => claim.scope === 'entity')
    return {
      index: index + 1,
      sha: row.shortSha,
      date: row.committedAt.slice(0, 10),
      location: `${row.path.split('/').pop()}:${row.lineStart}–${row.lineEnd}`,
      tier: row.tier ?? '—',
      firstDifference: firstDifference(row.changeLevel),
      change: changeSummary(row.changeLevel),
      ...(entityRationale ? { rationale: entityRationale.text } : {}),
    }
  })

  return {
    repository: {
      name: summary.rootPath,
      commits: summary.counts.commits,
      revisions: summary.counts.revisions,
      entities: summary.counts.entities,
      schema: summary.schemaVersion === null ? 'unknown' : `v${summary.schemaVersion}`,
    },
    ladder: tiers,
    crossFileTotal: ladder.crossFileTotal,
    moves,
    discontinuities: {
      total: discontinuities.total,
      incomparable: discontinuities.incomparable,
      rows: discontinuityRows,
    },
    timeline: {
      symbol: featured?.symbol ?? '—',
      path: featured?.path ?? '',
      stableKey: featured?.stableKey ?? '',
      total: timelineRows.length,
      entityRationales: rows.filter((row) =>
        row.intent.some((claim) => claim.scope === 'entity')
      ).length,
      batchRationales: rows.filter((row) =>
        row.intent.length > 0 && row.intent.every((claim) => claim.scope === 'batch')
      ).length,
      rows: timelineRows,
    },
    hotspots: hotspots.rows,
    hotspotsTotal: hotspots.total,
    hotspotsHiddenTests: hotspots.hiddenTests,
    changeDistribution: {
      none: summary.changeLevels.none ?? 0,
      shape: summary.changeLevels.shape ?? 0,
      total: summary.changes + summary.untouched,
    },
    ostracised: {
      // A 級確證 = 列出的 + 測試檔裡被排除的。C 級是疑似，**不混進 A**。
      strengthA: ostracised.rows.length + ostracised.hiddenTests,
      strengthC: ostracised.suspected,
      shown: ostracised.rows.length,
      hiddenTests: ostracised.hiddenTests,
      rows: ostracised.rows,
    },
  }
}
