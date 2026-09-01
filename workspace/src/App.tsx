import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import {
  fetchDiscontinuities,
  fetchHotspots,
  fetchLadder,
  fetchEntities,
  fetchEvolution,
  fetchOstracised,
  fetchOstracisedTargets,
  fetchSummary,
  featuredKey,
} from './api'
// **直接用後端那一份，不抄。** page-logic.ts 是零相依的純函式，Vite 只會把
// 用到的那兩個打包進來，不會把後端拖進前端的建置圖。舊頁面與新前端共用同一組
// 網址，任何一邊改了編碼規則另一邊的連結就失效——所以它必須只有一份。
import { formatTimelineHash, parseTimelineHash } from '../../src/ui/page-logic'
import type {
  Discontinuity,
  DiscontinuityView,
  EntityListItem,
  Snippet,
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
  ViewId,
  WorkspaceData,
} from './types'

/**
 * 每個畫面自己抓自己的資料。
 *
 * **載入中不是空白，錯誤不是靜默。** 這個工具的畫面上有很多合理的空白
 * （沒有理由就留白），所以「還在抓」與「本來就沒有」必須長得不一樣——
 * 否則使用者會把載入狀態讀成觀測結果。
 */
function ViewQuery<T>({ query, children }: {
  query: { data?: T; error: unknown; isPending: boolean }
  children: (data: T) => React.ReactNode
}) {
  if (query.isPending) {
    return <div className="view-state" role="status"><i className="view-spinner" aria-hidden="true" />Reading the index…</div>
  }
  if (query.error || !query.data) {
    return (
      <div className="view-state error" role="alert">
        <strong>This view could not be loaded.</strong>
        <code>{query.error instanceof Error ? query.error.message : 'Unknown error'}</code>
      </div>
    )
  }
  return <>{children(query.data)}</>
}

const navItems: Array<{ id: ViewId; index: string; label: string }> = [
  { id: 'ladder', index: '01', label: 'Match ladder' },
  { id: 'discontinuities', index: '02', label: 'Discontinuities' },
  { id: 'timeline', index: '03', label: 'Timeline' },
  { id: 'hotspots', index: '04', label: 'Hotspots' },
  { id: 'ostracised', index: '05', label: 'Ostracised' },
]

const format = (value: number) => value.toLocaleString('en-US')
/**
 * hunk 證據的三態。**「unknown」不是「沒碰到」**——這次改動根本沒有 hunk
 * 資料（純改名、二進位），把它顯示成「沒碰到」就是把不知道當成負證據。
 */
const HUNK_LABEL: Record<TimelineRow['hunkEvidence'], string> = {
  touched: 'hunk touched it',
  untouched: 'hunk missed it',
  unknown: 'no hunk data',
}
const HUNK_TITLE: Record<TimelineRow['hunkEvidence'], string> = {
  touched: 'A diff hunk in this commit overlaps the declaration',
  untouched: 'The file changed, but no hunk overlaps this declaration',
  unknown: 'This change carries no hunk information — not the same as untouched',
}
const shortSha = (value: string) => value.slice(0, 10)
const percentage = (value: number) => `${(value * 100).toFixed(1)}%`
/**
 * 語料識別。匯出時 `--label` 已經把本機路徑換成語料名（`vuejs/core`），本機跑
 * `ostracon ui` 時則是絕對路徑——**那讀起來像開發診斷資訊，不該塞進 breadcrumb**。
 * 所以主標題用 basename，這裡只補最後兩段，完整值留在 title 屬性。
 */
const shortenPath = (value: string) => {
  const parts = value.split('/').filter(Boolean)
  return parts.length <= 2 ? value : `…/${parts.slice(-2).join('/')}`
}

function PageIntro({ eyebrow, title, body, aside }: { eyebrow: React.ReactNode; title: React.ReactNode; body: string; aside?: React.ReactNode }) {
  return (
    <header className="page-intro">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-lede">{body}</p>
      </div>
      {aside ? <div className="intro-aside">{aside}</div> : null}
    </header>
  )
}

function MethodNote({ children }: { children: React.ReactNode }) {
  return (
    <details className="method-note">
      <summary>How this was calculated</summary>
      <div>{children}</div>
    </details>
  )
}

function LiteralEvidence({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div className="literal-evidence">
      <span className="literal-label">Literal evidence</span>
      <blockquote>“{children}”</blockquote>
      {note ? <p>{note}</p> : null}
    </div>
  )
}

function LadderGlyph({ tiers, selected }: { tiers: LadderTier[]; selected: LadderTier['id'] }) {
  const max = Math.log10(Math.max(...tiers.map(t => t.count)) + 1)
  return (
    <svg className="ladder-glyph" viewBox="0 0 164 250" role="img" aria-label="Accepted match tiers shown on a logarithmic scale">
      {tiers.map((tier, index) => {
        const width = 28 + (Math.log10(tier.count + 1) / max) * 122
        return (
          <g key={tier.id} transform={`translate(7 ${index * 35 + 6})`}>
            <rect className="glyph-track" width="150" height="24" rx="7" />
            <rect className={selected === tier.id ? 'glyph-bar glyph-bar-active' : 'glyph-bar'} width={width} height="24" rx="7" />
          </g>
        )
      })}
    </svg>
  )
}

/**
 * 只有 L5 拿得到「真實的搬移範例」——跨檔案搬移是唯一一個後端逐條回傳的。
 *
 * 其餘六層**不編造範例**。先前這裡替 L1–L4 各寫了一筆假的配對（假 sha、假路徑），
 * 而這個工具唯一的賣點就是誠實。改成呈現判準、計數與那個計數的語意——
 * 那些是真的，而且比一條假範例更能說明那一層在做什麼。
 */
function TierEvidence({ tier, move, moveIndex, moveCount, onNext }: {
  tier: LadderTier
  move?: MoveEvidence
  moveIndex: number
  moveCount: number
  onNext: () => void
}) {
  const meaning = {
    'unique-by-construction': 'unique by construction — both buckets must hold exactly one candidate, so this is always zero',
    'content-class-size': 'size of the content-equivalence class — reaching this tier means content was ambiguous and position resolved it',
    'tied-candidates': 'tied candidates still available at acceptance',
  }[tier.ambiguityMeaning]

  return (
    <motion.aside key={`${tier.id}-${move?.sha ?? 'none'}`} className="evidence-panel" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.18 }}>
      <p className="eyebrow">{tier.id}{move ? ` · ${moveIndex + 1} of ${moveCount}` : ''}</p>
      {move ? (
        <>
          <h2 className="mono evidence-symbol">{move.symbol}</h2>
          <p className="mono quiet">{move.sha} · {move.subject}</p>
          <div className="path-move">
            <span>From</span><code>{move.fromPath}</code><b aria-hidden="true">↓</b><span>To</span><code>{move.toPath}</code>
          </div>
        </>
      ) : (
        <>
          <h2 className="evidence-symbol">{format(tier.count)} accepted</h2>
          <p className="quiet">Aggregate tier · per-link evidence not exported.</p>
        </>
      )}
      <div className="verification-grid">
        <div><span>Criterion</span><strong>{tier.criterion}</strong></div>
        <div><span>Exact verification</span><strong className={tier.exactVerified ? 'cool' : ''}>{tier.exactVerified ? 'required' : 'not applicable'}</strong></div>
        {move?.exactJaccard != null ? <div><span>Exact Jaccard</span><strong>{move.exactJaccard.toFixed(4)}</strong></div> : null}
        <div><span>Multi-candidate</span><strong>{format(tier.multiCandidate)}</strong></div>
      </div>
      {move ? <LiteralEvidence note="Verbatim commit subject — not inferred intent.">{move.subject}</LiteralEvidence> : null}
      <MethodNote>
        <p>{tier.explanation}</p>
        <p><b>Multi-candidate</b> here means: {meaning}.</p>
        {tier.exactVerified
          ? <p>MinHash only recalls candidates. Acceptance requires exact n-gram Jaccard, never the estimate.</p>
          : <p>This tier is deterministic. &ldquo;Not applicable&rdquo; is not the same as &ldquo;verified zero times&rdquo;.</p>}
      </MethodNote>
      {tier.id === 'L5' && moveCount > 1 ? <button className="action-button" onClick={onNext}>Next L5 evidence <span>{String(((moveIndex + 1) % moveCount) + 1).padStart(2, '0')} / {moveCount}</span></button> : null}
    </motion.aside>
  )
}

function LadderView() {
  const query = useQuery({ queryKey: ['ladder'], queryFn: fetchLadder })
  return <ViewQuery query={query}>{data => <LadderBody data={data} />}</ViewQuery>
}

function LadderBody({ data }: { data: LadderView }) {
  const [selected, setSelected] = useState<LadderTier['id']>('L5')
  const [moveIndex, setMoveIndex] = useState(0)
  const tier = data.tiers.find(item => item.id === selected) ?? data.tiers[data.tiers.length - 1]!
  const move = tier.id === 'L5' && data.moves.length > 0
    ? data.moves[moveIndex % data.moves.length]
    : undefined

  return (
    <div className="view">
      <PageIntro eyebrow="Match ladder" title={<>{format(data.crossFileTotal)} moves crossed<br />a file boundary.</>} body="A progressive matcher keeps identity only when every weaker explanation has been exhausted. Select a tier to audit its rule and a real accepted revision." aside={<div className="verified-pill"><i />Output verified</div>} />
      <div className="ladder-layout">
        <section className="panel ladder-panel">
          <div className="panel-heading"><span>Accepted links · first matching tier</span><span>log scale</span></div>
          <div className="ladder-body">
            <LadderGlyph tiers={data.tiers} selected={selected} />
            <div className="tier-list">
              {data.tiers.map(item => (
                <button key={item.id} onClick={() => { setSelected(item.id); setMoveIndex(0) }} className={item.id === selected ? 'tier-row selected' : 'tier-row'}>
                  <strong>{item.id}</strong><b>{format(item.count)}</b><span>{item.criterion}</span><i aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
          <p className="panel-foot">L4/L5 are recalled by MinHash, then accepted only after exact Jaccard verification.</p>
        </section>
        <TierEvidence tier={tier} move={move} moveIndex={moveIndex} moveCount={data.moves.length} onNext={() => setMoveIndex(index => (index + 1) % data.moves.length)} />
      </div>
    </div>
  )
}

/**
 * 一段原始碼，或說明它為什麼不在。
 *
 * **索引不存原始碼**（只有 blob hash 與 byte 位移），所以片段是回讀 git 切出
 * 來的——匯出時沒給 `--repo` 就沒有。那不是缺陷，但**必須說出來**：這個介面
 * 有很多合理的空白，使用者不該把「沒讀」當成「沒有這段程式碼」。
 */
function SnippetBlock({ snippet, reason, empty }: {
  snippet?: Snippet
  reason: DiscontinuityView['snippets']
  empty: string
}) {
  if (snippet) {
    return (
      <>
        <pre>{snippet.text}</pre>
        {snippet.truncated
          ? <small className="snippet-note">First {snippet.text.split('\n').length} of {snippet.lines} lines</small>
          : <small className="snippet-note quiet">{snippet.lines} line{snippet.lines === 1 ? '' : 's'}</small>}
      </>
    )
  }
  const why = reason === 'not-requested'
    ? 'Source was not embedded in this export. The index stores a blob hash and byte offsets, never the source itself.'
    : reason === 'repo-unavailable'
      ? 'The corpus could not be read, so the source could not be recovered.'
      : empty
  return <p className="honest-blank">{why}</p>
}

function DiscontinuityCard({ row, selected, onClick }: { row: Discontinuity; selected: boolean; onClick: () => void }) {
  return (
    <button className={selected ? 'list-row selected' : 'list-row'} onClick={onClick}>
      <span><strong className="mono">{row.symbol}</strong><code>{row.path}</code></span>
      <span className="mono">sim {row.similarity == null ? '—' : row.similarity.toFixed(4)}<small>{shortSha(row.sha)}</small></span>
    </button>
  )
}

function DiscontinuitiesView() {
  const query = useQuery({ queryKey: ['discontinuities'], queryFn: fetchDiscontinuities })
  return <ViewQuery query={query}>{data => <DiscontinuitiesBody data={data} />}</ViewQuery>
}

function DiscontinuitiesBody({ data }: { data: DiscontinuityView }) {
  const [selectedId, setSelectedId] = useState(data.rows[0].id)
  const selected = data.rows.find(row => row.id === selectedId) ?? data.rows[0]
  return (
    <div className="view">
      <PageIntro eyebrow="Discontinuities" title={<>The slot stayed.<br />The lineage did not.</>} body="These are not moves. The same qualified slot reappears with a different entity, so earlier discussion must not be carried forward as evidence." aside={<div className="count-pill">{format(data.total)} recorded</div>} />
      <div className="split-layout">
        <section className="panel list-panel">
          <div className="panel-heading"><span>{data.total} breaks</span><span>lowest similarity first</span></div>
          <div className="stack-list">{data.rows.map(row => <DiscontinuityCard key={row.id} row={row} selected={row.id === selected.id} onClick={() => setSelectedId(row.id)} />)}</div>
          <p className="panel-foot cool">{data.rows.length} of {format(data.total)} shown · {data.incomparable} had no comparable token set (recorded as null, not zero)</p>
        </section>
        <motion.section key={selected.id} className="panel discontinuity-detail" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}>
          <p className="eyebrow">Selected break · #{String(selected.id).padStart(3, '0')}</p>
          <h2 className="mono detail-title">{selected.symbol}</h2>
          <p className="mono quiet">{shortSha(selected.sha)} · {selected.subject}</p>
          <div className="revision-pair">
            <div>
              <span>Before · previous entity</span><code>{selected.path}</code>
              <SnippetBlock snippet={selected.before} reason={data.snippets} empty="No earlier revision in this slot." />
              <small className="mono">{selected.beforeEntity.slice(0, 12)}…</small>
            </div>
            <div className="after">
              <span>After · new entity</span><code>{selected.path}</code>
              <SnippetBlock snippet={selected.after} reason={data.snippets} empty="Not available." />
              <small className="mono">{selected.afterEntity.slice(0, 12)}…</small>
            </div>
          </div>
          <div className="verdict"><strong>Same slot · different entity</strong><p>Responsibility continues under the qualified slot, but code ancestry does not. Similarity {selected.similarity?.toFixed(4) ?? '—'} is recorded, not promoted into identity.</p></div>
          <MethodNote><p>The adjacent revisions resolve to the same <code>slot_id</code>. No accepted ladder match exists, so <code>slot_discontinuity</code> records both entity IDs, the commit, and nullable similarity.</p></MethodNote>
          <div className="policy-note"><span>Evidence policy</span><p>Claims attached to the earlier entity stop here. The slot remains visible while the ancestry break stays explicit.</p></div>
        </motion.section>
      </div>
    </div>
  )
}

function TimelineRowView({ row, selected }: { row: TimelineRow; selected: boolean }) {
  return (
    <article id={`timeline-${row.sha}`} className={selected ? 'timeline-row selected' : 'timeline-row'}>
      <div className="timeline-commit"><small>{String(row.index).padStart(3, '0')}</small><strong>{row.sha}</strong><span>{row.date}</span><code>{row.location}</code></div>
      <div className="timeline-change"><button className="tier-badge" title="The first hash layer that differs">{row.tier} · {row.firstDifference}</button><span className={`hunk-${row.hunkEvidence}`} title={HUNK_TITLE[row.hunkEvidence]}>{HUNK_LABEL[row.hunkEvidence]}</span><p>{row.change}</p></div>
      <div className="timeline-evidence">{row.rationale ? <LiteralEvidence>{row.rationale}</LiteralEvidence> : <p className="honest-blank">— no entity-level or batch-level rationale</p>}</div>
    </article>
  )
}

/**
 * 宣告 picker。**這是新前端補回舊介面最有價值的能力**：五個畫面本來都是策展
 * 好的故事，但這個工具的核心問題是「**我那個宣告**發生了什麼」，而那需要能
 * 任選一個。
 *
 * 每一列顯示改動數與**專屬理由數**——理由是稀有的，所以「值不值得點進去」
 * 這件事必須在點進去之前就看得到。
 */
function DeclarationPicker({ entities, current, onPick, onClose }: {
  entities: EntityListItem[]
  current?: string
  onPick: (entity: EntityListItem) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const needle = query.trim().toLowerCase()
  const matches = useMemo(() => {
    const scored = needle === ''
      ? entities
      : entities.filter(e => `${e.symbol} ${e.path}`.toLowerCase().includes(needle))
    // 有專屬理由的排前面：那是這個工具唯一稀有的東西，藏在第 300 名沒有意義。
    return [...scored].sort((a, b) =>
      (b.withEntityIntent > 0 ? 1 : 0) - (a.withEntityIntent > 0 ? 1 : 0)
      || b.revisions - a.revisions).slice(0, 60)
  }, [entities, needle])

  return (
    <div className="picker-backdrop" onClick={onClose} role="presentation">
      <div className="picker" onClick={event => event.stopPropagation()} role="dialog" aria-label="Choose a declaration">
        <input
          ref={inputRef}
          className="picker-input"
          type="search"
          value={query}
          placeholder="Filter by symbol or path"
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'Enter' && matches[0]) onPick(matches[0])
          }}
        />
        <div className="picker-list">
          {matches.length === 0
            ? <p className="honest-blank">Nothing matches. {format(entities.length)} declarations are exported.</p>
            : matches.map(entity => (
              <button
                key={entity.stableKey}
                className={entity.stableKey === current ? 'picker-row current' : 'picker-row'}
                onClick={() => onPick(entity)}
              >
                <span>
                  <strong className="mono">{entity.symbol}</strong>
                  {entity.dead ? <i className="tag-dead">removed</i> : null}
                  <code>{entity.path}</code>
                </span>
                <span className="picker-meta">
                  <b>{format(entity.revisions)}</b> changes
                  {entity.withEntityIntent > 0
                    ? <em className="has-rationale">{entity.withEntityIntent} rationale{entity.withEntityIntent === 1 ? '' : 's'}</em>
                    : entity.withBatchIntent > 0
                      ? <em>{entity.withBatchIntent} batch-only</em>
                      : <em className="quiet">no rationale</em>}
                </span>
              </button>
            ))}
        </div>
        <p className="picker-foot">
          Showing {matches.length} of {format(entities.length)} · declarations with an entity-specific rationale come first
        </p>
      </div>
    </div>
  )
}

function TimelineView({ stableKey, onSelect }: {
  stableKey?: string
  onSelect: (key: string) => void
}) {
  const list = useQuery({ queryKey: ['entities'], queryFn: fetchEntities })
  const entities = list.data
  const key = stableKey ?? (entities ? featuredKey(entities) : undefined)
  const inEntities = entities?.find(item => item.stableKey === key)
  // **被推翻的做法不在 entities.json 裡，但它們的時間軸一定被匯出。**
  // 只在第一份名單裡找，會讓 Ostracised 的「Open its timeline」指向錯誤頁。
  // 只有找不到時才抓第二份——那份 50.9 KB，沒必要每次都付。
  const fallback = useQuery({
    queryKey: ['ostracised-targets'],
    queryFn: fetchOstracisedTargets,
    enabled: entities !== undefined && key !== undefined && inEntities === undefined,
  })
  const entity = inEntities ?? fallback.data?.find(item => item.stableKey === key)
  const stillLooking = entities !== undefined && inEntities === undefined
    && key !== undefined && fallback.isPending
  const evolution = useQuery({
    queryKey: ['evolution', entity?.stableKey],
    queryFn: () => fetchEvolution(entity!),
    enabled: entity !== undefined,
  })
  const query = {
    isPending: list.isPending || stillLooking || (entity !== undefined && evolution.isPending),
    error: list.error ?? fallback.error ?? evolution.error,
    data: entities && evolution.data
      ? { entities, timeline: evolution.data }
      : undefined,
  }
  // 兩份名單都找過了還是沒有——網址寫錯或匯出範圍不含它。**要說出來，不要
  // 靜默退回精選**，否則使用者以為自己看的是他要的那一個。
  if (entities && stableKey !== undefined && entity === undefined && !stillLooking) {
    return (
      <div className="view-state error" role="alert">
        <strong>That declaration is not in this export.</strong>
        <code>{stableKey}</code>
        <p>Neither the declaration list nor the ostracised list contains it.</p>
      </div>
    )
  }
  return (
    <ViewQuery query={query}>
      {data => <TimelineBody data={data.timeline} entities={data.entities} onSelect={onSelect} />}
    </ViewQuery>
  )
}

function TimelineBody({ data, entities, onSelect }: {
  data: TimelineView
  entities: EntityListItem[]
  onSelect: (key: string) => void
}) {
  const [picking, setPicking] = useState(false)
  const hits = data.rows.filter(row => row.rationale)
  const initialHit = Math.max(0, hits.findIndex(row => window.location.hash.endsWith(row.sha)))
  const [hitIndex, setHitIndex] = useState(initialHit)
  const selected = hits[hitIndex] ?? hits[0]
  const rowRef = useRef<HTMLDivElement>(null)

  // 「/」開 picker：命令列的慣例，而且不與瀏覽器既有快捷鍵衝突。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.key === '/') { event.preventDefault(); setPicking(true) }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const jump = () => {
    const next = (hitIndex + 1) % hits.length
    const target = hits[next]
    setHitIndex(next)
    history.replaceState(null, '', `#${data.stableKey}/${target.sha}`)
    requestAnimationFrame(() => document.getElementById(`timeline-${target.sha}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }

  useEffect(() => {
    if (window.location.hash.includes('/')) requestAnimationFrame(() => document.getElementById(`timeline-${selected.sha}`)?.scrollIntoView({ block: 'center' }))
  }, [])

  return (
    <div className="view" ref={rowRef}>
      {picking ? (
        <DeclarationPicker
          entities={entities}
          current={data.stableKey}
          onPick={entity => { setPicking(false); onSelect(entity.stableKey) }}
          onClose={() => setPicking(false)}
        />
      ) : null}
      <PageIntro
        eyebrow={<button className="picker-open" onClick={() => setPicking(true)}>Timeline · <b>change declaration</b> <kbd>/</kbd></button>}
        title={<span className="mono">{data.symbol}{data.dead ? <i className="tag-dead">removed</i> : null}</span>}
        body={data.path} aside={<button className="jump-control" onClick={jump}><b>{data.entityRationales}</b><span>entity rationales<small>{data.batchRationales} batch-only</small></span><code>{hitIndex + 1} / {data.total}</code></button>} />
      <section className="panel timeline-panel">
        <div className="timeline-head"><span>Commit / location</span><span>Structural change</span><span>Evidence — blank is honest</span></div>
        <div className="timeline-rows">{data.rows.map(row => <TimelineRowView key={row.sha} row={row} selected={row.sha === selected.sha} />)}</div>
        <p className="panel-foot">Rows use a fixed block size. Selection is an inset box-shadow; it never changes border, padding, or alignment.</p>
      </section>
      <MethodNote><p>The tier badge names the first hash layer that differs and whether the commit hunk touched the declaration. Cold-open instrumentation for fetch / render / alignRows is intentionally marked as not yet measured.</p></MethodNote>
    </div>
  )
}

function annualRate(row: Hotspot) { return row.structural / (row.days / 365) }

function HotspotsView({ onOpen }: { onOpen: (key: string) => void }) {
  // 熱點的分母（`none` 佔多少）在 summary 裡，而 summary 是外殼一定會抓的，
  // 所以這裡是快取命中，不是第二次請求。
  const hotspots = useQuery({ queryKey: ['hotspots'], queryFn: fetchHotspots })
  const summary = useQuery({ queryKey: ['summary'], queryFn: fetchSummary })
  const query = {
    isPending: hotspots.isPending || summary.isPending,
    error: hotspots.error ?? summary.error,
    data: hotspots.data && summary.data
      ? { ...hotspots.data, changeDistribution: summary.data.changeDistribution }
      : undefined,
  }
  return <ViewQuery query={query}>{data => <HotspotsBody data={data} onOpen={onOpen} />}</ViewQuery>
}

function HotspotsBody({ data, onOpen }: {
  data: HotspotView & { changeDistribution: WorkspaceData['changeDistribution'] }
  onOpen: (key: string) => void
}) {
  const [mode, setMode] = useState<'absolute' | 'rate'>('absolute')
  const rows = useMemo(() => [...data.rows].sort((a, b) => mode === 'absolute' ? b.structural - a.structural : annualRate(b) - annualRate(a)), [data.rows, mode])
  const max = Math.max(...rows.map(row => mode === 'absolute' ? row.structural : annualRate(row)))
  const noneShare = data.changeDistribution.none / data.changeDistribution.total
  // 用「速率最高但絕對次數不高」的那一筆當反例；換一套語料不保證叫
  // processSuspense，所以用資料挑，不用名字寫死。
  const rateOutlier = [...data.rows].sort((a, b) => annualRate(b) - annualRate(a))
    .find(row => row.structural < Math.max(...data.rows.map(r => r.structural)) / 2)
  return (
    <div className="view">
      <PageIntro eyebrow="Hotspots" title={<>Structural churn,<br />not edit volume.</>} body={`Rank entities by shape-changing revisions. The ${format(data.changeDistribution.none)} untouched pairs stay out of the list instead of inflating activity.`} aside={<div className="segmented"><button className={mode === 'absolute' ? 'active' : ''} onClick={() => setMode('absolute')}>Absolute</button><button className={mode === 'rate' ? 'active' : ''} onClick={() => setMode('rate')}>Rate / year</button></div>} />
      <div className="hotspot-layout">
        <section className="panel hotspot-table">
          <div className="hotspot-head"><span># · Entity</span><span>{mode === 'absolute' ? 'Structural / observed' : 'Structural / year'}</span><span>Span</span></div>
          {rows.map((row, index) => {
            const value = mode === 'absolute' ? row.structural : annualRate(row)
            return <article className={index === 0 ? 'hotspot-row selected' : 'hotspot-row'} key={row.stableKey} onClick={() => onOpen(row.stableKey)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen(row.stableKey) }} title="Open this timeline"><b>{String(index + 1).padStart(2, '0')}</b><div><strong className="mono">{row.symbol}</strong><code>{row.path}</code></div><div><strong>{mode === 'absolute' ? `${row.structural} / ${row.observed}` : value.toFixed(1)}</strong><i style={{ '--bar': `${(value / max) * 100}%` } as React.CSSProperties} /></div><span>{format(Math.round(row.days))}d</span></article>
          })}
          <p className="panel-foot">{data.rows.length} of {format(data.total)} entities with structural change · {data.hiddenTests} in test files excluded · <code>change_level = shape</code></p>
        </section>
        <aside className="hotspot-side">
          <section className="distribution-panel panel"><p className="eyebrow">Change-level distribution</p><strong>{format(data.changeDistribution.none)}</strong><span>none · {percentage(noneShare)}</span><i><b style={{ width: `${noneShare * 100}%` }} /></i><p>{format(data.changeDistribution.shape)} shape changes enter the ranking.</p></section>
          {rateOutlier ? <section className="panel rate-caveat"><p className="eyebrow">Why absolute is the default</p><h2>A short-lived spike is not a long-term hotspot.</h2><div className="rate-example"><strong className="mono">{rateOutlier.symbol}</strong><span>{rateOutlier.structural} structural / {rateOutlier.observed} observed</span><span>{Math.round(rateOutlier.days)} days alive</span><b>≈ {annualRate(rateOutlier).toFixed(0)} structural changes / year</b></div><p>That annualised rate outranks entities with far more sustained work. Absolute count answers where the work actually accumulated.</p></section> : null}
        </aside>
      </div>
      <MethodNote><p>Hotspots count entity-level revisions whose change level is exactly <code>shape</code>. Raw revision volume and untouched observations never contribute.</p></MethodNote>
    </div>
  )
}

function OstracisedRow({ row, selected, onClick }: { row: OstracisedEntity; selected: boolean; onClick: () => void }) {
  return <button className={selected ? 'ostracised-row selected' : 'ostracised-row'} onClick={onClick}><span><strong className="mono">{row.symbol}</strong><code>{row.path}</code></span><b>{row.durationDays.toFixed(0)}d</b><i>{row.strength}</i></button>
}

function OstracisedView({ onOpen }: { onOpen: (key: string) => void }) {
  const query = useQuery({ queryKey: ['ostracised'], queryFn: fetchOstracised })
  return <ViewQuery query={query}>{data => <OstracisedBody data={data} onOpen={onOpen} />}</ViewQuery>
}

function OstracisedBody({ data, onOpen }: { data: OstracisedView; onOpen: (key: string) => void }) {
  const [selectedKey, setSelectedKey] = useState(data.rows[0].stableKey)
  const selected = data.rows.find(row => row.stableKey === selectedKey) ?? data.rows[0]
  return (
    <div className="view">
      <PageIntro eyebrow="Ostracised" title={<>Short-lived code,<br />with its exit context.</>} body="An entity can be real, useful and brief. Empty rationale cells remain empty; grouping helps the first view reveal experiments without inventing intent." aside={<div className="strength-switch"><b>A · {data.strengthA}</b><span>C · {data.strengthC} suspected</span></div>} />
      <div className="ostracised-layout">
        <section className="panel removal-cluster">
          <p className="eyebrow">Grouping preview · by remove_commit</p><code>{shortSha(selected.diedSha)} · {selected.diedAt.slice(0, 10)}</code><h2 className="mono">{selected.diedSubject}</h2><p>{data.rows.length} listed · grouping by remove_commit is not applied yet</p>
          <div>{data.rows.map(row => <OstracisedRow key={row.stableKey} row={row} selected={row.stableKey === selected.stableKey} onClick={() => setSelectedKey(row.stableKey)} />)}</div>
          <p className="panel-foot">Concentration audit pending: compare <code>remove_commit</code> and <code>introduce_commit</code> before making this the default grouping.</p>
        </section>
        <motion.aside key={selected.stableKey} className="panel ostracised-detail" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}>
          <p className="eyebrow">Strength {selected.strength} · {selected.method}</p><h2 className="mono detail-title">{selected.symbol}</h2><code>{selected.path}</code>
          <div className="lifetime"><div><span>Introduced</span><b>{selected.bornAt.slice(0, 10)}</b></div><div><span>Removed</span><b>{selected.diedAt.slice(0, 10)}</b></div><code>duration_days = {selected.durationDays.toFixed(2)}</code></div>
          <button className="action-button" onClick={() => onOpen(selected.stableKey)}>Open its timeline <span className="mono">{selected.symbol}</span></button>
          <LiteralEvidence note="Verbatim subject — it explains the removal commit, not necessarily this symbol alone.">{selected.diedSubject}</LiteralEvidence>
          <div className="sparse-note"><span>Intent layer</span><p>No entity-level rationale. The commit subject is shown with its scope made explicit; the blank is not backfilled by inference.</p></div>
          <MethodNote><p>An inverse diff finds a declaration introduced after one parent and absent at the removal commit. Strength A means the removal is directly witnessed.</p></MethodNote>
          <p className="panel-foot">{data.shown} shown · {data.hiddenTests} tests hidden · C stays suspected</p>
        </motion.aside>
      </div>
    </div>
  )
}

function Workspace({ repository }: { repository: Repository }) {
  // **網址是唯一真相。** 深連結、picker 選取、從熱點／被推翻清單跳過來，
  // 三條路徑都經由這裡，所以「我看到的東西」永遠貼得出去。
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])
  const timelineKey = parseTimelineHash(hash).key || undefined
  const [view, setView] = useState<ViewId>(() => timelineKey ? 'timeline' : 'ladder')

  /** 從任何畫面跳進某一條時間軸。 */
  const openTimeline = (stableKey: string) => {
    history.replaceState(null, '', formatTimelineHash(stableKey, ''))
    setHash(formatTimelineHash(stableKey, ''))
    setView('timeline')
  }
  return (
    <div className="app-shell">
      <aside className="app-rail">
        <div className="brand"><i aria-hidden="true" /><strong>ostracon</strong></div>
        <div className="repo-block"><span>Repository</span><button title={repository.name}><b className="mono">{repository.name.split('/').pop()}</b><small className="repo-path">{shortenPath(repository.name)}</small><small>{format(repository.commits)} commits indexed</small></button></div>
        <nav aria-label="Workspace views">{navItems.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><span>{item.index}</span><b>{item.label}</b></button>)}</nav>
        <div className="rail-foot"><span>Schema {repository.schema}</span><b>{format(repository.revisions)} revisions · {format(repository.entities)} entities</b></div>
      </aside>
      <main className="workspace-main">
        <div className="mobile-nav"><div className="brand"><i /><strong>ostracon</strong></div><select value={view} onChange={event => setView(event.target.value as ViewId)} aria-label="Choose view">{navItems.map(item => <option value={item.id} key={item.id}>{item.index} · {item.label}</option>)}</select></div>
        <div className="topbar"><span className="mono">{navItems.find(item => item.id === view)?.label.toUpperCase()} / {repository.name.split('/').pop()}</span><span className="top-status"><i />output verified</span></div>
        <AnimatePresence mode="wait">
          <motion.div key={view} className="view-wrap" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
            {view === 'ladder' ? <LadderView /> : null}
            {view === 'discontinuities' ? <DiscontinuitiesView /> : null}
            {view === 'timeline' ? <TimelineView stableKey={timelineKey} onSelect={openTimeline} /> : null}
            {view === 'hotspots' ? <HotspotsView onOpen={openTimeline} /> : null}
            {view === 'ostracised' ? <OstracisedView onOpen={openTimeline} /> : null}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  )
}

export default function App() {
  // **外殼只等 summary。** 它是唯一每一頁都要的資料（語料身分與規模），
  // 而且只有 0.3 KB——其餘五個端點合計 154 KB，一起等就是讓使用者為了看
  // 一頁而下載五頁。
  const { data, error, isPending } = useQuery({ queryKey: ['summary'], queryFn: fetchSummary })
  if (isPending) return <div className="load-state"><div className="brand"><i /><strong>ostracon</strong></div><p>Reading the index</p></div>
  if (error || !data) {
    return (
      <div className="load-state error">
        <strong>The index could not be read.</strong>
        <code>{error instanceof Error ? error.message : 'Unknown error'}</code>
        <p>Start the backend with <code>ostracon ui --db &lt;index.db&gt;</code>, or serve an exported static site.</p>
      </div>
    )
  }
  return <Workspace repository={data} />
}
