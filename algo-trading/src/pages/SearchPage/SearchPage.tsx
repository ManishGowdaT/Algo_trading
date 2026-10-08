import { useEffect, useState } from 'react'
import { Search, Radio, RefreshCw } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useAngelConnection } from '../../shared/angel/AngelConnectionProvider'
import { apiGet, apiStream } from '../../trading/api'
import { TradingViewChart, type CandleItem } from '../../components/chart/TradingViewChart'

type Instrument = {
  exchange: string; symboltoken: string; tradingsymbol: string; name: string;
  instrumentType: string; expiry: string | null; lotSize: number | null; optionType: string | null;
}
type Snapshot = {
  instrument: Instrument; interval: string; status: string; serverTime: number;
  historyStatus: string; candles: CandleItem[];
  quote: { ltp: number; timestamp: number | null; receivedAt: number; source: string } | null;
  error?: string;
}
const intervals = [['ONE_MINUTE', '1m'], ['THREE_MINUTE', '3m'], ['FIVE_MINUTE', '5m'], ['FIFTEEN_MINUTE', '15m'], ['THIRTY_MINUTE', '30m'], ['ONE_HOUR', '1h']]
const toggles = { showEma: false, showJma: false, showMha: false, showMarkers: false, showPriceLines: false }
const price = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })

function ConnectedSearch() {
  const [query, setQuery] = useState('')
  const [exchange, setExchange] = useState('ALL')
  const [items, setItems] = useState<Instrument[]>([])
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [selected, setSelected] = useState<Instrument | null>(null)
  const [interval, setTimeframe] = useState('FIVE_MINUTE')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [streamError, setStreamError] = useState('')
  const [connected, setConnected] = useState(false)
  const [searchRetry, setSearchRetry] = useState(0)
  const [streamRetry, setStreamRetry] = useState(0)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(clock)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setItems([]); setSearchError(''); setLoading(query.trim().length >= 2)
    if (query.trim().length < 2) return () => controller.abort()
    let deadline: ReturnType<typeof setTimeout>
    const debounce = setTimeout(() => {
      deadline = setTimeout(() => { setLoading(false); setSearchError('Search timed out. Please retry.'); controller.abort() }, 15000)
      void apiGet<{ items: Instrument[] }>(`/instruments/search?${new URLSearchParams({ query: query.trim(), exchange })}`, controller.signal)
        .then(data => { if (!controller.signal.aborted) setItems(data.items) })
        .catch(error => { if (!controller.signal.aborted) setSearchError(error.message || 'Search is unavailable. Please retry.') })
        .finally(() => { clearTimeout(deadline); if (!controller.signal.aborted) setLoading(false) })
    }, 400)
    return () => { controller.abort(); clearTimeout(debounce); clearTimeout(deadline) }
  }, [query, exchange, searchRetry])

  useEffect(() => {
    setSnapshot(null); setStreamError(''); setConnected(false)
    if (!selected) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let failures = 0
    const connect = async () => {
      if (controller.signal.aborted) return
      try {
        await apiStream<Snapshot>(`/instruments/live?${new URLSearchParams({ exchange: selected.exchange, symboltoken: selected.symboltoken, interval })}`,
          controller.signal, data => {
            if (controller.signal.aborted) return
            if (data.error) throw new Error(data.error)
            if (data.instrument.exchange !== selected.exchange || data.instrument.symboltoken !== selected.symboltoken || data.interval !== interval) throw new Error('Live instrument changed. Please select it again.')
            setSnapshot(data); setConnected(true); setStreamError(''); failures = 0
          })
      } catch (error) {
        if (controller.signal.aborted) return
        setStreamError(error instanceof Error ? error.message : 'Live data is unavailable.')
        failures++
      }
      if (!controller.signal.aborted) {
        setConnected(false)
        timer = setTimeout(() => void connect(), Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) + Math.random() * 500)
      }
    }
    void connect()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [selected, interval, streamRetry])

  const deliveryAge = snapshot ? now - snapshot.serverTime : Infinity
  const quoteAge = snapshot?.quote?.timestamp ? now - snapshot.quote.timestamp : Infinity
  const status = !connected || deliveryAge > 10000 ? 'RECONNECTING'
    : snapshot?.status === 'LIVE' && quoteAge > 15000 ? 'STALE' : snapshot?.status || 'WAITING'
  const message = streamError || (status === 'STALE' ? 'No recent trades received. The market may be closed or this instrument may be inactive.'
    : status === 'WAITING' ? 'Waiting for an Angel One quote. Inactive instruments may not receive ticks.'
    : status === 'RECONNECTING' ? 'Connecting to the live feed…' : '')

  return <div className="mx-auto w-full max-w-[1600px] p-4 md:p-6">
    <div className="mb-5 flex items-center gap-3"><Search className="h-6 w-6 text-[#0052FF]" /><div><h1 className="text-xl font-semibold text-[#1E222D]">Market Search</h1><p className="text-sm text-[#787B86]">Find stocks, indices, futures and option contracts on Angel One.</p></div></div>
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <section className="rounded-xl border border-[#E0E3EB] bg-white p-4" aria-label="Instrument search">
        <label className="mb-2 block text-sm font-medium" htmlFor="instrument-search">Symbol or company</label>
        <input id="instrument-search" type="search" autoComplete="off" maxLength={80} value={query} onChange={event => setQuery(event.target.value)} placeholder="RELIANCE, NIFTY CE, BANKNIFTY…" className="mb-3 min-h-11 w-full rounded-lg border border-[#E0E3EB] px-3 text-sm focus:border-[#0052FF] focus:outline-none" />
        <label className="sr-only" htmlFor="search-exchange">Exchange</label>
        <select id="search-exchange" value={exchange} onChange={event => setExchange(event.target.value)} className="mb-4 min-h-11 w-full rounded-lg border border-[#E0E3EB] px-3 text-sm">
          {['ALL', 'NSE', 'BSE', 'NFO', 'BFO', 'MCX'].map(value => <option key={value} value={value}>{value === 'ALL' ? 'All exchanges' : value}</option>)}
        </select>
        <div aria-live="polite" className="mb-3 text-sm text-[#787B86]">{loading ? 'Searching…' : searchError || (query.trim().length < 2 ? 'Enter at least two characters to search.' : items.length ? `${items.length} matches. Narrow your search for more specific contracts.` : 'No matching instruments.')}</div>
        {searchError && <button onClick={() => setSearchRetry(value => value + 1)} className="mb-3 text-sm text-[#0052FF]">Retry search</button>}
        <ul className="max-h-[400px] space-y-2 overflow-y-auto lg:max-h-[600px]">
          {items.map(item => <li key={`${item.exchange}:${item.symboltoken}`}><button onClick={() => setSelected(item)} className={`w-full rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-[#0052FF] ${selected?.exchange === item.exchange && selected.symboltoken === item.symboltoken ? 'border-[#0052FF] bg-blue-50' : 'border-[#E0E3EB] hover:bg-slate-50'}`}>
            <span className="block break-all text-sm font-semibold text-[#1E222D]">{item.tradingsymbol}</span><span className="mt-1 block text-xs text-[#787B86]">{item.name} · {item.exchange} · {item.instrumentType}</span>
            {item.expiry && <span className="mt-1 block text-xs text-[#787B86]">Expiry {item.expiry}{item.lotSize ? ` · Lot ${item.lotSize}` : ''}</span>}
          </button></li>)}
        </ul>
      </section>
      <section className="min-w-0 rounded-xl border border-[#E0E3EB] bg-white p-4" aria-label="Live instrument chart">
        {!selected ? <div className="flex min-h-[400px] flex-col items-center justify-center gap-3 text-center text-[#787B86]"><Radio className="h-8 w-8" /><p>Select an instrument to view its quote and chart.</p></div> : <>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3"><div><h2 className="break-all text-lg font-semibold">{selected.tradingsymbol}</h2><p className="text-xs text-[#787B86]">{selected.exchange} · {selected.name}</p></div><div className="text-right"><p className="text-2xl font-semibold tabular-nums">{snapshot?.quote ? price.format(snapshot.quote.ltp) : '—'}</p><p className={`text-xs font-semibold ${status === 'LIVE' ? 'text-emerald-600' : 'text-amber-700'}`}>{status === 'LIVE' ? 'Live' : status.toLowerCase().replace('_', ' ')}</p></div></div>
          {snapshot?.quote && <p className="mb-3 text-xs text-[#787B86]">{snapshot.quote.timestamp ? `Exchange time: ${new Date(snapshot.quote.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST` : 'Fallback quote: exchange timestamp unavailable.'} · {snapshot.quote.source}</p>}
          <div className="mb-3 flex flex-wrap gap-2">{intervals.map(([value, label]) => <button key={value} onClick={() => setTimeframe(value)} aria-pressed={interval === value} className={`min-h-10 rounded-md px-3 text-sm ${interval === value ? 'bg-[#0052FF] text-white' : 'bg-slate-100 text-slate-600'}`}>{label}</button>)}<button onClick={() => setStreamRetry(value => value + 1)} aria-label="Reconnect live data" className="ml-auto min-h-10 rounded-md px-3 text-sm text-[#0052FF]"><RefreshCw className="h-4 w-4" /></button></div>
          {message && <p role="status" className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">{message}</p>}
          {snapshot?.historyStatus !== 'READY' && <p className="mb-3 text-xs text-[#787B86]">{snapshot?.historyStatus === 'RETRYING' ? 'Chart history is temporarily unavailable; retrying with backoff.' : 'Loading chart history…'}</p>}
          <div className="h-[380px] md:h-[560px]"><TradingViewChart key={`${selected.exchange}:${selected.symboltoken}:${interval}`} candles={snapshot?.candles || []} toggles={toggles} liveUpdates /></div>
          <p className="mt-3 text-xs text-[#787B86]">The latest candle is forming. Live candles are built from received ticks; gaps during disconnections can make them incomplete. Data availability depends on market hours and the selected contract.</p>
        </>}
      </section>
    </div>
  </div>
}

export default function SearchPage() {
  const { user } = useAuth()
  const { connectStatus, brokerAccountId, openConnect } = useAngelConnection()
  if (connectStatus !== 'connected' || !brokerAccountId) return <div className="p-6"><h1 className="mb-3 text-xl font-semibold">Market Search</h1><p className="mb-4 text-sm text-slate-600">Connect your Angel One account to search instruments and view live market data.</p><button onClick={openConnect} className="rounded-lg bg-[#0052FF] px-4 py-3 text-sm font-semibold text-white">Connect Angel One</button></div>
  return <ConnectedSearch key={`${user?._id}:${brokerAccountId}`} />
}
