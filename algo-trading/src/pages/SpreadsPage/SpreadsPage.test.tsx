import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'

// Lightweight hook harness: test the page's own actions without a DOM dependency.
const harness = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[] }))
const requests = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const routing = vi.hoisted(() => ({ search: '', navigate: vi.fn() }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual,
    useState: (initial: unknown) => {
      const index = harness.cursor++
      if (!(index in harness.states)) harness.states[index] = initial
      return [harness.states[index], (value: unknown) => { harness.states[index] = typeof value === 'function' ? value(harness.states[index]) : value }]
    },
    useRef: (initial: unknown) => {
      const index = harness.cursor++
      if (!(index in harness.states)) harness.states[index] = { current: initial }
      return harness.states[index]
    },
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => unknown) => { harness.effects.push(effect) },
  }
})
vi.mock('../../trading', () => ({ apiGet: requests.get, apiPost: requests.post }))
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/spreads', search: routing.search }), useNavigate: () => routing.navigate }))
import SpreadsPage from './SpreadsPage'
import DiscoveryPanel, { type DiscoveryPayload } from './DiscoveryPanel'
type Element = ReactElement<Record<string, unknown>>
function descendants(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(descendants)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as Element
  return [element, ...descendants(element.props.children as ReactNode)]
}
function render() { harness.cursor = 0; harness.effects = []; return descendants(SpreadsPage()) }
function input(elements: Element[], value: number) { return elements.find(e => e.type === 'input' && e.props.value === value)! }
const discoveryPayload: DiscoveryPayload = {
  updated: 1000, refreshing: false, top: [], all: [], universe: { source: 'fixture_nse_bod', size: 2 }, errors: [], data_mode: 'fixtures', data_note: 'Synthetic data',
}
function renderDiscovery(selected: string[] = [], onAdd = vi.fn().mockResolvedValue(undefined)) {
  harness.cursor = 0; harness.effects = []
  return descendants(DiscoveryPanel({ available: true, disabled: false, selected, onAdd }))
}
function button(elements: Element[], label: string) { return elements.find(e => e.type === 'button' && e.props.children === label)! }
beforeEach(() => {
  harness.states = []; harness.cursor = 0; harness.effects = []
  routing.search = ''; routing.navigate.mockReset()
  requests.get.mockReset(); requests.post.mockReset()
  requests.get.mockImplementation((path: string) => Promise.resolve(path.includes('/status') ? { connected: false, expiresAt: null } : { symbol: path.includes('BANKNIFTY') ? 'BANKNIFTY' : 'NIFTY', expiries: ['2026-11-12'], data_mode: 'fixtures', data_note: 'synthetic' }))
})
it('loads setup without scanning; defaults and automatic expiry remain original', async () => {
  let elements = render()
  expect(input(elements, 30).props.min).toBe(5)
  expect(input(elements, 5).props.max).toBe(5000)
  expect(elements.some(e => e.type === 'input' && e.props.value === 12)).toBe(false)
  const effects = [...harness.effects]
  effects.forEach(effect => effect())
  await new Promise(resolve => setTimeout(resolve, 0))
  elements = render()
  expect(requests.post).not.toHaveBeenCalled()
  const expiry = elements.find(e => e.props['aria-label'] === 'NIFTY expiry')!
  expect(expiry.props.value).toBe('')
  expect(elements.find(e => e.type === 'button' && e.props.type === 'submit')!.props.disabled).toBe(false)
})
it('only explicit submit scans, uses target DTE, and prevents duplicate in-flight submits', async () => {
  let finish: (value: unknown) => void = () => undefined
  requests.post.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const elements = render()
  const submit = elements.find(e => e.type === 'form')!.props.onSubmit as (event: unknown) => Promise<void>
  const event = { preventDefault: vi.fn() }
  const first = submit(event)
  await submit(event)
  expect(requests.post).toHaveBeenCalledTimes(1)
  expect(requests.post).toHaveBeenCalledWith('/spreads/scan', { underlyings: ['NIFTY'], expiries: {}, dte: 30, width: 5, min_vrp: 1.15, min_oi: 100, max_spread_pct: .1, min_cushion: 2, min_ror: 15 })
  finish({ ok: true, candidates: [], underlyings: [], failure_count: 0 })
  await first
})
it('adding BANKNIFTY does not mutate spread width or trigger a scan', async () => {
  let elements = render()
  const symbol = elements.find(e => e.props['aria-label'] === 'NSE underlying symbol')!
  ;(symbol.props.onChange as (event: unknown) => void)({ target: { value: 'BANKNIFTY' } })
  elements = render()
  const add = elements.find(e => e.type === 'button' && String(e.props.children).startsWith('Load F'))!
  await (add.props.onClick as () => Promise<void>)()
  elements = render()
  expect(input(elements, 5)).toBeTruthy()
  expect(requests.post).not.toHaveBeenCalled()
  expect(requests.get).toHaveBeenCalledWith('/spreads/underlyings/BANKNIFTY/expiries')
})

it('shows successful OAuth status even when Python expiry loading fails', async () => {
  routing.search = '?upstox=connected'
  requests.get.mockImplementation((path: string) => path.includes('/status')
    ? Promise.resolve({ connected: true, expiresAt: Date.now() + 60000, lastAttempt: { stage: 'connected', at: '2026-10-12T00:00:00Z' } })
    : Promise.reject(new Error('Spread Terminal service is unavailable.')))
  render(); harness.effects.forEach(effect => effect())
  await new Promise(resolve => setTimeout(resolve, 0))
  const elements = render()
  expect(elements.some(e => e.props.role === 'status' && e.props.children === 'Upstox connected')).toBe(true)
  expect(elements.some(e => e.props.children === 'Spread Terminal service is unavailable.')).toBe(true)
  expect(requests.post).not.toHaveBeenCalled()
})

it('retains callback failure after query cleanup and expiry errors', async () => {
  routing.search = '?upstox=error&message=Upstox%20reports%20no%20active%20trading%20segments.'
  requests.get.mockImplementation((path: string) => path.includes('/status')
    ? Promise.resolve({ connected: false, expiresAt: null })
    : Promise.reject(new Error('Connect Upstox to scan.')))
  render(); harness.effects.forEach(effect => effect())
  await new Promise(resolve => setTimeout(resolve, 0))
  routing.search = ''
  render(); harness.effects.forEach(effect => effect())
  await new Promise(resolve => setTimeout(resolve, 0))
  const elements = render()
  expect(elements.some(e => e.props.children === 'Upstox reports no active trading segments.')).toBe(true)
  expect(elements.some(e => e.props.children === 'Connect Upstox to scan.')).toBe(true)
})

it('discovery loads only on explicit action and never starts a spread scan', async () => {
  let elements = renderDiscovery()
  expect(requests.get).not.toHaveBeenCalled(); expect(requests.post).not.toHaveBeenCalled()
  requests.post.mockResolvedValue(discoveryPayload)
  await (button(elements, 'Discover opportunities').props.onClick as () => Promise<void>)()
  elements = renderDiscovery()
  expect(requests.post).toHaveBeenCalledWith('/spreads/discover')
  expect(requests.post).toHaveBeenCalledTimes(1)
  requests.get.mockResolvedValue(discoveryPayload)
  await (button(elements, 'Check cached ranking').props.onClick as () => Promise<void>)()
  expect(requests.get).toHaveBeenCalledWith('/spreads/trending', expect.any(AbortSignal))
})

it('discovery selection adds names without changing settings or launching scan', async () => {
  const row = { ticker:'RELIANCE',spot:100,chg:1,rv21:.2,iv14:null,vrp14:null,shock:2,edge:false,score:1,vrp_pass:false,shock_pass:true }
  requests.post.mockResolvedValue({ ...discoveryPayload, top:[row],all:[row] })
  let elements = renderDiscovery()
  await (button(elements,'Discover opportunities').props.onClick as () => Promise<void>)()
  elements = renderDiscovery()
  const checkbox = elements.find(e => e.props['aria-label'] === 'Select discovery RELIANCE')!
  ;(checkbox.props.onChange as () => void)()
  const onAdd = vi.fn().mockResolvedValue(undefined)
  elements = renderDiscovery([], onAdd)
  await (button(elements,'Add selected to scanner').props.onClick as () => Promise<void>)()
  expect(onAdd).toHaveBeenCalledWith(['RELIANCE'])
  expect(requests.post).toHaveBeenCalledTimes(1)
  expect(renderDiscovery().some(e => e.props.children === 'Unavailable')).toBe(true)
})

it('discovery enforces the combined ten-underlying limit and displays request errors', async () => {
  const row = { ticker:'EXTRA',spot:100,chg:1,rv21:.2,iv14:.3,vrp14:1.5,shock:2,edge:true,score:2,vrp_pass:true,shock_pass:true }
  requests.post.mockResolvedValue({ ...discoveryPayload,top:[row],all:[row] })
  let elements = renderDiscovery()
  await (button(elements,'Discover opportunities').props.onClick as () => Promise<void>)()
  elements = renderDiscovery(Array.from({ length:20 },(_,i)=>`S${i}`))
  ;(elements.find(e => e.props['aria-label']==='Select discovery EXTRA')!.props.onChange as () => void)()
  elements = renderDiscovery()
  expect(elements.some(e => String(e.props.children).includes('Choose at most 20 underlyings including'))).toBe(true)
  requests.post.mockRejectedValue(new Error('Connect Upstox'))
  await (button(elements,'Discover opportunities').props.onClick as () => Promise<void>)()
  expect(renderDiscovery().some(e => e.props.children==='Connect Upstox')).toBe(true)
})

it('adding discovered stock loads expiries and surfaces unavailable earnings without scanning', async () => {
  requests.get.mockResolvedValue({ symbol:'RELIANCE',expiries:['2026-11-12'],data_mode:'upstox',data_note:'Live',scan_availability:{available:false,reason:'Stock earnings inputs unavailable.'} })
  let elements = render()
  const panel = elements.find(e => e.type === DiscoveryPanel)!
  await (panel.props.onAdd as (symbols: string[]) => Promise<void>)(['RELIANCE'])
  elements = render()
  expect(elements.some(e => e.props['aria-label']==='RELIANCE expiry')).toBe(true)
  const text = elements.map(e => String(e.props.children)).join(' ')
  expect(text).toContain('Stock earnings inputs unavailable.')
  expect(requests.post).not.toHaveBeenCalled()
  expect(input(elements,5)).toBeTruthy()
})

it('retries a setup abort once and reports live mode independently of expiry failures', async () => {
  let statusCalls = 0
  requests.get.mockImplementation((path: string) => {
    if (path.includes('/status')) {
      statusCalls += 1
      return statusCalls === 1 ? Promise.reject(new DOMException('scope changed','AbortError')) : Promise.resolve({ connected:false,expiresAt:null,data_mode:'upstox' })
    }
    return Promise.reject(new Error('Connect Upstox to scan.'))
  })
  render(); harness.effects.forEach(effect => effect())
  await new Promise(resolve => setTimeout(resolve,0))
  const elements = render()
  expect(statusCalls).toBe(2)
  const panel = elements.find(e => e.type === DiscoveryPanel)!
  expect(panel.props.available).toBe(false)
  expect(elements.some(e => String(e.props.children).startsWith('Fixture mode:'))).toBe(false)
})

it('polls one discovery refresh, displays progress, and automatically finishes', async () => {
  vi.useFakeTimers()
  try {
    requests.post.mockResolvedValue({ ...discoveryPayload,refreshing:true,progress:{stage:'history',completed:10,total:219} })
    requests.get.mockResolvedValue(discoveryPayload)
    const elements=renderDiscovery()
    const request=(button(elements,'Discover opportunities').props.onClick as () => Promise<void>)()
    await vi.advanceTimersByTimeAsync(0)
    expect(renderDiscovery().some(e => e.props.children==='Daily history: 10 / 219')).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    await request
    expect(requests.post).toHaveBeenCalledTimes(1)
    expect(requests.get).toHaveBeenCalledTimes(1)
    expect(button(renderDiscovery(),'Discover opportunities').props.disabled).toBe(false)
  } finally { vi.useRealTimers() }
})

it('releases loading state when a discovery request never responds', async () => {
  vi.useFakeTimers()
  try {
    requests.post.mockImplementation(() => new Promise(() => {}))
    const request=(button(renderDiscovery(),'Discover opportunities').props.onClick as () => Promise<void>)()
    await vi.advanceTimersByTimeAsync(200_000)
    await request
    const elements=renderDiscovery()
    expect(elements.some(e => String(e.props.children).startsWith('Discovery took too long.'))).toBe(true)
    expect(button(elements,'Discover opportunities').props.disabled).toBe(false)
  } finally { vi.useRealTimers() }
})


it('surfaces conditional stock availability without claiming inputs are ready', async () => {
  requests.get.mockResolvedValue({symbol:'RELIANCE',expiries:['2026-11-12'],data_mode:'upstox',data_note:'Live',scan_availability:{available:null,status:'requires_validation',reason:'Earnings availability is checked during the scan.'}})
  const elements = render()
  const panel = elements.find(e => e.type === DiscoveryPanel)!
  await (panel.props.onAdd as (symbols: string[]) => Promise<void>)(['RELIANCE'])
  expect(render().map(e => String(e.props.children)).join(' ')).toContain('Earnings availability is checked during the scan.')
  expect(requests.post).not.toHaveBeenCalled()
})
