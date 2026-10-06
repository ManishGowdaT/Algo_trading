import { useEffect, useRef, useState } from 'react'
import {
  Play,
  Square,
  Clock,
  Activity,
  Target
} from 'lucide-react'
import { useAngelConnection } from '../../shared/angel/AngelConnectionProvider'
import { apiGet, apiPost, isApiScopeCurrent } from '../../trading'
import { retainedStopStatus, type StrategyStopStatus } from '../../trading/strategyStopStatus'
import { startResilientPolling } from '../../utils/resilientPolling'
import { usePageTitle } from '../../hooks/usePageTitle'
import MobileStrategyActions from '../../components/Layout/MobileStrategyActions'
import { useAuth } from '../../context/AuthContext'
import { readAccountSetting, writeAccountSetting } from '../../trading/accountSettings'
import { AccountSettingsSaveQueue, canStartStrategy, loadValidatedStrategySettings } from '../../trading/strategySettingsLifecycle'

type Underlying = 'SENSEX' | 'NIFTY' | 'BANKNIFTY'
type Exchange = 'BSE' | 'NFO'

const INDEX_CONFIG: Record<Underlying, { qty: number, step: number, exchange: Exchange }> = {
  SENSEX: { qty: 10, step: 10, exchange: 'BSE' },
  NIFTY: { qty: 75, step: 75, exchange: 'NFO' },
  BANKNIFTY: { qty: 15, step: 15, exchange: 'NFO' },
}

export default function FiveMinBreakoutPage() {
  const { user } = useAuth()
  const { brokerAccountId } = useAngelConnection()
  if (!user || !brokerAccountId) return <FiveMinBreakoutPageInner scope="unavailable" userId="" accountId="" />
  const scope = `${user._id}:${brokerAccountId}`
  return <FiveMinBreakoutPageInner key={scope} scope={scope} userId={user._id} accountId={brokerAccountId} />
}

type StrategyState = 'WAITING' | 'SIGNAL' | 'IN_POSITION' | 'COOLDOWN' | 'EXITED' | 'STOPPED' | 'POSITION_PROTECTED' | 'POSITION_UNPROTECTED' | 'EXIT_PENDING' | 'RECONCILIATION_REQUIRED'
type StrikeMode = 'ATM' | 'ITM' | 'OTM'

function getSavedState<T>(scope: string, key: string, fallback: T): T {
  try {
    const [userId, accountId] = scope.split(':')
    return readAccountSetting(userId, accountId, key, fallback)
  } catch {
    return fallback
  }
}

function FiveMinBreakoutPageInner({ scope, userId, accountId }: { scope: string; userId: string; accountId: string }) {
  usePageTitle('5 Min Breakout')
  const { connectStatus } = useAngelConnection()
  const settingsSaveQueue = useRef(new AccountSettingsSaveQueue(scope))

  const [isRunning, setIsRunning] = useState<boolean>(false)
  const [state, setState] = useState<StrategyState>('STOPPED')
  const [message, setMessage] = useState<string>('')

  const [lookback, setLookback] = useState<4 | 5>(() => getSavedState(scope, 'fmb_lookback', 5))
  const [underlying, setUnderlying] = useState<Underlying>(() => getSavedState(scope, 'fmb_underlying', 'SENSEX'))
  const [exchange, setExchange] = useState<Exchange>(() => getSavedState(scope, 'fmb_exchange', 'BSE'))
  const [quantity, setQuantity] = useState<number>(() => getSavedState(scope, 'fmb_quantity', INDEX_CONFIG.SENSEX.qty))
  const [liveTradingConsent, setLiveTradingConsent] = useState(() => getSavedState(scope, 'fmb_liveTradingConsent', false))

  const [targetPoints, setTargetPoints] = useState<number>(() => getSavedState(scope, 'fmb_targetPoints', 20))
  const [bufferPoints, setBufferPoints] = useState<number>(() => getSavedState(scope, 'fmb_bufferPoints', 2))
  const [maxRangeLimit, setMaxRangeLimit] = useState<number>(() => getSavedState(scope, 'fmb_maxRangeLimit', 30))

  const [premiumMin, setPremiumMin] = useState<number>(() => getSavedState(scope, 'fmb_premiumMin', 300))
  const [premiumMax, setPremiumMax] = useState<number>(() => getSavedState(scope, 'fmb_premiumMax', 400))

  const [strikeMode, setStrikeMode] = useState<StrikeMode>(() => getSavedState(scope, 'fmb_strikeMode', 'ATM'))
  const [strikeDepth, setStrikeDepth] = useState<number>(() => getSavedState(scope, 'fmb_strikeDepth', 1))

  // Live Monitor State from Backend
  const [monitoredPremiums, setMonitoredPremiums] = useState<{ ce: string, pe: string }>({ ce: '---', pe: '---' })
  const [checkpoints, setCheckpoints] = useState([
    { id: 'broker', label: 'Broker Connection', status: 'pending' },
    { id: 'index_ltp', label: 'Index LTP Sync', status: 'pending' },
    { id: 'contracts', label: 'Options Discovery', status: 'pending' },
    { id: 'range', label: '5-Min Range Lock', status: 'pending' },
    { id: 'breakout', label: 'Breakout Vigil', status: 'pending' }
  ])

  const [entryPrice, setEntryPrice] = useState<number | null>(null)
  const [stopLoss, setStopLoss] = useState<number | null>(null)
  const [target, setTarget] = useState<number | null>(null)
  const [currentLtp, setCurrentLtp] = useState<number | null>(null)
  const [activeTradeId, setActiveTradeId] = useState<string | null>(null)
  const [isExiting, setIsExiting] = useState(false)

  const [settingsReady, setSettingsReady] = useState(false)
  useEffect(() => {
    let active = true
    setSettingsReady(false)
    if (!userId || !accountId) { setSettingsReady(true); return () => { active = false } }
    loadValidatedStrategySettings('5minBreakout', () => apiGet<{ data?: { config?: Record<string, unknown> | null } }>('/strategies/settings/5minBreakout'))
      .then((config) => {
        if (!active) return
        setLookback(Number(config.lookback ?? 5) as 4 | 5)
        setUnderlying(config.underlying as Underlying ?? 'SENSEX')
        setExchange(config.exchange as Exchange ?? INDEX_CONFIG.SENSEX.exchange)
        setQuantity(Number(config.quantity ?? INDEX_CONFIG.SENSEX.qty))
        setTargetPoints(Number(config.targetPoints ?? 20)); setBufferPoints(Number(config.bufferPoints ?? 2))
        setMaxRangeLimit(Number(config.maxRangeLimit ?? 30)); setLiveTradingConsent(Boolean(config.liveTradingConsent))
        setStrikeMode(config.strikeMode as StrikeMode ?? 'ATM'); setStrikeDepth(Number(config.strikeDepth ?? 1))
        setPremiumMin(Number(config.premiumMin ?? 300)); setPremiumMax(Number(config.premiumMax ?? 400))
        setSettingsReady(true)
      })
      .catch((error) => { if (active) setMessage(error instanceof Error ? `Could not load saved settings: ${error.message}` : 'Could not load saved settings.') })
    return () => { active = false }
  }, [scope])
  useEffect(() => {
    settingsSaveQueue.current.activate()
    return () => settingsSaveQueue.current.dispose()
  }, [])

  useEffect(() => {
    if (!settingsReady || !userId || !accountId) return
    const config = { lookback, underlying, exchange, quantity, targetPoints, bufferPoints, maxRangeLimit, liveTradingConsent, strikeMode, strikeDepth, premiumMin, premiumMax }
    Object.entries(config).forEach(([key, value]) => writeAccountSetting(userId, accountId, `fmb_${key}`, value))
    const timer = window.setTimeout(() => {
      settingsSaveQueue.current.enqueue(config, (_scope, snapshot) => apiPost('/strategies/settings/5minBreakout', { config: snapshot }), isApiScopeCurrent)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [settingsReady, userId, accountId, lookback, underlying, exchange, quantity, targetPoints, bufferPoints, maxRangeLimit, liveTradingConsent, strikeMode, strikeDepth, premiumMin, premiumMax])

  // Poll Backend Status
  useEffect(() => {
    let active = true

    const fetchStatus = async () => {
      try {
        const res = await apiGet<{
          data: {
            isRunning: boolean
            state: StrategyState
            message: string
            monitoredPremiums: { ce: string, pe: string }
            checkpoints: Array<{ id: string, label: string, status: string }>
            activeTradeId: string | null
            entryPrice: number | null
            currentLtp: number | null
            stopLoss: number | null
            target: number | null
          }
        }>('/strategies/5minBreakout/status')

        if (!active || !res.data) return false

        const d = res.data
        setIsRunning(d.isRunning)
        setState(d.state)
        if (d.message) setMessage(d.message)
        if (d.monitoredPremiums) setMonitoredPremiums(d.monitoredPremiums)
        if (d.checkpoints) setCheckpoints(d.checkpoints)
        setActiveTradeId(d.activeTradeId)
        setEntryPrice(d.entryPrice)
        setCurrentLtp(d.currentLtp)
        setStopLoss(d.stopLoss)
        setTarget(d.target)
        return true
      } catch {
        // Ignore offline errors
        return false
      }
    }

    const stopPolling = startResilientPolling(fetchStatus, { intervalMs: 1500 })
    return () => {
      active = false
      stopPolling()
    }
  }, [])

  const handleUnderlyingChange = (val: Underlying) => {
    setUnderlying(val)
    setExchange(INDEX_CONFIG[val].exchange)
    setQuantity(INDEX_CONFIG[val].qty)
  }

  const startStrategy = async () => {
    if (!canStartStrategy(settingsReady, settingsReady, connectStatus === 'connected') || !userId || !accountId) return
    try {
      setMessage('Starting breakout engine on backend...')
      const payload = {
        underlying,
        exchange,
        quantity,
        lookback,
        targetPoints,
        bufferPoints,
        maxRangeLimit,
        strikeMode,
        strikeDepth,
        premiumMin,
        premiumMax,
        liveTradingConsent
      }
      await apiPost('/strategies/5minBreakout/start', payload)
      setIsRunning(true)
      setState('WAITING')
    } catch (err) {
      console.error('Failed to start strategy:', err)
      setMessage('Failed to launch strategy on backend engine.')
    }
  }

  const stopStrategy = async () => {
    try {
      setMessage('Halting strategy on backend...')
      const stopped = await apiPost<{ data?: StrategyStopStatus }>('/strategies/5minBreakout/stop')
      setIsRunning(false)
      if (retainedStopStatus(stopped.data)) {
        setState(stopped.data!.state as StrategyState)
        setActiveTradeId(stopped.data!.activeTradeId || null)
        setMessage('New entries stopped. Open or unresolved positions remain managed.')
        return
      }
      setState('STOPPED')
      setActiveTradeId(null)
      setEntryPrice(null)
      setCurrentLtp(null)
      setStopLoss(null)
      setTarget(null)
    } catch (err) {
      console.error('Failed to stop strategy:', err)
    }
  }

  const manualExitPosition = async () => {
    if (isExiting) return
    setIsExiting(true)
    setMessage('Manual exit initiated...')
    try {
      await apiPost('/strategies/5minBreakout/exit')
    } catch (err) {
      console.error('Failed to exit position:', err)
    } finally {
      setIsExiting(false)
    }
  }

  return (
    <div className="space-y-4 max-md:space-y-3 select-none">
      {/* Control Panel Header */}
      <div className="bg-white rounded border border-[#E0E3EB] shadow-sm p-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${isRunning ? 'bg-[#089981] animate-pulse' : 'bg-[#787B86]'}`} />
              <h2 className="text-xs font-bold text-[#1E222D] uppercase tracking-wider">5 Min Breakout Scanner</h2>
            </div>
            <p className="text-xs font-medium text-[#787B86]">
              {message || `Scanning for premium range spikes on ${underlying} 5m candles.`}
            </p>
            <div className="flex items-center gap-6 max-md:flex-wrap max-md:gap-3 pt-1">
              <div>
                <p className="text-[10px] font-bold uppercase text-[#787B86]">State</p>
                <p className="text-xs font-bold text-[#1E222D]">{state}</p>
              </div>
              <div className="h-6 w-[1px] bg-[#E0E3EB]" />
              <div>
                <p className="text-[10px] font-bold uppercase text-[#787B86]">Network Status</p>
                <p className={`text-xs font-bold ${connectStatus === 'connected' ? 'text-[#089981]' : 'text-[#F23645]'}`}>
                  {connectStatus.toUpperCase()}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 max-md:hidden">
            {['IN_POSITION', 'POSITION_PROTECTED', 'POSITION_UNPROTECTED', 'EXIT_PENDING', 'RECONCILIATION_REQUIRED'].includes(state) && activeTradeId && (
              <button
                disabled={isExiting}
                onClick={manualExitPosition}
                className="flex items-center gap-1.5 px-4 py-2 bg-[#FF9800] hover:bg-[#e68a00] disabled:opacity-50 text-white text-xs font-semibold rounded shadow-sm transition-colors"
              >
                Exit Position
              </button>
            )}
            {!isRunning ? (
              <button
                onClick={startStrategy}
                disabled={!canStartStrategy(settingsReady, settingsReady, connectStatus === 'connected') || !userId || !accountId}
                className="flex items-center gap-1.5 px-4 py-2 bg-[#089981] hover:bg-[#07806c] disabled:opacity-50 text-white text-xs font-semibold rounded shadow-sm transition-colors"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                Start Strategy
              </button>
            ) : (
              <button
                onClick={stopStrategy}
                className="flex items-center gap-1.5 px-4 py-2 bg-[#F23645] hover:bg-[#d92b39] text-white text-xs font-semibold rounded shadow-sm transition-colors"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                Stop Strategy
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Configuration Area */}
        <div className="lg:col-span-8 space-y-4">
          <div className="bg-white rounded border border-[#E0E3EB] shadow-sm p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#1E222D] mb-4 flex items-center gap-1.5 pb-2 border-b border-[#E0E3EB]">
              <Clock className="w-3.5 h-3.5 text-[#0052FF]" />
              Breakout Parameters
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Underlying Instrument</label>
                  <select
                    value={underlying}
                    onChange={(e) => handleUnderlyingChange(e.target.value as Underlying)}
                    disabled={isRunning}
                    className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF] disabled:opacity-50"
                  >
                    <option value="SENSEX">SENSEX (BSE)</option>
                    <option value="NIFTY">NIFTY (NSE)</option>
                    <option value="BANKNIFTY">BANKNIFTY (NSE)</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Premium Lookback Candles</label>
                  <select
                    value={lookback}
                    onChange={(e) => setLookback(Number(e.target.value) as 4 | 5)}
                    disabled={isRunning}
                    className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF] disabled:opacity-50"
                  >
                    <option value={4}>4 Candles (Fast)</option>
                    <option value={5}>5 Candles (Balanced)</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Order Quantity</label>
                  <input
                    type="number"
                    value={quantity}
                    step={INDEX_CONFIG[underlying].step}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                    disabled={isRunning}
                    className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF] disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="space-y-4">
              <div className="grid grid-cols-3 max-md:grid-cols-1 gap-2">
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block truncate">Target (Pts)</label>
                    <input
                      type="number"
                      value={targetPoints}
                      onChange={(e) => setTargetPoints(parseFloat(e.target.value) || 0)}
                      disabled={isRunning}
                      className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-2.5 py-1.5 text-xs font-semibold text-[#089981] tabular-nums outline-none focus:border-[#089981] disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block truncate">SL Buffer</label>
                    <input
                      type="number"
                      value={bufferPoints}
                      onChange={(e) => setBufferPoints(parseFloat(e.target.value) || 0)}
                      disabled={isRunning}
                      className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-2.5 py-1.5 text-xs font-semibold text-[#F23645] tabular-nums outline-none focus:border-[#F23645] disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block truncate">Max Range</label>
                    <input
                      type="number"
                      value={maxRangeLimit}
                      onChange={(e) => setMaxRangeLimit(parseFloat(e.target.value) || 0)}
                      disabled={isRunning}
                      className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-2.5 py-1.5 text-xs font-semibold text-[#0052FF] tabular-nums outline-none focus:border-[#0052FF] disabled:opacity-50"
                    />
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between p-3 bg-[#F8F9FA] border border-[#E0E3EB] rounded">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-[#F23645]" />
                    <div>
                      <p className="text-xs font-bold text-[#1E222D]">Real Market Execution Consent</p>
                      <p className="text-[10px] text-[#787B86] font-medium">Transmit real orders to broker API</p>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={liveTradingConsent}
                    onChange={(e) => setLiveTradingConsent(e.target.checked)}
                    disabled={isRunning}
                    className="w-4 h-4 text-[#F23645] rounded border-[#E0E3EB]"
                  />
                </div>
              </div>
            </div>

            {/* Position Monitor Panel */}
            {state !== 'STOPPED' && (
              <div className="mt-4 bg-white p-4 rounded border border-[#E0E3EB] shadow-sm">
                <div className="flex items-center justify-between mb-3 border-b border-[#E0E3EB] pb-2">
                  <h3 className="text-xs font-bold uppercase text-[#0052FF]">Breakout Trade Monitor</h3>
                  <span className="text-[10px] font-semibold text-[#089981]">Active Engine Feed</span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <div>
                    <p className="text-[10px] font-bold text-[#787B86] uppercase">LTP</p>
                    <p className="text-sm font-bold text-[#1E222D] tabular-nums mt-0.5">₹{currentLtp?.toFixed(2) || '---'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#787B86] uppercase">Entry Trigger</p>
                    <p className="text-sm font-bold text-[#1E222D] tabular-nums mt-0.5">₹{entryPrice?.toFixed(2) || '---'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#787B86] uppercase">Stop Loss</p>
                    <p className="text-sm font-bold text-[#F23645] tabular-nums mt-0.5">₹{stopLoss?.toFixed(2) || '---'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#787B86] uppercase">Target</p>
                    <p className="text-sm font-bold text-[#089981] tabular-nums mt-0.5">₹{target?.toFixed(2) || '---'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#787B86] uppercase">Unrealized PNL</p>
                    <p className={`text-sm font-bold tabular-nums mt-0.5 ${currentLtp && entryPrice
                      ? currentLtp >= entryPrice ? 'text-[#089981]' : 'text-[#F23645]'
                      : 'text-[#787B86]'
                      }`}>
                      {currentLtp && entryPrice
                        ? `₹${((currentLtp - entryPrice) * quantity).toFixed(2)}`
                        : '---'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Checkpoints & Monitor Side Panel */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-white rounded border border-[#E0E3EB] shadow-sm p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#1E222D] mb-4 flex items-center gap-1.5 pb-2 border-b border-[#E0E3EB]">
              <Target className="w-3.5 h-3.5 text-[#0052FF]" />
              Monitored Premiums &amp; System Health
            </h3>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[#F8F9FA] border border-[#E0E3EB] p-3 rounded">
                  <p className="text-[10px] font-bold text-[#0052FF] uppercase mb-1">CE Premium</p>
                  <p className="text-xs font-bold text-[#1E222D]">{monitoredPremiums.ce}</p>
                </div>
                <div className="bg-[#F8F9FA] border border-[#E0E3EB] p-3 rounded">
                  <p className="text-[10px] font-bold text-[#F23645] uppercase mb-1">PE Premium</p>
                  <p className="text-xs font-bold text-[#1E222D]">{monitoredPremiums.pe}</p>
                </div>
              </div>

              <p className="text-[10px] font-bold text-[#787B86] uppercase pt-2">Breakout Checkpoints</p>
              <div className="space-y-1.5">
                {checkpoints.map(cp => (
                  <div key={cp.id} className="flex items-center gap-2 bg-[#F8F9FA] border border-[#E0E3EB] px-3 py-1.5 rounded">
                    <div className={`w-2 h-2 rounded-full ${cp.status === 'success'
                      ? 'bg-[#089981]'
                      : cp.status === 'error'
                        ? 'bg-[#F23645]'
                        : 'bg-[#787B86]'
                      }`} />
                    <span className="text-[10px] font-semibold text-[#434651] uppercase truncate">{cp.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <MobileStrategyActions
        isRunning={isRunning}
        hasPosition={['IN_POSITION', 'POSITION_PROTECTED', 'POSITION_UNPROTECTED', 'EXIT_PENDING', 'RECONCILIATION_REQUIRED'].includes(state) && Boolean(activeTradeId)}
        isExiting={isExiting}
        canStart={canStartStrategy(settingsReady, settingsReady, connectStatus === 'connected') && Boolean(userId && accountId)}
        onStart={() => void startStrategy()}
        onStop={() => void stopStrategy()}
        onExit={() => void manualExitPosition()}
      />
    </div>
  )
}
