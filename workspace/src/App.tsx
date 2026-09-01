import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { fetchWorkspace } from './api'
import type {
  Discontinuity,
  Hotspot,
  LadderTier,
  MoveEvidence,
  OstracisedEntity,
  TimelineRow,
  ViewId,
  WorkspaceData,
} from './types'

const navItems: Array<{ id: ViewId; index: string; label: string }> = [
  { id: 'ladder', index: '01', label: 'Match ladder' },
  { id: 'discontinuities', index: '02', label: 'Discontinuities' },
  { id: 'timeline', index: '03', label: 'Timeline' },
  { id: 'hotspots', index: '04', label: 'Hotspots' },
  { id: 'ostracised', index: '05', label: 'Ostracised' },
]

const format = (value: number) => value.toLocaleString('en-US')
const shortSha = (value: string) => value.slice(0, 10)
const percentage = (value: number) => `${(value * 100).toFixed(1)}%`

function PageIntro({ eyebrow, title, body, aside }: { eyebrow: string; title: React.ReactNode; body: string; aside?: React.ReactNode }) {
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
          <p className="quiet">No per-link listing is exported for this tier. Only cross-file moves are enumerated, because only they name two different files.</p>
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

function LadderView({ data }: { data: WorkspaceData }) {
  const [selected, setSelected] = useState<LadderTier['id']>('L5')
  const [moveIndex, setMoveIndex] = useState(0)
  const tier = data.ladder.find(item => item.id === selected) ?? data.ladder[data.ladder.length - 1]!
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
            <LadderGlyph tiers={data.ladder} selected={selected} />
            <div className="tier-list">
              {data.ladder.map(item => (
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

function DiscontinuityCard({ row, selected, onClick }: { row: Discontinuity; selected: boolean; onClick: () => void }) {
  return (
    <button className={selected ? 'list-row selected' : 'list-row'} onClick={onClick}>
      <span><strong className="mono">{row.symbol}</strong><code>{row.path}</code></span>
      <span className="mono">sim {row.similarity == null ? '—' : row.similarity.toFixed(4)}<small>{shortSha(row.sha)}</small></span>
    </button>
  )
}

function DiscontinuitiesView({ data }: { data: WorkspaceData }) {
  const [selectedId, setSelectedId] = useState(data.discontinuities.rows[0].id)
  const selected = data.discontinuities.rows.find(row => row.id === selectedId) ?? data.discontinuities.rows[0]
  return (
    <div className="view">
      <PageIntro eyebrow="Discontinuities" title={<>The slot stayed.<br />The lineage did not.</>} body="These are not moves. The same qualified slot reappears with a different entity, so earlier discussion must not be carried forward as evidence." aside={<div className="count-pill">{format(data.discontinuities.total)} recorded</div>} />
      <div className="split-layout">
        <section className="panel list-panel">
          <div className="panel-heading"><span>{data.discontinuities.total} breaks</span><span>lowest similarity first</span></div>
          <div className="stack-list">{data.discontinuities.rows.map(row => <DiscontinuityCard key={row.id} row={row} selected={row.id === selected.id} onClick={() => setSelectedId(row.id)} />)}</div>
          <p className="panel-foot cool">{data.discontinuities.rows.length} of {format(data.discontinuities.total)} shown · {data.discontinuities.incomparable} had no comparable token set (recorded as null, not zero)</p>
        </section>
        <motion.section key={selected.id} className="panel discontinuity-detail" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}>
          <p className="eyebrow">Selected break · #{String(selected.id).padStart(3, '0')}</p>
          <h2 className="mono detail-title">{selected.symbol}</h2>
          <p className="mono quiet">{shortSha(selected.sha)} · {selected.subject}</p>
          <div className="revision-pair">
            <div><span>Before · previous entity</span><code>{selected.path}</code><small className="mono">{selected.beforeEntity.slice(0, 12)}…</small></div>
            <div className="after"><span>After · new entity</span><code>{selected.path}</code><small className="mono">{selected.afterEntity.slice(0, 12)}…</small></div>
          </div>
          <p className="honest-blank">Source snippets are not shown. The index stores a blob hash and byte offsets, never the source itself — reading the two revisions back is a separate step, not a missing field.</p>
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
      <div className="timeline-change"><button className="tier-badge" title="The first hash layer that differs">{row.tier} · {row.firstDifference}</button><p>{row.change}</p></div>
      <div className="timeline-evidence">{row.rationale ? <LiteralEvidence>{row.rationale}</LiteralEvidence> : <p className="honest-blank">— no entity-level or batch-level rationale</p>}</div>
    </article>
  )
}

function TimelineView({ data }: { data: WorkspaceData }) {
  const hits = data.timeline.rows.filter(row => row.rationale)
  const initialHit = Math.max(0, hits.findIndex(row => window.location.hash.endsWith(row.sha)))
  const [hitIndex, setHitIndex] = useState(initialHit)
  const selected = hits[hitIndex] ?? hits[0]
  const rowRef = useRef<HTMLDivElement>(null)

  const jump = () => {
    const next = (hitIndex + 1) % hits.length
    const target = hits[next]
    setHitIndex(next)
    history.replaceState(null, '', `#${data.timeline.stableKey}/${target.sha}`)
    requestAnimationFrame(() => document.getElementById(`timeline-${target.sha}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }

  useEffect(() => {
    if (window.location.hash.includes('/')) requestAnimationFrame(() => document.getElementById(`timeline-${selected.sha}`)?.scrollIntoView({ block: 'center' }))
  }, [])

  return (
    <div className="view" ref={rowRef}>
      <PageIntro eyebrow="Timeline" title={<span className="mono">{data.timeline.symbol}</span>} body={data.timeline.path} aside={<button className="jump-control" onClick={jump}><b>{data.timeline.entityRationales}</b><span>entity rationales<small>{data.timeline.batchRationales} batch-only</small></span><code>{hitIndex + 1} / {data.timeline.total}</code></button>} />
      <section className="panel timeline-panel">
        <div className="timeline-head"><span>Commit / location</span><span>Structural change</span><span>Evidence — blank is honest</span></div>
        <div className="timeline-rows">{data.timeline.rows.map(row => <TimelineRowView key={row.sha} row={row} selected={row.sha === selected.sha} />)}</div>
        <p className="panel-foot">Rows use a fixed block size. Selection is an inset box-shadow; it never changes border, padding, or alignment.</p>
      </section>
      <MethodNote><p>The tier badge names the first hash layer that differs and whether the commit hunk touched the declaration. Cold-open instrumentation for fetch / render / alignRows is intentionally marked as not yet measured.</p></MethodNote>
    </div>
  )
}

function annualRate(row: Hotspot) { return row.structural / (row.days / 365) }

function HotspotsView({ data }: { data: WorkspaceData }) {
  const [mode, setMode] = useState<'absolute' | 'rate'>('absolute')
  const rows = useMemo(() => [...data.hotspots].sort((a, b) => mode === 'absolute' ? b.structural - a.structural : annualRate(b) - annualRate(a)), [data.hotspots, mode])
  const max = Math.max(...rows.map(row => mode === 'absolute' ? row.structural : annualRate(row)))
  const noneShare = data.changeDistribution.none / data.changeDistribution.total
  // 用「速率最高但絕對次數不高」的那一筆當反例；換一套語料不保證叫
  // processSuspense，所以用資料挑，不用名字寫死。
  const rateOutlier = [...data.hotspots].sort((a, b) => annualRate(b) - annualRate(a))
    .find(row => row.structural < Math.max(...data.hotspots.map(r => r.structural)) / 2)
  return (
    <div className="view">
      <PageIntro eyebrow="Hotspots" title={<>Structural churn,<br />not edit volume.</>} body={`Rank entities by shape-changing revisions. The ${format(data.changeDistribution.none)} untouched pairs stay out of the list instead of inflating activity.`} aside={<div className="segmented"><button className={mode === 'absolute' ? 'active' : ''} onClick={() => setMode('absolute')}>Absolute</button><button className={mode === 'rate' ? 'active' : ''} onClick={() => setMode('rate')}>Rate / year</button></div>} />
      <div className="hotspot-layout">
        <section className="panel hotspot-table">
          <div className="hotspot-head"><span># · Entity</span><span>{mode === 'absolute' ? 'Structural / observed' : 'Structural / year'}</span><span>Span</span></div>
          {rows.map((row, index) => {
            const value = mode === 'absolute' ? row.structural : annualRate(row)
            return <article className={index === 0 ? 'hotspot-row selected' : 'hotspot-row'} key={row.stableKey}><b>{String(index + 1).padStart(2, '0')}</b><div><strong className="mono">{row.symbol}</strong><code>{row.path}</code></div><div><strong>{mode === 'absolute' ? `${row.structural} / ${row.observed}` : value.toFixed(1)}</strong><i style={{ '--bar': `${(value / max) * 100}%` } as React.CSSProperties} /></div><span>{format(Math.round(row.days))}d</span></article>
          })}
          <p className="panel-foot">{data.hotspots.length} of {format(data.hotspotsTotal)} entities with structural change · {data.hotspotsHiddenTests} in test files excluded · <code>change_level = shape</code></p>
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

function OstracisedView({ data }: { data: WorkspaceData }) {
  const [selectedKey, setSelectedKey] = useState(data.ostracised.rows[0].stableKey)
  const selected = data.ostracised.rows.find(row => row.stableKey === selectedKey) ?? data.ostracised.rows[0]
  return (
    <div className="view">
      <PageIntro eyebrow="Ostracised" title={<>Short-lived code,<br />with its exit context.</>} body="An entity can be real, useful and brief. Empty rationale cells remain empty; grouping helps the first view reveal experiments without inventing intent." aside={<div className="strength-switch"><b>A · {data.ostracised.strengthA}</b><span>C · {data.ostracised.strengthC} suspected</span></div>} />
      <div className="ostracised-layout">
        <section className="panel removal-cluster">
          <p className="eyebrow">Grouping preview · by remove_commit</p><code>{shortSha(selected.diedSha)} · {selected.diedAt.slice(0, 10)}</code><h2 className="mono">{selected.diedSubject}</h2><p>{data.ostracised.rows.length} listed · grouping by remove_commit is not applied yet</p>
          <div>{data.ostracised.rows.map(row => <OstracisedRow key={row.stableKey} row={row} selected={row.stableKey === selected.stableKey} onClick={() => setSelectedKey(row.stableKey)} />)}</div>
          <p className="panel-foot">Concentration audit pending: compare <code>remove_commit</code> and <code>introduce_commit</code> before making this the default grouping.</p>
        </section>
        <motion.aside key={selected.stableKey} className="panel ostracised-detail" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}>
          <p className="eyebrow">Strength {selected.strength} · {selected.method}</p><h2 className="mono detail-title">{selected.symbol}</h2><code>{selected.path}</code>
          <div className="lifetime"><div><span>Introduced</span><b>{selected.bornAt.slice(0, 10)}</b></div><div><span>Removed</span><b>{selected.diedAt.slice(0, 10)}</b></div><code>duration_days = {selected.durationDays.toFixed(2)}</code></div>
          <LiteralEvidence note="Verbatim subject — it explains the removal commit, not necessarily this symbol alone.">{selected.diedSubject}</LiteralEvidence>
          <div className="sparse-note"><span>Intent layer</span><p>No entity-level rationale. The commit subject is shown with its scope made explicit; the blank is not backfilled by inference.</p></div>
          <MethodNote><p>An inverse diff finds a declaration introduced after one parent and absent at the removal commit. Strength A means the removal is directly witnessed.</p></MethodNote>
          <p className="panel-foot">{data.ostracised.shown} shown · {data.ostracised.hiddenTests} tests hidden · C stays suspected</p>
        </motion.aside>
      </div>
    </div>
  )
}

function Workspace({ data }: { data: WorkspaceData }) {
  const [view, setView] = useState<ViewId>(() => window.location.hash.includes('/') ? 'timeline' : 'ladder')
  return (
    <div className="app-shell">
      <aside className="app-rail">
        <div className="brand"><i aria-hidden="true" /><strong>ostracon</strong></div>
        <div className="repo-block"><span>Repository</span><button><b className="mono">{data.repository.name}</b><small>{format(data.repository.commits)} commits indexed</small></button></div>
        <nav aria-label="Workspace views">{navItems.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><span>{item.index}</span><b>{item.label}</b></button>)}</nav>
        <div className="rail-foot"><span>Schema {data.repository.schema}</span><b>{format(data.repository.revisions)} revisions · {format(data.repository.entities)} entities</b></div>
      </aside>
      <main className="workspace-main">
        <div className="mobile-nav"><div className="brand"><i /><strong>ostracon</strong></div><select value={view} onChange={event => setView(event.target.value as ViewId)} aria-label="Choose view">{navItems.map(item => <option value={item.id} key={item.id}>{item.index} · {item.label}</option>)}</select></div>
        <div className="topbar"><span className="mono">{navItems.find(item => item.id === view)?.label.toUpperCase()} / {data.repository.name}</span><span className="top-status"><i />output verified</span></div>
        <AnimatePresence mode="wait">
          <motion.div key={view} className="view-wrap" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
            {view === 'ladder' ? <LadderView data={data} /> : null}
            {view === 'discontinuities' ? <DiscontinuitiesView data={data} /> : null}
            {view === 'timeline' ? <TimelineView data={data} /> : null}
            {view === 'hotspots' ? <HotspotsView data={data} /> : null}
            {view === 'ostracised' ? <OstracisedView data={data} /> : null}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  )
}

export default function App() {
  const { data, error, isPending } = useQuery({ queryKey: ['ostracon-workspace', 'vuejs/core', 'v3'], queryFn: fetchWorkspace, staleTime: Infinity, retry: 1 })
  if (isPending) return <div className="load-state"><div className="brand"><i /><strong>ostracon</strong></div><p>Loading indexed evidence</p><code>fetch → render → alignRows</code></div>
  if (error || !data) return <div className="load-state error"><strong>Workspace could not be loaded.</strong><code>{error instanceof Error ? error.message : 'Unknown error'}</code></div>
  return <Workspace data={data} />
}
