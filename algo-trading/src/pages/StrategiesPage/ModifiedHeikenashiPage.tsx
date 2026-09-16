import { useEffect, useState } from 'react'
import {
    Activity,
    ShieldAlert,
    Target,
    ChevronRight,
    Play,
    Square,
    XCircle
} from 'lucide-react'
import { useAngelConnection } from '../../shared/angel/AngelConnectionProvider'
import { apiGet, apiPost } from '../../trading'
import { usePageTitle } from '../../hooks/usePageTitle'

type Underlying = 'SENSEX' | 'NIFTY' | 'BANKNIFTY' | 'CRUDEOILM'
type Exchange = 'BFO' | 'NFO' | 'MCX'

const INDEX_CONFIG: Record<Underlying, { qty: number, step: number, exchange: Exchange }> = {
    SENSEX: { qty: 20, step: 20, exchange: 'BFO' },
    NIFTY: { qty: 65, step: 65, exchange: 'NFO' },
    BANKNIFTY: { qty: 30, step: 30, exchange: 'NFO' },
    CRUDEOILM: { qty: 1, step: 1, exchange: 'MCX' },
}

type StrategyState = 'WAITING' | 'SCANNING' | 'IN_POSITION' | 'COOLDOWN' | 'STOPPED'
type Trend = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
type StrikeMode = 'ATM' | 'ITM' | 'OTM'
type ExitStrategy = 'CANDLES' | 'TARGET' | 'TRAILING_SL'

const TIMEFRAME_OPTIONS = [
    { label: '1m', value: 'ONE_MINUTE' },
    { label: '3m', value: 'THREE_MINUTE' },
    { label: '5m', value: 'FIVE_MINUTE' },
    { label: '15m', value: 'FIFTEEN_MINUTE' },
    { label: '30m', value: 'THIRTY_MINUTE' },
]

function getSavedState<T>(key: string, fallback: T): T {
    try {
        const item = localStorage.getItem(key)
        if (item === null) return fallback
        try {
            return JSON.parse(item) as T
        } catch {
            return item as unknown as T
        }
    } catch {
        return fallback
    }
}

export default function ModifiedHeikenashiPage() {
    usePageTitle('Modified Heikenashi')
    const { connectStatus } = useAngelConnection()

    const [isRunning, setIsRunning] = useState<boolean>(() => getSavedState('mha_isRunning', false))
    const [state, setState] = useState<StrategyState>(() => getSavedState('mha_state', 'STOPPED'))
    const [message, setMessage] = useState<string>('')
    const [trend, setTrend] = useState<Trend>('NEUTRAL')

    // Core Configuration
    const [underlying, setUnderlying] = useState<Underlying>(() => getSavedState('mha_underlying', 'SENSEX'))
    const [quantity, setQuantity] = useState<number>(() => getSavedState('mha_quantity', INDEX_CONFIG.SENSEX.qty))
    const [baseTimeframe, setBaseTimeframe] = useState<string>(() => getSavedState('mha_baseTimeframe', 'FIVE_MINUTE'))
    const [needConfirmation, setNeedConfirmation] = useState<boolean>(() => getSavedState('mha_needConfirmation', false))
    const [confirmationTimeframe, setConfirmationTimeframe] = useState<string>(() => getSavedState('mha_confirmationTimeframe', 'FIFTEEN_MINUTE'))

    // Strike Selection
    const [strikeMode, setStrikeMode] = useState<StrikeMode>(() => getSavedState('mha_strikeMode', 'ATM'))
    const [strikeDepth, setStrikeDepth] = useState<number>(() => getSavedState('mha_strikeDepth', 1))
    const [premiumMin, setPremiumMin] = useState<number>(() => getSavedState('mha_premiumMin', 300))
    const [premiumMax, setPremiumMax] = useState<number>(() => getSavedState('mha_premiumMax', 400))

    // Exit Strategy Configuration
    const [exitStrategy, setExitStrategy] = useState<ExitStrategy>(() => getSavedState('mha_exitStrategy', 'CANDLES'))
    const [targetPoints, setTargetPoints] = useState<number>(() => getSavedState('mha_targetPoints', 20))
    const [slPoints, setSlPoints] = useState<number>(() => getSavedState('mha_slPoints', 30))
    const [trailingStopPoints, setTrailingStopPoints] = useState<number>(() => getSavedState('mha_trailingStopPoints', 20))
    const [initialSlPoints, setInitialSlPoints] = useState<number>(() => getSavedState('mha_initialSlPoints', 30))
    const [finalTargetPoints, setFinalTargetPoints] = useState<number>(() => getSavedState('mha_finalTargetPoints', 100))

    const [liveTradingConsent, setLiveTradingConsent] = useState<boolean>(() => getSavedState('mha_liveTradingConsent', false))

    // Dynamic Live Monitor States from Backend Status
    const [monitoredPremiums, setMonitoredPremiums] = useState<{ ce: string, pe: string }>({ ce: '---', pe: '---' })
    const [checkpoints, setCheckpoints] = useState([
        { id: 'broker', label: 'Broker Connection', status: 'pending' },
        { id: 'expiry', label: 'Next Expiry Locked', status: 'pending' },
        { id: 'mha_trend', label: 'HA Trend Stability', status: 'pending' },
        { id: 'confirmation', label: 'ATM Strike Sync', status: 'pending' },
        { id: 'indicators', label: 'Premium Discovery', status: 'pending' }
    ])

    const [activeTradeId, setActiveTradeId] = useState<string | null>(null)
    const [activeTradePremium, setActiveTradePremium] = useState<string | null>(null)
    const [entryPrice, setEntryPrice] = useState<number | null>(null)
    const [currentLtp, setCurrentLtp] = useState<number | null>(null)
    const [activeTrailingSl, setActiveTrailingSl] = useState<number | null>(null)
    const [isExiting, setIsExiting] = useState<boolean>(false)

    // Local Storage Sync
    useEffect(() => {
        localStorage.setItem('mha_isRunning', JSON.stringify(isRunning))
        localStorage.setItem('mha_state', JSON.stringify(state))
        localStorage.setItem('mha_underlying', JSON.stringify(underlying))
        localStorage.setItem('mha_quantity', JSON.stringify(quantity))
        localStorage.setItem('mha_baseTimeframe', JSON.stringify(baseTimeframe))
        localStorage.setItem('mha_needConfirmation', JSON.stringify(needConfirmation))
        localStorage.setItem('mha_confirmationTimeframe', JSON.stringify(confirmationTimeframe))
        localStorage.setItem('mha_strikeMode', JSON.stringify(strikeMode))
        localStorage.setItem('mha_strikeDepth', JSON.stringify(strikeDepth))
        localStorage.setItem('mha_premiumMin', JSON.stringify(premiumMin))
        localStorage.setItem('mha_premiumMax', JSON.stringify(premiumMax))
        localStorage.setItem('mha_exitStrategy', JSON.stringify(exitStrategy))
        localStorage.setItem('mha_targetPoints', JSON.stringify(targetPoints))
        localStorage.setItem('mha_slPoints', JSON.stringify(slPoints))
        localStorage.setItem('mha_trailingStopPoints', JSON.stringify(trailingStopPoints))
        localStorage.setItem('mha_initialSlPoints', JSON.stringify(initialSlPoints))
        localStorage.setItem('mha_finalTargetPoints', JSON.stringify(finalTargetPoints))
        localStorage.setItem('mha_liveTradingConsent', JSON.stringify(liveTradingConsent))
    }, [isRunning, state, underlying, quantity, baseTimeframe, needConfirmation, confirmationTimeframe, strikeMode, strikeDepth, premiumMin, premiumMax, exitStrategy, targetPoints, slPoints, trailingStopPoints, initialSlPoints, finalTargetPoints, liveTradingConsent])

    // Poll Strategy Status from Backend Engine
    useEffect(() => {
        let active = true

        const fetchStatus = async () => {
            try {
                const res = await apiGet<{
                    data: {
                        isRunning: boolean
                        state: StrategyState
                        message: string
                        trend: Trend
                        monitoredPremiums: { ce: string, pe: string }
                        checkpoints: Array<{ id: string, label: string, status: string }>
                        activeTradeId: string | null
                        activeTradePremium: string | null
                        entryPrice: number | null
                        currentLtp: number | null
                        activeTrailingSl: number | null
                    }
                }>('/strategies/ModifiedHeikenAshi/status')

                if (!active || !res.data) return

                const d = res.data
                setIsRunning(d.isRunning)
                setState(d.state)
                if (d.message) setMessage(d.message)
                setTrend(d.trend)
                if (d.monitoredPremiums) setMonitoredPremiums(d.monitoredPremiums)
                if (d.checkpoints) setCheckpoints(d.checkpoints)
                setActiveTradeId(d.activeTradeId)
                setActiveTradePremium(d.activeTradePremium)
                setEntryPrice(d.entryPrice)
                setCurrentLtp(d.currentLtp)
                setActiveTrailingSl(d.activeTrailingSl)
            } catch (err) {
                // Ignore status errors when backend offline
            }
        }

        fetchStatus()
        const interval = setInterval(fetchStatus, 1500)
        return () => {
            active = false
            clearInterval(interval)
        }
    }, [])

    const handleUnderlyingChange = (val: Underlying) => {
        setUnderlying(val)
        setQuantity(INDEX_CONFIG[val].qty)
    }

    const startStrategy = async () => {
        try {
            setMessage('Launching algorithm on backend engine...')
            const payload = {
                underlying,
                quantity,
                baseTimeframe,
                needConfirmation,
                confirmationTimeframe,
                strikeMode,
                strikeDepth,
                premiumMin,
                premiumMax,
                exitStrategy,
                targetPoints,
                slPoints,
                trailingStopPoints,
                initialSlPoints,
                finalTargetPoints,
                liveTradingConsent
            }
            await apiPost('/strategies/ModifiedHeikenAshi/start', payload)
            setIsRunning(true)
            setState('SCANNING')
        } catch (err) {
            console.error('Failed to start strategy:', err)
            setMessage('Failed to launch strategy on backend engine.')
        }
    }

    const stopStrategy = async () => {
        try {
            setMessage('Halting algorithm on backend engine...')
            await apiPost('/strategies/ModifiedHeikenAshi/stop')
            setIsRunning(false)
            setState('STOPPED')
            setTrend('NEUTRAL')
            setActiveTradeId(null)
            setActiveTradePremium(null)
            setEntryPrice(null)
            setCurrentLtp(null)
            setActiveTrailingSl(null)
        } catch (err) {
            console.error('Failed to stop strategy:', err)
        }
    }

    const manualExitPosition = async () => {
        if (isExiting) return
        setIsExiting(true)
        setMessage('Manual exit initiated...')
        try {
            await apiPost('/strategies/ModifiedHeikenAshi/exit')
        } catch (err) {
            console.error('Failed to exit position:', err)
        } finally {
            setIsExiting(false)
        }
    }

    return (
        <div className="space-y-4 select-none">
            {/* Status Panel Header */}
            <div className="bg-white rounded border border-[#E0E3EB] shadow-sm p-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <span className={`w-2.5 h-2.5 rounded-full ${isRunning ? 'bg-[#089981] animate-pulse' : 'bg-[#787B86]'}`} />
                            <h2 className="text-xs font-bold text-[#1E222D] uppercase tracking-wider">Modified Heiken Ashi Controller</h2>
                        </div>
                        <p className="text-xs font-medium text-[#787B86]">
                            {message || 'Ready to monitor market volatility and execution signals.'}
                        </p>
                        <div className="flex items-center gap-6 pt-1">
                            <div>
                                <p className="text-[10px] font-bold uppercase text-[#787B86]">State</p>
                                <p className="text-xs font-bold text-[#1E222D]">{state}</p>
                            </div>
                            <div className="h-6 w-[1px] bg-[#E0E3EB]" />
                            <div>
                                <p className="text-[10px] font-bold uppercase text-[#787B86]">HA Trend</p>
                                <p className={`text-xs font-bold ${trend === 'BULLISH' ? 'text-[#089981]' : trend === 'BEARISH' ? 'text-[#F23645]' : 'text-[#787B86]'}`}>
                                    {trend}
                                </p>
                            </div>
                            {activeTradePremium && (
                                <>
                                    <div className="h-6 w-[1px] bg-[#E0E3EB]" />
                                    <div>
                                        <p className="text-[10px] font-bold uppercase text-[#787B86]">Active Contract</p>
                                        <p className="text-xs font-bold text-[#0052FF]">{activeTradePremium}</p>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        {!isRunning ? (
                            <button
                                onClick={startStrategy}
                                disabled={connectStatus !== 'connected'}
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
                            <Activity className="w-3.5 h-3.5 text-[#0052FF]" />
                            Execution Parameters
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
                                        <option value="CRUDEOILM">CRUDEOILM (MCX)</option>
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
                                <div>
                                    <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Primary Timeframe</label>
                                    <select
                                        value={baseTimeframe}
                                        onChange={(e) => setBaseTimeframe(e.target.value)}
                                        disabled={isRunning}
                                        className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF] disabled:opacity-50"
                                    >
                                        {TIMEFRAME_OPTIONS.map(opt => (
                                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="pt-1">
                                    <div className="flex items-center justify-between p-2.5 bg-[#F8F9FA] rounded border border-[#E0E3EB]">
                                        <div className="flex items-center gap-2">
                                            <ShieldAlert className="w-4 h-4 text-[#0052FF]" />
                                            <div>
                                                <p className="text-xs font-bold text-[#1E222D]">Higher Timeframe Sync</p>
                                                <p className="text-[10px] text-[#787B86] font-medium">Dual Candle Validation</p>
                                            </div>
                                        </div>
                                        <input
                                            type="checkbox"
                                            checked={needConfirmation}
                                            onChange={(e) => setNeedConfirmation(e.target.checked)}
                                            disabled={isRunning}
                                            className="w-4 h-4 text-[#0052FF] rounded border-[#E0E3EB]"
                                        />
                                    </div>

                                    {needConfirmation && (
                                        <div className="mt-3">
                                            <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Confirmation Timeframe</label>
                                            <select
                                                value={confirmationTimeframe}
                                                onChange={(e) => setConfirmationTimeframe(e.target.value)}
                                                disabled={isRunning}
                                                className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF] disabled:opacity-50"
                                            >
                                                {TIMEFRAME_OPTIONS.map(opt => (
                                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                    )}
                                </div>
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

                        {state !== 'STOPPED' && (
                            <div className="mt-4 bg-white p-4 rounded border border-[#E0E3EB] shadow-sm">
                                <div className="flex items-center justify-between mb-3 border-b border-[#E0E3EB] pb-2">
                                    <h3 className="text-xs font-bold uppercase text-[#0052FF]">Position Monitor</h3>
                                    <span className="text-[10px] font-semibold text-[#089981]">Active Engine Feed</span>
                                </div>

                                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                                    <div>
                                        <p className="text-[10px] font-bold text-[#787B86] uppercase">LTP</p>
                                        <p className="text-sm font-bold text-[#1E222D] tabular-nums mt-0.5">
                                            ₹{currentLtp?.toFixed(2) || '---'}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-bold text-[#787B86] uppercase">Entry</p>
                                        <p className="text-sm font-bold text-[#1E222D] tabular-nums mt-0.5">
                                            ₹{entryPrice?.toFixed(2) || '---'}
                                        </p>
                                    </div>
                                    {exitStrategy === 'TRAILING_SL' && (
                                        <div>
                                            <p className="text-[10px] font-bold text-[#787B86] uppercase">Trailing SL</p>
                                            <p className="text-sm font-bold text-[#F23645] tabular-nums mt-0.5">
                                                ₹{activeTrailingSl?.toFixed(2) || '---'}
                                            </p>
                                        </div>
                                    )}
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
                                    <div>
                                        <p className="text-[10px] font-bold text-[#787B86] uppercase">Signal Trend</p>
                                        <p className={`text-sm font-bold mt-0.5 ${trend === 'BULLISH' ? 'text-[#089981]' : trend === 'BEARISH' ? 'text-[#F23645]' : 'text-[#787B86]'}`}>
                                            {trend}
                                        </p>
                                    </div>
                                </div>

                                {['IN_POSITION', 'POSITION_PROTECTED', 'POSITION_UNPROTECTED'].includes(state) && activeTradeId && (
                                    <div className="mt-4 pt-3 border-t border-[#E0E3EB] flex justify-end">
                                        <button
                                            onClick={manualExitPosition}
                                            disabled={isExiting}
                                            className="flex items-center gap-1.5 px-4 py-1.5 bg-[#FF9800] hover:bg-[#e68a00] disabled:opacity-50 text-white text-xs font-semibold rounded shadow-sm transition-colors"
                                        >
                                            <XCircle className="w-3.5 h-3.5" />
                                            {isExiting ? 'Exiting...' : 'Exit Position'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Side Controls */}
                <div className="lg:col-span-4 space-y-4">
                    <div className="bg-white rounded border border-[#E0E3EB] shadow-sm p-4">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-[#1E222D] mb-4 flex items-center gap-1.5 pb-2 border-b border-[#E0E3EB]">
                            <Target className="w-3.5 h-3.5 text-[#0052FF]" />
                            Risk &amp; Strike Parameters
                        </h3>

                        <div className="space-y-4">
                            <div>
                                <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1.5 block">Strike Preference</label>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {(['ITM', 'ATM', 'OTM'] as StrikeMode[]).map((mode) => (
                                        <button
                                            key={mode}
                                            onClick={() => setStrikeMode(mode)}
                                            disabled={isRunning}
                                            className={`py-1.5 rounded text-xs font-bold uppercase transition-colors ${strikeMode === mode
                                                ? 'bg-[#0052FF] text-white shadow-sm'
                                                : 'bg-[#F0F3FA] text-[#434651] hover:bg-[#E0E3EB]'
                                                }`}
                                        >
                                            {mode}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {strikeMode !== 'ATM' && (
                                <div>
                                    <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Strike Offset Depth</label>
                                    <div className="flex items-center justify-between p-1 bg-[#F0F3FA] border border-[#E0E3EB] rounded">
                                        <button
                                            onClick={() => setStrikeDepth(Math.max(1, strikeDepth - 1))}
                                            disabled={isRunning}
                                            className="w-7 h-7 flex items-center justify-center text-[#434651] font-bold text-base disabled:opacity-50"
                                        >-</button>
                                        <span className="text-xs font-bold text-[#1E222D]">{strikeDepth}</span>
                                        <button
                                            onClick={() => setStrikeDepth(strikeDepth + 1)}
                                            disabled={isRunning}
                                            className="w-7 h-7 flex items-center justify-center text-[#434651] font-bold text-base disabled:opacity-50"
                                        >+</button>
                                    </div>
                                </div>
                            )}

                            <div>
                                <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Option Premium Filter</label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="number"
                                        value={premiumMin}
                                        onChange={(e) => setPremiumMin(Number(e.target.value))}
                                        disabled={isRunning}
                                        placeholder="Min"
                                        className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF] disabled:opacity-50"
                                    />
                                    <ChevronRight className="w-3.5 h-3.5 text-[#787B86]" />
                                    <input
                                        type="number"
                                        value={premiumMax}
                                        onChange={(e) => setPremiumMax(Number(e.target.value))}
                                        disabled={isRunning}
                                        placeholder="Max"
                                        className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF] disabled:opacity-50"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1.5 block">Exit Condition Logic</label>
                                <div className="space-y-2">
                                    <label className="flex items-center gap-2 cursor-pointer" onClick={() => !isRunning && setExitStrategy('CANDLES')}>
                                        <input
                                            type="radio"
                                            name="exitStrategy"
                                            checked={exitStrategy === 'CANDLES'}
                                            onChange={() => setExitStrategy('CANDLES')}
                                            disabled={isRunning}
                                            className="w-3.5 h-3.5 text-[#0052FF]"
                                        />
                                        <span className="text-xs font-semibold text-[#1E222D]">2 Reversal HA Red Candles</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer" onClick={() => !isRunning && setExitStrategy('TARGET')}>
                                        <input
                                            type="radio"
                                            name="exitStrategy"
                                            checked={exitStrategy === 'TARGET'}
                                            onChange={() => setExitStrategy('TARGET')}
                                            disabled={isRunning}
                                            className="w-3.5 h-3.5 text-[#0052FF]"
                                        />
                                        <span className="text-xs font-semibold text-[#1E222D]">Fixed Target &amp; SL Points</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer" onClick={() => !isRunning && setExitStrategy('TRAILING_SL')}>
                                        <input
                                            type="radio"
                                            name="exitStrategy"
                                            checked={exitStrategy === 'TRAILING_SL'}
                                            onChange={() => setExitStrategy('TRAILING_SL')}
                                            disabled={isRunning}
                                            className="w-3.5 h-3.5 text-[#0052FF]"
                                        />
                                        <span className="text-xs font-semibold text-[#1E222D]">Dynamic Trailing SL Logic</span>
                                    </label>
                                </div>
                            </div>

                            {exitStrategy === 'TARGET' && (
                                <div className="space-y-3 pt-2 border-t border-[#E0E3EB]">
                                    <div>
                                        <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Target Points</label>
                                        <input
                                            type="number"
                                            value={targetPoints}
                                            onChange={(e) => setTargetPoints(parseFloat(e.target.value) || 0)}
                                            disabled={isRunning}
                                            className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#089981] disabled:opacity-50"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Stop Loss Points</label>
                                        <input
                                            type="number"
                                            value={slPoints}
                                            onChange={(e) => setSlPoints(parseFloat(e.target.value) || 0)}
                                            disabled={isRunning}
                                            className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#F23645] disabled:opacity-50"
                                        />
                                    </div>
                                </div>
                            )}

                            {exitStrategy === 'TRAILING_SL' && (
                                <div className="space-y-3 pt-2 border-t border-[#E0E3EB]">
                                    <div>
                                        <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Initial SL Points</label>
                                        <input
                                            type="number"
                                            value={initialSlPoints}
                                            onChange={(e) => setInitialSlPoints(parseFloat(e.target.value) || 0)}
                                            disabled={isRunning}
                                            className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#F23645] disabled:opacity-50"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Trail Step Points</label>
                                        <input
                                            type="number"
                                            value={trailingStopPoints}
                                            onChange={(e) => setTrailingStopPoints(parseFloat(e.target.value) || 0)}
                                            disabled={isRunning}
                                            className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF] disabled:opacity-50"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold uppercase text-[#787B86] mb-1 block">Final Target Points</label>
                                        <input
                                            type="number"
                                            value={finalTargetPoints}
                                            onChange={(e) => setFinalTargetPoints(parseFloat(e.target.value) || 0)}
                                            disabled={isRunning}
                                            className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 text-xs font-semibold text-[#1E222D] outline-none focus:border-[#089981] disabled:opacity-50"
                                        />
                                    </div>
                                </div>
                            )}

                        </div>
                    </div>
                </div>
            </div>

            {/* Live Monitor Panel */}
            <div className="bg-white rounded border border-[#E0E3EB] shadow-sm p-4">
                <h3 className="text-xs font-bold uppercase text-[#1E222D] mb-3 flex items-center gap-2 border-b border-[#E0E3EB] pb-2">
                    <span className="w-2 h-2 rounded-full bg-[#0052FF] animate-pulse" />
                    Engine Health Checkpoints &amp; Monitored Options
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                    <div className={`border rounded p-3 ${activeTradePremium === monitoredPremiums.ce && monitoredPremiums.ce !== '---'
                        ? 'bg-[#0052FF]/10 border-[#0052FF]'
                        : 'bg-[#F8F9FA] border-[#E0E3EB]'
                        }`}>
                        <p className="text-[10px] font-bold text-[#0052FF] uppercase mb-1">Monitored CE Option</p>
                        <p className="text-sm font-bold text-[#1E222D]">{monitoredPremiums.ce}</p>
                    </div>
                    <div className={`border rounded p-3 ${activeTradePremium === monitoredPremiums.pe && monitoredPremiums.pe !== '---'
                        ? 'bg-[#F23645]/10 border-[#F23645]'
                        : 'bg-[#F8F9FA] border-[#E0E3EB]'
                        }`}>
                        <p className="text-[10px] font-bold text-[#F23645] uppercase mb-1">Monitored PE Option</p>
                        <p className="text-sm font-bold text-[#1E222D]">{monitoredPremiums.pe}</p>
                    </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                    {checkpoints.map(cp => (
                        <div key={cp.id} className="flex items-center gap-2 bg-[#F8F9FA] border border-[#E0E3EB] px-3 py-2 rounded">
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
    )
}
