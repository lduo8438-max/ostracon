import type {
  Discontinuity,
  DiscontinuityView,
  EntityListItem,
  Hotspot,
  HotspotView,
  LadderTier,
  LadderView,
  MoveEvidence,
  OstracisedEntity,
  OstracisedView,
  Repository,
  TimelineRow,
  TimelineView,
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
  withBatchIntent: number
  dead: boolean
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
 * **每個畫面只抓自己要的。**
 *
 * 一次抓齊六個端點是量出來被否決的：對 `ostracon ui` 而言 `node:sqlite` 是
 * 同步的、HTTP 伺服器是單執行緒，六個並行請求只會排在同一個 event loop 上
 * ——實測 1,434 ms，比舊頁面序列抓三個的 830 ms 還慢。靜態站台沒有這個瓶頸
 * （同一份資料 4 ms），但首屏會多下載 154 KB（gzip）的 JSON，其中
 * `ostracised.json` 50.9 KB 與 `discontinuities.json` 42.8 KB 在 ladder 頁
 * 一個位元組都用不到。
 *
 * 所以拆成逐資源：兩種後端都受益，而且理由不同——伺服器省的是同步查詢的
 * 排隊時間，靜態站台省的是頻寬。
 */

/** 外殼要的：語料身分與規模。每一頁都會用到，所以它是唯一「一定會抓」的。 */
export async function fetchSummary(): Promise<Repository & {
  changeDistribution: WorkspaceData['changeDistribution']
}> {
  const summary = await get<ApiSummary>('/api/summary.json')
  return {
    name: summary.rootPath,
    commits: summary.counts.commits,
    revisions: summary.counts.revisions,
    entities: summary.counts.entities,
    schema: summary.schemaVersion === null ? 'unknown' : `v${summary.schemaVersion}`,
    changeDistribution: {
      none: summary.changeLevels.none ?? 0,
      shape: summary.changeLevels.shape ?? 0,
      total: summary.changes + summary.untouched,
    },
  }
}

export async function fetchLadder(): Promise<LadderView> {
  const ladder = await get<ApiLadder>('/api/ladder.json')
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
  return {
    tiers,
    crossFileTotal: ladder.crossFileTotal,
    moves: ladder.moves.map((move) => ({
      symbol: move.symbol,
      fromPath: move.fromPath,
      toPath: move.toPath,
      sha: move.shortSha,
      subject: move.subject,
      exactJaccard: move.exactJaccard,
      ambiguitySize: move.ambiguitySize,
    })),
  }
}

export async function fetchDiscontinuities(): Promise<DiscontinuityView> {
  const view = await get<ApiDiscontinuities>('/api/discontinuities.json')
  return {
    total: view.total,
    incomparable: view.incomparable,
    rows: view.rows.map((row, index) => ({
      id: index,
      symbol: row.symbol,
      similarity: row.similarity,
      sha: row.shortSha,
      subject: row.subject,
      path: row.path,
      beforeEntity: row.prevStableKey,
      afterEntity: row.nextStableKey,
    })),
  }
}

export async function fetchHotspots(): Promise<HotspotView> {
  const view = await get<ApiHotspots>('/api/hotspots.json')
  return { rows: view.rows, total: view.total, hiddenTests: view.hiddenTests }
}

export async function fetchOstracised(): Promise<OstracisedView> {
  const view = await get<ApiOstracised>('/api/ostracised.json')
  return {
    // A 級確證 = 列出的 + 測試檔裡被排除的。C 級是疑似，**不混進 A**。
    strengthA: view.rows.length + view.hiddenTests,
    strengthC: view.suspected,
    shown: view.rows.length,
    hiddenTests: view.hiddenTests,
    rows: view.rows,
  }
}

/**
 * 宣告清單。**picker 的資料來源**，也是挑「精選」那一條時的依據。
 *
 * 匯出時是聯集：有意圖的一律收，再用改動量補滿（實測 vuejs/core 752 筆）。
 * 752 筆在瀏覽器裡篩選是零成本的，不需要伺服器端搜尋。
 */
export async function fetchEntities(): Promise<EntityListItem[]> {
  const entities = await get<ApiEntity[]>('/api/entities.json')
  return entities.map((entity) => ({
    stableKey: entity.stableKey,
    symbol: entity.symbol,
    path: entity.path,
    revisions: entity.revisions,
    withEntityIntent: entity.withEntityIntent,
    withBatchIntent: entity.withBatchIntent,
    dead: entity.dead,
  }))
}

/**
 * 沒有指定要看哪一個時的預設：**有專屬理由、而且時間軸最長的那一個**。
 *
 * 不寫死 stable_key——換一套語料就會指到不存在的東西，而那正是稀疏訊號最需要
 * 被找到的場景（實測 vuejs/core 的 compileScript 是 306 列裡藏 2 條）。
 */
export const featuredKey = (entities: EntityListItem[]): string | undefined =>
  (entities.filter((entity) => entity.withEntityIntent > 0)
    .sort((a, b) => b.revisions - a.revisions)[0] ?? entities[0])?.stableKey

/**
 * 被推翻的做法也可以開時間軸。
 *
 * **它們的時間軸一定會被匯出**（`export.ts`：「清單看得到、點進去沒有資料，
 * 就是把一個落差換成另一個落差」），但它們**不一定在 `entities.json` 裡**——
 * 那份是策展過的（有意圖的一律收，再用改動量補滿）。實測 vuejs/core：
 * 537 條被推翻的做法有 493 條不在那 752 筆裡，而 1,245 個時間軸檔案正好是
 * 兩份名單的聯集。
 *
 * 只在 `entities.json` 裡找，就會讓產品自己產生的按鈕指向「不在匯出範圍」的
 * 錯誤頁。舊的三欄頁面兩份名單都查，這裡漏了。
 */
export async function fetchOstracisedTargets(): Promise<EntityListItem[]> {
  const view = await get<ApiOstracised>('/api/ostracised.json')
  return view.rows.map((row) => ({
    stableKey: row.stableKey,
    symbol: row.symbol,
    path: row.path,
    // 這份名單沒有改動數與理由數——**留 0 而不是猜**，畫面用 `dead` 分辨。
    revisions: 0,
    withEntityIntent: 0,
    withBatchIntent: 0,
    dead: true,
  }))
}

/** 一個宣告的完整時間軸。 */
export async function fetchEvolution(
  entity: EntityListItem,
): Promise<TimelineView> {
  const rows = await get<ApiEvolutionRow[]>(`/api/evolution/${entity.stableKey}.json`)
  return {
    symbol: entity.symbol,
    path: entity.path,
    stableKey: entity.stableKey,
    dead: entity.dead,
    total: rows.length,
    entityRationales: rows.filter((row) =>
      row.intent.some((claim) => claim.scope === 'entity')
    ).length,
    batchRationales: rows.filter((row) =>
      row.intent.length > 0 && row.intent.every((claim) => claim.scope === 'batch')
    ).length,
    rows: rows.map((row, index) => {
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
    }),
  }
}
