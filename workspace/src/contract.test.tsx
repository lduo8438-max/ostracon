import { StrictMode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, beforeAll } from 'vitest'
import { DiscontinuitiesBody, OstracisedBody, TimelineBody } from './App'
import type { DiscontinuityView, OstracisedView, TimelineRow, TimelineView } from './types'

/**
 * **這幾條要的是「真的渲染起來」，不是「純函式回對值」。**
 *
 * 上線後的兩個全黑崩潰（create-t3-app 的 Discontinuities、osiris 的 Timeline）
 * 都在 render 本體裡：`data.rows[0].id` 與 `selected.sha`。它們通不過任何
 * 「把元件掛起來」的測試，卻通得過所有只驗資料的測試——而先前這裡一條
 * 渲染測試都沒有。
 *
 * 用 `createRoot` + `act` 而不是 `renderToStaticMarkup`，因為 effect 也要跑：
 * 冷開深連結的捲動就在 effect 裡，而它先前讀的正是那個 undefined。
 */

beforeAll(() => {
  // 少了這個旗標，React 不會把 `act` 當成測試環境，effect 就不保證在 `act`
  // 回來之前跑完——測試會通過，但**它驗到的比它宣稱的少**。
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom 沒有這個方法，而深連結的 effect 會呼叫它。
  Element.prototype.scrollIntoView = function scrollIntoView() {}
})

function render(node: React.ReactNode): { html: string; root: Root; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(<StrictMode>{node}</StrictMode>) })
  return { html: container.innerHTML, root, container }
}

const KEY = 'a'.repeat(64)

const row = (index: number, rationale?: string): TimelineRow => ({
  index,
  sha: `sha${index}`,
  date: '2026-01-0' + index,
  location: 'a.ts:1–9',
  tier: 'L1',
  firstDifference: 'raw bytes differ',
  hunkEvidence: 'touched',
  change: 'change level · raw',
  ...(rationale === undefined ? {} : { rationale }),
})

const timeline = (rows: TimelineRow[]): TimelineView => ({
  symbol: 'hasBit',
  path: 'packages/reactivity/src/dep.ts',
  stableKey: KEY,
  dead: true,
  total: rows.length,
  entityRationales: rows.filter(r => r.rationale).length,
  batchRationales: 0,
  rows,
})

describe('空資料是合法輸入', () => {
  it('**零斷層要渲染出空狀態，不是崩潰**', () => {
    // create-t3-app：1,378 顆 commit、405 個 entity、0 條斷層。那是答案。
    const data: DiscontinuityView = { total: 0, snippets: 'included', incomparable: 0, rows: [] }
    const { html } = render(<DiscontinuitiesBody data={data} />)
    expect(html).toContain('No discontinuities recorded')
    // **片段狀態要跟著講對。** `included` 與 `not-requested` 是兩件事，
    // 零斷層不能把前者說成後者。
    expect(html).toContain('Source snippets were embedded for this export')
    expect(html).not.toContain('Source was not embedded')
  })

  it('零斷層但語料讀不到時，說的是另一件事', () => {
    const data: DiscontinuityView = { total: 0, snippets: 'repo-unavailable', incomparable: 0, rows: [] }
    const { html } = render(<DiscontinuitiesBody data={data} />)
    expect(html).toContain('The corpus could not be read')
  })

  it('有斷層時仍然走清單版面', () => {
    // 沒有這一條，上面兩條可以在一個「永遠回空狀態」的元件上通過。
    const data: DiscontinuityView = {
      total: 1, snippets: 'included', incomparable: 0,
      rows: [{
        id: 0, symbol: 'parse', path: 'a.ts', similarity: 0.42,
        sha: 'abc1234567', subject: 'refactor: rewrite',
        beforeEntity: 'b'.repeat(64), afterEntity: 'c'.repeat(64),
      }],
    }
    const { html } = render(<DiscontinuitiesBody data={data} />)
    expect(html).toContain('Selected break')
    expect(html).not.toContain('No discontinuities recorded')
  })

  it('**沒有被推翻的做法時也要渲染得出來**', () => {
    const data: OstracisedView = { strengthA: 0, strengthC: 0, shown: 0, hiddenTests: 0, rows: [] }
    const { html } = render(<OstracisedBody data={data} onOpen={() => {}} />)
    expect(html).toContain('No overturned approaches recorded')
  })
})

describe('時間軸沒有專屬理由時', () => {
  const rows = [row(1), row(2), row(3)]

  it('**每一列都要照常顯示，跳轉控制停用並顯示 0 / 0**', () => {
    // 理由是稀有的（Osiris 4.0%）。「一條都沒有」是常態，不是例外。
    window.location.hash = ''
    const { html, container } = render(
      <TimelineBody data={timeline(rows)} entities={[]} onSelect={() => {}} />,
    )
    expect(container.querySelectorAll('.timeline-row')).toHaveLength(3)
    expect(html).toContain('0 / 0')
    const jump = container.querySelector<HTMLButtonElement>('.jump-control')
    expect(jump?.disabled).toBe(true)
    // 沒有理由就不該有任何一列被反白——先前是強制反白第 0 個命中。
    expect(container.querySelectorAll('.timeline-row.selected')).toHaveLength(0)
  })

  it('**舊的 key-only 深連結對零理由的宣告仍能冷開**', () => {
    // demo 的 landing 直接連 `#<stable_key>`（`Dep.ts:hasBit`，零專屬理由），
    // 而那個網址已經公開、被存起來、被貼給別人。
    window.location.hash = `#${KEY}`
    const { container } = render(
      <TimelineBody data={timeline(rows)} entities={[]} onSelect={() => {}} />,
    )
    expect(container.querySelectorAll('.timeline-row')).toHaveLength(3)
  })

  it('有理由時跳轉控制要能用，且計數器用同一個陣列當分母', () => {
    // 分母寫過 `data.total`（全部改動數），與旁邊那個「N entity rationales」
    // 不是同一個母體——這個專案已經被同型的兩個分母咬過一次。
    window.location.hash = ''
    const { html, container } = render(
      <TimelineBody data={timeline([row(1), row(2, 'to prevent RangeError')])} entities={[]} onSelect={() => {}} />,
    )
    expect(html).toContain('1 / 1')
    expect(container.querySelector<HTMLButtonElement>('.jump-control')?.disabled).toBe(false)
    expect(container.querySelectorAll('.timeline-row.selected')).toHaveLength(1)
  })

  it('深連結指到沒有理由的那一列時，反白的是那一列，游標是 0', () => {
    // 先前 `hits.findIndex` 找不到就退回第 0 個命中，於是 `#key/sha` 會靜默
    // 捲到別的地方——把「找不到」偽裝成「找到了」。
    window.location.hash = `#${KEY}/sha1`
    const { html, container } = render(
      <TimelineBody data={timeline([row(1), row(2, 'because X')])} entities={[]} onSelect={() => {}} />,
    )
    const selected = container.querySelectorAll('.timeline-row.selected')
    expect(selected).toHaveLength(1)
    expect(selected[0]!.querySelector('strong')?.textContent).toBe('sha1')
    expect(html).toContain('0 / 1')
  })
})
