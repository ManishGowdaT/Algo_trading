import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../../trading'
import { displayedCandidates, numericColumns, type Ranges, type ViewRow } from './viewFilters'
import DiscoveryPanel from './DiscoveryPanel'
import './spreads-page.css'

type Status = { connected: boolean; expiresAt: number | null; data_mode?: 'fixtures' | 'upstox'; lastAttempt?: { stage: string; at: string; message?: string; httpStatus?: number } | null }
type Setup = { symbol: string; expiries: string[]; data_mode: 'fixtures' | 'upstox'; data_note: string; scan_availability?: { available: boolean | null; status?: string; reason: string | null } }
type Parameters = { dte: number; width: number; min_vrp: number; min_oi: number; max_spread_pct: number; min_cushion: number; min_ror: number }
type Candidate = ViewRow & {
  expiration: string; long_strike: number; width: number; iv: number; rv21: number
  max_gap: number; p_raw: number; lot_size: number | null; ev_per_lot_inr: number | null
  credit_per_lot_inr: number | null; max_loss_per_lot_inr: number | null; lot_size_status: string; monetary_status?: string
  short_instrument_key: string | null; long_instrument_key: string | null
  layers: {
    l1: Record<string, number | null>; l2: { earnings_inside: boolean; max_gap_pct: number }
    l3: { iv: number; rv21: number; ratio: number }; l4: { p_raw: number; p_adj: number; horizon_td: number }
    l5: { short: { spread_pct: number; oi: number }; long: { spread_pct: number; oi: number } }
  }
}
type Funnel = Record<string, number>
type Scan = { symbol: string; ok: boolean; error: string | null; expiry: string | null; dte: number | null; candidates: Candidate[]; funnel: Funnel | null; capabilities?: Record<string, string>; capability_blockers?: string[]; data_warnings?: string[]; earnings_source_note?: string; meta: { spot: number } | null }
type Result = { ok: boolean; candidates: Candidate[]; funnel: Funnel | null; underlyings: Scan[]; success_count: number; failure_count: number; elapsed: number; data_mode: string; data_note: string; ranking_note: string }
const defaultParams: Parameters = { dte: 30, width: 5, min_vrp: 1.15, min_oi: 100, max_spread_pct: .1, min_cushion: 2, min_ror: 15 }
const MAX_UNDERLYINGS = 20
const controls: { key: keyof Parameters; label: string; min: number; max: number; step: number }[] = [
  { key: 'dte', label: 'Target DTE (calendar days)', min: 5, max: 90, step: 1 },
  { key: 'width', label: 'Width (points; NSE range extended)', min: .5, max: 5000, step: .5 },
  { key: 'min_vrp', label: 'Minimum IV / RV21', min: .8, max: 2, step: .05 },
  { key: 'min_oi', label: 'Minimum open interest', min: 0, max: 1000, step: 25 },
  { key: 'max_spread_pct', label: 'Bid/ask fraction (0.10 = 10%)', min: .02, max: .30, step: .01 },
  { key: 'min_cushion', label: 'Minimum cushion %', min: 0, max: 15, step: .5 },
  { key: 'min_ror', label: 'Minimum return on risk %', min: 5, max: 50, step: 1 },
]
const stages = ['considered', 'cushion', 'friction', 'paired', 'ror', 'vrp', 'final']
const headers: { label: string; key?: keyof ViewRow }[] = [
  { label: 'Underlying', key: 'ticker' }, { label: 'Expiry' }, { label: 'Strategy', key: 'type' },
  { label: 'Short / long', key: 'short_strike' }, { label: 'Credit', key: 'credit' },
  { label: 'Return / risk', key: 'ror_pct' }, { label: 'Cushion', key: 'cushion_pct' }, { label: 'EV', key: 'ev' }, { label: 'Details' },
]
const inputClass = 'mt-1 block h-11 w-full rounded-xl border border-slate-300 bg-white px-3.5 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50'
const buttonClass = 'inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-50'
const cardClass = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6'
function FunnelView({ funnel }: { funnel: Funnel }) {
  return <div className="my-3 flex flex-wrap gap-2" aria-label="Filter funnel">{stages.map(stage => <div key={stage} className="min-w-24 flex-1 rounded-lg border p-3 text-xs"><span className="capitalize">{stage}</span><strong className="float-right">{funnel[stage]}</strong><div className="mt-2 h-1 bg-slate-100"><div className="h-1 bg-blue-600" style={{ width: `${Math.min(100, (funnel[stage] || 0) / Math.max(funnel.considered, 1) * 100)}%` }} /></div></div>)}</div>
}

export default function SpreadsPage() {
  const [connection, setConnection] = useState<Status>({ connected: false, expiresAt: null })
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [addingDiscovery, setAddingDiscovery] = useState(false)
  const [message, setMessage] = useState('')
  const [connectionMessage, setConnectionMessage] = useState('')
  const callbackFailure = useRef('')
  const [input, setInput] = useState('NIFTY')
  const [selected, setSelected] = useState<string[]>(['NIFTY'])
  const [options, setOptions] = useState<Record<string, string[]>>({})
  const [availability, setAvailability] = useState<Record<string, string>>({})
  const [expiries, setExpiries] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<'fixtures' | 'upstox'>('fixtures')
  const [params, setParams] = useState(defaultParams)
  const [scanning, setScanning] = useState(false)
  const scanBusy = useRef(false)
  const [result, setResult] = useState<Result | null>(null)
  const [search, setSearch] = useState('')
  const [strategy, setStrategy] = useState('')
  const [earnings, setEarnings] = useState('')
  const [ranges, setRanges] = useState<Ranges>({})
  const [sortKey, setSortKey] = useState<keyof ViewRow | ''>('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const location = useLocation()
  const navigate = useNavigate()
  const visible = displayedCandidates(result?.candidates || [], search, strategy, earnings, ranges, sortKey, sortDir)
  const activeView = Boolean(search || strategy || earnings || sortKey || Object.values(ranges).some(range => range.min || range.max))
  const refreshExpiries = useCallback(async (symbol: string) => {
    const setup = await apiGet<Setup>(`/spreads/underlyings/${encodeURIComponent(symbol)}/expiries`)
    setMode(setup.data_mode)
    setOptions(current => ({ ...current, [setup.symbol]: setup.expiries }))
    setAvailability(current => ({ ...current, [setup.symbol]: setup.scan_availability?.reason || (setup.scan_availability?.available === false ? 'Exact stock scan inputs unavailable.' : '') }))
    setSelected(current => current.includes(setup.symbol) || current.length >= MAX_UNDERLYINGS ? current : [...current, setup.symbol])
    setExpiries(current => ({ ...current, [setup.symbol]: setup.expiries.includes(current[setup.symbol]) ? current[setup.symbol] : '' }))
  }, [])
  useEffect(() => {
    let alive = true
    const query = new URLSearchParams(location.search)
    const callbackResult = query.get('upstox')
    const callbackMessage = query.get('message')
    if (callbackResult === 'error') callbackFailure.current = callbackMessage || 'Upstox connection failed.'
    // Commit provider connection status before attempting Python/expiry requests.
    // A market-data failure must not hide a successfully completed OAuth login.
    void (async () => {
      try {
        let status: Status
        try { status = await apiGet<Status>('/spreads/upstox/status') }
        catch (error) {
          // Initial account-scope hydration can abort in-flight page requests.
          // Retry once only while this mounted page still owns the request.
          if (!alive) return
          if (!(error instanceof Error) || error.name !== 'AbortError') throw error
          status = await apiGet<Status>('/spreads/upstox/status')
        }
        if (!alive) return
        setConnection(status)
        if (status.data_mode) setMode(status.data_mode)
        if (callbackFailure.current) setConnectionMessage(callbackFailure.current)
        else if (callbackResult === 'connected' && !status.connected) setConnectionMessage('Upstox returned, but this Node server has no active connection. The server may have restarted. Start a fresh connection; see the connection diagnostics below.')
        else if (status.connected) setConnectionMessage('Upstox connected. Market-data availability is checked separately.')
        else if (status.lastAttempt?.stage === 'failed') setConnectionMessage(status.lastAttempt.message || 'The last Upstox connection failed.')
        try { await refreshExpiries('NIFTY') }
        catch (error) { if (alive) setMessage(error instanceof Error ? error.message : 'Could not load expiries.') }
      } catch (error) {
        if (alive) setConnectionMessage(callbackFailure.current || (error instanceof Error ? error.message : 'Could not check Upstox connection status.'))
      } finally {
        if (alive) {
          setLoading(false)
          if (callbackResult) {
            query.delete('upstox'); query.delete('message'); query.delete('expiresAt'); query.delete('requestId')
            navigate({ pathname: location.pathname, search: query.size ? `?${query}` : '' }, { replace: true })
          }
        }
      }
    })()
    return () => { alive = false }
  }, [location.pathname, location.search, navigate, refreshExpiries])
  async function connect() {
    callbackFailure.current = ''
    setConnecting(true); setMessage(''); setConnectionMessage('Opening Upstox authorization…')
    try {
      const data = await apiPost<{ authorizationUrl: string }>('/spreads/upstox/connect')
      window.location.assign(data.authorizationUrl)
    } catch (error) { setConnectionMessage(error instanceof Error ? error.message : 'Could not connect.'); setConnecting(false) }
  }
  async function disconnect() {
    setDisconnecting(true)
    try { setConnection(await apiPost<Status>('/spreads/upstox/disconnect')); setConnectionMessage('Upstox disconnected.') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not disconnect.') }
    finally { setDisconnecting(false) }
  }
  async function add() {
    const symbols = [...new Set(input.toUpperCase().split(/[\s,;]+/).filter(Boolean))]
    if (!symbols.length || symbols.some(symbol => !/^[A-Z0-9&._-]{1,30}$/.test(symbol))) { setMessage('Enter valid NSE symbols separated by commas or spaces.'); return }
    if (new Set([...selected, ...symbols]).size > MAX_UNDERLYINGS) { setMessage(`Choose at most ${MAX_UNDERLYINGS} underlyings.`); return }
    setLoading(true); setMessage('')
    try { for (const symbol of symbols) await refreshExpiries(symbol) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load underlying.') }
    finally { setLoading(false); setInput(current => { const typed = current.toUpperCase().split(/[\s,;]+/).filter(Boolean); return typed.some(symbol => !selected.includes(symbol)) ? typed.filter(symbol => !selected.includes(symbol)).join(', ') : '' }) }
  }
  async function scan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (scanBusy.current || !selected.length) return
    scanBusy.current = true; setScanning(true); setMessage(''); setResult(null)
    try {
      const data = await apiPost<Result>('/spreads/scan', { underlyings: selected, expiries: Object.fromEntries(selected.filter(symbol => expiries[symbol]).map(symbol => [symbol, expiries[symbol]])), ...params })
      setResult(data)
      if (data.failure_count) setMessage(`${data.success_count} scanned; ${data.failure_count} unavailable. See per-underlying details.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Scan failed.') }
    finally { scanBusy.current = false; setScanning(false) }
  }
  async function addDiscovered(symbols: string[]) {
    if (new Set([...selected, ...symbols]).size > MAX_UNDERLYINGS) throw new Error(`Choose at most ${MAX_UNDERLYINGS} underlyings.`)
    setAddingDiscovery(true); setLoading(true)
    const failures: string[] = []
    try {
      for (const symbol of symbols) {
        try { await refreshExpiries(symbol) }
        catch { failures.push(symbol) }
      }
      if (failures.length) throw new Error(`Could not load expiries for ${failures.join(', ')}. Successfully loaded names remain in the scanner.`)
    } finally { setAddingDiscovery(false); setLoading(false) }
  }
  function toggleSort(key: keyof ViewRow) {
    if (sortKey === key) setSortDir(current => current === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }
  function resetView() { setSearch(''); setStrategy(''); setEarnings(''); setRanges({}); setSortKey(''); setSortDir('desc') }
  return <main className="spreads-page mx-auto max-w-[1440px] space-y-5 bg-slate-50/70 p-3 text-slate-800 sm:p-5 lg:p-7" data-testid="spreads-page">
    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="bg-gradient-to-r from-slate-950 via-slate-900 to-blue-950 px-5 py-6 text-white md:px-8 md:py-8">
        <div className="flex flex-wrap items-start justify-between gap-5"><div><p className="text-xs font-semibold uppercase tracking-[.18em] text-blue-300">Options research workspace</p><h1 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">Spreads</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Find NSE option opportunities with the original scanner methodology. Choose names, review the setup, then run one scan.</p></div>
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/15 bg-white/5 p-2"><span className="sr-only" role="status">{loading ? 'Loading setup…' : connection.connected ? 'Upstox connected' : 'Upstox not connected'}</span><span aria-hidden="true" className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${connection.connected ? 'text-emerald-200' : 'text-amber-100'}`}><span className={`h-2 w-2 rounded-full ${connection.connected ? 'bg-emerald-400' : 'bg-amber-400'}`} />{loading ? 'Checking connection…' : connection.connected ? 'Upstox connected' : 'Upstox disconnected'}</span><button type="button" className="min-h-10 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-blue-50 disabled:opacity-50" disabled={connecting || scanning} onClick={() => void connect()}>{connecting ? 'Connecting…' : connection.connected ? 'Reconnect Upstox' : 'Connect Upstox'}</button>{connection.connected && <button type="button" className="min-h-10 rounded-xl border border-white/25 px-3 py-2 text-sm text-white hover:bg-white/10 disabled:opacity-50" disabled={disconnecting || scanning} onClick={() => void disconnect()}>{disconnecting ? 'Disconnecting…' : 'Disconnect'}</button>}</div>
        </div>
        <div className="mt-6 grid gap-2 text-xs sm:grid-cols-3"><div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5"><span className="text-blue-300">01</span><span className="ml-2 text-slate-200">Discover or select underlyings</span></div><div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5"><span className="text-blue-300">02</span><span className="ml-2 text-slate-200">Choose expiry and scan settings</span></div><div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5"><span className="text-blue-300">03</span><span className="ml-2 text-slate-200">Review ranked spreads</span></div></div>
      </div>
      <div className="px-5 py-3 md:px-8">{connectionMessage && <p role="status" className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900">{connectionMessage}</p>}<details className="group mt-1 text-sm"><summary className="cursor-pointer list-none font-medium text-slate-600 marker:hidden">Connection diagnostics <span className="text-slate-400 group-open:hidden">＋</span><span className="hidden text-slate-400 group-open:inline">−</span></summary><div className="mt-3 grid gap-2 rounded-xl bg-slate-50 p-4 text-xs text-slate-600 sm:grid-cols-2"><p>{connection.connected ? 'Connected' : 'Not connected'}{connection.expiresAt ? ` · expires ${new Date(connection.expiresAt).toLocaleString()}` : ''}</p><p>{connection.lastAttempt ? `${connection.lastAttempt.stage} · ${connection.lastAttempt.at}${connection.lastAttempt.httpStatus ? ` · HTTP ${connection.lastAttempt.httpStatus}` : ''} · ${connection.lastAttempt.message || ''}` : 'No connection attempt recorded in this Node process. In-memory connections reset when Node restarts.'}</p><p className="sm:col-span-2">Detailed OAuth events appear in the Node backend terminal with the [SpreadsOAuth] prefix. Python handles market data after connection.</p></div></details></div>
    </section>
    <DiscoveryPanel available={connection.connected || mode === 'fixtures'} disabled={scanning || addingDiscovery} selected={selected} onAdd={addDiscovered} />
    <section className={cardClass}>
      <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-widest text-blue-700">Build your scan</p><h2 className="mt-1 text-xl font-semibold tracking-tight">Select underlyings</h2><p className="mt-1 text-sm text-slate-500">Add up to {MAX_UNDERLYINGS} NSE F&amp;O names. Expiries load for each selection.</p></div><span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">{selected.length} / {MAX_UNDERLYINGS} selected</span></div>
      {selected.length > 0 && <p className="mt-4 rounded-xl border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm leading-6 text-slate-800"><span className="mr-2 text-xs font-semibold uppercase tracking-wide text-blue-800">Selected</span><span className="font-semibold">{selected.join(', ')}</span></p>}
      <div className="my-5 flex flex-col gap-2 sm:flex-row sm:items-end"><label className="min-w-0 flex-1 text-sm font-medium text-slate-700">Add by NSE symbol<input aria-label="NSE underlying symbol" placeholder="Search NIFTY, BANKNIFTY or a stock such as RELIANCE" value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add() } }} className={inputClass} /><span className="mt-1 block text-xs font-normal text-slate-500">Selected: {selected.length ? selected.join(', ') : 'none'}. Type additional symbols here, then choose Add.</span></label><button type="button" className={buttonClass} disabled={loading || scanning} onClick={() => void add()}>Load F&amp;O expiries · add</button><button type="button" className={buttonClass} disabled={scanning || loading || !selected.length} onClick={() => { setSelected([]); setExpiries({}); setResult(null); setInput('') }}>Clear all</button></div>
      <div className="mt-3 space-y-2" aria-label="Selected underlying controls">{selected.map(symbol => <div key={symbol} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2"><div className="flex min-w-0 items-center gap-2"><strong className="text-sm text-slate-900">{symbol}</strong><span className="text-xs text-slate-500">NSE F&amp;O</span>{expiries[symbol] && <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{expiries[symbol]}</span>}</div><div className="flex items-center gap-2"><details className="group relative"><summary className="cursor-pointer list-none rounded-lg px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-50">Expiry <span className="text-slate-400 group-open:hidden">＋</span><span className="hidden text-slate-400 group-open:inline">−</span></summary><div className="absolute right-0 z-20 mt-1 w-64 rounded-xl border border-slate-200 bg-white p-3 shadow-lg"><label className="block text-xs font-medium text-slate-600">Option expiry<select aria-label={`${symbol} expiry`} disabled={scanning || !options[symbol]?.length} value={expiries[symbol] || ''} onChange={event => setExpiries(current => ({ ...current, [symbol]: event.target.value }))} className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800 disabled:text-slate-400"><option value="">Automatic · nearest target DTE</option>{options[symbol]?.map(expiry => <option key={expiry}>{expiry}</option>)}</select></label></div></details>{availability[symbol] && <details className="group relative"><summary aria-label={`${symbol} stock data note`} className="cursor-pointer list-none rounded-lg px-2 py-2 text-xs font-medium text-amber-800 hover:bg-amber-50">Data note <span className="text-slate-400 group-open:hidden">＋</span><span className="hidden text-slate-400 group-open:inline">−</span></summary><div className="absolute right-0 z-20 mt-1 w-[min(360px,calc(100vw-5rem))] rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950 shadow-lg">{availability[symbol]}<p className="mt-1">Other selected underlyings can still scan.</p></div></details>}<button type="button" aria-label={`Remove ${symbol}`} title={`Remove ${symbol}`} disabled={scanning || loading} className="rounded-lg px-3 py-2 text-xs font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50" onClick={() => setSelected(current => current.filter(value => value !== symbol))}>Remove</button></div></div>)}</div>
      <form onSubmit={event => void scan(event)} className="mt-5">
        <fieldset disabled={scanning} className="mt-6 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 md:p-5"><legend className="px-2 text-base font-semibold text-slate-900">Scanner parameters</legend><p className="mb-4 text-sm text-slate-500">Defaults match the original scanner. Adjust only the filters you want to change.</p><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{controls.map(control => { const labels: Record<keyof Parameters, string> = { dte: 'Target expiry distance', width: 'Spread width (index points / stock ₹)', min_vrp: 'Minimum IV ÷ RV21', min_oi: 'Minimum open interest', max_spread_pct: 'Maximum bid–ask fraction', min_cushion: 'Minimum price cushion (%)', min_ror: 'Minimum return on risk (%)' }; const hints: Record<keyof Parameters, string> = { dte: 'Calendar days · default 30', width: 'Must match an available hedge strike', min_vrp: 'Ratio · default 1.15', min_oi: 'Provider reported units · default 100', max_spread_pct: 'Fraction: 0.10 means 10% · default 0.10', min_cushion: 'Percent · default 2', min_ror: 'Percent · default 15' }; return <label key={control.key} className="text-sm font-medium text-slate-700">{labels[control.key]}<input aria-label={control.label} required type="number" min={control.min} max={control.max} step={control.step} value={params[control.key]} onChange={event => setParams(current => ({ ...current, [control.key]: Number(event.target.value) }))} className={inputClass} /><span className="mt-1 block text-xs font-normal text-slate-500">{hints[control.key]}</span></label> })}</div></fieldset>
        <p className="mt-4 rounded-xl bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-900">Width must match an available hedge strike. Up to 12 candidate strikes per side are evaluated. NSE index widths can extend to 5,000 points; the scanner never changes your width automatically.</p>
        <div className="mt-5 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center"><button type="submit" disabled={loading || scanning || !selected.length || (mode === 'upstox' && !connection.connected)} className="min-h-12 rounded-xl bg-blue-700 px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-200 disabled:cursor-not-allowed disabled:bg-slate-400">{scanning ? 'Scanning selected underlyings…' : `Scan ${selected.length} underlying${selected.length === 1 ? '' : 's'}`}</button><span className="text-xs text-slate-500">One scan request · no orders are placed</span></div>
      </form>
      {mode === 'fixtures' && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">Fixture mode: synthetic prices, quotes, earnings and lot sizes; these are not live signals.</p>}
    </section>
    {scanning && <section role="status" aria-live="polite" className="rounded-2xl border border-blue-200 bg-blue-50 p-4"><div className="flex items-center gap-3"><span aria-hidden="true" className="h-3 w-3 animate-pulse rounded-full bg-blue-600" /><div><p className="text-sm font-semibold text-blue-950">Scanning {selected.length} underlying{selected.length === 1 ? '' : 's'}</p><p className="mt-1 text-xs text-blue-800">Fetching option data and evaluating the selected spreads. Results will appear here when the scan finishes.</p></div></div></section>}
    {message && <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">{message}</p>}
    {result && <section className={cardClass} aria-label="Combined spread scan results">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-widest text-blue-700">Scan results</p><h2 className="mt-1 text-xl font-semibold tracking-tight">Ranked opportunities</h2><p className="mt-1 text-sm text-slate-500">{result.success_count} scanned · {result.failure_count} unavailable · {result.elapsed}s · {result.candidates.length} opportunities</p></div><div className="flex flex-wrap gap-2"><span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800">Bull Put and Bear Call</span><span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">Ranked by original EV</span></div></div>
      <p className="mt-3 text-xs text-[#626875]">{result.data_note}</p><p className="mt-2 text-xs text-[#626875]">{result.ranking_note} Original EV uses 100 units. INR per lot uses actual contract quantity and does not affect ranking; fixture lots are synthetic.</p>
      {result.funnel && <FunnelView funnel={result.funnel} />}
      <div aria-label="Per-underlying scan status">{result.underlyings.map(item => <details key={item.symbol} className="my-2 rounded-lg border p-3 text-xs"><summary>{item.symbol} · {item.ok ? `${item.expiry} · ${item.dte} days · spot ${item.meta?.spot} · ${item.candidates.length} opportunities` : item.error}</summary>{item.funnel && <FunnelView funnel={item.funnel} />}<p className="mt-2">{Object.entries(item.capabilities || {}).map(([key, value]) => `${key}: ${value}`).join(' · ')}</p>{item.earnings_source_note && <p className="mt-2">Earnings source: {item.earnings_source_note}</p>}{item.capability_blockers?.length ? <p className="mt-2 text-amber-800">Blocked to preserve original inputs: {item.capability_blockers.join('; ')}</p> : null}</details>)}</div>
      <details className="my-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4"><summary className="cursor-pointer text-sm font-semibold text-slate-800">Filter and sort results <span className="font-normal text-slate-500">· {visible.length} shown of {result.candidates.length}</span></summary><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs font-medium text-slate-600">Underlying<input aria-label="Filter underlying" placeholder="Search symbol" value={search} onChange={event => setSearch(event.target.value)} className={inputClass} /></label>
        <label className="text-xs font-medium text-slate-600">Strategy<select aria-label="Filter strategy" value={strategy} onChange={event => setStrategy(event.target.value)} className={inputClass}><option value="">All strategies</option><option value="BULL PUT">Bull Put</option><option value="BEAR CALL">Bear Call</option></select></label>
        <label className="text-xs font-medium text-slate-600">Earnings inside expiry<select aria-label="Filter earnings" value={earnings} onChange={event => setEarnings(event.target.value)} className={inputClass}><option value="">All</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        {numericColumns.map(key => { const title: Record<(typeof numericColumns)[number], string> = { short_strike: 'Short strike', credit: 'Credit', ror_pct: 'Return / risk (%)', cushion_pct: 'Cushion (%)', vrp: 'IV / RV21', p_adj: 'Adjusted breach (%)', ev: 'Expected value (100 units)' }; return <fieldset key={key} className="min-w-0"><legend className="text-xs font-medium text-slate-600">{title[key]}</legend><div className="mt-1 flex gap-2">{(['min', 'max'] as const).map(bound => <input key={bound} type="number" aria-label={`${key} ${bound}`} placeholder={`${bound} value`} value={ranges[key]?.[bound] || ''} onChange={event => setRanges(current => ({ ...current, [key]: { ...current[key], [bound]: event.target.value } }))} className="h-10 min-w-0 w-1/2 rounded-lg border border-slate-300 px-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" />)}</div></fieldset> })}
        <button type="button" disabled={!activeView} onClick={resetView} className={buttonClass}>Reset view</button>
      </div></details>
      <div className="overflow-hidden rounded-2xl border border-slate-200"><div className="overflow-x-auto"><table className="w-full min-w-[780px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr>{headers.map(header => <th key={header.label} aria-sort={header.key && header.key === sortKey ? sortDir === 'asc' ? 'ascending' : 'descending' : undefined} className="border-b border-slate-200 px-4 py-3">{header.key ? <button type="button" className="hover:text-blue-700" onClick={() => toggleSort(header.key!)}>{header.label} {header.key === sortKey ? sortDir === 'asc' ? '↑' : '↓' : '↕'}</button> : header.label}</th>)}</tr></thead><tbody>{visible.map(({ candidate: row }, index) => <tr key={`${row.ticker}-${row.expiration}-${row.type}-${row.short_strike}-${index}`} className="border-b border-slate-100 align-top last:border-0 hover:bg-blue-50/40">
        {[<span className="font-semibold text-slate-900">{row.ticker}</span>, row.expiration, <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${row.type === 'BULL PUT' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>{row.type === 'BULL PUT' ? 'Bull Put' : 'Bear Call'}</span>, <span className="whitespace-nowrap font-medium tabular-nums">{row.short_strike} / {row.long_strike}</span>, <span className="font-semibold tabular-nums">{row.credit}</span>, <span className="tabular-nums">{row.ror_pct}%</span>, <span className="tabular-nums">{row.cushion_pct}%</span>, <span className="font-semibold tabular-nums">{row.ev}</span>].map((value, column) => <td key={column} className="px-4 py-3.5">{value}</td>)}
        <td className="px-4 py-3"><details className="group"><summary className="cursor-pointer whitespace-nowrap font-medium text-blue-700 hover:text-blue-900">Full breakdown <span className="text-slate-400 group-open:hidden">＋</span><span className="hidden text-slate-400 group-open:inline">−</span></summary><div className="mt-3 grid w-[min(620px,calc(100vw-4rem))] gap-3 whitespace-normal text-xs sm:grid-cols-2"><div className="rounded-xl bg-slate-50 p-3"><strong>Spread</strong><p className="mt-1">Expiry {row.expiration} · width {row.width} · credit {row.credit}</p><p>Short {row.short_instrument_key ?? 'unavailable'} · long {row.long_instrument_key ?? 'unavailable'}</p></div><div className="rounded-xl bg-slate-50 p-3"><strong>Returns</strong><p className="mt-1">RoR {row.ror_pct}% · cushion {row.cushion_pct}% · EV {row.ev} original 100-unit convention</p><p>Lot {row.lot_size ?? 'unavailable'} · EV/lot {row.ev_per_lot_inr == null ? 'Unavailable' : `₹${row.ev_per_lot_inr}`}{row.lot_size_status === 'fixture' ? ' (fixture)' : ''}</p><p>Credit/lot ₹{row.credit_per_lot_inr ?? '—'} · max loss/lot ₹{row.max_loss_per_lot_inr ?? '—'} · lot source {row.lot_size_status}</p></div><div className="rounded-xl bg-slate-50 p-3 sm:col-span-2"><strong>Original calculation layers</strong><p className="mt-1">RV: {Object.entries(row.layers.l1).map(([key, value]) => `${key} ${value ?? '—'}`).join(' · ')}</p><p>Earnings: {row.earnings ? 'inside expiry' : 'outside expiry'} · max gap {row.layers.l2.max_gap_pct}%</p><p>IV {row.layers.l3.iv} / RV21 {row.layers.l3.rv21} = VRP {row.layers.l3.ratio}</p><p>Historical breach: raw {row.layers.l4.p_raw} · earnings adjusted {row.layers.l4.p_adj} · {row.layers.l4.horizon_td} trading days</p><p>Friction: short {row.layers.l5.short.spread_pct * 100}% · OI {row.layers.l5.short.oi}; long {row.layers.l5.long.spread_pct * 100}% · OI {row.layers.l5.long.oi}</p>{row.monetary_status === 'ambiguous_duplicate_strike' && <p className="mt-2 font-medium text-amber-800">Per-lot amounts unavailable: duplicate strike quotes cannot be attributed unambiguously.</p>}</div></div></details></td>
      </tr>)}</tbody></table></div></div>
      {result.underlyings.some(item => item.data_warnings?.length) && <details className="mt-3 text-xs"><summary>Market-data notes (do not block scanning)</summary>{result.underlyings.map(item => item.data_warnings?.length ? <p key={item.symbol} className="mt-2">{item.symbol}: {item.data_warnings.join(' ')}</p> : null)}</details>}
      {!visible.length && <p className="mt-4 text-xs">{result.candidates.length ? 'No opportunities match these display filters.' : result.success_count ? 'No candidates passed the scanner filters.' : 'Scan unavailable. See the per-underlying error above.'}</p>}
    </section>}
    <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4 text-xs leading-5 text-slate-500"><p>Discovery ranks the NSE option-underlying universe using the original calculations. Selecting a name does not run a spread scan.</p><p className="mt-2">Research only. Upstox supplies market data; this page has no order-placement path.</p></section>
  </main>
}
