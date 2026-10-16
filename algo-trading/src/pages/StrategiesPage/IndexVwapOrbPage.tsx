import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Square, XCircle, Activity } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useAngelConnection } from '../../shared/angel/AngelConnectionProvider'
import { apiGet, apiPost, isApiScopeCurrent } from '../../trading'
import { AccountSettingsSaveQueue, loadValidatedStrategySettings } from '../../trading/strategySettingsLifecycle'
import { startResilientPolling } from '../../utils/resilientPolling'
import { hasOrbExposure, lotFor, normalizeOrbSettings, orbDate, orbDefaults, validOrbConfig, type IndexOrbConfig, type IndexUnderlying, type OrbCandle, type OrbStatus } from '../../trading/indexVwapOrbUi'
import StrategiesLayout from './StrategiesLayout'
import MobileStrategyActions from '../../components/Layout/MobileStrategyActions'
import IndexOrbChart from '../../components/chart/IndexOrbChart'

const NAME = 'IndexVwapOrb'
const field = 'w-full min-h-11 rounded border border-slate-200 bg-slate-50 px-3 text-sm disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900'
const panel = 'rounded border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900'
const display = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '--'

export default function IndexVwapOrbPage() {
  const { user } = useAuth()
  const { brokerAccountId } = useAngelConnection()
  const scope = user && brokerAccountId ? `${user._id}:${brokerAccountId}` : 'unavailable'
  return <IndexOrbInner key={scope} scope={scope} />
}
function IndexOrbInner({ scope }: { scope: string }) {
  const { connectStatus, openConnect } = useAngelConnection()
  const active = useRef(true)
  const saveQueue = useRef(new AccountSettingsSaveQueue(scope))
  const editVersion = useRef(0)
  const [config, setConfig] = useState<IndexOrbConfig>(() => structuredClone(orbDefaults))
  const [saved, setSaved] = useState<IndexOrbConfig | null>(null)
  const [settingsReady, setSettingsReady] = useState(false)
  const [status, setStatus] = useState<OrbStatus | null>(null)
  const [statusReady, setStatusReady] = useState(false)
  const [message, setMessage] = useState('')
  const [saveState, setSaveState] = useState('Loading settings')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [date, setDate] = useState(orbDate())
  const [timeframe, setTimeframe] = useState<'1m' | '5m'>('1m')
  const [history, setHistory] = useState<OrbCandle[]>([])
  const [historyMessage, setHistoryMessage] = useState('')
  const [showLevels, setShowLevels] = useState(true)
  const [showVwap, setShowVwap] = useState(true)
  const [showMarkers, setShowMarkers] = useState(true)
  const current = useCallback(() => active.current && isApiScopeCurrent(scope), [scope])
  const exposure = hasOrbExposure(status)
  const locked = !settingsReady || !statusReady || Boolean(status?.isRunning) || exposure || busy || saving
  const valid = validOrbConfig(config)
  const dirty = !saved || JSON.stringify(saved) !== JSON.stringify(config)
  const lot = lotFor(status, config.underlying)
  const lotValid = lot === null || config.quantity % lot === 0
  const canStart = !locked && valid && lotValid && !dirty && connectStatus === 'connected'

  useEffect(() => {
    const queue = saveQueue.current
    let mounted = true
    const effectCurrent = () => mounted && current()
    active.current = true; queue.activate()
    if (scope === 'unavailable') { setMessage('Connect a broker account to load this strategy.'); return () => { mounted = false; active.current = false; queue.dispose() } }
    loadValidatedStrategySettings(NAME, () => apiGet(`/strategies/settings/${NAME}`))
      .then(value => { if (!effectCurrent()) return; const next = normalizeOrbSettings(value); setConfig(next); setSaved(next); setSettingsReady(true); setSaveState('Settings loaded') })
      .catch(error => { if (effectCurrent()) { setMessage(error.message); setSaveState('Settings unavailable') } })
    const stop = startResilientPolling(async () => {
      try {
        const response = await apiGet<{ data: OrbStatus }>(`/strategies/${NAME}/status`)
        if (!effectCurrent()) return false
        setStatus(response.data); setStatusReady(true); return true
      } catch { if (effectCurrent()) setStatusReady(false); return false }
    }, { intervalMs: 1500 })
    return () => { mounted = false; active.current = false; queue.dispose(); stop() }
  }, [scope, current])

  const update = (change: Partial<IndexOrbConfig>) => {
    if (locked) return
    editVersion.current++; setConfig(previous => ({ ...previous, ...change })); setSaveState('Unsaved changes')
  }
  const save = () => {
    if (locked || !valid || !lotValid) return
    const version = editVersion.current
    const snapshot = structuredClone(config)
    setSaveState('Saving settings...')
    setSaving(true)
    saveQueue.current.enqueue(snapshot, async (_scope, value) => {
      try {
        const response = await apiPost<{ data: { config: Record<string, unknown> } }>(`/strategies/settings/${NAME}`, { config: value })
        if (!current()) return
        const next = normalizeOrbSettings(response.data.config)
        setSaved(next)
        if (version === editVersion.current) { setConfig(next); setSaveState('Settings saved') }
      } catch (error) { if (current()) setSaveState(`Save failed: ${error instanceof Error ? error.message : 'Please retry'}`); throw error }
      finally { if (current()) setSaving(false) }
    }, isApiScopeCurrent)
  }
  const action = async (kind: 'start' | 'stop' | 'exit') => {
    if (!current() || busy || (kind === 'start' && !canStart)) return
    setBusy(true);setMessage('')
    try {
      const response = await apiPost<{ data: OrbStatus }>(`/strategies/${NAME}/${kind}`, kind === 'start' ? config : undefined)
      if (!current()) return
      setStatus(response.data); setStatusReady(true)
      setMessage(kind === 'stop' && hasOrbExposure(response.data) ? 'New entries stopped. Held or unresolved positions remain managed.' : response.data.message ?? '')
    } catch (error) { if (current()) setMessage(error instanceof Error ? error.message : 'Request failed') }
    finally { if (current()) setBusy(false) }
  }

  const liveData = status?.underlyingData?.date === date && date === orbDate()
    && (status.analysis?.underlying === config.underlying || status.ceContract?.underlying === config.underlying) ? status.underlyingData : null
  const hasLiveData = Boolean(liveData)
  useEffect(() => {
    let validRequest = true
    setHistory([]);setHistoryMessage('')
    if (!settingsReady || hasLiveData) return () => { validRequest = false }
    apiGet<{ data: { candles: OrbCandle[] } }>(`/chart/market-data?underlying=${config.underlying}&date=${date}&interval=${timeframe}`)
      .then(res => { if (validRequest && current()) { setHistory(res.data.candles ?? []);setHistoryMessage('Price history only. Strategy overlays require backend replay diagnostics.') } })
      .catch(error => { if (validRequest && current()) setHistoryMessage(error.message) })
    return () => { validRequest = false }
  }, [config.underlying, date, timeframe, settingsReady, hasLiveData, current])
  const candles = liveData ? (timeframe === '1m' ? liveData.candles1m : liveData.candles5m) : history
  const analysis = status?.analysis?.underlying === config.underlying ? status.analysis : null
  const d = analysis?.diagnostics
  const setup = d?.setup
  const candidate = d?.latestCandidate
  const held = status?.referenceRisk
  const checkpoints = [
    ['Broker connection', connectStatus === 'connected' && status?.brokerReady], ['Spot 1M / 5M ready', liveData?.ready],
    ['Volume / VWAP ready', typeof d?.vwap === 'number'], ['Opening range locked', typeof d?.orHigh === 'number'],
    ['5M breakout closed', Boolean(setup?.breakout || candidate?.breakoutClosedAt)],
    ['5M retest held', Boolean(setup?.retest || candidate?.retestClosedAt)], ['1M pivot confirmed', Boolean(setup?.pivot || candidate?.pivot)],
    ['Entry admissible', Boolean(analysis?.isEntry && !status?.dailyEntries?.blocked && (status?.dailyEntries?.filled ?? 2) + (status?.dailyEntries?.reserved ?? 0) < 2)],
    ['Option contracts ready', Boolean(status?.ceContract && status?.peContract)],
  ] as const
  return <StrategiesLayout title="Index VWAP + Opening Range" subtitle="NIFTY, BANKNIFTY and SENSEX · 5M setup / 1M execution" backTo="/strategies">
    <div className="mt-4 space-y-4 pb-20 md:pb-0">
      <section className={`${panel} flex flex-wrap items-center justify-between gap-3`}>
        <div><p className="font-semibold flex items-center gap-2"><Activity size={16} />{statusReady ? status?.state ?? 'STOPPED' : 'Status unavailable'}</p>
          <p className="text-xs text-slate-500 mt-1">{message || status?.message || 'Load saved settings, then start when ready.'}</p></div>
        <div className="flex flex-wrap gap-2">
          {connectStatus !== 'connected' && <button className="min-h-11 rounded border px-3 text-sm" onClick={() => void openConnect()}>Connect Angel One</button>}
          {exposure && <button disabled={busy || !statusReady} onClick={() => void action('exit')} className="min-h-11 rounded border border-red-400 px-3 text-sm text-red-600 disabled:opacity-50"><XCircle className="inline w-4 mr-1" />Exit position</button>}
          {status?.isRunning ? <button disabled={busy} onClick={() => void action('stop')} className="min-h-11 rounded bg-red-500 px-4 text-sm text-white"><Square className="inline w-4 mr-1" />Stop strategy</button>
            : <button disabled={!canStart} onClick={() => void action('start')} className="min-h-11 rounded bg-emerald-600 px-4 text-sm text-white disabled:opacity-50"><Play className="inline w-4 mr-1" />Start strategy</button>}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className={`${panel} lg:col-span-2`}>
          <h2 className="font-semibold mb-4">Strategy settings</h2>
          <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-semibold">Underlying instrument<select className={`${field} mt-1`} value={config.underlying} onChange={e => update({ underlying: e.target.value as IndexUnderlying })}>
              <option value="NIFTY">NIFTY (NSE)</option><option value="BANKNIFTY">BANKNIFTY (NSE)</option><option value="SENSEX">SENSEX (BSE)</option></select></label>
            <label className="text-xs font-semibold">Order quantity<input className={`${field} mt-1`} type="number" min={lot ?? 1} step={lot ?? 1} value={config.quantity} onChange={e => update({ quantity: Number(e.target.value) })} />
              <span className="block mt-1 font-normal text-slate-500">{lot ? `Resolved lot: ${lot}. Use whole lots.` : 'Contract lot is verified by the backend before entry.'}</span></label>
            <label className="text-xs font-semibold">Retest tolerance (index points)<input className={`${field} mt-1`} type="number" min={0} value={config.retestTolerancePointsByUnderlying[config.underlying]} onChange={e => update({ retestTolerancePointsByUnderlying: { ...config.retestTolerancePointsByUnderlying, [config.underlying]: Number(e.target.value) } })} /></label>
            <div><p className="text-xs font-semibold mb-1">Strike preference</p><div className="grid grid-cols-3 gap-1">{(['ATM', 'ITM', 'OTM'] as const).map(mode => <button type="button" key={mode} aria-pressed={config.strikeMode === mode} onClick={() => update({ strikeMode: mode })} className={`min-h-11 rounded text-sm ${mode === config.strikeMode ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'} disabled:opacity-60`}>{mode}</button>)}</div></div>
            {config.strikeMode !== 'ATM' && <label className="text-xs font-semibold">Strike offset depth<input className={`${field} mt-1`} type="number" min={1} max={100} step={1} value={config.strikeDepth} onChange={e => update({ strikeDepth: Number(e.target.value) })} /></label>}
            <label className="text-xs font-semibold">Minimum option premium<input className={`${field} mt-1`} type="number" min={0} value={config.premiumMin} onChange={e => update({ premiumMin: Number(e.target.value) })} /></label>
            <label className="text-xs font-semibold">Maximum option premium<input className={`${field} mt-1`} type="number" min={0} value={config.premiumMax} onChange={e => update({ premiumMax: Number(e.target.value) })} /></label>
            <label className="flex items-center gap-2 text-sm min-h-11"><input type="checkbox" checked={config.liveTradingConsent} onChange={e => update({ liveTradingConsent: e.target.checked })} />Enable live trading consent</label>
          </fieldset>
          <p className="text-xs text-slate-500 mt-3">Live consent requires separate account execution permission. Stop before editing; open-position settings remain fixed.</p>
          <div className="flex flex-wrap gap-3 items-center mt-3"><button type="button" onClick={save} disabled={locked || !valid || !lotValid || !dirty || saveState === 'Saving settings...'} className="min-h-11 rounded bg-blue-600 text-white px-4 text-sm disabled:opacity-50">Save settings</button><span className="text-xs" role="status">{saveState}</span></div>
          {(!valid || !lotValid) && <p role="alert" className="text-sm text-red-500 mt-2">Enter valid numeric values, premium bounds and whole-lot quantity.</p>}
        </section>
        <section className={panel}><h2 className="font-semibold mb-3">Fixed strategy rules</h2><dl className="text-sm space-y-3">
          {Object.entries({ 'Opening range (IST)': '09:15 - 09:30', 'Setup / execution': 'Closed 5M / closed 1M', 'Confirmed pivot': '2 bars left + 2 right', 'Stop buffer': '2 index points', Target: '2R', 'Daily entry cap': '2 across selected indices', 'New-entry cutoff (IST)': '11:30', 'EOD square-off (IST)': '15:20' }).map(([key, value]) => <div className="flex justify-between gap-3" key={key}><dt className="text-slate-500">{key}</dt><dd className="text-right font-medium">{value}</dd></div>)}</dl>
          <div className="mt-4 border-t pt-3 text-xs text-slate-500">Session VWAP is calculated from selected-index 1M volume. Missing or invalid data blocks entry.</div>
        </section>
      </div>

      <section className={panel}><div className="flex justify-between flex-wrap gap-2 mb-3"><h2 className="font-semibold">Live monitor</h2><span className="text-sm">{status?.dailyEntries ? `${status.dailyEntries.filled} filled + ${status.dailyEntries.reserved} reserved / 2 · ${status.dailyEntries.sessionDate}` : 'Daily entry count unavailable'}</span></div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{checkpoints.map(([label, ready]) => <div key={label} className="rounded border border-slate-200 dark:border-slate-700 p-3 text-xs"><span className={`inline-block w-2 h-2 rounded-full mr-2 ${statusReady && ready ? 'bg-emerald-500' : 'bg-slate-400'}`} />{label}<span className="block mt-1 text-slate-500">{statusReady && ready ? 'Ready' : 'Waiting'}</span></div>)}</div>
        <p className="text-sm mt-3">Setup: {analysis?.state ?? 'Waiting for analysis'} · Data: {liveData?.ready ? 'Ready' : status?.dataReadiness ?? 'Unavailable'}</p>
        <p className="text-xs text-slate-500 mt-1">{analysis?.failedReasons?.join(' · ') || liveData?.errors?.join(' · ') || 'Checkpoints follow backend diagnostics.'}</p>
        <div className="grid gap-3 sm:grid-cols-3 mt-4">{[['Monitored CE option', status?.monitoredPremiums?.ce], ['Monitored PE option', status?.monitoredPremiums?.pe], ['Automatic expiry', status?.selectedExpiry]].map(([label, value]) => <div key={label} className="rounded bg-slate-50 dark:bg-slate-800 p-3"><p className="text-xs text-slate-500">{label}</p><p className="text-sm font-semibold break-all mt-1">{value ?? '--'}</p></div>)}</div>
      </section>

      <section className={panel}><h2 className="font-semibold mb-3">{config.underlying} index chart</h2>
        <div className="flex flex-wrap items-center gap-3 mb-3"><div className="flex rounded bg-slate-100 p-1">{(['1m', '5m'] as const).map(tf => <button key={tf} type="button" onClick={() => setTimeframe(tf)} className={`min-h-11 px-4 rounded text-sm ${timeframe === tf ? 'bg-blue-600 text-white' : 'text-slate-600'}`}>{tf}</button>)}</div>
          <span className="text-xs">Regular candles</span><label className="text-xs">Session date<input aria-label="Chart session date" type="date" className="ml-2 min-h-11 rounded border px-2 text-slate-700" value={date} max={orbDate()} onChange={e => { if (e.target.value) setDate(e.target.value) }} /></label>
          {([['OR / risk levels', showLevels, setShowLevels], ['Session VWAP', showVwap, setShowVwap], ['Setup markers', showMarkers, setShowMarkers]] as const).map(([label, checked, set]) => <label key={label} className="text-xs flex items-center gap-1 min-h-11"><input type="checkbox" checked={checked} onChange={e => set(e.target.checked)} />{label}</label>)}
        </div>
        <IndexOrbChart candles={candles} status={liveData ? status : null} underlying={config.underlying} date={date} timeframe={timeframe} showLevels={showLevels} showVwap={showVwap} showMarkers={showMarkers} />
        <p className="text-xs text-slate-500 mt-2">{historyMessage || 'Backend signal overlays show confirmation time. Signal markers are not broker fills.'} Time axis: candle close (IST). All chart levels are index points. Option premium and P&amp;L are shown below.</p>
      </section>

      <section className={panel}><h2 className="font-semibold mb-3">Position summary</h2>
        <p className="text-sm mb-3">{status?.activeTradePremium ?? 'No held option'} · {status?.positionState ?? 'NONE'}</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">{[['Option entry premium', display(status?.entryPrice)], ['Option last premium', display(status?.currentLtp)], ['Remaining quantity', display(status?.remainingQuantity)], ['Index entry', display(held?.entry)], ['Index SL', display(held?.stop)], ['Index target', display(held?.target)], ['Unrealized option P&L', status?.entryPrice && status?.currentLtp ? display((status.currentLtp - status.entryPrice) * (status.remainingQuantity ?? 0)) : '--']].map(([label, value]) => <div key={label}><p className="text-xs text-slate-500">{label}</p><p className="font-semibold mt-1">{value}</p></div>)}</div>
        {held && <p className="text-xs text-amber-600 mt-3">Index exits are software-managed. Broker-native option protection: {status?.positionState === 'PROTECTED' ? 'verified' : 'not verified'}. Held risk remains active after Stop.</p>}
      </section>
      <section className={panel}><h2 className="font-semibold mb-2">Execution log</h2><div className="max-h-48 overflow-auto rounded bg-slate-950 text-slate-200 p-3 text-xs font-mono whitespace-pre-wrap break-words">{status?.logs?.join('\n') || 'No execution events.'}</div></section>
    </div>
    <MobileStrategyActions isRunning={Boolean(status?.isRunning)} hasPosition={exposure} isExiting={busy || Boolean(status?.exitInProgress)} canStart={canStart} onStart={() => void action('start')} onStop={() => void action('stop')} onExit={() => void action('exit')} />
  </StrategiesLayout>
}
