import { describe, expect, it } from 'vitest'
import { hasOrbExposure, lotFor, normalizeOrbSettings, orbDefaults, orbOverlays, validOrbConfig, type OrbStatus } from './indexVwapOrbUi'
import { isValidStrategySettings } from './strategySettingsLifecycle'

describe('Index VWAP ORB configuration and presentation', () => {
  it('accepts defaults/per-index overrides without mixing settings across indices', () => {
    const config = normalizeOrbSettings({ underlying: 'BANKNIFTY', quantity: 30, retestTolerancePointsByUnderlying: { BANKNIFTY: 25 } })
    expect(config.retestTolerancePointsByUnderlying).toEqual({ NIFTY: 10, BANKNIFTY: 25, SENSEX: 30 })
    expect(config.liveTradingConsent).toBe(false)
    expect(orbDefaults.retestTolerancePointsByUnderlying.BANKNIFTY).toBe(20)
    expect(isValidStrategySettings(config, 'IndexVwapOrb')).toBe(true)
  })
  it('rejects unknown/invalid settings and does not silently add trading-rule overrides', () => {
    for (const bad of [{ quantity: 0 }, { underlying: 'CRUDEOILM' }, { liveTradingConsent: null }, { premiumMin: 20, premiumMax: 10 },
      { strikeDepth: 101 }, { retestTolerancePointsByUnderlying: null }, { riskReward: 3 }, { retestTolerancePointsByUnderlying: { NIFTY: -1 } }]) {
      expect(() => normalizeOrbSettings(bad)).toThrow()
    }
    expect(validOrbConfig({ ...orbDefaults, quantity: NaN })).toBe(false)
  })
  it('retains exposure after Stop and validates lot metadata against selected underlying', () => {
    const status: OrbStatus = { isRunning: false, state: 'POSITION_UNPROTECTED', activeTradeId: 'held', ceContract: { underlying: 'NIFTY', lot_size: 65 } }
    expect(hasOrbExposure(status)).toBe(true)
    expect(lotFor(status, 'NIFTY')).toBe(65)
    expect(lotFor(status, 'SENSEX')).toBeNull()
    expect(hasOrbExposure({ isRunning: false, state: 'STOPPED', dailyEntries: { sessionDate: '2026-10-16', filled: 0, reserved: 1, limit: 2, blocked: true } })).toBe(true)
  })
  it('plots only matching backend diagnostics, never recomputes strategy levels or leaks another date/index', () => {
    const open = Date.parse('2026-10-16T09:15:00+05:30') / 1000
    const bars = [{ time: open + 1800, open: 100, high: 102, low: 99, close: 101 }]
    const signalAt = (open + 1860) * 1000
    const status: OrbStatus = { isRunning: true, state: 'SCANNING', analysis: { underlying: 'NIFTY', diagnostics: {
      sessionDate: '2026-10-16', orHigh: 111, orLow: 98, vwapSeries: [{ time: open, value: null }, { time: open + 1800, value: 100.5 }],
      latestCandidate: { signalClosedAt: signalAt, entryPrice: 110, stopLoss: 100, takeProfit: 130,
        pivot: { formedAt: (open + 1500) * 1000, confirmedAt: (open + 1680) * 1000, price: 109 } },
    } } }
    const overlay = orbOverlays(status, 'NIFTY', '2026-10-16', bars)
    expect(overlay.lines.find(l => l.title === 'OR High')?.price).toBe(111)
    expect(orbOverlays(status, 'NIFTY', '2026-10-16', bars, 300).lines[0].to).toBe(open + 2100)
    expect(overlay.vwap).toEqual([{ time: open + 1800, value: 100.5 }])
    expect(overlay.markers.find(m => m.text === 'Pivot confirmed 2+2')?.time).toBe(open + 1680)
    expect(overlay.markers.find(m => m.text.startsWith('Entry signal'))?.time).toBe(signalAt / 1000)
    expect(orbOverlays(status, 'SENSEX', '2026-10-16', bars).lines).toEqual([])
    expect(orbOverlays(status, 'NIFTY', '2026-10-15', bars).vwap).toEqual([])
  })
})
