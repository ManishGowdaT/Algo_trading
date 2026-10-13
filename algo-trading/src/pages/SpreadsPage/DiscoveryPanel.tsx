import { useEffect, useRef, useState } from 'react'
import { apiGet, apiPost } from '../../trading'

export type DiscoveryItem = { ticker: string; spot: number; chg: number; rv21: number | null; iv14: number | null; vrp14: number | null; iv_status?: 'pending' | 'available' | 'unavailable' | 'failed'; vrp_status?: 'pending' | 'available' | 'unavailable' | 'failed'; shock: number; vrp_pass: boolean; shock_pass: boolean; edge: boolean; score: number }
export type DiscoveryPayload = { updated: number; refreshing: boolean; progress?: { stage: string; completed: number; total: number } | null; stats?: { eligible_underlyings?: number; atm_iv_attempted?: number; atm_iv_available?: number; atm_iv_unavailable?: number; atm_iv_failed?: number; failed_requests?: number; option_chain_requests?: number; v3_greeks_requests?: number; rate_limit_responses?: number; total_runtime_seconds?: number; complete?: boolean }; top: DiscoveryItem[]; all: DiscoveryItem[]; universe: { source?: string; size?: number; note?: string }; errors: { ticker: string | null; stage: string; error: string }[]; capabilities?: Record<string, Record<string, string>>; data_mode: string; data_note: string }
type Props = { available: boolean; disabled: boolean; selected: string[]; onAdd: (symbols: string[]) => Promise<void> }
const MAX_UNDERLYINGS = 50
const searchClass = 'h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100'
const primaryButtonClass = 'inline-flex min-h-10 items-center justify-center rounded-xl border border-blue-800 bg-blue-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:border-blue-900 hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-600 disabled:opacity-100'
const metric = (value: number | null, percent = false) => value == null ? 'Unavailable' : `${(percent ? value * 100 : value).toFixed(2)}${percent ? '%' : ''}`

export default function DiscoveryPanel({ available, disabled, selected, onAdd }: Props) {
  const [payload, setPayload] = useState<DiscoveryPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [showAll, setShowAll] = useState(false)
  const [filter, setFilter] = useState('')
  const requestBusy = useRef(false)
  const addBusy = useRef(false)
  const mounted = useRef(true)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; controller.current?.abort() }
  }, [])
  async function load(force: boolean) {
    if (requestBusy.current || disabled || !available) return
    requestBusy.current = true; setBusy(true); setMessage('')
    const abort = new AbortController()
    controller.current = abort
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => { abort.abort(); reject(new Error('Discovery took too long. Use Check cached ranking to retrieve its latest status.')) }, 900_000)
    })
    try {
      let result = await Promise.race([force ? apiPost<DiscoveryPayload>('/spreads/discover') : apiGet<DiscoveryPayload>('/spreads/trending', abort.signal), deadline])
      while (result.refreshing && mounted.current && !abort.signal.aborted) {
        setPayload(result)
        setMessage(result.progress ? `${result.progress.stage === 'history' ? 'Daily history' : result.progress.stage === 'iv' ? 'ATM IV / VRP' : 'Instrument universe'}: ${result.progress.completed} / ${result.progress.total || 'loading'}${result.progress.stage === 'iv' ? ` · ${Math.max(0, result.progress.total - result.progress.completed)} pending` : ''}` : 'Discovery is running. Waiting for provider data…')
        await Promise.race([new Promise(resolve => setTimeout(resolve, 3000)), deadline])
        if (!mounted.current || abort.signal.aborted) return
        result = await Promise.race([apiGet<DiscoveryPayload>('/spreads/trending', abort.signal), deadline])
      }
      if (!mounted.current) return
      setPayload(result); setMessage(result.stats?.complete ? `Discovery complete · ${result.stats.eligible_underlyings ?? result.universe.size ?? 0} eligible · ${result.stats.atm_iv_attempted ?? 0} ATM IV / VRP attempts · ${result.stats.atm_iv_available ?? 0} available · ${result.stats.atm_iv_unavailable ?? 0} unavailable · ${result.stats.atm_iv_failed ?? 0} IV failed · ${result.stats.failed_requests ?? 0} provider errors · ${result.stats.option_chain_requests ?? 0} option-chain requests · ${result.stats.v3_greeks_requests ?? 0} V3 requests · ${result.stats.rate_limit_responses ?? 0} rate limits · ${result.stats.total_runtime_seconds ?? 0}s` : '')
      setPicked(current => current.filter(symbol => result.all.some(item => item.ticker === symbol)))
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Discovery could not be loaded.') }
    finally { if (deadlineTimer) clearTimeout(deadlineTimer); controller.current = null; requestBusy.current = false; if (mounted.current) setBusy(false) }
  }
  function toggle(symbol: string) {
    if (picked.includes(symbol)) { setPicked(current => current.filter(item => item !== symbol)); return }
    if (new Set([...selected, ...picked, symbol]).size > MAX_UNDERLYINGS) { setMessage(`Choose at most ${MAX_UNDERLYINGS} underlyings including your existing scanner selection.`); return }
    setPicked(current => [...current, symbol]); setMessage('')
  }
  async function add() {
    if (addBusy.current || disabled || !picked.length) return
    if (new Set([...selected, ...picked]).size > MAX_UNDERLYINGS) { setMessage(`Selection exceeds ${MAX_UNDERLYINGS} underlyings. Remove some names first.`); return }
    addBusy.current = true; setAdding(true); setMessage('')
    try { await onAdd(picked); setPicked([]); setMessage('Added to scanner. Set parameters and click SCAN when ready.') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not add selected underlyings.') }
    finally { addBusy.current = false; setAdding(false) }
  }
  function selectTop50() {
    if (!payload || disabled || busy || adding) return;
    const remaining = Math.max(0, MAX_UNDERLYINGS - new Set(selected).size);
    const top = [...new Set(payload.all.slice(0, MAX_UNDERLYINGS).map(row => row.ticker))]
      .filter(symbol => !selected.includes(symbol));
    setPicked(top.slice(0, remaining));
    setShowAll(true);
    setFilter('');
    setMessage(top.length > remaining
      ? `Selected ${remaining} top-ranked names. Existing scanner selections use ${selected.length} of the ${MAX_UNDERLYINGS} slots. Remove names from the scanner to select more.`
      : `Selected ${top.length} top-ranked names for addition. Names already in the scanner are retained. Click Add selected to scanner when ready.`);
  }
  const rows = (payload ? showAll ? payload.all : payload.top : []).filter(row => row.ticker.toLowerCase().includes(filter.trim().toLowerCase()))
  const shellButton = 'inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-600 disabled:opacity-100'
  return <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm" aria-label="Discover NSE F&O opportunities">
    <div className="flex flex-col gap-4 border-b border-slate-200 bg-gradient-to-r from-blue-50 to-white p-5 md:flex-row md:items-center md:justify-between md:px-6"><div><p className="text-xs font-semibold uppercase tracking-widest text-blue-700">Find candidates</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">Discovery ranking</h2><p className="mt-1 max-w-2xl text-sm text-slate-600">Ranks NSE F&amp;O underlyings with the original volume-shock and IV/RV method. Select names here, then scan them separately.</p></div><div className="flex flex-wrap gap-2"><button type="button" disabled={!available || disabled || busy || adding} className={primaryButtonClass} onClick={() => load(true)}>{busy ? 'Refreshing ranking…' : 'Discover opportunities'}</button><button type="button" disabled={!available || disabled || busy || adding} className={shellButton} onClick={() => load(false)}>Check cached ranking</button></div></div>
    <div className="p-5 md:p-6">
    {!available && <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Connect Upstox to load live market discovery.</p>}
    {busy && !payload && <p role="status" className="mt-3 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900">Loading the NSE F&amp;O universe and historical market inputs…</p>}
    {message && <p role="status" className="mt-3 rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">{message}</p>}
    {payload && <>
      <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">{payload.data_note}<br /><span className="text-slate-500">{payload.universe.size ?? 0} eligible · {payload.all.length} ranked · {payload.universe.source || 'source unavailable'} · {payload.updated ? `updated ${new Date(payload.updated * 1000).toLocaleString()}` : 'No successful ranking yet'}{payload.refreshing ? ' · refresh in progress' : ''}</span></p>
      <details className="mt-3 rounded-xl border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-medium text-slate-700">How to read this ranking</summary><p className="mt-2 text-xs leading-5 text-slate-600">Daily change is historical. RV21 and ATM IV are annualized percentages; VRP and volume shock are ratios. Edge score is the original percentile-rank sum, not a predicted return. ATM IV and VRP are attempted for every eligible underlying.</p></details>
      <div className="my-4 flex flex-col gap-3 rounded-2xl bg-slate-50 p-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex flex-wrap items-center gap-2"><button type="button" className={shellButton} onClick={() => setShowAll(current => !current)}>{showAll ? 'Show top 5' : `Show all ${payload.all.length}`}</button><span className="text-xs font-medium text-slate-600">{picked.length} selected · {selected.length} already in scan · limit {MAX_UNDERLYINGS} total</span></div><div className="flex flex-wrap items-center gap-2"><button type="button" className={primaryButtonClass} disabled={!picked.length || disabled || adding || busy} onClick={() => void add()}>{adding ? 'Adding…' : 'Add selected to scanner'}</button>{picked.length > 0 && <button type="button" className={shellButton} disabled={adding || busy} onClick={() => setPicked([])}>Clear picks</button>}</div>{adding && <span role="status" className="text-xs font-medium text-blue-800">Adding selected underlyings…</span>}</div>
      <label className="mb-3 block max-w-sm text-xs font-medium text-slate-600">Find an underlying<input aria-label="Search discovery underlyings" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Type a symbol, for example TATAELXSI" className={`${searchClass} mt-1`} /></label>
      <button type="button" className={`${shellButton} mb-3`} disabled={disabled || busy || adding || !payload.all.length || selected.length >= MAX_UNDERLYINGS} onClick={selectTop50}>Select top 50</button>
      <div className={`rounded-2xl border border-slate-200 ${showAll ? 'max-h-[min(65vh,680px)] overflow-auto overscroll-contain' : 'overflow-x-auto'}`}><table className="w-full min-w-[900px] text-left text-sm"><thead className="sticky top-0 z-10 bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr>{['Select','Rank','Underlying','Spot (₹ / index pts)','Daily change','Volume shock','RV21','ATM IV','VRP','Edge','Score'].map(title => <th key={title} className="border-b border-slate-200 px-3 py-3">{title}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.ticker} className="border-b border-slate-100 last:border-0 hover:bg-blue-50/40"><td className="px-3 py-3"><input type="checkbox" aria-label={`Select discovery ${row.ticker}`} checked={picked.includes(row.ticker)} disabled={disabled || adding || busy || selected.includes(row.ticker)} onChange={() => toggle(row.ticker)} /></td><td className="px-3 py-3 tabular-nums text-slate-500">{payload.all.findIndex(item => item.ticker === row.ticker) + 1}</td><td className="px-3 py-3 font-semibold text-slate-900">{row.ticker}{selected.includes(row.ticker) ? <span className="ml-2 rounded-full bg-blue-100 px-2 py-1 text-[10px] font-medium text-blue-800">In scan</span> : null}</td><td className="px-3 py-3 tabular-nums">{metric(row.spot)}</td><td className="px-3 py-3 tabular-nums">{row.chg.toFixed(2)}%</td><td className="px-3 py-3 tabular-nums">{metric(row.shock)}×</td><td className="px-3 py-3 tabular-nums">{metric(row.rv21, true)}</td><td className="px-3 py-3 tabular-nums" title={row.iv_status || (payload.refreshing ? 'pending' : 'unavailable')}>{row.iv14 == null ? row.iv_status === 'failed' ? 'Failed' : payload.refreshing ? 'Pending' : 'Unavailable' : metric(row.iv14, true)}</td><td className="px-3 py-3 tabular-nums" title={row.vrp_status || (payload.refreshing ? 'pending' : 'unavailable')}>{row.vrp14 == null ? row.vrp_status === 'failed' ? 'Failed' : payload.refreshing ? 'Pending' : 'Unavailable' : metric(row.vrp14)}</td><td className="px-3 py-3">{row.edge ? 'Yes' : 'No'}</td><td className="px-3 py-3 tabular-nums">{metric(row.score)}</td></tr>)}</tbody></table></div>
      {!rows.length && <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">{payload.all.length && filter.trim() ? `No symbols match “${filter.trim()}”.` : 'No rankable underlyings returned. Check provider-input errors below; discovery does not guarantee spread candidates.'}</p>}
      {!!payload.errors.length && <details className="mt-3 text-xs"><summary>{payload.errors.length} provider-input issue(s)</summary>{payload.errors.map((error, index) => <p key={index} className="mt-2">{error.ticker || 'Universe'} · {error.stage}: {error.error}</p>)}</details>}
      <details className="mt-3 rounded-xl border border-slate-200 p-3 text-xs"><summary className="cursor-pointer font-medium text-slate-700">Data-source and capability notes</summary><p className="mt-2">{payload.universe.note}</p><p className="mt-2">Discovery does not require earnings. Exact stock spread scans can still report missing earnings inputs.</p>{Object.entries(payload.capabilities || {}).map(([symbol, notes]) => <p key={symbol} className="mt-1">{symbol}: {Object.entries(notes).map(([key, value]) => `${key} ${value}`).join(' · ')}</p>)}</details>
    </>}
    </div>
  </section>
}
