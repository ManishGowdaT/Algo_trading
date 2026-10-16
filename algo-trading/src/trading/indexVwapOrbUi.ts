export type IndexUnderlying = 'NIFTY' | 'BANKNIFTY' | 'SENSEX'
export type IndexOrbConfig = {
  underlying: IndexUnderlying; quantity: number; strikeMode: 'ATM' | 'ITM' | 'OTM'; strikeDepth: number
  premiumMin: number; premiumMax: number; retestTolerancePointsByUnderlying: Record<IndexUnderlying, number>
  liveTradingConsent: boolean
}
export type OrbCandle = { time: number; open: number; high: number; low: number; close: number; volume?: number }
type Pivot = { formedAt: number; confirmedAt: number; price: number }
export type OrbCandidate = { underlying?: IndexUnderlying; setupId?: string; direction?: string; entryPrice?: number; stopLoss?: number; takeProfit?: number
  breakoutClosedAt?: number; retestClosedAt?: number; signalClosedAt?: number; pivot?: Pivot }
export type OrbAnalysis = OrbCandidate & { underlying?: IndexUnderlying; state?: string; isEntry?: boolean; failedReasons?: string[]
  diagnostics?: { sessionDate?: string; asOf?: number; orHigh?: number; orLow?: number; vwap?: number; vwapSource?: string
    vwapSeries?: { time: number; value: number | null }[]; latestCandidate?: OrbCandidate | null
    setup?: { breakout?: { closeTime: number }; retest?: { closeTime: number }; pivot?: Pivot } | null } }
export type OrbStatus = {
  isRunning: boolean; state: string; message?: string; brokerReady?: boolean; dataReadiness?: string; positionState?: string
  activeTradeId?: string | null; activeTradePremium?: string | null; entryPrice?: number | null; currentLtp?: number | null
  remainingQuantity?: number; pendingEntryQuantity?: number; exitInProgress?: boolean; exitTriggered?: boolean
  selectedExpiry?: string; monitoredPremiums?: { ce: string; pe: string }; logs?: string[]
  ceContract?: { lot_size?: number; lotSize?: number; lotsize?: number; underlying?: string }
  peContract?: { lot_size?: number; lotSize?: number; lotsize?: number; underlying?: string }
  referenceRisk?: { underlying: IndexUnderlying; entry: number; stop: number; target: number; signalClosedAt: number } | null
  analysis?: OrbAnalysis | null
  underlyingData?: { date: string; ready?: boolean; fresh?: boolean; complete?: boolean; errors?: string[]; candles1m: OrbCandle[]; candles5m: OrbCandle[] } | null
  dailyEntries?: { sessionDate: string; filled: number; reserved: number; limit: number; blocked: boolean } | null
}
export const orbDefaults: IndexOrbConfig = { underlying: 'NIFTY', quantity: 1, strikeMode: 'ATM', strikeDepth: 1,
  premiumMin: 0, premiumMax: 1000000, retestTolerancePointsByUnderlying: { NIFTY: 10, BANKNIFTY: 20, SENSEX: 30 }, liveTradingConsent: false }
export function validOrbConfig(value: unknown): value is IndexOrbConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const c = value as IndexOrbConfig
  const allowed = Object.keys(orbDefaults)
  if (Object.keys(c).some(k => !allowed.includes(k)) || !['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(c.underlying)) return false
  if (!Number.isSafeInteger(c.quantity) || c.quantity < 1 || c.quantity > 1000000 || !['ATM', 'ITM', 'OTM'].includes(c.strikeMode)) return false
  if (!Number.isSafeInteger(c.strikeDepth) || c.strikeDepth < 1 || c.strikeDepth > 100 || typeof c.liveTradingConsent !== 'boolean') return false
  if (![c.premiumMin, c.premiumMax].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000000) || c.premiumMin > c.premiumMax) return false
  const map = c.retestTolerancePointsByUnderlying
  return Boolean(map && !Array.isArray(map) && Object.keys(map).length === 3 && ['NIFTY', 'BANKNIFTY', 'SENSEX'].every(k =>
    Object.hasOwn(map, k) && typeof map[k as IndexUnderlying] === 'number' && Number.isFinite(map[k as IndexUnderlying]) && map[k as IndexUnderlying] >= 0 && map[k as IndexUnderlying] <= 1000000))
}
export function normalizeOrbSettings(value: Record<string, unknown>): IndexOrbConfig {
  if (Object.hasOwn(value, 'retestTolerancePointsByUnderlying') && (!value.retestTolerancePointsByUnderlying
    || typeof value.retestTolerancePointsByUnderlying !== 'object' || Array.isArray(value.retestTolerancePointsByUnderlying))) throw new Error('Saved tolerance settings are invalid.')
  const config = { ...orbDefaults, ...value, retestTolerancePointsByUnderlying: {
    ...orbDefaults.retestTolerancePointsByUnderlying, ...(value.retestTolerancePointsByUnderlying as object ?? {}),
  } }
  if (!validOrbConfig(config)) throw new Error('Saved strategy settings are invalid.')
  return config
}
export function hasOrbExposure(status: OrbStatus | null): boolean {
  return Boolean(status?.activeTradeId || status?.pendingEntryQuantity || status?.dailyEntries?.blocked
    || ['POSITION_PROTECTED', 'POSITION_UNPROTECTED', 'IN_POSITION', 'EXIT_PENDING', 'RECONCILIATION_REQUIRED'].includes(status?.state ?? ''))
}
export function orbDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
export function lotFor(status: OrbStatus | null, underlying: IndexUnderlying): number | null {
  const contract = status?.ceContract
  if (contract?.underlying !== underlying) return null
  const lot = contract.lot_size ?? contract.lotSize ?? contract.lotsize
  return typeof lot === 'number' && Number.isSafeInteger(lot) && lot > 0 ? lot : null
}
export type OrbOverlay = { from: number; to: number; price: number; title: string; color: string }
export type OrbMarker = { time: number; text: string; color: string; position: 'aboveBar' | 'belowBar'; shape: 'circle' | 'arrowUp' }
// Presentation only: every trading level/decision comes from backend diagnostics.
export function orbOverlays(status: OrbStatus | null, underlying: IndexUnderlying, date: string, candles: OrbCandle[], duration = 60) {
  const analysis = status?.analysis?.underlying === underlying && status.analysis.diagnostics?.sessionDate === date ? status.analysis : null
  const d = analysis?.diagnostics
  const open = Date.parse(`${date}T09:15:00+05:30`) / 1000
  const end = (candles.at(-1)?.time ?? open) + duration
  const lines: OrbOverlay[] = []
  for (const [price, title, color] of [[d?.orHigh, 'OR High', '#1559cf'], [d?.orLow, 'OR Low', '#1559cf']] as const) {
    if (typeof price === 'number' && Number.isFinite(price) && end >= open + 900) lines.push({ from: open + 900, to: end, price, title, color })
  }
  const held = status?.referenceRisk?.underlying === underlying && orbDate(new Date(status.referenceRisk.signalClosedAt)) === date ? status.referenceRisk : null
  const candidate = d?.latestCandidate
  const entryTime = held?.signalClosedAt ?? candidate?.signalClosedAt
  if (entryTime) for (const [price, title, color] of [[held?.entry ?? candidate?.entryPrice, 'Index entry', '#334155'],
    [held?.stop ?? candidate?.stopLoss, 'Index SL', '#ef4444'], [held?.target ?? candidate?.takeProfit, 'Index target (2R)', '#089981']] as const) {
    if (typeof price === 'number' && Number.isFinite(price)) lines.push({ from: entryTime / 1000, to: end, price,
      title: held ? title : `Signal ${title.toLowerCase()} (not a fill)`, color })
  }
  const markers: OrbMarker[] = []
  const add = (ms: number | undefined, text: string, color: string) => {
    if (ms && candles.length && ms / 1000 <= end) markers.push({ time: ms / 1000, text, color, position: 'aboveBar', shape: 'circle' })
  }
  add(d?.setup?.breakout?.closeTime ?? candidate?.breakoutClosedAt, '5M breakout confirmed', '#1559cf')
  add(d?.setup?.retest?.closeTime ?? candidate?.retestClosedAt, '5M retest held', '#089981')
  const pivot = d?.setup?.pivot ?? candidate?.pivot
  add(pivot?.formedAt, 'Pivot formed (confirmed later)', '#7c3aed')
  add(pivot?.confirmedAt, 'Pivot confirmed 2+2', '#7c3aed')
  add(candidate?.signalClosedAt, 'Entry signal (not an order fill)', '#089981')
  return { lines, markers, vwap: d?.vwapSeries?.filter((v): v is { time: number; value: number } => typeof v.value === 'number' && Number.isFinite(v.value)) ?? [],
    open, rangeEnd: open + 900, cutoff: open + 8100 }
}
