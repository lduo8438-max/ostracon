export type ViewId = 'ladder' | 'discontinuities' | 'timeline' | 'hotspots' | 'ostracised'

export interface RepositorySummary {
  name: string
  commits: number
  revisions: number
  entities: number
  schema: string
}
// quickCheck 與 indexedMinutesBefore/After 已移除：那是 **angular 壓力測試的
// 基準數字**，不是被索引語料的屬性。放在每一套語料共用的標頭上，就會出現
// 「標題寫 vuejs/core、數字是 angular」——那正是接上真端點前發生的事。
// 那些數字屬於 README 與 docs/benchmarks/，不屬於這個畫面。

/**
 * `multiCandidate` 在不同層代表不同的事，所以後端把語意一起送過來。
 * 畫面**不得**自行解讀，也不得把三種加總。
 */
export type AmbiguityMeaning =
  | 'unique-by-construction'
  | 'content-class-size'
  | 'tied-candidates'

export interface LadderTier {
  id: 'L1' | 'L2' | 'L3' | 'L3b' | 'L3c' | 'L4' | 'L5'
  count: number
  /** `ambiguity_size > 1` 的筆數。讀它之前先看 `ambiguityMeaning`。 */
  multiCandidate: number
  ambiguityMeaning: AmbiguityMeaning
  criterion: string
  explanation: string
  /** false 對 L1–L3c 的意思是「不適用」，不是「驗證失敗」。 */
  exactVerified: boolean
}

export interface MoveEvidence {
  symbol: string
  fromPath: string
  toPath: string
  sha: string
  subject: string
  /** 精確 Jaccard。MinHash 的估計值只負責召回，**不會出現在這裡**。 */
  exactJaccard: number | null
  ambiguitySize: number | null
}

export interface Discontinuity {
  id: number
  symbol: string
  /** null = 舊內容無法解析，沒有可比較的集合；0 = 比較過且完全無交集。 */
  similarity: number | null
  sha: string
  subject: string
  path: string
  beforeEntity: string
  afterEntity: string
}
// beforeCode / afterCode 尚未接。索引**不存原始碼**（只存 blob_sha 與 byte
// 位移），要顯示片段得回讀 git blob——實跑驗過可行（17 ms／段，549 條合計
// 約 278 KB），但它牽涉匯出流程與一條授權注意事項，另外一刀處理。
// 在那之前畫面誠實留白，不編造程式碼。

export interface TimelineRow {
  index: number
  sha: string
  date: string
  location: string
  /** 這一版是被哪一層接起來的。誕生那一列沒有前像，所以是 '—'。 */
  tier: string
  /** 四層雜湊裡第一個相異的層級。 */
  firstDifference: string
  change: string
  rationale?: string
}
// hunkTouched 尚未接。資料在 file_hunk 裡，但判準必須與 matcher 的
// `insidePureAddHunk` 共用——另寫一份就會出現「畫面說沒碰到、matcher 當時
// 認為碰到了」，那是最難發現的那種錯。

export interface Hotspot {
  stableKey: string
  symbol: string
  path: string
  structural: number
  observed: number
  days: number
  dead: boolean
}

export interface OstracisedEntity {
  stableKey: string
  symbol: string
  path: string
  durationDays: number
  strength: 'A' | 'C'
  method: string
  bornAt: string
  diedAt: string
  diedSha: string
  diedSubject: string
}

export interface WorkspaceData {
  repository: RepositorySummary
  ladder: LadderTier[]
  /** 跨檔案搬移的總數。`moves` 可能因為上限而較少。 */
  crossFileTotal: number
  moves: MoveEvidence[]
  discontinuities: { total: number; incomparable: number; rows: Discontinuity[] }
  timeline: {
    symbol: string
    path: string
    stableKey: string
    total: number
    entityRationales: number
    batchRationales: number
    rows: TimelineRow[]
  }
  hotspots: Hotspot[]
  /** 動過結構的宣告總數（未截斷）。清單只是其中前幾名。 */
  hotspotsTotal: number
  /** 被排除的測試檔宣告數。**排除不得靜默。** */
  hotspotsHiddenTests: number
  changeDistribution: { none: number; shape: number; total: number }
  ostracised: { strengthA: number; strengthC: number; shown: number; hiddenTests: number; rows: OstracisedEntity[] }
}
