import { StrictMode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, beforeAll } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DiscontinuitiesBody, OstracisedBody, TimelineBody, TimelineView } from './App'
import type { DiscontinuityView, OstracisedView, TimelineRow, TimelineView as TimelineViewData } from './types'

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

const timeline = (rows: TimelineRow[]): TimelineViewData => ({
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


/**
 * 從 `page.ts` 搬過來的產品契約。
 *
 * 舊頁面是一整個樣板字串，node 這一端執行不了它，所以那些測試只能對原始碼
 * 做 regex 釘樁。搬過來的條件是**改成對現在真的出貨的東西斷言**——能改成
 * 行為驗證的就改，改不了的（CSS、產物內容）留在 node 那一側對成品斷言。
 */
describe('從舊頁面搬過來的契約', () => {
  it('**整批理由不進逐列的暖色格**', () => {
    // 舊頁面釘的是 `.claim.batch q` 這條 CSS。契約是「唯一的暖色只給能歸到
    // 這個宣告身上的逐字引文」——整批引文說的是別人的事。
    window.location.hash = ''
    const rows = [row(1), row(2, 'to prevent RangeError')]
    const { container } = render(
      <TimelineBody data={{ ...timeline(rows), batchRationales: 1 }} entities={[]} onSelect={() => {}} />,
    )
    const cells = container.querySelectorAll('.timeline-evidence')
    expect(cells).toHaveLength(2)
    expect(cells[0]!.querySelector('.literal-evidence')).toBeNull()
    expect(cells[0]!.querySelector('.honest-blank')).not.toBeNull()
    expect(cells[1]!.querySelector('.literal-evidence')).not.toBeNull()
  })

  it('**選取會更新網址，但不得堆積上一頁**', () => {
    // 時間軸要可分享；用 replaceState 而不是 pushState——在左欄點十條宣告
    // 不該在上一頁堆十筆。
    window.location.hash = ''
    const before = history.length
    const { container } = render(
      <TimelineBody data={timeline([row(1), row(2, 'because X')])} entities={[]} onSelect={() => {}} />,
    )
    act(() => { container.querySelector<HTMLButtonElement>('.jump-control')!.click() })
    expect(window.location.hash).toBe(`#${KEY}/sha2`)
    expect(history.length).toBe(before)
  })

  it('**已消亡的宣告仍看得到，並且逐列標示**', () => {
    // 舊頁面的 tab 叫「All declarations」而不是「Current declarations」——
    // 契約是清單不宣稱只有現存的東西。picker 現在承擔同一件事。
    window.location.hash = ''
    const entities = [
      { stableKey: KEY, symbol: 'hasBit', path: 'dep.ts', revisions: 3, withEntityIntent: 0, withBatchIntent: 0, dead: true },
      { stableKey: 'b'.repeat(64), symbol: 'live', path: 'a.ts', revisions: 9, withEntityIntent: 2, withBatchIntent: 0, dead: false },
    ]
    const { container } = render(
      <TimelineBody data={timeline([row(1)])} entities={entities} onSelect={() => {}} />,
    )
    act(() => { container.querySelector<HTMLButtonElement>('.picker-open')!.click() })
    const picker = container.querySelector('.picker')!
    expect(picker.textContent).toContain('hasBit')
    expect(picker.querySelectorAll('.tag-dead')).toHaveLength(1)
    expect(picker.textContent).not.toContain('Current declarations')
  })
})

/**
 * 深連結的解析。**舊頁面把這一條列為「原始碼層級的釘樁，不是行為驗證」**
 * ——它當時只能 regex 比對 `switchTab("gone")` 有沒有出現。現在是真的跑。
 */
describe('深連結解析（真的發請求）', () => {
  const ENTITY_KEY = 'e'.repeat(64)
  const GONE_KEY = 'f'.repeat(64)

  const serve = (body: unknown) => Promise.resolve(
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  )

  function stubFetch() {
    const seen: string[] = []
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.endsWith('api/entities.json')) {
        return serve([{ stableKey: ENTITY_KEY, symbol: 'live', path: 'a.ts', revisions: 1, withEntityIntent: 0, withBatchIntent: 0, dead: false }])
      }
      if (url.endsWith('api/ostracised.json')) {
        return serve({ rows: [{ stableKey: GONE_KEY, symbol: 'hasBit', path: 'dep.ts', durationDays: 0, strength: 'A', method: 'inverse-diff', bornAt: '2026-01-01', diedAt: '2026-01-01', diedSha: 'abc1234567', diedSubject: 'refactor: reduce bundle size' }], hiddenTests: 0, suspected: 0 })
      }
      if (url.includes('api/evolution/')) {
        return serve([{ shortSha: 'sha1', committedAt: '2026-01-01', changeLevel: 'raw', hunkEvidence: 'touched', tier: 'L1', path: 'dep.ts', lineStart: 1, lineEnd: 2, intent: [] }])
      }
      return Promise.resolve(new Response('nope', { status: 404 }))
    }) as typeof fetch
    return seen
  }

  const mount = async (key: string) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const c = document.createElement('div')
    document.body.appendChild(c)
    await act(async () => {
      createRoot(c).render(
        <QueryClientProvider client={client}>
          <TimelineView stableKey={key} onSelect={() => {}} />
        </QueryClientProvider>,
      )
    })
    // 這裡有一條**相依的**請求鏈（entities → 可能的 ostracised → evolution），
    // 一次 flush 只推得動一段。**不能用 `isFetching() > 0` 當迴圈條件**：
    // 兩段之間它會短暫歸零，於是提早離開，下一段根本還沒發出去。
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    }
    return c
  }

  it('**只出現在被推翻名單裡的 key 也打得開**', async () => {
    // `Dep.ts:hasBit` 只在 ostracised.json，不在 entities.json——而 demo 的
    // landing 就是直接連它。只查第一份名單會讓產品自己的按鈕指向錯誤頁。
    const seen = stubFetch()
    const c = await mount(GONE_KEY)
    expect(c.querySelector('.view-state.error')).toBeNull()
    expect(c.querySelectorAll('.timeline-row')).toHaveLength(1)
    expect(seen.some(u => u.endsWith('api/ostracised.json'))).toBe(true)
  })

  it('第一份名單就找得到時，不去抓第二份（50.9 KB 不白付）', async () => {
    const seen = stubFetch()
    await mount(ENTITY_KEY)
    expect(seen.some(u => u.endsWith('api/ostracised.json'))).toBe(false)
  })

  it('**兩份都沒有時要說出來，不得靜默退回精選**', async () => {
    stubFetch()
    const c = await mount('9'.repeat(64))
    expect(c.querySelector('.view-state.error')).not.toBeNull()
    expect(c.textContent).toContain('not in this export')
    expect(c.querySelectorAll('.timeline-row')).toHaveLength(0)
  })
})
